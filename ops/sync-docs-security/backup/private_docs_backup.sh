#!/usr/bin/env bash
# Encrypted backup of the NEXUS SYNC private documents and their metadata, as one snapshot (Claude, 2026-11-21).
#   private_docs_backup.sh            nightly: snapshot -> check -> encrypt (AES-256, key file) -> decrypt and check again -> retention
# The archive holds owner_documents rows (storage 'sync_private', incl. deleted ones for the audit trail) as CSV and the
# files, so files and metadata always restore together (restore.sh). Retention: RETENTION_DAYS (30). A document the owner
# deletes is gone from the live system at once and disappears from backups when the last archive holding it expires.
# Settings come from the environment so the same script runs against staging:
#   DOCS_DIR OUT_DIR KEY_FILE PG_CONTAINER PSQL_CMD RETENTION_DAYS
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DOCS="${DOCS_DIR:-/opt/2906-system/backend/private-docs}"
OUT="${OUT_DIR:-/var/backups/2906/private-docs}"
KEY="${KEY_FILE:-/etc/argus-backup/private-docs.key}"
PG="${PG_CONTAINER:-2906_postgres}"
PSQL="${PSQL_CMD:-psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -X -v ON_ERROR_STOP=1}"
RET="${RETENTION_DAYS:-30}"
umask 077
[ -s "$KEY" ] || { echo "FAIL: key file $KEY missing"; exit 1; }
mkdir -p "$OUT"; chmod 700 "$OUT"
TS=$(date -u +%Y%m%dT%H%M%SZ); WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
snapshot() {
  rm -rf "$WORK/snap"; mkdir -p "$WORK/snap/files"
  docker exec "$PG" sh -c "$PSQL -c \"\\copy (SELECT * FROM owner_documents WHERE storage='sync_private' ORDER BY id) TO STDOUT WITH CSV HEADER\"" > "$WORK/snap/owner_documents.csv"
  if [ -d "$DOCS" ]; then find "$DOCS" -maxdepth 1 -type f -exec cp -p {} "$WORK/snap/files/" \; ; fi
  python3 "$HERE/verify.py" "$WORK/snap/owner_documents.csv" "$WORK/snap/files"
}
# a document deleted between the metadata copy and the file copy makes the first snapshot inconsistent: take it again
snapshot || { echo "snapshot changed while copying, taking it again"; sleep 5; snapshot; }
ARCH="$OUT/private-docs_$TS.tar.gpg"
tar -C "$WORK/snap" -cf - owner_documents.csv files | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --passphrase-file "$KEY" -o "$ARCH"
# restore check of exactly what was written
mkdir -p "$WORK/check"
gpg --batch --quiet --decrypt --passphrase-file "$KEY" "$ARCH" | tar -C "$WORK/check" -xf -
python3 "$HERE/verify.py" "$WORK/check/owner_documents.csv" "$WORK/check/files" >/dev/null || { echo "FAIL: the archive did not restore cleanly"; rm -f "$ARCH"; exit 1; }
find "$OUT" -maxdepth 1 -name 'private-docs_*.tar.gpg' -mtime +"$RET" -delete
echo "private documents backup ok: $ARCH ($(du -h "$ARCH" | cut -f1), restore verified)"
