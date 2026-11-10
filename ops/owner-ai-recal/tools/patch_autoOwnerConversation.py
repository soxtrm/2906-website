"""Patch production autoOwnerConversation.js (md5 0134df18...) for the 2026-11-10
Owner AI recalibration. Every replacement must match exactly once, else abort.
usage: python -I patch_autoOwnerConversation.py <src> <dst>
"""
import hashlib, sys

src, dst = sys.argv[1], sys.argv[2]
raw = open(src, 'rb').read()
assert hashlib.md5(raw).hexdigest().startswith('0134df18'), 'unexpected production base'
s = raw.decode('utf-8')

def rep(old, new, count=1):
    global s
    n = s.count(old)
    assert n == count, f'expected {count} match(es), found {n}: {old[:90]!r}'
    s = s.replace(old, new)

# 0. imports
rep("const { looksLikeFutureAvailability, ownerIntakeStopDecision } = require('./ownerConversationStopRules')",
    "const { looksLikeFutureAvailability, ownerIntakeStopDecision } = require('./ownerConversationStopRules')\n"
    "// Owner AI recalibration (Claude, 2026-11-10): deterministic decision layer first.\n"
    "const ownerDecisionRuntime = require('./ownerDecisionRuntime')\n"
    "const { insideWindow: insideOwnerReplyWindow, nextWindowOpen: nextOwnerReplyWindow } = require('./ownerDecision')")

# 1. never pitch subletting (S09/S14: 'One last question, sorry for the spam' + subletting companies)
rep("const OPTIONAL_FIELDS = ['photos', 'map', 'pets', 'sharing', 'subletting']",
    "// 2026-11-10 recalibration: the subletting pitch is retired (founder casebook S09/S14).\n"
    "const OPTIONAL_FIELDS = ['photos', 'map', 'pets', 'sharing']")

# 2. ontology guards: a room is already shared; residential never gets the commercial permit interview
rep("""function mustFieldsFor(checklist) {""",
"""// 2026-11-10 recalibration: what the owner actually said in THIS conversation.
function ownerSaidText(checklist) {
  return ((checklist && checklist._log) || []).filter(e => e && e.from === 'owner').map(e => String(e.text || ''))
    .concat(((checklist && checklist._pending) || []).map(String)).join('\\n')
}
const RESIDENTIAL_EVIDENCE_RE = /\\b(?:bed(?:room)?s?|bath(?:room)?s?|apartment|flat|villa|bungalow|maisonette|penthouse|studio|townhouse|house|residential|duplex)\\b/i
const COMMERCIAL_LISTING_RE = /\\b(?:commercial|office\\s+space|shop|retail|warehouse|showroom|industrial|store\\s+room|catering|restaurant|class\\s+\\d)\\b/i
function isCommercialChecklist(checklist) {
  if (checklist?.property_category !== 'commercial') return false
  const said = ownerSaidText(checklist)
  // A home with a garage/pool/office corner is still a home (bungalow 6340, villa 5275).
  if (RESIDENTIAL_EVIDENCE_RE.test(said) && !COMMERCIAL_LISTING_RE.test(said)) return false
  return true
}
function isStudioChecklist(checklist) {
  return checklist?.property_subtype === 'studio' || /\\bstudio\\b/i.test(ownerSaidText(checklist)) && !/\\bwas\\s+(?:a\\s+)?studio\\b/i.test(ownerSaidText(checklist))
}

function mustFieldsFor(checklist) {""")
rep("""  if (checklist?.listing_kind === 'room') return ROOM_MUST_FIELDS
  if (checklist?.property_category === 'commercial') return COMMERCIAL_MUST_FIELDS
  if (checklist?.transaction_type === 'sale') return SALE_MUST_FIELDS
  return MUST_FIELDS
}""",
"""  if (checklist?.listing_kind === 'room') return ROOM_MUST_FIELDS
  if (isCommercialChecklist(checklist)) return COMMERCIAL_MUST_FIELDS
  if (checklist?.transaction_type === 'sale') return SALE_MUST_FIELDS
  // A studio has no separate bedroom: never ask "how many bedrooms" (S08/S12/S13).
  if (isStudioChecklist(checklist)) return MUST_FIELDS.filter(f => f !== 'bedrooms')
  return MUST_FIELDS
}""")
rep("""  if (checklist?.listing_kind === 'room') return [...ROOM_MUST_FIELDS, 'photos', 'map', 'pets', 'sharing']
  if (checklist?.property_category === 'commercial') return [...COMMERCIAL_MUST_FIELDS, 'size_sqm', 'photos', 'plans', 'map']""",
"""  // A room in a shared flat is ALREADY shared: no professional-sharing question (S10/S11).
  if (checklist?.listing_kind === 'room') return [...ROOM_MUST_FIELDS, 'photos', 'map', 'pets']
  if (isCommercialChecklist(checklist)) return [...COMMERCIAL_MUST_FIELDS, 'size_sqm', 'photos', 'plans', 'map']""")
