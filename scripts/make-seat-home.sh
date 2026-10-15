#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Build a writable, isolated DSH_HOME for a seat.
#
# Why this exists: dsh rewrites $DSH_HOME/profiles/<name>/cordis.yml on EVERY boot,
# so a seat needs a home it can write to; and pointing it at your own ~/.dsh means
# a seat boot rewrites the same profile files your own dsh sessions are using.
# This builds a private home from your existing one — bundles and the pnpm
# node_modules are symlinked (no copies), credentials are symlinked (not copied),
# and only the profile directory is a real writable copy.
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

# Bundles + their pnpm tree are shared read-only; symlink, never copy.
ln -sfn "$SOURCE/profiles/node_modules" "$TARGET/profiles/node_modules"
echo "linked          $TARGET/profiles/node_modules -> $SOURCE/profiles/node_modules"

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

cat <<EOF

seat home ready: $TARGET

  run a seat:  node $REPO/src/dsh-seat.mjs --cwd <repo> --dsh-home $TARGET
  probe ACP:   PROBE_DSH_HOME=$TARGET node $REPO/probes/probe-acp.mjs

This directory must stay writable by the user running dsh.
EOF
