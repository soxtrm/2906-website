#!/usr/bin/env bash
# WhatsApp connect from the profile, second way in: a code typed into WhatsApp ("Link with phone
# number instead"). An agent who has ARGUS open on the phone cannot scan a QR on that same screen.
# Adds waha.requestPairingCode() and POST /api/crm/agent-profile/:id/whatsapp/pair-code. Nothing
# existing changes. Exact-anchor edit, backup, syntax check, restart, auto-rollback.
#   bash apply.sh            apply
#   bash apply.sh rollback <backup dir>
set -euo pipefail
LIVE=/opt/2906-system/backend; CT=2906_backend
up() { for i in $(seq 1 45); do [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
if [ "${1:-}" = rollback ]; then
  BK=${2:?backup dir}; cp -p "$BK/waha.js" "$LIVE/waha.js"; cp -p "$BK/crmAgentProfile.js" "$LIVE/routes/crmAgentProfile.js"
  docker restart "$CT" >/dev/null; up && echo "ROLLED BACK, backend up" || { echo "backend did not come up"; exit 1; }; exit 0
fi
TS=$(date -u +%Y%m%dT%H%M%SZ); BK=/opt/2906-system/backups/whatsapp-pair-code-$TS; mkdir -p "$BK"
cp -p "$LIVE/waha.js" "$BK/waha.js"; cp -p "$LIVE/routes/crmAgentProfile.js" "$BK/crmAgentProfile.js"; echo "backup: $BK"
restore() { echo "ROLLING BACK"; cp -p "$BK/waha.js" "$LIVE/waha.js"; cp -p "$BK/crmAgentProfile.js" "$LIVE/routes/crmAgentProfile.js"; docker restart "$CT" >/dev/null; }
python3 - "$LIVE/waha.js" "$LIVE/routes/crmAgentProfile.js" <<'PY' || { cp -p "$BK/waha.js" "$LIVE/waha.js"; cp -p "$BK/crmAgentProfile.js" "$LIVE/routes/crmAgentProfile.js"; echo "nothing changed"; exit 1; }
import sys
waha_p, route_p = sys.argv[1], sys.argv[2]
waha = open(waha_p, 'rb').read(); route = open(route_p, 'rb').read()
if b'requestPairingCode' in waha or b'whatsapp/pair-code' in route: print('REFUSE: already applied'); sys.exit(1)

def once(raw, anchor, what):
    n = raw.count(anchor)
    if n != 1: print('REFUSE: %s anchor found %dx' % (what, n)); sys.exit(1)

def eol(raw): return b'\r\n' if b'\r\n' in raw else b'\n'

FUNC = b"""// Link with a code instead of the QR (WhatsApp: Linked devices -> Link a device -> Link with
// phone number instead). The session has to be waiting for a link (SCAN_QR_CODE). The code
// is returned to the caller only; neither it nor the number is logged here.
async function requestPairingCode(session, phoneNumber) {
  const res = await wahaRequest('POST', `/api/${session}/auth/request-code`, { phoneNumber })
  const code = res && res.code ? String(res.code) : ''
  if (!code) throw new Error('WAHA returned no pairing code')
  return code
}

"""
a1 = b'// Idempotent create-or-resume for a deterministic per-Agent session name'
a2 = b'  getQrImage, ensureAgentSession, stopSession,'
once(waha, a1, 'waha function'); once(waha, a2, 'waha export')
waha = waha.replace(a1, FUNC.replace(b'\n', eol(waha)) + a1).replace(a2, b'  getQrImage, ensureAgentSession, stopSession, requestPairingCode,')

ROUTE = b"""// Same connect, without a QR: returns a code the agent types into WhatsApp. Made for the phone,
// where the QR would be on the very screen that has to scan it. The number comes from the form
// and is only handed to WAHA; nothing is stored or logged here.
router.post('/:id/whatsapp/pair-code', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const phone = String((req.body && req.body.phone) || '').replace(/\\D/g, '')
    if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'Enter your WhatsApp number with the country code, for example 356 9912 3456.' })
    const agentR = await db.query(`SELECT whatsapp_session FROM agents WHERE id = $1`, [id])
    if (!agentR.rows[0]) return res.status(404).json({ error: 'Agent not found' })
    const session = agentR.rows[0].whatsapp_session || agentSessionName(id)
    if (agentR.rows[0].whatsapp_session !== session) {
      await db.query(`UPDATE agents SET whatsapp_session = $1, updated_at = NOW() WHERE id = $2`, [session, id])
    }

    await waha.ensureAgentSession(session)
    let whatsapp = await liveWhatsappState(session)
    for (let i = 0; i < 12 && whatsapp.status !== 'QR_REQUIRED' && whatsapp.status !== 'CONNECTED'; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      whatsapp = await liveWhatsappState(session)
    }
    if (whatsapp.status === 'CONNECTED') return res.json(whatsapp)
    if (whatsapp.status !== 'QR_REQUIRED') return res.status(503).json({ error: 'WhatsApp is still starting. Wait a few seconds and try again.' })
    try {
      whatsapp.code = await waha.requestPairingCode(session, phone)
    } catch (err) {
      log.warn('agent whatsapp pair-code: request failed', { session, err: err.message })
      return res.status(502).json({ error: 'WhatsApp did not give a code for this number. Check the number, or use the QR code.' })
    }
    await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type, details)
         VALUES ($1,$2,'WA_PAIR_CODE_REQUESTED',$3)`,
      [req.agent.id, req.agent.role, JSON.stringify({ session })])
    res.json(whatsapp)
  } catch (err) {
    log.error('agent whatsapp pair-code failed', { err: err.message })
    res.status(500).json({ error: 'WhatsApp could not be started. Try again.' })
  }
})

"""
a3 = b"router.post('/:id/whatsapp/disconnect', auth, async (req, res) => {"
once(route, a3, 'route')
route = route.replace(a3, ROUTE.replace(b'\n', eol(route)) + a3)
open(waha_p, 'wb').write(waha); open(route_p, 'wb').write(route); print('patched')
PY
for f in waha.js routes/crmAgentProfile.js; do
  docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }
done
docker restart "$CT" >/dev/null
up || { echo "backend did not come up"; restore; exit 1; }
sleep 4
if docker logs --since 1m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
echo "APPLIED, backend up. Rollback: bash $0 rollback $BK"