rep("""function sharingEligible(checklist) {
  return Number(checklist.bedrooms) !== 1
}""",
"""function sharingEligible(checklist) {
  if (checklist.listing_kind === 'room' || checklist.sharing === 'existing_shared' || isStudioChecklist(checklist)) return false
  return Number(checklist.bedrooms) !== 1
}""")

# 3. truthful canned texts
rep("""const FALL3_NEEDS_HUMAN_TEXT =
  'Thank you for your feedback, I am currently on appointments, I will be coming back later to you'""",
"""// 2026-11-10 recalibration: an automated persona must never invent the
// agent's whereabouts ("on appointments", S09). Truthful handoff instead.
const FALL3_NEEDS_HUMAN_TEXT =
  `Thank you — I'll pass this to the agent handling it, who will get back to you personally.`""")
rep("""        ? "Sorry, I couldn't open that file on my end — could you resend it, or just tell me the details directly (bedrooms, bathrooms, price, availability)?\"""",
    """        ? "Sorry, I couldn't open that file on my end — could you resend it when you have a moment?\"""")

# 4. video is media, not a document (it triggered 'couldn't open that file' + re-asked known facts)
rep("""  const isImage = !!mediaMimeType && String(mediaMimeType).startsWith('image/')
  const mediaSentinel = isVoiceNote
    ? '[voice]'
    : (mediaMimeType && !isImage ? '[document]' : '[media]')""",
"""  const isImage = !!mediaMimeType && String(mediaMimeType).startsWith('image/')
  const isVideo = !!mediaMimeType && String(mediaMimeType).startsWith('video/')
  const mediaSentinel = isVoiceNote
    ? '[voice]'
    : isVideo ? '[video]'
    : (mediaMimeType && !isImage ? '[document]' : '[media]')""")
rep("""  if (!isImage && !isVoiceNote && mediaMimeType && payload) {""",
    """  if (!isImage && !isVoiceNote && !isVideo && mediaMimeType && payload) {""")

# 5. quiet hours as a hard final gate for automated owner replies (S11)
rep("""  if (messageText && hasAlreadySentExactText(row.checklist, messageText)) {
    return { allow: false, reason: 'duplicate_message' }
  }""",
"""  if (messageText && hasAlreadySentExactText(row.checklist, messageText)) {
    return { allow: false, reason: 'duplicate_message' }
  }
  // 2026-11-10 recalibration: automated owner replies only 08:30–19:00 Malta.
  if (!insideOwnerReplyWindow(new Date())) return { allow: false, reason: 'quiet_hours' }
  // Phrases the founder casebook forbids in any automated owner message.
  if (messageText && FORBIDDEN_OUTBOUND_RE.test(messageText)) return { allow: false, reason: 'forbidden_phrase' }""")
