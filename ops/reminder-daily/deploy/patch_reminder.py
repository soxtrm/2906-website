#!/usr/bin/env python3
"""ARGUS P0 Reminder Due + inbox + Safe Drafts (2026-11-21): anchor patches on the LIVE backend.
usage: patch_reminder.py <backend_dir>   — every anchor must occur exactly once; CRLF kept."""
import sys, os
ROOT = sys.argv[1]
CRON, AV, R7, CRM = 'cron.js', 'services/availability.js', 'services/ownerRecheck7d.js', 'routes/crm.js'

PATCHES = [
# ── cron: plan 09:00 Malta, send every minute 09–19 ─────────────────────────
(CRON, """  // ── Reminder sweep every 30 minutes ───────────────────────────""",
"""  // ── Reminder Due, automatic (Kev, 2026-11-21) ───────────────────────────
  // 09:00 Malta: every reminder due today gets one dispatch record (planned /
  // skipped / waiting with the reason); then every minute until 19:00 the due
  // ones are re-checked and sent with an approved Safe Draft. No backlog.
  cron.schedule('0 9 * * 1-6', async () => {
    try {
      const r = await require('./services/reminderDaily').planDay(new Date())
      log.info('Cron reminder daily plan', { date: r.date, skipped: r.skipped || null, planned: (r.planned || []).length, notSent: (r.skipped || []).length, waiting: (r.waiting || []).length })
      await beatOk('reminder_daily_plan', '09:00 Malta Mon-Sat', 24 * 3600e3, { date: r.date, planned: (r.planned || []).length, skipped: Array.isArray(r.skipped) ? r.skipped.length : r.skipped, waiting: (r.waiting || []).length })
    } catch (err) {
      log.error('Cron reminder daily plan error', err)
      await beatFail('reminder_daily_plan', '09:00 Malta Mon-Sat', 24 * 3600e3, err)
    }
  }, { timezone: 'Europe/Malta' })
  cron.schedule('* 9-19 * * 1-6', async () => {
    try {
      const daily = require('./services/reminderDaily')
      if (new Date().getMinutes() % 15 === 0) await daily.planDay(new Date()).catch(err => log.warn('reminder daily re-plan failed', { err: err.message }))
      const r = await daily.tick(new Date())
      for (const x of (r.results || [])) {
        if (x.state === 'sent') await autoEvents.record({ rule: 'reminder_daily', action: 'owner_message_sent', result: 'success', account: x.session, trigger: 'reminder due', details: { reminder_id: x.reminderId, dispatch_id: x.id } })
        else if (['skipped', 'failed', 'ambiguous', 'waiting'].includes(x.state)) await autoEvents.record({ rule: 'reminder_daily', action: `owner_message_${x.state}`, result: x.state === 'failed' || x.state === 'ambiguous' ? 'failed' : 'skipped', reason: x.reason, trigger: 'reminder due', details: { reminder_id: x.reminderId, dispatch_id: x.id } })
      }
      await beatOk('reminder_daily_send', 'every minute 09-19 Malta Mon-Sat', 60e3, { results: (r.results || []).length, skipped: r.skipped || null })
    } catch (err) {
      log.error('Cron reminder daily send error', err)
      await beatFail('reminder_daily_send', 'every minute 09-19 Malta Mon-Sat', 60e3, err)
    }
  }, { timezone: 'Europe/Malta' })

  // ── Reminder sweep every 30 minutes ───────────────────────────"""),

# ── inbox: decide read/unread 45 s after every owner DM ─────────────────────
(R7, """  try { await noteQuietNegative({ session, chatId, senderPhone, text: t }) } catch (err) { log.debug('[recheck7d] quiet note failed', { err: err.message }) }""",
"""  try { await noteQuietNegative({ session, chatId, senderPhone, text: t }) } catch (err) { log.debug('[recheck7d] quiet note failed', { err: err.message }) }
  // Kev, 2026-11-21: processed, non-actionable answers to OUR question leave the inbox; anything actionable stays unread.
  try { require('./inboxDisposition').onInbound({ session, chatId, senderPhone, text: t, messageId: payload?.id || null }) } catch (err) { log.debug('[inbox] disposition hook failed', { err: err.message }) }"""),

# ── availability: "No" without rented evidence is "not available", no thank-you text ──
(AV, """  // 1. Thank the owner, same account, same chat — after a ~30s human pause, with
  // the 👎 in the same job. An instant "thanks for letting me know" on the
  // second an owner writes "it's rented" is the most-read message in this whole
  // flow and the one that most needs to look typed. See services/humanDelay.js.
  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat,
    text: MSG_OWNER_RENTED_THANKS,
    reactTo: replyMsgId, reactEmoji: '👎',
    label: 'rented_thanks', jobId: `av-human-rented-${check.id}`,
  })""",
"""  // 1. Kev, 2026-11-21: no thank-you text for a "no" — it only adds a message to
  // the chat. A 👍 on the owner's reply acknowledges it; the chat is marked read
  // by inboxDisposition when nothing in the reply needs a person.
  if (replyMsgId) await reactAs(ownerSession, replyMsgId, '👍').catch(() => {})

  // A plain "no" answers "is it still available?" — it is not evidence of a
  // tenancy. Only an explicit rented/let/sold statement goes to "Rented?".
  const said = String(check.reply_text || (await db.query(`SELECT reply_text FROM availability_checks WHERE id=$1`, [check.id])).rows[0]?.reply_text || '')
  const notRentedWords = NEGATED_RENTED.test(said) ? said.replace(NEGATED_RENTED, ' ') : said
  if (!(RENTED_VERB.test(notRentedWords) || BARE_RENT.test(notRentedWords))) {
    const reason = `Owner said not available (no rented statement) — owner said: "${said.trim().replace(/\\s+/g, ' ').slice(0, 160)}"`
    const upd = await db.query(
      `UPDATE properties SET available_status='not_available', status_change_reason=$2, updated_at=NOW()
        WHERE id=$1 AND COALESCE(available_status,'available') NOT IN ('rented','archived') RETURNING id`, [check.property_id, reason])
    if (upd.rows.length) {
      await db.query(`INSERT INTO property_activities (property_id, activity_type, details, is_significant, created_at) VALUES ($1,'owner_said_not_available',$2::jsonb,TRUE,NOW())`,
        [check.property_id, JSON.stringify({ source: 'av_owner_reply', check_id: check.id, owner_reply: said.slice(0, 500), old_status: check.available_status || null, new_status: 'not_available', reason })]).catch(() => {})
    }
    await reactOnRequest(check, '👎')
    await postToRequester(check, `🔴 #${ref} — owner says NOT AVAILABLE (no word of rented). Marked "not available"; nothing else was changed.`)
    log.info('[av] owner said not available — no rented evidence, marked not_available', { checkId: check.id, ref })
    return { applied: !!upd.rows.length, notAvailable: true }
  }"""),
(AV, """        if (!wide.already) {
          await humanDelay.queueOwnerMessage({
            session, chatId, text: MSG_OWNER_NOTHING_AVAILABLE_THANKS,
            reactTo: payload?.id || null, reactEmoji: payload?.id ? '👍' : null,
            label: 'owner_all_unavailable_thanks', jobId: `av-owner-all-unavailable-${wide.ownerId}`,
          }).catch(err => log.warn('[av] owner-wide thanks queue failed', { err: err.message }))
        }""",
"""        // Kev, 2026-11-21: no "thank you" text for "nothing available"; a 👍 only.
        if (!wide.already && payload?.id) await reactAs(session, payload.id, '👍').catch(() => {})"""),

# ── CRM routes: library review, reminder report, inbox decisions ───────────
(CRM, """    res.json({ templates: await require('../services/outreachLibrary').list(persona) })""",
"""    const intent = req.query.intent ? String(req.query.intent) : null
    const status = req.query.status ? String(req.query.status) : null
    res.json({ templates: await require('../services/outreachLibrary').list(persona, { intent, status }) })"""),
(CRM, """router.post('/outreach/library/:id/active', auth, adminOnly, async (req, res) => {""",
"""// Safe Drafts review (Kev, 2026-11-21): pack texts are sendable only once approved here.
router.post('/outreach/library/review', auth, adminOnly, async (req, res) => {
  try {
    res.json({ updated: await require('../services/outreachLibrary').setReview(req.body?.ids || [], String(req.body?.status || ''), req.agent?.username || 'admin') })
  } catch (err) { outreachAutomationError(res, err, 'Failed to review the texts') }
})
// Reminder Due: what the 09:00 run planned, sent, skipped and why (read-only).
router.get('/outreach/reminder-daily', auth, adminOnly, async (req, res) => {
  try {
    const daily = require('../services/reminderDaily')
    const date = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : daily.maltaParts().date
    res.json(await daily.report(date))
  } catch (err) { outreachAutomationError(res, err, 'Failed to read the reminder run') }
})
router.get('/outreach/inbox-dispositions', auth, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const r = await require('../db').query(
      `SELECT id, session, right(phone,4) AS phone_last4, owner_id, left(text,200) AS text, disposition, action, detail, created_at
         FROM owner_inbox_dispositions ORDER BY id DESC LIMIT $1`, [limit])
    res.json({ rows: r.rows })
  } catch (err) { outreachAutomationError(res, err, 'Failed to read inbox decisions') }
})

router.post('/outreach/library/:id/active', auth, adminOnly, async (req, res) => {"""),
(CRM, """  const known = ['account_restricted', 'system_manager_not_outreach', 'invalid_pace', 'unknown_persona', 'invalid_period', 'invalid_slot', 'invalid_length', 'foreign_persona_signature', 'greeting_not_allowed', 'not_found', 'invalid_target']""",
"""  const known = ['account_restricted', 'system_manager_not_outreach', 'invalid_pace', 'unknown_persona', 'invalid_period', 'invalid_slot', 'invalid_length', 'foreign_persona_signature', 'greeting_not_allowed', 'not_found', 'invalid_target', 'invalid_status', 'unknown_placeholder']"""),
]

def main():
    files = {}
    for path, old, new in PATCHES:
        full = os.path.join(ROOT, path)
        if path not in files:
            files[path] = open(full, 'r', encoding='utf-8', newline='').read()
        text = files[path]
        crlf = '\r\n' in text
        o = old.replace('\n', '\r\n') if crlf else old
        n = new.replace('\n', '\r\n') if crlf else new
        c = text.count(o)
        if c != 1:
            print(f'ANCHOR {c}x in {path}: {old[:90]!r}'); sys.exit(1)
        files[path] = text.replace(o, n)
    for path, text in files.items():
        open(os.path.join(ROOT, path), 'w', encoding='utf-8', newline='').write(text)
    print(f'patched {len(PATCHES)} anchors in {len(files)} files')

main()
