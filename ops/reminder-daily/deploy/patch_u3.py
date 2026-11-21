#!/usr/bin/env python3
"""Reminder/inbox update 3 (Kev, 2026-11-21): one decision per owner turn, context-specific "No",
no reactions/thank-you, read only after save. Anchor patches on the CURRENT live files (after update 1).
usage: patch_u3.py <backend_dir>"""
import sys, os
ROOT = sys.argv[1]
AV, SCOPE, R7, HOOK = 'services/availability.js', 'services/ownerScopeReply.js', 'services/ownerRecheck7d.js', 'routes/webhook.js'

PATCHES = [
# ── classifyReply reads the reply through the question that was asked ──────
(AV, """  const raw = String(text || '').trim()
  if (!raw) return { status: 'unclear' }

  // "tenant until September\"""",
"""  const raw = String(text || '').trim()
  if (!raw) return { status: 'unclear' }

  // Kev, 2026-11-21: "No, nothing ELSE available" talks about the owner's OTHER
  // properties — it says nothing about this listing, so it never changes it and
  // never triggers a second question. "No, this apartment is unavailable" does.
  if (/\\b(?:nothing|anything|none)\\s+else\\b|\\bno\\s+other\\b|\\bnothing\\s+more\\b/i.test(raw)
      && !/\\b(?:this|that|the)\\s+(?:one|apartment|flat|property|place|house|penthouse|maisonette|studio|unit)\\b|\\bit(?:'s|\\s+is|\\s+has|\\s+was)\\b/i.test(raw)) {
    return { status: 'replied_other' }
  }

  // "tenant until September\""""),
(AV, """const NEGATED_AVAILABILITY =
  /\\b(?:no longer|not|isn'?t|is not|nt)""",
"""const NEGATED_AVAILABILITY =
  /\\bunavailable\\b|\\b(?:no longer|not|isn'?t|is not|nt)"""),
(AV, """  if (UNCLEAR_TRIGGERS.test(t)) return { status: 'replied_unclear' }""",
"""  // A plain "No" / "sorry, not at the moment" that answers OUR "is it still available?"
  // is a no for this listing — no clarifying question. It is not evidence of a tenancy:
  // onRented marks it "not available", only an explicit rented statement goes to "Rented?".
  if (neg && !pos && require('./inboxDisposition').decide(raw).kind === 'quiet_no') return { status: 'replied_no', quiet: true }
  if (UNCLEAR_TRIGGERS.test(t)) return { status: 'replied_unclear' }"""),
(AV, """  if (verdict.status === 'unclear' || verdict.status === 'replied_unclear') {""",
"""  if (verdict.status === 'replied_other') {
    await db.query(
      `UPDATE availability_checks SET reply_text = $2, reply_message_id = $3, reply_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [check.id, String(text).slice(0, 2000), payload?.id || null])
    log.info('[av] owner spoke about other properties only — this listing unchanged, no follow-up question', { checkId: check.id, ref: check.ref })
    return
  }
  if (verdict.status === 'unclear' || verdict.status === 'replied_unclear') {"""),
# no WhatsApp reaction on a plain "no" either
(AV, """  if (replyMsgId) await reactAs(ownerSession, replyMsgId, '👍').catch(() => {})""",
"""  // (no reaction either — Kev, 2026-11-21: nothing is sent back for a plain answer)"""),
(AV, """        if (!wide.already && payload?.id) await reactAs(session, payload.id, '👍').catch(() => {})""",
"""        // (no reaction either — Kev, 2026-11-21)"""),
# "No, contact me in January": the callback is saved; nothing is sent back to the owner
(AV, """  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: check.owner_chat_id,
    reactTo: replyMsgId, reactEmoji: '👍',
    label: 'coming_soon_ack', jobId: `av-human-soon-${check.id}`,
  })""",
"""  const ownerCallback = require('./inboxDisposition').decide(replyText || check.reply_text || '').kind === 'no_with_callback'
  if (!ownerCallback) await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: check.owner_chat_id,
    reactTo: replyMsgId, reactEmoji: '👍',
    label: 'coming_soon_ack', jobId: `av-human-soon-${check.id}`,
  })"""),
(AV, """  if (SOON_NOTE_TARGET === 'requester') await postToRequester(check, `🟡 #${ref} — ${note}`)
  else {""", """  if (SOON_NOTE_TARGET === 'requester' || ownerCallback) await postToRequester(check, `🟡 #${ref} — ${note}`)
  else {"""),
# "nothing else" is never an owner-wide "all rented"
(SCOPE, """  if (!raw || raw.length > 400) return { scope: null }""",
"""  if (!raw || raw.length > 400) return { scope: null }
  // Kev, 2026-11-21: "nothing ELSE available" is about other properties, never "all my listings are gone"
  if (/\\b(?:nothing|anything|none)\\s+else\\b|\\bno\\s+other\\b|\\bnothing\\s+more\\b/i.test(raw)) return { scope: null, reason: 'about_other_properties' }"""),
# read only after the answer is saved (inboxDisposition), not 20 s after it arrived
(R7, """  if (isQuietNegative(text)) {
    for (const k of keys) await redis.set(k, '1', 'EX', 6 * 3600).catch(() => {})
    const waha = require('../waha')
    setTimeout(() => { waha.sendSeen(session, chatId).catch?.(() => {}) }, 20_000)
    return true
  }""",
"""  // Kev, 2026-11-21: a quiet "no" is marked read by inboxDisposition once the answer is saved.
  if (isQuietNegative(text)) return true"""),
# one authoritative decision per owner turn: no AI / OG-1 reply after a final "No"
(HOOK, """    // ── ARGUS dynamic facts (2026-09-23, services/ownerFactEngine.js) ────────""",
"""    // Kev, 2026-11-21: ONE decision per owner turn. A plain "No", "No, contact me in
    // January" or "stop" that answers our own question is final: no AI reply, no OG-1
    // reply, no second bot message. Actionable messages are not final.
    let _finalTurn = false
    if (!isGroup && !payload.fromMe && phone && text) {
      try { _finalTurn = (await require('../services/inboxDisposition').finalTurn({ phone, session, text })).final === true }
      catch (e) { log.warn('inbox final-turn check failed', { err: e.message }) }
    }

    // ── ARGUS dynamic facts (2026-09-23, services/ownerFactEngine.js) ────────"""),
(HOOK, """if (!isGroup && !payload.fromMe && phone && (text || _payloadHasMedia) && !intelligenceOutcome?.suppressAutomation) {""",
"""if (!isGroup && !payload.fromMe && phone && (text || _payloadHasMedia) && !intelligenceOutcome?.suppressAutomation && !_finalTurn) {"""),
(HOOK, """if (!isGroup && !payload.fromMe && (text || _payloadHasMedia) && !intelligenceOutcome?.suppressAutomation) {""",
"""if (!isGroup && !payload.fromMe && (text || _payloadHasMedia) && !intelligenceOutcome?.suppressAutomation && !_finalTurn) {"""),
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
            sys.stdout.write(f'ANCHOR {c}x in {path}: {old[:80]!r}\n'.encode('ascii', 'replace').decode()); sys.exit(1)
        files[path] = text.replace(o, n)
    for path, text in files.items():
        open(os.path.join(ROOT, path), 'w', encoding='utf-8', newline='').write(text)
    print(f'patched {len(PATCHES)} anchors in {len(files)} files')

main()
