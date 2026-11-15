#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
backend=/opt/2906-system/backend
backup=/opt/2906-system/backups/crm-matching-$(date -u +%Y%m%dT%H%M%SZ)
files=(services/matchEngine.js services/clientAssistant.js)
baseline() {
  (cd "$backend" && sha256sum -c <<'SHA'
f64c9cc4f9f834aa3e444329b70318dadc4863c809ec72f3b9f1115e4c562933  services/matchEngine.js
03b187bc8817a110f50d674fd6a08413e15c74da209d104404a09d41d81db857  services/clientAssistant.js
SHA
  )
}
healthy() {
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:3001/health >/dev/null &&
      [[ $(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/crm/me) == 401 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}
rollback() {
  for file in "${files[@]}"; do cp -p "$backup/base/$file" "$backend/$file"; done
  docker restart 2906_backend >/dev/null
  healthy
}

exec 9>/opt/2906-system/.crm-matching-deploy.lock
flock -n 9
baseline
mkdir -p "$backup"
chmod 700 "$backup"
mkdir -p "$backup"/{base,staged}/services
for file in "${files[@]}"; do
  cp -p "$backend/$file" "$backup/base/$file"
  cp -p "$backend/$file" "$backup/staged/$file"
done
patch --batch --forward --fuzz=0 -d "$backup/staged" -p1 < "$here/preserve-closed-matches.patch"
node --check "$backup/staged/services/matchEngine.js"
node --check "$backup/staged/services/clientAssistant.js"
MATCHING_BACKEND="$backup/staged" node --test "$here/closed-search.test.cjs"

active_sends=$(docker exec -i 2906_postgres psql -X -U 2906user -d 2906db -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running') AND id <> 50)
     + (SELECT count(*) FROM outreach_plan_entries WHERE send_status='sending');
SQL
)
[[ "$active_sends" == 0 ]] || { echo 'Outreach send in progress. Retry after it finishes.'; exit 1; }
baseline
if ! cp -p "$backup/staged/services/matchEngine.js" "$backend/services/matchEngine.js" ||
   ! cp -p "$backup/staged/services/clientAssistant.js" "$backend/services/clientAssistant.js" ||
   ! docker restart 2906_backend >/dev/null || ! healthy; then
  echo "Release failed. Restoring $backup/base" >&2
  rollback
  exit 1
fi
(cd "$backend" && sha256sum "${files[@]}")
echo "Ready. Rollback files: $backup/base"
