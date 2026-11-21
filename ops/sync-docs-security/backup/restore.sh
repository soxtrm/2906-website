#!/usr/bin/env bash
# Restore NEXUS SYNC private documents from an encrypted archive (Claude, 2026-11-21).
#   restore.sh <archive.tar.gpg> check                 decrypt into a temp dir and verify, change nothing
#   restore.sh <archive.tar.gpg> files                 put missing files back into DOCS_DIR (never overwrites)
#   restore.sh <archive.tar.gpg> files+metadata        also re-insert missing owner_documents rows (by id, never overwrites)
# Same environment settings as private_docs_backup.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ARCH="${1:?archive}"; MODE="${2:-check}"
DOCS="${DOCS_DIR:-/opt/2906-system/backend/private-docs}"
KEY="${KEY_FILE:-/etc/argus-backup/private-docs.key}"
PG="${PG_CONTAINER:-2906_postgres}"
PSQL="${PSQL_CMD:-psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -X -v ON_ERROR_STOP=1}"
umask 077; WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
gpg --batch --quiet --decrypt --passphrase-file "$KEY" "$ARCH" | tar -C "$WORK" -xf -
python3 "$HERE/verify.py" "$WORK/owner_documents.csv" "$WORK/files"
[ "$MODE" = check ] && { echo "archive ok, nothing changed"; exit 0; }
mkdir -p "$DOCS"; chmod 700 "$DOCS"
n=0; for f in "$WORK"/files/*; do [ -e "$f" ] || continue; b=$(basename "$f"); if [ ! -e "$DOCS/$b" ]; then cp -p "$f" "$DOCS/$b"; chmod 600 "$DOCS/$b"; n=$((n+1)); fi; done
echo "files restored: $n"
if [ "$MODE" = files+metadata ]; then
  docker exec -i "$PG" sh -c "$PSQL" > /dev/null <<SQL
CREATE TEMP TABLE restore_docs (LIKE owner_documents INCLUDING DEFAULTS);
\copy restore_docs FROM STDIN WITH CSV HEADER
$(cat "$WORK/owner_documents.csv")
\.
INSERT INTO owner_documents SELECT * FROM restore_docs ON CONFLICT (id) DO NOTHING;
SQL
  echo "metadata rows re-inserted where missing"
fi
