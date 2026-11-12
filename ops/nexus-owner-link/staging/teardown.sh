#!/bin/bash
# Remove the staging stack. Only objects of the compose project "argus-nexus-staging".
#   bash teardown.sh           stop and remove containers and networks, keep data
#   bash teardown.sh --purge   also delete the staging volumes (staging data is lost)
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "--purge" ]; then docker compose --profile nexus down -v; else docker compose --profile nexus down; fi
docker compose ls --all | grep -c argus-nexus-staging || true
