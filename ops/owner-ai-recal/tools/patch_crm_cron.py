"""Add Owner Conversation Quality routes to the P0 routes/crm.js (CRLF) and the
weekly tick to the P0 cron.js. Exact-match, CRLF-safe (newline='').
usage: python -I patch_crm_cron.py <p0_backend_dir> <out_backend_dir>
"""
import os, sys

src, dst = sys.argv[1], sys.argv[2]

def load(rel):
    return open(os.path.join(src, rel), 'r', encoding='utf-8', newline='').read()

def save(rel, s):
    p = os.path.join(dst, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf-8', newline='').write(s)

# ── routes/crm.js ──────────────────────────────────────────────────────────
crm = load('routes/crm.js')
assert crm.count('\r\n') > 1000, 'expected CRLF crm.js'
tail = 'module.exports = router\r\n'
assert crm.endswith(tail) and crm.count(tail) == 1
block = r"""
// ── Owner Conversation Quality (Claude, 2026-11-10, Owner AI recalibration) ──
// Admin only. Weekly reports are immutable; reviews are append-only and turn
// approved corrections into fixture candidates for the NEXT release. Nothing
// here changes live reply behaviour, templates or Auto settings.
const ownerQuality = () => require('../services/ownerQualityReport')
const qualityError = (res, err, fallback) => {
  const status = err && err.status ? err.status : 500
  if (status >= 500) log.error(fallback, err)
  res.status(status).json({ error: status >= 500 ? fallback : err.message })
}

router.get('/owner-quality/reports', auth, adminOnly, async (req, res) => {
  try { res.json(await ownerQuality().list(Math.min(Number(req.query.limit) || 20, 100))) } catch (err) { qualityError(res, err, 'Failed to load quality reports') }
})

router.post('/owner-quality/reports', auth, adminOnly, async (req, res) => {
  try {
    const out = await ownerQuality().generate({ now: new Date(), trigger: 'manual', createdBy: req.agent?.username || 'admin' })
    res.json({ ok: true, id: out.id, digest: out.digest })
  } catch (err) { qualityError(res, err, 'Failed to generate the quality report') }
})

router.get('/owner-quality/reports/:id', auth, adminOnly, async (req, res) => {
  try {
    const r = await ownerQuality().get(String(req.params.id))
    if (!r) return res.status(404).json({ error: 'report not found' })
    res.json(r)
  } catch (err) { qualityError(res, err, 'Failed to load the quality report') }
})

router.get('/owner-quality/reports/:id/export', auth, adminOnly, async (req, res) => {
  try {
    const r = await ownerQuality().get(String(req.params.id))
    if (!r) return res.status(404).json({ error: 'report not found' })
    res.setHeader('Content-Disposition', `attachment; filename="owner-ai-quality-${r.period_from instanceof Date ? r.period_from.toISOString().slice(0, 10) : String(r.period_from).slice(0, 10)}-anonymised.json"`)
    res.json(ownerQuality().exportable(r))
  } catch (err) { qualityError(res, err, 'Failed to export the quality report') }
})

router.post('/owner-quality/reports/:id/cases/:caseId/review', auth, adminOnly, async (req, res) => {
  try {
    res.json(await ownerQuality().review(String(req.params.id), String(req.params.caseId), {
      decision: req.body?.decision, correctedAction: req.body?.correctedAction || null,
      correctedReply: req.body?.correctedReply || null, note: req.body?.note || null,
    }, req.agent?.username || 'admin'))
  } catch (err) { qualityError(res, err, 'Failed to save the review') }
})

// Full evidence for one case, behind admin auth only (never exported).
router.get('/owner-quality/conversations/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (!id) return res.status(400).json({ error: 'valid id required' })
    const r = await db.query(`SELECT id, session, status, cancelled_reason, created_at, updated_at, checklist FROM owner_auto_conversations WHERE id=$1`, [id])
    if (!r.rows[0]) return res.status(404).json({ error: 'conversation not found' })
    const c = r.rows[0]
    const log_ = ((c.checklist && c.checklist._log) || []).slice(-30)
    const keep = ['price', 'previous_price', 'bedrooms', 'bathrooms', 'town', 'available_date', 'property_category', 'listing_kind', 'property_subtype', 'transaction_type', 'availability_status', 'viewing_status', 'pets', 'sharing', '_owner_ai_facts', '_owner_ai_provenance']
    const decisions = (await db.query(`SELECT created_at, next_action, reason_code, fact_mutations, draft_reply, sent, block_reason, policy_version, release, intent FROM owner_ai_decisions WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]).catch(() => ({ rows: [] }))).rows
    res.json({ id: c.id, session: c.session, status: c.status, reason: c.cancelled_reason, created_at: c.created_at, updated_at: c.updated_at,
      stored_facts: Object.fromEntries(keep.filter(k => c.checklist && c.checklist[k] != null).map(k => [k, c.checklist[k]])), log: log_, decisions })
  } catch (err) { qualityError(res, err, 'Failed to load the conversation evidence') }
})

router.get('/owner-quality/decisions', auth, adminOnly, async (req, res) => {
  try {
    const r = await db.query(`SELECT id, created_at, conversation_id, session, persona, inbound_redacted, next_action, reason_code, fact_mutations, draft_reply, send_eligible, sent, block_reason, policy_version, intent FROM owner_ai_decisions ORDER BY created_at DESC LIMIT $1`, [Math.min(Number(req.query.limit) || 50, 200)])
    res.json({ decisions: r.rows })
  } catch (err) { qualityError(res, err, 'Failed to load owner AI decisions') }
})

router.post('/owner-quality/incidents/:id/resolve', auth, adminOnly, async (req, res) => {
  try {
    const r = await db.query(`UPDATE owner_ai_quality_incidents SET resolved_at=NOW(), resolved_by=$2 WHERE id=$1 AND resolved_at IS NULL RETURNING id`, [Number(req.params.id), req.agent?.username || 'admin'])
    res.json({ ok: !!r.rows.length })
  } catch (err) { qualityError(res, err, 'Failed to resolve the incident') }
})

"""
crm = crm[:-len(tail)] + block.replace('\n', '\r\n').lstrip('\r\n') + '\r\n' + tail
assert "require('../db')" in crm or 'const db = ' in crm, 'crm.js must already have db'
save('routes/crm.js', crm)

# ── cron.js (mixed endings: insert with the line ending used at the anchor) ──
cron = load('cron.js')
anchor = "  // Property Source Sync (Claude, 2026-11-09). Hourly look for DUE sources only:"
assert cron.count(anchor) == 1
i = cron.index(anchor)
eol = '\r\n' if cron[i - 2:i] == '\r\n' else '\n'
tick = eol.join([
    "  // Owner Conversation Quality (Claude, 2026-11-10): weekly report Monday",
    "  // 08:30 Europe/Malta from a persisted schedule row (survives restarts) and a",
    "  // P0 incident scan every 10 minutes. Read-only over conversations; never sends.",
    "  cron.schedule('* * * * *', async () => {",
    "    try {",
    "      const r = await require('./services/ownerQualityReport').tick(new Date())",
    "      if (r && r.ran) log.info('Cron: owner quality report generated', { id: r.id, next: r.next })",
    "    } catch (err) {",
    "      log.error('Cron owner-quality error', err)",
    "    }",
    "  })",
    "",
])
cron = cron[:i] + tick + cron[i:]
save('cron.js', cron)
print('patched crm.js and cron.js')
