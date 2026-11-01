#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Start this seat's runner from a managed launch: OpenRig's community-harness
# preset command, or a terminal seat's startup action. It runs in the seat's own
# tmux pane, in the seat's working directory, and replaces itself with the runner.
#
# What it does that a bare `node src/dsh-seat.mjs` doesn't:
#   - runs the runner (and dsh) on a pinned Node, by absolute path;
#   - pins JAVA_HOME by absolute path when the seat's work needs a specific JDK;
#   - picks the conversation the launch asked for: OPENRIG_RESUME_REF resumes
#     that exact ref, an OpenRig new-conversation signal (OPENRIG_LAUNCH_ATTEMPT
#     or OPENRIG_CONVERSATION) passes no --session, --fresh/DSH_SEAT_FRESH=1
#     passes none, and only a launch with no signal falls back to
#     runner-state.json (a relaunch then continues the saved conversation);
#   - uses the seat's own DSH_HOME, built on first use (scripts/make-seat-home.sh);
#   - gives the seat a private TMPDIR (0700, owned by you), which dsh's
#     workspace-write sandbox already lets it write;
#   - hands dsh an allowlisted environment (--scrub-env), not your whole one;
#   - sends an initial prompt so the agent orients itself with `rig whoami`.
#
# The seat:   $OPENRIG_SESSION_NAME (set by a managed launch), else the first argument.
# Options:    --fresh (before or after the seat name) starts a new conversation;
#             an unknown -- argument is refused, never ignored.
# Its files:  $OPENRIG_HOME/state/dsh/<seat>/   (runner-state.json, home/, seat.env)
#
# Settings come from DSH_SEAT_<KEY> in the environment, else from <seat>/seat.env:
# plain KEY=VALUE lines that are read, never sourced. Keys:
#   NODE            absolute path to node (required); must be Node $NODE_MAJOR
#   NODE_MAJOR      required Node major version (default 24)
#   JAVA_HOME       absolute JDK home; exported, its bin/ put first on PATH
#   DSH_COMMAND     dsh executable (default: dsh, found on PATH after NODE's dir)
#   DSH_HOME        the seat's dsh home (default: <seat>/home, built on first use)
#   SOURCE_HOME     the home a new seat home is built from (default: ~/.dsh)
#   POSTURE         floor only (the default); auto and full_bypass are refused here
#   MODEL           ACP model value, passed as --model
#   TMP_ROOT        parent of the seat's TMPDIR (default /private/tmp/dsh-seat, else /tmp/dsh-seat)
#   INITIAL_PROMPT  the first turn's text, or "off" (default: orient with rig whoami)
#   ENV_<NAME>      exported to the seat and passed through --scrub-env as NAME;
#                   "{seat_tmp}" in the value becomes the seat's TMPDIR
#                   (e.g. ENV_LUCLI_HOME={seat_tmp}/lucli-home)
#
# DSH_SEAT_DRY_RUN=1 prints the resolved environment and command, then exits.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUNNER="$ROOT/src/dsh-seat.mjs"

die() {
  echo "seat-up: $*" >&2
  exit 1
}

# ── Arguments ───────────────────────────────────────────────────────────────
# --fresh starts a new conversation and may sit before or after the seat name;
# every other -- argument is a usage error rather than something to ignore.
FRESH_REQUESTED=0
if [ "${DSH_SEAT_FRESH:-}" = 1 ]; then FRESH_REQUESTED=1; fi
SEAT_ARG=""
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH_REQUESTED=1 ;;
    -*) die "unknown option '$arg'; usage: seat-up.sh [--fresh] [<member>@<rig>]" ;;
    *)
      [ -z "$SEAT_ARG" ] \
        || die "unexpected extra argument '$arg'; usage: seat-up.sh [--fresh] [<member>@<rig>]"
      SEAT_ARG="$arg"
      ;;
  esac
done

