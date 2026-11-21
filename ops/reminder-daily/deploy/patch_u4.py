#!/usr/bin/env python3
"""Owner conversation recovery, update 4 (Kev, 2026-11-21): one reply per owner turn at the two
send chokepoints, early turn decision, recheck step timing, 21-day no-stock cadence, CRM reports.
usage: patch_u4.py <backend_dir>  — anchors on the live files after update 3; every anchor exactly once."""
import sys, os
ROOT = sys.argv[1]
WAHA, AV, R7, SCOPE, COOL, HOOK, CRM = ('waha.js', 'services/availability.js', 'services/ownerRecheck7d.js', 'services/ownerScopeReply.js',
                                         'services/cooldownRules.js', 'routes/webhook.js', 'routes/crm.js')
PATCHES = [
# ── waha.sendText: turn guard + send-time wording for automated replies ─────
(WAHA, """  await require('./services/outreachIdentity').assertOutboundIdentity(session, chatId, text)
  log.debug('Sending message via WAHA'""",
"""  await require('./services/outreachIdentity').assertOutboundIdentity(session, chatId, text)
  // Kev, 2026-11-21: one owner turn → at most one automated reply (services/ownerTurnGuard.js)
  const _turn = await require('./services/ownerTurnGuard').check(session, chatId, text).catch(() => ({ allow: true }))
  if (!_turn.allow) return { blocked: true, reason: _turn.reason }
  // automated replies get the wording of the moment they are sent ("have a good evening" at 09:55 was wrong)
  if (_turn.automated) text = require('./services/timeGreeting').fixForSend(chatId, text)
  log.debug('Sending message via WAHA'"""),
(WAHA, """  const result = await wahaRequest('POST', '/api/sendText', body,
    timeoutMs ? { timeoutMs } : undefined)""",
"""  const result = await wahaRequest('POST', '/api/sendText', body,
    timeoutMs ? { timeoutMs } : undefined)
  require('./services/ownerTurnGuard').noteSent(session, chatId).catch(() => {})"""),
(WAHA, """async function sendSeen(session, chatId) {""",
"""// Read receipt with its outcome: { api: 'accepted' | 'error', error }. Accepted means WAHA took
// the request; GOWS has no unread counter, so the phone's own state is not observable.
async function sendSeenChecked(session, chatId) {
  try { await wahaRequest('POST', '/api/sendSeen', { session, chatId }); return { api: 'accepted', at: new Date().toISOString() } }
  catch (err) { return { api: 'error', error: String(err.message || err).slice(0, 200) } }
}

async function sendSeen(session, chatId) {"""),
(WAHA, """module.exports = { sendText, sendImage, sendVideo, sendFile, sendReaction, deleteMessage, sendSeen, markChatUnread,""",
 """module.exports = { sendText, sendImage, sendVideo, sendFile, sendReaction, deleteMessage, sendSeen, sendSeenChecked, markChatUnread,"""),
# ── availability.sendTextAs / reactAs: same guard (this path bypasses waha.sendText) ──
(AV, """  await require('./outreachIdentity').assertOutboundIdentity(session, body.chatId, text)
  let res
  try {
    res = await wahaFetch('POST', '/api/sendText', body)""",
"""  await require('./outreachIdentity').assertOutboundIdentity(session, body.chatId, text)
  const _turn = await require('./ownerTurnGuard').check(session, body.chatId, text).catch(() => ({ allow: true }))
  if (!_turn.allow) return { blocked: true, reason: _turn.reason }
  let res
  try {
    res = await wahaFetch('POST', '/api/sendText', body)"""),
(AV, """  try { require('./contactTouch').recordOutbound(body.chatId, body.session).catch(() => {}) } catch { /* non-fatal */ }
  return res
}""",
"""  try { require('./contactTouch').recordOutbound(body.chatId, body.session).catch(() => {}) } catch { /* non-fatal */ }
  require('./ownerTurnGuard').noteSent(body.session, body.chatId).catch(() => {})
  return res
}"""),
(AV, """async function reactAs(session, messageId, emoji) {
  if (!session || !messageId) return false""",
"""async function reactAs(session, messageId, emoji) {
  if (!session || !messageId) return false
  if (!(await require('./ownerTurnGuard').reactionAllowed(session, messageId).catch(() => true))) {
    log.info('[av] reaction skipped — owner turn is final', { session, msg: String(messageId).slice(-24) })
    return false
  }"""),
# ── webhook: the turn decision happens BEFORE any handler can reply ─────────
(HOOK, """    // ── !av / !avstatus (isolated, additive — see services/availability.js) ────""",
"""    // Kev, 2026-11-21: ONE owner turn = ONE decision, taken before availability.js,
    // ownerRecheck7d, autoOwnerConversation or any other handler can reply. The turn
    // guard in waha.sendText / availability.sendTextAs enforces it on every send.
    let _turn = { final: false }
    if (!isGroup && !payload.fromMe && phone && (text || _payloadHasMedia)) {
      try {
        if (text) _turn = await require('../services/inboxDisposition').finalTurn({ phone, session, text })
        await require('../services/ownerTurnGuard').noteInbound({ session, phone, chatId: payload.from, final: _turn.final === true })
      } catch (e) { log.warn('owner turn bookkeeping failed', { err: e.message }) }
    }

    // ── !av / !avstatus (isolated, additive — see services/availability.js) ────"""),
(HOOK, """      try { _finalTurn = (await require('../services/inboxDisposition').finalTurn({ phone, session, text })).final === true }""",
"""      try { _finalTurn = _turn.final === true }"""),
# ── weekly recheck: a message written before our next question went out is not its answer ──
(R7, """  await db.query(`UPDATE owner_recheck_threads SET stage='asked_viewings', confirmed_ids=$2, step_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id, confirmedIds])
  await queueReply({ ...thread, session: live }, VIEWINGS_TEXT, replyTo, 'viewings')""",
"""  await db.query(`UPDATE owner_recheck_threads SET stage='asked_viewings', confirmed_ids=$2, step_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id, confirmedIds])
  const _q = await queueReply({ ...thread, session: live }, VIEWINGS_TEXT, replyTo, 'viewings')
  // step_at = when the question actually goes out (Kev, 2026-11-21, Raymond Psaila)
  await db.query(`UPDATE owner_recheck_threads SET step_at = NOW() + make_interval(secs => $2) WHERE id=$1`, [thread.id, Math.round((_q?.delayMs || 0) / 1000)])"""),
(R7, """  await db.query(`UPDATE owner_recheck_threads SET stage='asked_terms', step_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
  await queueReply(thread, mood === 'many' ? PITCH_MANY : PITCH_FEW, replyTo, 'pitch')""",
"""  await db.query(`UPDATE owner_recheck_threads SET stage='asked_terms', step_at=NOW(), updated_at=NOW() WHERE id=$1`, [thread.id])
  const _q = await queueReply(thread, mood === 'many' ? PITCH_MANY : PITCH_FEW, replyTo, 'pitch')
  await db.query(`UPDATE owner_recheck_threads SET step_at = NOW() + make_interval(secs => $2) WHERE id=$1`, [thread.id, Math.round((_q?.delayMs || 0) / 1000)])"""),
(R7, """  thread.session = (await liveName(thread.session)) || session
""",
"""  thread.session = (await liveName(thread.session)) || session
  // Kev, 2026-11-21 (Raymond Psaila): the owner's "yes" arrived while our viewings question
  // was still queued, and was read as the answer to it → pitch → every later reply one step off.
  // A message written BEFORE our next question went out belongs to the previous turn.
  if (['asked_viewings', 'asked_terms'].includes(thread.stage) && thread.step_at && new Date(thread.step_at) > new Date()) {
    await event(thread.id, 'MESSAGE_BEFORE_QUESTION_SENT', { stage: thread.stage, reply: t.slice(0, 300) })
    const informative = /\\d|€|\\?/.test(t) || t.length > 60
    return { handled: !informative, reason: 'before_question_sent' }
  }
"""),
# ── 21-day no-stock cadence (was 180 days, and outreach did not even read it) ──
(SCOPE, """const PAUSE_DAYS = 180""", """const PAUSE_DAYS = 21 // Kev, 2026-11-21: owners without current stock are reconsidered after 21 days"""),
(COOL, """  const cooldownMs = RULES.SAME_ACCOUNT_DAYS * 86400 * 1000""",
"""  // Kev, 2026-11-21: an owner who told us there is nothing now, will let us know, or asked for a
  // later date is not written to by ANY account before that date (21-day cadence; callback dates first).
  if (contact.owner_contact_paused_until && new Date(contact.owner_contact_paused_until) > new Date()) {
    return { allowed: false, reason: `owner_paused_until_${new Date(contact.owner_contact_paused_until).toISOString().slice(0, 10)}` }
  }

  const cooldownMs = RULES.SAME_ACCOUNT_DAYS * 86400 * 1000"""),
# ── CRM: next-run preview, backlog report, reply-guard log ─────────────────
(CRM, """router.get('/outreach/inbox-dispositions', auth, adminOnly, async (req, res) => {""",
"""router.get('/outreach/reminder-daily/preview', auth, adminOnly, async (req, res) => {
  try { res.json(await require('../services/reminderDaily').preview(req.query.date ? String(req.query.date) : null)) }
  catch (err) { outreachAutomationError(res, err, 'Failed to preview the next reminder run') }
})
router.get('/outreach/reminder-backlog', auth, adminOnly, async (req, res) => {
  try { res.json(await require('../services/reminderBacklog').report()) }
  catch (err) { outreachAutomationError(res, err, 'Failed to build the reminder backlog report') }
})
router.get('/outreach/reply-guard', auth, adminOnly, async (req, res) => {
  try {
    const r = await require('../db').query(
      `SELECT id, session, right(regexp_replace(chat_id,'\\\\D','','g'),4) AS chat_last4, module, reason, left(text,160) AS text, created_at
         FROM owner_reply_guard_events ORDER BY id DESC LIMIT 60`)
    res.json({ rows: r.rows })
  } catch (err) { outreachAutomationError(res, err, 'Failed to read the reply guard') }
})
router.get('/outreach/inbox-dispositions', auth, adminOnly, async (req, res) => {"""),
]

def main():
    files = {}
    for path, old, new in PATCHES:
        full = os.path.join(ROOT, path)
        if path not in files:
            files[path] = open(full, 'r', encoding='utf-8', newline='').read()
        t = files[path]
        crlf = '\r\n' in t
        o = old.replace('\n', '\r\n') if crlf else old
        n = new.replace('\n', '\r\n') if crlf else new
        c = t.count(o)
        if c != 1:
            sys.stdout.write(f'ANCHOR {c}x in {path}: {old[:80]!r}\n'.encode('ascii', 'replace').decode()); sys.exit(1)
        files[path] = t.replace(o, n)
    for path, t in files.items():
        open(os.path.join(ROOT, path), 'w', encoding='utf-8', newline='').write(t)
    print(f'patched {len(PATCHES)} anchors in {len(files)} files')

main()
