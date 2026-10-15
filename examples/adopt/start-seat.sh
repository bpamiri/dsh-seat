#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Start a dsh seat in a tmux pane under its canonical OpenRig session name.
#
# Usage: ./start-seat.sh <repo-path> [member] [rig-name] [dsh-home] [posture]
#
# The canonical name format is <member>@<rig>: OpenRig's `rig discover` will see
# this pane, and `rig adopt --bind <member>=<session>` binds it to the member.
#
# DSH_HOME: dsh rewrites $DSH_HOME/profiles/<name>/cordis.yml on EVERY boot, so a
# seat needs a home it can write to and that nothing else is using. Pointing a
# seat at your own ~/.dsh rewrites the same profile files your own dsh sessions
# are using. This script therefore assembles a dedicated seat home for you under
# $OPENRIG_HOME/state/dsh/seat-home, and only uses something else if you pass it
# explicitly.

set -eu

REPO="${1:?usage: start-seat.sh <repo-path> [member] [rig-name] [dsh-home] [posture]}"
MEMBER="${2:-dev1-dsh}"
RIG="${3:-dsh-scratch}"
POSTURE="${5:-floor}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUNNER="$ROOT/src/dsh-seat.mjs"
STATE_ROOT="${OPENRIG_HOME:-$HOME/.openrig}/state/dsh"

if [ "$#" -ge 4 ] && [ -n "${4:-}" ]; then
  DSH_HOME_ARG="$4"
  SOURCE_HOME=""
else
  DSH_HOME_ARG="$STATE_ROOT/seat-home"
  SOURCE_HOME="${DSH_HOME:-$HOME/.dsh}"
fi

# Refuse the one combination that damages the operator's own dsh state: a seat
# and the operator cannot share a home, because dsh rewrites it on every boot.
if [ -n "$SOURCE_HOME" ] && [ "$DSH_HOME_ARG" = "$SOURCE_HOME" ]; then
  echo "refusing: dsh-home '$DSH_HOME_ARG' is your live dsh home." >&2
  echo "  dsh rewrites \$DSH_HOME/profiles/<name>/cordis.yml on every boot, so this seat would" >&2
  echo "  rewrite the profile tree your own dsh sessions are using." >&2
  echo "  Run without the dsh-home argument to get a dedicated seat home, or build one with:" >&2
  echo "    $ROOT/scripts/make-seat-home.sh <target-dir>" >&2
  exit 1
fi
if [ "$DSH_HOME_ARG" = "$HOME/.dsh" ]; then
  echo "refusing: dsh-home '$DSH_HOME_ARG' is your live dsh home (see the note above)." >&2
  exit 1
fi

# Assemble the seat home on first use — writable, private, credentials symlinked.
if [ -n "$SOURCE_HOME" ] && [ ! -d "$DSH_HOME_ARG/profiles" ]; then
  echo "no seat home at $DSH_HOME_ARG — building one from $SOURCE_HOME"
  DSH_SEAT_PROFILE="${DSH_SEAT_PROFILE:-acp}" "$ROOT/scripts/make-seat-home.sh" "$DSH_HOME_ARG" "$SOURCE_HOME" >/dev/null
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "warning: 'dsh' is not on this shell's PATH; the seat will fail to start unless the pane's shell finds it." >&2
fi

SESSION="${MEMBER}@${RIG}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists — attach with: tmux attach -t $SESSION" >&2
  exit 1
fi

tmux new-session -d -s "$SESSION" -c "$REPO" \
  "node '$RUNNER' --session-name '$SESSION' --cwd '$REPO' --dsh-home '$DSH_HOME_ARG' --state-root '$STATE_ROOT' --posture '$POSTURE'"

echo "started seat '$SESSION' in $REPO"
echo "  dsh home: $DSH_HOME_ARG"
echo "  attach:   tmux attach -t $SESSION"
echo "  discover: rig discover"
echo "  adopt:    rig adopt rig.yaml --bind <pod>.${MEMBER}=$SESSION   # logical ids are pod-qualified"