SESSION="${OPENRIG_SESSION_NAME:-$SEAT_ARG}"
[ -n "$SESSION" ] || die "no seat name: run under a managed launch (OPENRIG_SESSION_NAME) or pass <member>@<rig>"

OPENRIG_HOME_DIR="${OPENRIG_HOME:-$HOME/.openrig}"
STATE_ROOT="$OPENRIG_HOME_DIR/state/dsh"
# The same single path segment the runner uses (src/state.mjs sanitizeSessionName).
SEAT_NAME="$(printf '%s' "$SESSION" | sed 's/[^A-Za-z0-9._@-][^A-Za-z0-9._@-]*/_/g')"
SEAT_DIR="$STATE_ROOT/$SEAT_NAME"
SEAT_ENV="$SEAT_DIR/seat.env"

# conf KEY [default]: DSH_SEAT_KEY from the environment, else the last KEY= line
# of seat.env, else the default. The file is read as data, never executed.
conf() {
  _key="$1"
  _val="$(printenv "DSH_SEAT_$_key" 2>/dev/null || true)"
  if [ -z "$_val" ] && [ -f "$SEAT_ENV" ]; then
    _val="$(grep "^$_key=" "$SEAT_ENV" | tail -n 1 | cut -d= -f2-)" || true
  fi
  if [ -z "$_val" ]; then _val="${2:-}"; fi
  printf '%s' "$_val"
}

