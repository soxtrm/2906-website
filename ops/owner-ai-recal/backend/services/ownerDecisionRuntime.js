'use strict'

// ============================================================================
// services/ownerDecisionRuntime.js — wires the pure ownerDecision contract into
// the live owner checklist flow (autoOwnerConversation.processStep).
// Claude, 2026-11-10, Owner AI recalibration.
//
//   context  → built from VERIFIED state only: sending account persona
//              (agentIdentityRegistry / whatsapp_accounts), the conversation's
//              own checklist + log, global suppression, human takeover, clock.
//   decision → ownerDecision.decide() (deterministic, no model call)
//   effects  → facts merged into the checklist with provenance; one audit row
//              per turn in owner_ai_decisions (redacted); at most ONE outbound
//              message, always through the caller's gatedSend (final gate).
//
// Anything the decision layer does not settle ("pass_through") returns to the
// existing field flow unchanged, so every working path is preserved.
// ============================================================================

const crypto = require('crypto')
const db = require('../db')
const log = require('../logger')
const { decide, POLICY_VERSION, ACTIONS } = require('./ownerDecision')

const BACKEND_RELEASE = process.env.ARGUS_RELEASE || 'owner-ai-recal-20261110'
const FIELD_QUESTION = {
  price: 'What would the monthly rent be?',
  bedrooms: 'How many bedrooms does it have?',
  bathrooms: 'How many bathrooms does it have?',
  town: 'Which town or area is it in?',
  available_date: 'When would it be available from?',
  viewable_date: 'When could someone come to view it?',
  photos: 'Could you send a couple of photos when you get a chance?',
  map: 'Could you share the address or a map pin?',
  commercial_use: 'What is the space permitted to be used for?',
  permit_info: 'Could you tell me the permit status?',
  size_sqm: 'Roughly how many square metres is it?',
  condition: 'Is it in shell form, finished or furnished?',
  development_stage: 'Is it on-plan, under construction or already built?',
  plans: 'Do you have any floor plans you can share?',
  pets: 'Would you consider tenants with a pet?',
  sharing: 'Would sharing between professionals be an option?',
}
// ACK reasons after which the normal field flow may ask ONE useful question.
const FIELD_CONTINUE = new Set(['PRICE_CORRECTION', 'AVAILABLE_CONFIRMED', 'STUDIO_EXPLICIT', 'ROOM_NOT_ENTIRE_APARTMENT',
  'RESIDENTIAL_NOT_COMMERCIAL', 'FUTURE_VACANCY', 'NO_PETS', 'NO_SUBLETTING', 'OWNER_MEDIA_BURST', 'QUESTION_ALREADY_ANSWERED'])

function redact(text) {
  return String(text || '')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:triq|street|st\.?|road|rd\.?)\s+[^\n,.]{2,40}/gi, '[address]')
    .slice(0, 600)
}
function phoneHash(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  return d ? crypto.createHash('sha256').update(`argus-owner:${d.slice(-8)}`).digest('hex').slice(0, 24) : null
}

function ownerLines(checklist, pending) {
  const logged = (checklist._log || []).filter(e => e && e.from === 'owner').map(e => String(e.text || ''))
  return logged.concat(pending || [])
}

// Known facts the owner already gave in THIS conversation (never re-asked).
function knownFacts(checklist) {
  const k = { ...(checklist._owner_ai_facts || {}) }
  if (checklist.price != null && k.asking_rent == null) k.asking_rent = Number(checklist.price)
  if (checklist.available_date && !k.available_from) k.available_from = checklist.available_date
  if (checklist.property_category === 'residential' && !k.use_type) k.use_type = 'RESIDENTIAL'
  return k
}

