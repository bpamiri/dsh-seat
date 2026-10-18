#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Build a writable, isolated DSH_HOME for a seat.
#
# Why this exists: dsh rewrites $DSH_HOME/profiles/<name>/cordis.yml on EVERY boot,
# so a seat needs a home it can write to; and pointing it at your own ~/.dsh means
# a seat boot rewrites the same profile files your own dsh sessions are using.
# This builds a private home from your existing one — the pnpm bundle tree, where
# the home has one (dsh before 0.2.1), and credentials are symlinked (not copied),
# and only the profile directory is a real writable copy.
#
# It also writes the seat's own home-level cordis.patch.yml (which outranks the
# profile layer): dsh's session-log and plugin-list uploads to DeepSeek are turned
# off, and a fresh sessions root stores plain JSONL so dsh-seat can read per-turn
# token usage.
#
# Usage: ./scripts/make-seat-home.sh [target-dir] [source-home]
#   target-dir    default: <repo>/.seat-home
#   source-home   default: $DSH_HOME, else ~/.dsh
#
# Env: DSH_SEAT_PROFILE (default: acp)

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

TARGET="${1:-$REPO/.seat-home}"
SOURCE="${2:-${DSH_HOME:-$HOME/.dsh}}"
PROFILE="${DSH_SEAT_PROFILE:-acp}"

if [ ! -d "$SOURCE/profiles/$PROFILE" ]; then
  echo "error: $SOURCE/profiles/$PROFILE does not exist" >&2
  echo "       boot it once with:  DSH_HOME=$SOURCE dsh --profile $PROFILE --help" >&2
  exit 1
fi

mkdir -p "$TARGET/profiles"

if [ -e "$TARGET/profiles/$PROFILE" ]; then
  echo "profile copy already present: $TARGET/profiles/$PROFILE (left as is)"
else
  cp -R "$SOURCE/profiles/$PROFILE" "$TARGET/profiles/$PROFILE"
  echo "copied profile  $PROFILE  (a real, writable copy)"
fi

# Bundles + their pnpm tree are shared read-only; symlink, never copy. dsh 0.2.1
# and later resolve bundles from its own install and keep no tree here.
if [ -e "$SOURCE/profiles/node_modules" ]; then
  ln -sfn "$SOURCE/profiles/node_modules" "$TARGET/profiles/node_modules"
  echo "linked          $TARGET/profiles/node_modules -> $SOURCE/profiles/node_modules"
fi

if [ -f "$SOURCE/.credentials.yaml" ]; then
  ln -sfn "$SOURCE/.credentials.yaml" "$TARGET/.credentials.yaml"
  echo "linked          $TARGET/.credentials.yaml -> $SOURCE/.credentials.yaml"
else
  echo "note: no $SOURCE/.credentials.yaml — the seat will rely on provider env vars" >&2
fi

# Optional state that affects model/provider defaults.
for extra in settings.yaml.imported .agent-presets; do
  if [ -e "$SOURCE/$extra" ] && [ ! -e "$TARGET/$extra" ]; then
    cp -R "$SOURCE/$extra" "$TARGET/$extra"
    echo "copied          $extra"
  fi
done

# Seat defaults. dsh composes $DSH_HOME/cordis.patch.yml over the profile's own
# patch, and a patch replaces a row's whole config, so every field a row needs is
# written out. An existing file is the operator's: leave it alone.
PATCH="$TARGET/cordis.patch.yml"
if [ -e "$PATCH" ]; then
  echo "seat patch already present: $PATCH (left as is)"
else
  SESSIONS="$(cd "$TARGET" && pwd)/sessions"
  SESSIONS_YAML="$(printf '%s' "$SESSIONS" | sed "s/'/''/g")"
  {
    echo "# dsh-seat seat defaults, written by scripts/make-seat-home.sh. Safe to edit."
    echo "# A patch replaces a row's whole config, so keep every field the row needs."
    echo ""
    echo "# Do not attach this seat's session log to DeepSeek API requests"
    echo "# (dsh-session-log-deepseek; on by default)."
    echo "- id: session-log-deepseek"
    echo "  config:"
    echo "    enabled: false"
    echo ""
    echo "# Do not attach the names and versions of this seat's plugin packages to"
    echo "# DeepSeek API requests (dsh-plugin-package-inventory-deepseek; on by default)."
    echo "- id: plugin-package-inventory-deepseek"
    echo "  config:"
    echo "    enabled: false"
    if [ ! -e "$TARGET/sessions" ]; then
      echo ""
      echo "# Plain JSONL session logs, so dsh-seat can read per-turn token usage"
      echo "# without zstd. Set only on a fresh sessions root."
      echo "- id: session-persistence-jsonl"
      echo "  config:"
      # printf, not echo: dash's echo would turn a backslash in the path into an escape.
      printf "    root: '%s'\n" "$SESSIONS_YAML"
      echo "    compression: none"
    fi
  } > "$PATCH"
  echo "wrote           $PATCH (session-log and plugin-list uploads off)"
fi

cat <<EOF

seat home ready: $TARGET

  run a seat:  node $REPO/src/dsh-seat.mjs --cwd <repo> --dsh-home $TARGET
  probe ACP:   PROBE_DSH_HOME=$TARGET node $REPO/probes/probe-acp.mjs

This directory must stay writable by the user running dsh.
EOF