is_absolute() {
  case "$1" in /*) return 0 ;; *) return 1 ;; esac
}

# ── Node ────────────────────────────────────────────────────────────────────
NODE="$(conf NODE)"
[ -n "$NODE" ] || die "set NODE to an absolute node path (DSH_SEAT_NODE, or NODE= in $SEAT_ENV)"
is_absolute "$NODE" || die "NODE must be an absolute path, not '$NODE'"
[ -x "$NODE" ] || die "NODE '$NODE' is not executable"
NODE_MAJOR="$(conf NODE_MAJOR 24)"
FOUND_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$FOUND_MAJOR" = "$NODE_MAJOR" ] || die "NODE '$NODE' is Node $FOUND_MAJOR; this seat is pinned to Node $NODE_MAJOR"
PATH="$(dirname "$NODE"):$PATH"

# ── Java ────────────────────────────────────────────────────────────────────
JAVA_PIN="$(conf JAVA_HOME)"
if [ -n "$JAVA_PIN" ]; then
  is_absolute "$JAVA_PIN" || die "JAVA_HOME must be an absolute path, not '$JAVA_PIN'"
  [ -x "$JAVA_PIN/bin/java" ] || die "JAVA_HOME '$JAVA_PIN' has no bin/java"
  JAVA_HOME="$JAVA_PIN"
  export JAVA_HOME
  PATH="$JAVA_HOME/bin:$PATH"
fi
export PATH

# ── Posture ─────────────────────────────────────────────────────────────────
POSTURE="$(conf POSTURE floor)"
# A managed launch runs unattended, so it stays on the floor. auto (escalations
# allowed once) is still available on the runner itself, as a deliberate choice.
[ "$POSTURE" = floor ] \
  || die "POSTURE '$POSTURE' is not allowed here: a managed launch is floor-only. To run with auto, start the runner directly with --posture auto as a deliberate choice."

# ── dsh and its home ────────────────────────────────────────────────────────
DSH_COMMAND="$(conf DSH_COMMAND dsh)"
command -v "$DSH_COMMAND" >/dev/null 2>&1 || die "dsh command '$DSH_COMMAND' is not on PATH ($PATH)"

SEAT_HOME="$(conf DSH_HOME "$SEAT_DIR/home")"
SOURCE_HOME="$(conf SOURCE_HOME "$HOME/.dsh")"
# A seat and your own dsh cannot share a home: dsh rewrites it on every boot.
[ "$SEAT_HOME" != "$SOURCE_HOME" ] && [ "$SEAT_HOME" != "$HOME/.dsh" ] \
  || die "DSH_HOME '$SEAT_HOME' is your live dsh home; a seat needs its own (see scripts/make-seat-home.sh)"
if [ ! -d "$SEAT_HOME/profiles" ]; then
  echo "seat-up: no seat home at $SEAT_HOME; building one from $SOURCE_HOME"
  "$ROOT/scripts/make-seat-home.sh" "$SEAT_HOME" "$SOURCE_HOME" >/dev/null
fi
if [ ! -e "$SEAT_HOME/.credentials.yaml" ]; then
  echo "seat-up: note: $SEAT_HOME has no .credentials.yaml; with a scrubbed environment dsh gets a provider key only when MODEL names its provider (provider/id)" >&2
fi

# ── Private TMPDIR ──────────────────────────────────────────────────────────
if [ -d /private/tmp ]; then DEFAULT_TMP_ROOT=/private/tmp/dsh-seat; else DEFAULT_TMP_ROOT=/tmp/dsh-seat; fi
TMP_ROOT="$(conf TMP_ROOT "$DEFAULT_TMP_ROOT")"
is_absolute "$TMP_ROOT" || die "TMP_ROOT must be an absolute path, not '$TMP_ROOT'"
SEAT_TMP="$TMP_ROOT/$SEAT_NAME"
for dir in "$TMP_ROOT" "$SEAT_TMP"; do
  # A shared /tmp can hold a directory someone else planted: refuse a symlink or
  # a directory you don't own, and keep both levels private.
  [ ! -L "$dir" ] || die "$dir is a symlink; refusing it as a seat temp directory"
  if [ -e "$dir" ]; then
    [ -d "$dir" ] && [ "$(ls -ldn "$dir" | awk '{print $3}')" = "$(id -u)" ] \
      || die "$dir exists and is not a directory you own"
  else
    mkdir -m 700 "$dir"
  fi
  chmod 700 "$dir"
done
TMPDIR="$SEAT_TMP"
export TMPDIR

# ── Extra seat variables (ENV_<NAME> in the settings) ───────────────────────
PASS_NAMES=""
add_pass() {
  case " $PASS_NAMES " in *" $1 "*) return ;; esac
  PASS_NAMES="$PASS_NAMES $1"
}
[ -n "$JAVA_PIN" ] && add_pass JAVA_HOME
EXTRA_KEYS="$( { env | sed -n 's/^DSH_SEAT_ENV_\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'; \
  [ -f "$SEAT_ENV" ] && sed -n 's/^ENV_\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$SEAT_ENV"; } | sort -u)"
for name in $EXTRA_KEYS; do
  value="$(conf "ENV_$name")"
  value="$(printf '%s' "$value" | sed "s|{seat_tmp}|$SEAT_TMP|g")"
  export "$name=$value"
  add_pass "$name"
done

# ── Session decision ────────────────────────────────────────────────────────
# Follow what the launch asked for before any heuristic:
#   1 explicit --fresh + OPENRIG_RESUME_REF is a contradiction and is refused;
#   2 OPENRIG_RESUME_REF resumes exactly that ref (never runner-state.json);
#   3 an OpenRig new-conversation signal passes no --session;
#   4 --fresh / DSH_SEAT_FRESH=1 passes no --session;
#   5 otherwise the saved runner-state.json id, else fresh.
RESUME_REF="${OPENRIG_RESUME_REF:-}"
ASKED_NEW=0
if [ -n "${OPENRIG_LAUNCH_ATTEMPT:-}" ] || [ -n "${OPENRIG_CONVERSATION:-}" ]; then ASKED_NEW=1; fi

if [ "$FRESH_REQUESTED" = 1 ] && [ -n "$RESUME_REF" ]; then
  die "conflicting launch request: --fresh (or DSH_SEAT_FRESH=1) asks for a new conversation, but OPENRIG_RESUME_REF=$RESUME_REF asks to resume one. Refusing to pick one silently."
fi

SESSION_ID=""
RESUME_SOURCE=""
case "$RESUME_REF" in
  "") ;;
  *[!A-Za-z0-9._:-]*) die "OPENRIG_RESUME_REF '$RESUME_REF' is not a valid session id (allowed: letters, digits, . _ : -); refusing to fall back to runner-state.json" ;;
esac
if [ -n "$RESUME_REF" ]; then
  SESSION_ID="$RESUME_REF"
  RESUME_SOURCE=openrig-resume
elif [ "$ASKED_NEW" = 1 ]; then
  RESUME_SOURCE=openrig-fresh
elif [ "$FRESH_REQUESTED" = 1 ]; then
  RESUME_SOURCE=asked-fresh
else
  SAVED_SESSION_ID="$("$NODE" -e '
    try {
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (typeof s.sessionId === "string" && /^[A-Za-z0-9._:-]+$/.test(s.sessionId)) process.stdout.write(s.sessionId);
    } catch {}
  ' "$SEAT_DIR/runner-state.json")"
  if [ -n "$SAVED_SESSION_ID" ]; then
    SESSION_ID="$SAVED_SESSION_ID"
    RESUME_SOURCE=runner-state
  else
    RESUME_SOURCE=none
  fi
fi
case "$RESUME_SOURCE" in
  openrig-resume) RESUME_LABEL="resuming $SESSION_ID (asked by OpenRig)" ;;
  openrig-fresh) RESUME_LABEL="fresh (OpenRig asked for a new conversation; runner-state.json not used)" ;;
  asked-fresh) RESUME_LABEL="fresh (asked with --fresh)" ;;
  runner-state) RESUME_LABEL="resuming $SESSION_ID from runner-state.json" ;;
  *) RESUME_LABEL="fresh (no saved session)" ;;
esac

# ── The runner ──────────────────────────────────────────────────────────────
DEFAULT_PROMPT="You are running as the OpenRig seat $SESSION. Run \`rig whoami --json\` to learn your rig, peers and how to reach them, then check \`rig queue\` for work addressed to you before doing anything else."
INITIAL_PROMPT="$(conf INITIAL_PROMPT "$DEFAULT_PROMPT")"
MODEL="$(conf MODEL)"

set -- "$RUNNER" \
  --session-name "$SESSION" \
  --cwd "$PWD" \
  --dsh-home "$SEAT_HOME" \
  --dsh-command "$DSH_COMMAND" \
  --state-root "$STATE_ROOT" \
  --posture "$POSTURE" \
  --runtime-label dsh \
  --scrub-env
for name in $PASS_NAMES; do set -- "$@" --pass-env "$name"; done
[ -n "$SESSION_ID" ] && set -- "$@" --session "$SESSION_ID"
[ -n "$MODEL" ] && set -- "$@" --model "$MODEL"
[ -n "${OPENRIG_NODE_ID:-}" ] && set -- "$@" --node-id "$OPENRIG_NODE_ID"
[ -n "${OPENRIG_OCCUPANT_GENERATION:-}" ] && set -- "$@" --generation "$OPENRIG_OCCUPANT_GENERATION"
[ "$INITIAL_PROMPT" != "off" ] && set -- "$@" --initial-prompt "$INITIAL_PROMPT"

if [ -n "${DSH_SEAT_DRY_RUN:-}" ]; then
  echo "NODE=$NODE"
  echo "PATH=$PATH"
  echo "JAVA_HOME=${JAVA_HOME:-}"
  echo "TMPDIR=$TMPDIR"
  echo "RESUME_SOURCE=$RESUME_SOURCE"
  echo "RESUME_DECISION=$RESUME_LABEL"
  for name in $PASS_NAMES; do echo "PASS $name=$(printenv "$name")"; done
  for arg in "$@"; do echo "ARG $arg"; done
  exit 0
fi

echo "seat-up: $SESSION · node $FOUND_MAJOR · $RESUME_LABEL · tmp $SEAT_TMP"
exec "$NODE" "$@"