async function buildContext({ checklist, session, phone, now = new Date() }) {
  const { resolveIdentityForSession } = require('./agentIdentityRegistry')
  let identity = null
  try { identity = await resolveIdentityForSession(session, db) } catch (err) { log.warn('ownerDecisionRuntime identity lookup failed', { err: err.message }) }
  let dnc = false
  try { dnc = await require('./ownerOptOut').isGloballySuppressed(phone) } catch { dnc = false }
  // Only a real human takeover counts here; every other stand-down reason
  // (complaint, permanent stop, gate outage) is enforced by the final send gate.
  let humanActive = false
  try { humanActive = (await require('./ownerSendGate').getStandDownReason(phone)) === 'human_active' } catch { humanActive = false }
  const lastBot = [...(checklist._log || [])].reverse().find(e => e && e.from === 'bot')
  return {
    now, identity, senderUnknown: !identity, dnc, humanActive,
    known: knownFacts(checklist), lastBotText: lastBot ? lastBot.text : null,
    // Account Auto / P0 manual pause govern OUTREACH; owner replies keep their
    // own gates (global pause, automation_disabled, human takeover, DNC).
    autoEnabled: true, manualPaused: false,
  }
}

// Decision facts → checklist fields the existing flow and drafts already read.
function applyFacts(checklist, decision, { messageId = null, at = new Date() } = {}) {
  const f = (decision && decision.fact_mutations) || {}
  if (!Object.keys(f).length) return checklist
  const next = { ...checklist }
  next._owner_ai_facts = { ...(next._owner_ai_facts || {}), ...f }
  next._owner_ai_provenance = { ...(next._owner_ai_provenance || {}) }
  for (const k of Object.keys(f)) next._owner_ai_provenance[k] = { at: at.toISOString(), source_message_id: messageId, policy: POLICY_VERSION, reason: decision.reason_code }

  const rent = f.room_rent != null ? f.room_rent : f.asking_rent
  if (rent != null && Number(rent) > 0) {
    if (next.price != null && Number(next.price) !== Number(rent)) next.previous_price = next.price
    next.price = Number(rent)
    next._price_evidence = { price: Number(rent), source: 'owner_direct_statement', reason: decision.reason_code, at: at.toISOString(), message_id: messageId }
    delete next._confidence_price
    delete next._unresolved_price
  }
  if (f.property_type === 'STUDIO') { next.property_subtype = 'studio'; next.bedrooms = 0; delete next._unresolved_bedrooms }
  if (f.property_type === 'ROOM_IN_SHARED_APARTMENT') { next.listing_kind = 'room'; next.sharing = 'existing_shared'; if (f.total_bedrooms) next.whole_property_total_bedrooms = f.total_bedrooms }
  if (f.rooms_available != null) next.available_room_count = f.rooms_available
  if (f.property_type && !['STUDIO', 'ROOM_IN_SHARED_APARTMENT'].includes(f.property_type)) next.property_subtype = String(f.property_type).toLowerCase()
  if (f.bedrooms != null && f.property_type !== 'ROOM_IN_SHARED_APARTMENT') next.bedrooms = f.bedrooms
  if (f.bathrooms != null) next.bathrooms = f.bathrooms
  if (f.office) next.has_office = true
  if (f.use_type === 'RESIDENTIAL') { next.property_category = 'residential'; delete next.commercial_use; delete next.permit_info }
  if (f.use_type === 'COMMERCIAL') next.property_category = 'commercial'
  if (f.transaction_mode === 'SALE') next.transaction_type = 'sale'
  if (f.approx_area_sqm) next.size_sqm = f.approx_area_sqm
  if (f.available_from && /^\d{4}-\d{2}-\d{2}$/.test(f.available_from)) next.available_date = f.available_from
  if (f.tenant_departure_date) {
    // A move-out date is not an available-from date (S07): keep any earlier
    // availability note, otherwise record it as unconfirmed so the field flow
    // neither re-asks it nor lets a legacy extractor turn "November" into it.
    next.tenant_departure_date = f.tenant_departure_date
    if (!next.available_date) next.available_date = `after ${f.tenant_departure_date} (current tenant leaves; to confirm)`
    next._owner_ai_turn = { ...(next._owner_ai_turn || {}), available_date: next.available_date }
  }
  if (f.key_handover_from) next.key_handover_from = f.key_handover_from
  if (f.pets_allowed === false) next.pets = 'no'
  if (f.pets_allowed === true) next.pets = 'yes'
  if (f.subletting_allowed === false) next.subletting = 'no'
  if (f.photos_received || f.media_count) next.photos = true
  if (f.media_status) next._media_pending = f.media_status
  if (f.viewing_status) next.viewing_status = f.viewing_status
  if (f.callback_requested) next.callback_requested = true
  if (f.availability_status) next.availability_status = f.availability_status
  if (f.availability_status === 'AVAILABLE_MARKETING' && !f.tenant_departure_date) {
    // "Yes, it's available" is not a date; never let a legacy extractor store the sentence (S06).
    if (!next.available_date || !/\d|now|immediate|asap|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(String(next.available_date))) {
      next.available_date = f.available_from && /^\d{4}-\d{2}-\d{2}$/.test(f.available_from) ? f.available_from : 'available (owner confirmed; exact date not given)'
    }
    next._owner_ai_turn = { ...(next._owner_ai_turn || {}), available_date: next.available_date }
  }
  if (f.do_not_contact) next.do_not_contact = true
  return next
}