rep("""function hasAlreadySentExactText(checklist, text) {""",
"""const FORBIDDEN_OUTBOUND_RE = /\\bsorry\\s+for\\s+(?:the\\s+)?spam\\b|\\bon\\s+appointments\\b|\\bone\\s+last\\s+question\\b|\\bsubletting\\s+compan/i
// An LLM-phrased question must not open with sympathy the owner never asked for (S05/S16).
function sanitizeOwnerQuestion(text) {
  return String(text || '').replace(/^\\s*(?:(?:i'?m\\s+)?sorry\\s+to\\s+hear\\s+(?:that|this)?[,.!—-]*\\s*)/i, '').replace(/^\\s*(\\w)/, (m, c) => c.toUpperCase())
}

function hasAlreadySentExactText(checklist, text) {""")

# 6. the decision layer runs first on every owner turn
rep("""    // ── BUSINESS / IDENTITY FIRST ────────────────────────────────────────
    // This is a direct answer, not another availability question. Unknown
    // personas are escalated instead of receiving an invented biography.
    if (isAgencyQuestion(combinedText)) {""",
"""    // ── OWNER AI DECISION LAYER (Claude, 2026-11-10 recalibration) ───────
    // Deterministic action contract first: privacy, human takeover, quiet
    // hours, direct questions, viewing/call offers, corrections, refusals and
    // facts. Only a "pass_through" turn reaches the field flow below, and an
    // acknowledgement is folded into the ONE question that flow may still ask.
    let ackPrefix = null
    let ackFull = null
    let ackUsed = false
    {
      const turn = await ownerDecisionRuntime.handleTurn({
        conversationId, phone, session, pending, log_, gatedSend,
        getChecklist: () => updatedChecklist,
        setChecklist: c => { updatedChecklist = c },
        persist: () => persistAndReturn({}),
        setStatus: async (status, reason, outreachState) => {
          await db.query(
            `UPDATE owner_auto_conversations SET status=$1, cancelled_reason=$2, checklist=$3, last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$4 AND status='active_collecting'`,
            [status, reason, JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId])
          if (outreachState) await db.query(`UPDATE outreach_log SET conversation_state=$2 WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone, outreachState])
        },
        scheduleAt: async when => {
          const delay = Math.max(60_000, new Date(when).getTime() - Date.now() + Math.floor(Math.random() * 10 * 60_000))
          const job = await addJob('auto-conversation', { conversationId, phone, session }, { delay })
          await db.query(`UPDATE owner_auto_conversations SET pending_job_id=$1, scheduled_response_at=$2, updated_at=NOW() WHERE id=$3`,
            [String(job.id), new Date(Date.now() + delay), conversationId])
        },
        notify: (reason, detail) => notifyAdminEscalation(session, phone, reason, detail),
        markUnread: () => waha.markChatUnread(session, phone).catch(() => {}),
      })
      if (turn.done) return
      if (turn.ackPrefix) { ackPrefix = turn.ackPrefix; ackFull = turn.ackFull; updatedChecklist._classified = true }
    }
    const withAck = (text, field) => {
      if (!ackPrefix || ackUsed) return sanitizeOwnerQuestion(text)
      ackUsed = true
      const q = ownerDecisionRuntime.FIELD_QUESTION[field]
      return q ? `${ackPrefix} ${q}` : ackFull
    }

    // ── BUSINESS / IDENTITY FIRST ────────────────────────────────────────
    // This is a direct answer, not another availability question. Unknown
    // personas are escalated instead of receiving an invented biography.
    if (!ackPrefix && isAgencyQuestion(combinedText)) {""")
rep("""    if (await detectFrustration(combinedText)) {""", """    if (!ackPrefix && await detectFrustration(combinedText)) {""")
rep("""    if (looksLikeNeedsHumanContact({ text: combinedText, isVoiceNote: /\\[voice\\]/.test(combinedText) })) {""",
    """    if (!ackPrefix && looksLikeNeedsHumanContact({ text: combinedText, isVoiceNote: /\\[voice\\]/.test(combinedText) })) {""")
