#!/bin/bash
# Owner AI recalibration — runtime before/after on the isolated argus_test DB.
# Production mirror (no config.js / credentials) = BEFORE; mirror + overlay = AFTER.
# Runs in the 2906-system-backend image on the --internal argus-outreach-testnet.
# Nothing reaches WhatsApp: the harness stubs WAHA, queues and config.
set -euo pipefail
R=/d/2906/nexus-bridge-work/20261110/argus-owner-ai-recal/ops
STAGE=$(mktemp -d)
mkdir -p "$STAGE/before" "$STAGE/after"
tar -C "$R/owner-ai-recal/prod-mirror" --exclude=config.js --exclude='*.json.bak' --exclude=node_modules -cf - . | tar -C "$STAGE/before" -xf -
cp -r "$STAGE/before/." "$STAGE/after/"
cp -r "$R/outreach-p0/backend/services/." "$STAGE/after/services/"
cp -r "$R/owner-ai-recal/backend/services/." "$STAGE/after/services/"
cp "$R/owner-ai-recal/backend/routes/crm.js" "$STAGE/after/routes/crm.js"
cp "$R/owner-ai-recal/backend/cron.js" "$STAGE/after/cron.js"
for d in before after; do
  mkdir -p "$STAGE/$d/ownerai-test/helpers"
  cp "$R/owner-ai-recal/backend/test/helpers/ownerHarness.js" "$STAGE/$d/ownerai-test/helpers/"
  cp "$R/owner-ai-recal/backend/test/ownerAi.runtime.test.js" "$STAGE/$d/ownerai-test/"
  cp "$R/owner-ai-recal/backend/test/ownerQuality.test.js" "$STAGE/$d/ownerai-test/"
done
cp "$R/owner-ai-recal/backend/migrations/20261110_owner_ai_recal.sql" "$STAGE/"
tar -C "$STAGE" -czf - . | ssh -o BatchMode=yes root@178.104.162.193 '
  set -e; rm -rf /tmp/claude-recal && mkdir -p /tmp/claude-recal && tar -xzf - -C /tmp/claude-recal
  docker exec -i argus-outreach-testdb psql -U test -d argus_test -v ON_ERROR_STOP=1 -q < /tmp/claude-recal/20261110_owner_ai_recal.sql
  for L in before after; do
    docker run --rm --network argus-outreach-testnet -v /tmp/claude-recal/$L:/work -w /work -e NODE_PATH=/app/node_modules -e TZ=UTC \
      -e OWNER_AI_LABEL=$L --entrypoint timeout 2906-system-backend 240 node --test --test-concurrency=1 --test-reporter=tap ownerai-test/ownerAi.runtime.test.js \
      > /tmp/claude-recal/$L.tap 2>&1 || true
    echo "== $L: $(grep -E "^# (pass|fail)" /tmp/claude-recal/$L.tap | tr "\n" " ")"
  done
  docker run --rm --network argus-outreach-testnet -v /tmp/claude-recal/after:/work -w /work -e NODE_PATH=/app/node_modules -e TZ=UTC \
    --entrypoint timeout 2906-system-backend 180 node --test --test-concurrency=1 --test-reporter=tap ownerai-test/ownerQuality.test.js > /tmp/claude-recal/quality.tap 2>&1 || true
  echo "== quality: $(grep -E "^# (pass|fail)" /tmp/claude-recal/quality.tap | tr "\n" " ")"'
mkdir -p "$R/owner-ai-recal/evidence/runtime"
for L in before after; do
  scp -q -o BatchMode=yes root@178.104.162.193:/tmp/claude-recal/$L/ownerai-test/out/runtime-$L.json "$R/owner-ai-recal/evidence/runtime/" || echo "no evidence for $L"
  scp -q -o BatchMode=yes root@178.104.162.193:/tmp/claude-recal/$L.tap "$R/owner-ai-recal/evidence/runtime/runtime-$L.tap" || true
done
scp -q -o BatchMode=yes root@178.104.162.193:/tmp/claude-recal/quality.tap "$R/owner-ai-recal/evidence/runtime/quality.tap" || true
rm -rf "$STAGE"