async function recordDecision({ conversationId, phone, session, persona, pending, decision, sent, blockReason, legacyPath = false }) {
  try {
    await db.query(
      `INSERT INTO owner_ai_decisions
         (conversation_id, phone_hash, phone_last4, session, persona, inbound_redacted, next_action, reason_code,
          fact_mutations, draft_reply, send_eligible, sent, block_reason, policy_version, release, intent, legacy_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [conversationId, phoneHash(phone), String(phone || '').replace(/\D/g, '').slice(-4), session, persona || null,
        redact((pending || []).join('\n')), decision.next_action, decision.reason_code, JSON.stringify(decision.fact_mutations || {}),
        decision.draft_reply ? redact(decision.draft_reply) : null, !!decision.send_eligible, !!sent, blockReason || null,
        POLICY_VERSION, BACKEND_RELEASE, decision.intent || null, !!legacyPath])
  } catch (err) {
    log.warn('ownerDecisionRuntime: decision audit write failed', { err: err.message })
  }
}

function stripTrailingQuestion(text) {
  const s = String(text || '').trim()
  if (!s.endsWith('?')) return s
  const parts = s.split(/(?<=[.!])\s+/)
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : s
}

// One owner turn. Returns { done } when the decision fully handled the turn,
// or { done:false, ackPrefix } to let the field flow continue with ONE
// deterministic question appended to the acknowledgement.
async function handleTurn(io) {
  const { conversationId, phone, session, pending, log_, gatedSend, setChecklist, getChecklist, persist,
    setStatus, scheduleAt, notify, markUnread, now = new Date() } = io
  const checklist = getChecklist()
  const context = await buildContext({ checklist, session, phone, now })
  const decision = decide({ messages: pending, context })
  setChecklist(applyFacts(getChecklist(), decision, { messageId: checklist._last_message_id || null, at: now }))
  const persona = context.identity ? context.identity.persona : null
  const audit = (sent, blockReason, legacyPath = false) => recordDecision({ conversationId, phone, session, persona, pending, decision, sent, blockReason, legacyPath })
  const send = async text => {
    const g = await gatedSend(session, phone, text, conversationId)
    if (g.sent) log_.push({ from: 'bot', text, at: new Date().toISOString(), policy: POLICY_VERSION })
    return g
  }

  switch (decision.next_action) {
    case ACTIONS.DEFER: {
      // Nothing is consumed: the full burst is re-read at the next window.
      await scheduleAt(new Date(decision.defer_until || now))
      await audit(false, decision.reason_code)
      return { done: true, decision, keepPending: true }
    }
    case ACTIONS.DNC: {
      try {
        await require('./ownerOptOut').markDoNotContact(phone, `Owner AI: ${decision.reason_code} — ${redact(pending.join(' ')).slice(0, 200)}`, db,
          { source: 'owner_ai_decision', sourceMessageId: checklist._last_message_id || null })
      } catch (err) { log.warn('ownerDecisionRuntime: markDoNotContact failed', { err: err.message }) }
      await persist()
      await setStatus('cancelled_chat', `owner opt-out / privacy (${decision.reason_code}) — automation stopped`, 'declined')
      await markUnread()
      await notify(`OWNER OPT-OUT / PRIVACY — ${decision.reason_code}; all automation stopped for this contact`, redact(pending.join(' ')).slice(0, 200))
      await audit(false, 'dnc')
      return { done: true, decision }
    }
    case ACTIONS.NO_SEND: {
      if (decision.intent === 'pass_through') { await audit(false, null, true); return { done: false, decision } }
      await persist()
      if (decision.reason_code === 'LONG_TERM_RENTED' || decision.intent === 'declined') {
        await setStatus('declined', decision.reason_code === 'LONG_TERM_RENTED' ? 'owner: long-term rented (no reply needed)' : 'owner declined the current offer (no reply needed)', 'declined')
        await markUnread()
      } else if (decision.reason_code === 'HUMAN_ACTIVE') {
        await markUnread()
      }
      await audit(false, decision.reason_code)
      return { done: true, decision }
    }
    case ACTIONS.WAIT_FOR_MEDIA: {
      await persist()
      await markUnread()
      if (decision.fact_mutations && decision.fact_mutations.media_status) {
        await notify('owner sent media that the bot cannot read yet — please review it in WhatsApp (no message was sent)', redact(pending.join(' ')).slice(0, 200))
      }
      await audit(false, 'wait_for_media')
      return { done: true, decision }
    }
    case ACTIONS.HUMAN_HANDOFF: {
      let sent = false; let block = null
      if (decision.send_eligible && decision.draft_reply) { const g = await send(decision.draft_reply); sent = g.sent; block = g.reason || null }
      await persist()
      await setStatus('needs_human_contact', `owner AI handoff: ${decision.reason_code}`, 'done')
      await markUnread()
      await notify(`NEEDS YOU — ${decision.reason_code.replace(/_/g, ' ').toLowerCase()}`, redact(pending.join(' ')).slice(0, 200))
      await audit(sent, block || (decision.send_eligible ? null : 'no_draft'))
      return { done: true, decision }
    }
    case ACTIONS.ANSWER_DIRECT: {
      // The same answer twice is refused by the duplicate gate: say it shorter
      // once, then leave it to a person (never silence, never the intro again).
      const norm = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      const sentBefore = t => (log_ || []).some(e => e && e.from === 'bot' && norm(e.text) === norm(t))
      let text = decision.draft_reply
      if (sentBefore(text)) {
        let short = null
        try { short = require('./agentIdentityRegistry').agencyShortAnswer?.(context.identity) || null } catch { short = null }
        text = short && !sentBefore(short) ? short : null
      }
      if (!text) {
        await persist(); await markUnread()
        await notify('owner repeated a question that was already answered — please reply personally', redact(pending.join(' ')).slice(0, 200))
        await audit(false, 'already_answered')
        return { done: true, decision }
      }
      const g = await send(text)
      await persist()
      await audit(g.sent, g.reason || null)
      return { done: true, decision }
    }
    case ACTIONS.ACKNOWLEDGE_UPDATE: {
      const cl = getChecklist()
      const multi = decision.fact_mutations && (decision.fact_mutations.property_candidates || decision.fact_mutations.new_property_candidates)
      if (multi && !cl._classified) { await audit(false, null, true); return { done: false, decision } } // existing portfolio drafts
      const terminal = !FIELD_CONTINUE.has(decision.reason_code) || multi
        || ['UNAVAILABLE', 'ON_HOLD', 'OFF_MARKET'].includes(decision.fact_mutations && decision.fact_mutations.availability_status)
        || decision.fact_mutations.current_property_status || decision.fact_mutations.portfolio_status || decision.reason_code === 'CONFLICT_REQUIRES_REVIEW'
      if (terminal) {
        let sent = false; let block = null
        if (decision.draft_reply) { const g = await send(decision.draft_reply); sent = g.sent; block = g.reason || null }
        await persist()
        const fm = decision.fact_mutations || {}
        if (fm.availability_status === 'UNAVAILABLE' || fm.availability_status === 'OFF_MARKET' || fm.portfolio_status) await setStatus('declined', `owner: ${fm.availability_status || fm.portfolio_status}`, 'declined')
        else if (fm.availability_status === 'ON_HOLD') await setStatus('future_followup', 'owner: on hold', 'done')
        else if (decision.reason_code === 'AGENT_TO_AGENT' || multi || fm.current_property_status) {
          await setStatus('ready_for_kev', `owner AI: ${decision.reason_code} — needs a person`, 'done')
          await notify(`owner AI: ${decision.reason_code.replace(/_/g, ' ').toLowerCase()} — please follow up`, redact(pending.join(' ')).slice(0, 200))
        }
        await markUnread()
        await audit(sent, block)
        return { done: true, decision }
      }
      await audit(false, null, true)
      return { done: false, decision, ackPrefix: decision.draft_reply ? stripTrailingQuestion(decision.draft_reply) : null, ackFull: decision.draft_reply }
    }
    default:
      await audit(false, null, true)
      return { done: false, decision }
  }
}

// Never ask what the owner already wrote in THIS conversation: fill the
// interview fields from the owner's own messages before a question is chosen.
// Skipped when the owner described several properties (no cross-unit mixing).
function backfillFromHistory(checklist) {
  const { extractFacts } = require('./ownerDecision')
  const said = ownerLines(checklist, checklist._pending).join('\n')
  if (!said.trim()) return checklist
  const f = extractFacts(said, {})
  if (f.property_candidates || f.new_property_candidates || /\b(?:another|second|other)\s+(?:flat|apartment|property|unit)\b/i.test(said)) return checklist
  const next = { ...checklist }
  const filled = []
  if (next.bedrooms == null && f.bedrooms != null && f.property_type !== 'ROOM_IN_SHARED_APARTMENT') { next.bedrooms = f.bedrooms; filled.push('bedrooms') }
  if (next.bathrooms == null && f.bathrooms != null) { next.bathrooms = f.bathrooms; filled.push('bathrooms') }
  if (next.price == null && (f.asking_rent || f.room_rent) && f.transaction_mode !== 'SALE') { next.price = f.room_rent || f.asking_rent; filled.push('price') }
  if (f.property_type === 'STUDIO' && next.property_subtype == null) { next.property_subtype = 'studio'; if (next.bedrooms == null) next.bedrooms = 0; filled.push('studio') }
  if (f.property_type === 'ROOM_IN_SHARED_APARTMENT' && next.listing_kind == null) { next.listing_kind = 'room'; filled.push('room') }
  if (filled.length) next._backfilled_from_history = [...new Set([...(next._backfilled_from_history || []), ...filled])]
  return next
}

// The decision layer's facts for this turn win over a later legacy extraction
// of the same message (called by processStep before it persists).
function enforceTurnFacts(checklist, { final = false } = {}) {
  const turn = checklist && checklist._owner_ai_turn
  if (!turn) return checklist
  const next = { ...checklist }
  if (turn.available_date) next.available_date = turn.available_date
  if (final) delete next._owner_ai_turn
  return next
}

module.exports = { handleTurn, enforceTurnFacts, backfillFromHistory, buildContext, applyFacts, knownFacts, recordDecision, redact, phoneHash, FIELD_QUESTION, stripTrailingQuestion, ownerLines }