rep("""    if (!fileWasExtracted && !checklist._external_source_flagged && (looksLikeExternalSource(combinedText) || isDocumentAttachment)) {""",
    """    if (!ackPrefix && !fileWasExtracted && !checklist._external_source_flagged && (looksLikeExternalSource(combinedText) || isDocumentAttachment)) {""")
rep("""    const stopDecision = ownerIntakeStopDecision(combinedText, ownerHistoryText)""",
    """    const stopDecision = ackPrefix ? null : ownerIntakeStopDecision(combinedText, ownerHistoryText)""")
rep("""    if (!checklist._classified) {
      // Prompt 2 ("mehrere Properties nicht vermischen" / portfolio) --""",
    """    if (!checklist._classified && !ackPrefix) {
      // Prompt 2 ("mehrere Properties nicht vermischen" / portfolio) --""")

# 6b. decision facts win over the legacy extractor before anything is chosen or persisted
rep("""    const askAbout = nextMissingField(updatedChecklist)
    if (!askAbout) {""",
"""    updatedChecklist = ownerDecisionRuntime.backfillFromHistory(ownerDecisionRuntime.enforceTurnFacts(updatedChecklist))
    const askAbout = nextMissingField(updatedChecklist)
    if (!askAbout) {""")
rep("""    if (finished) {
      const draftId = await writeDraftProperty(phone, updatedChecklist)""",
"""    if (updatedChecklist._owner_ai_turn) updatedChecklist = ownerDecisionRuntime.enforceTurnFacts(updatedChecklist, { final: true })
    if (finished) {
      const draftId = await writeDraftProperty(phone, updatedChecklist)""")

# 7. field-flow sends carry the acknowledgement once; finished message too
rep("""        const g9 = await gatedSend(session, phone, reply_message, conversationId)
        if (!g9.sent) return
        log_.push({ from: 'bot', text: reply_message, at: new Date().toISOString() })""",
"""        const out9 = withAck(reply_message, askAbout)
        const g9 = await gatedSend(session, phone, out9, conversationId)
        if (!g9.sent) return
        log_.push({ from: 'bot', text: out9, at: new Date().toISOString() })""")
rep("""          const g10 = await gatedSend(session, phone, built.reply_message, conversationId)
          if (!g10.sent) return
          log_.push({ from: 'bot', text: built.reply_message, at: new Date().toISOString() })""",
"""          const out10 = withAck(built.reply_message, next)
          const g10 = await gatedSend(session, phone, out10, conversationId)
          if (!g10.sent) return
          log_.push({ from: 'bot', text: out10, at: new Date().toISOString() })""")
rep("""      const thanks = "Perfect, thank you so much for all the details! I'll pass this along and we'll be in touch. Have a great day!\"""",
    """      const thanks = ackPrefix && !ackUsed
        ? `${ackPrefix} That's everything I need for now — thank you, we'll be in touch.`
        : "Perfect, thank you so much for all the details! I'll pass this along and we'll be in touch. Have a great day!\"
      ackUsed = true""")
rep("""    await db.query(
      `UPDATE owner_auto_conversations SET checklist=$1, last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
    )
  } finally {
    await releaseProcessingLock(conversationId)
  }
}""",
"""    // The decision layer acknowledged facts but the field flow had nothing
    // left to ask this turn: send the acknowledgement alone, once.
    if (ackPrefix && !ackUsed && ackFull) {
      ackUsed = true
      const gA = await gatedSend(session, phone, ackFull, conversationId)
      if (gA.sent) log_.push({ from: 'bot', text: ackFull, at: new Date().toISOString() })
    }
    await db.query(
      `UPDATE owner_auto_conversations SET checklist=$1, last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
    )
  } finally {
    await releaseProcessingLock(conversationId)
  }
}""")

# 8. exports for tests
rep("module.exports = {", "module.exports = {\n  _ownerAi: { isCommercialChecklist, isStudioChecklist, sanitizeOwnerQuestion, FORBIDDEN_OUTBOUND_RE },", 1)

open(dst, 'w', encoding='utf-8', newline='').write(s)
print('patched', dst)
