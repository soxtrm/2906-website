#!/bin/bash
# Build the staging bundle from COMMITTED code only (Claude, 2026-11-13).
#   bash package.sh <out.tgz> [<nexus repo> <nexus commit>]
# ARGUS code comes from `git archive HEAD`, NEXUS code from `git archive <commit>`:
# an uncommitted working tree can never end up on staging. No secrets are packed.
set -euo pipefail
OUT=${1:?output .tgz}; NEXUS_REPO=${2:-}; NEXUS_COMMIT=${3:-}
ROOT=$(git rev-parse --show-toplevel)
[ -z "$(git -C "$ROOT" status --porcelain -- ops/nexus-owner-link)" ] || { echo "ABORT: ops/nexus-owner-link has uncommitted changes"; exit 1; }
ARGUS_COMMIT=$(git -C "$ROOT" rev-parse --short HEAD)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git -C "$ROOT" archive HEAD ops/nexus-owner-link/staging ops/nexus-owner-link/backend/services ops/nexus-owner-link/backend/routes ops/nexus-owner-link/backend/migrations | tar -x -C "$TMP"
B="$TMP/bundle"; mv "$TMP/ops/nexus-owner-link/staging" "$B"; mv "$TMP/ops/nexus-owner-link/backend" "$B/backend"
if [ -n "$NEXUS_REPO" ]; then
  mkdir -p "$B/nexus-src"
  git -C "$NEXUS_REPO" archive "$NEXUS_COMMIT" | tar -x -C "$B/nexus-src"
  NEXUS_COMMIT=$(git -C "$NEXUS_REPO" rev-parse --short "$NEXUS_COMMIT")
fi
{ echo "ARGUS_COMMIT=$ARGUS_COMMIT"; echo "NEXUS_COMMIT=$NEXUS_COMMIT"
  # The two production files the pinned code was tested with.
  echo "DB_JS_MD5=c9712948fe7615e7d479c299885481da"; echo "BOARD_ACTION_MD5=21b3978b9188e95f0f9779636d046fab"; } > "$B/pins.env"
tar -czf "$OUT" -C "$B" .
echo "bundle $OUT: ARGUS $ARGUS_COMMIT, NEXUS ${NEXUS_COMMIT:-not included}"
