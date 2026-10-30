'use strict'
// ============================================================================
// ownerAssistant.js — OWNERGROUPS (Kev, 2026-09-04). The owner-side
// counterpart to CLIENTGROUPS (services/clientAssistant.js) -- same overall
// shape (activation toggle, persistent state row, human-priority override,
// kill-switch), but its OWN table (owner_assistant_state, migration 061),
// OWN BullMQ queue ('owner-assistant', queues.js), and OWN event log
// (owner_assistant_events). Never shares a row, a job id, or a code path
// with client_assistant_state.
//
// Just as important: this is COMPLETELY SEPARATE from
// services/autoOwnerConversation.js (the existing Auto-Owner-Conversation /
// hard-stop system, keyed on owner_auto_conversations.phone). That system is
// the first-contact automation that reacts to an outreach reply; this one is
// a NEW, independent "active listing loop" a human explicitly arms per
// owner with `!o`. The two can be ARMED or DISABLED completely independently
// for the exact same owner/chat -- this file never reads, writes, or joins
// against owner_auto_conversations, and autoOwnerConversation.js is left
// byte-for-byte untouched by this build.
//
// OG-1 scope: activation + entity linking + the state-machine skeleton +
// human-priority + kill-switch. OG-2 is what actually schedules real
// check-in jobs onto the 'owner-assistant' queue and moves status from
// ENABLED to ARMED -- this file's queue/worker plumbing exists now
// (cancelPendingJob/scheduleCheck) so OG-2 does not need a schema or wiring
// change to use it, mirroring how CLIENTGROUPS' own foundation (051/052)
// predated its engine (053).
// ============================================================================
const db     = require('../db')
const log    = require('../logger')
const waha   = require('../waha')
const config = require('../config')
const { addJob, QUEUES } = require('../queues')

async function intelligenceGuardedSend(state, text) {
  const gate = await require('./conversationIntelligence').preflightOutbound({
    phone: state.owner_phone, chatId: state.chat_id, session: state.session, draft: text,
  })
  if (!gate.allow) {
    const err = new Error(`conversation_intelligence_blocked:${gate.reason}`)
    err.code = 'CONVERSATION_INTELLIGENCE_BLOCKED'
    throw err
  }
  return waha.sendText(state.session, state.chat_id, text)
}

// ── configuration ────────────────────────────────────────────────────────
// Deliberately NOT embeddable via a bare substring match the way
// CLIENTGROUPS' `!=` is: `!=` is vanishingly unlikely to appear inside other
// text, but `!o` is a two-character prefix of REAL existing commands
// (`!outreach`, `!outreminder`) that any admin account could type from
// inside an owner's DM. A naive `.includes('!o')` would misfire on those.
// Word-boundary match instead: the token must be its own word (start/end of
// string or whitespace on both sides), so "!outreach" never matches but "!o"
// alone, "!o " or "...sounds good !o" all do.
const TOGGLE_TOKEN = (process.env.OWNER_ASSISTANT_TOKEN || '!o').trim()
const TOGGLE_RE = new RegExp(
  `(?:^|\\s)${TOGGLE_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`
)
function isToggleTrigger(text) {
  return TOGGLE_RE.test(String(text || ''))
}

// Same internal control channel CLIENTGROUPS notifies into (WA ASSISTANCE
// AND CO KG) -- one place Kevin/Olga already watch for every automation's
// internal chatter, not a second inbox to check. Small, self-contained
// duplication of clientAssistant.js's own controlChannel()/notifyControl()
// rather than a cross-require -- same "two separate small helpers over one
// premature shared module" choice this codebase already made for its two
// Gemini client helpers (see clientAssistant.js's own comment on that).
const CONTROL_GROUP_ID = (process.env.CLIENTS_GROUP_ID || '').trim() || null
async function controlChannel() {
  return CONTROL_GROUP_ID || config.admin.botNumber || null
}
async function notifyControl(session, text) {
  const to = await controlChannel()
  if (!to) { log.warn('ownerAssistant: no control channel configured, dropping notification'); return null }
  try {
    const sent = await waha.sendText(session || 'default', to, text)
    try { waha.markSentByBackend(sent?.id || sent?.key?.id) } catch { /* best-effort */ }
    return sent?.id || sent?.key?.id || null
  } catch (e) {
    log.warn('ownerAssistant: control channel send failed', { err: e.message })
    return null
  }
}

// ── persistence: resolvable in every direction (Kev's explicit OG-1 ask) ──
async function getState(session, chatId) {
  const r = await db.query(
    `SELECT * FROM owner_assistant_state WHERE session = $1 AND chat_id = $2`,
    [session, chatId])
  return r.rows[0] || null
}
async function getStateById(stateId) {
  const r = await db.query(`SELECT * FROM owner_assistant_state WHERE id = $1`, [stateId])
  return r.rows[0] || null
}
// owner_contact_id -> every state row for that owner (an owner in principle
// could be messaged from more than one of our accounts over time).
async function getStatesByOwnerContactId(ownerContactId) {
  if (!ownerContactId) return []
  const r = await db.query(
    `SELECT * FROM owner_assistant_state WHERE owner_contact_id = $1 ORDER BY enabled DESC, updated_at DESC`,
    [ownerContactId])
  return r.rows
}
// owner_contact_id -> every property that owner has on file. Resolved live
// (not a stored/cached array on the state row) so a newly-added listing for
// this owner is visible immediately -- same "resolve on read, never cache a
// list that can go stale" choice CLIENTGROUPS' matchEngine calls already make.
async function getLinkedProperties(ownerContactId) {
  if (!ownerContactId) return []
  const r = await db.query(
    `SELECT id, ref, town, sub_location, bedrooms, bathrooms, available_status,
            longlet_price, sale_price, shortlet, created_at
       FROM properties WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerContactId])
  return r.rows
}
// property_id -> the owner_contacts row (the OTHER direction of "property <->
// owner"), for completeness -- properties.owner_id already makes this a
// one-line join, but every other resolution direction here has a named
// function, so this one does too rather than being the one silent exception.
async function getOwnerContactForProperty(propertyId) {
  const r = await db.query(
    `SELECT oc.* FROM properties p JOIN owner_contacts oc ON oc.id = p.owner_id WHERE p.id = $1`,
    [propertyId])
  return r.rows[0] || null
}
async function resolveOwnerContactByPhone(phone) {
  if (!phone) return null
  const r = await db.query(`SELECT * FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`, [phone])
  return r.rows[0] || null
}

async function logEvent(stateId, kind, detail, { decision = null, reason = null } = {}) {
  await db.query(
    `INSERT INTO owner_assistant_events (state_id, kind, decision, reason, detail) VALUES ($1,$2,$3,$4,$5)`,
    [stateId, kind, decision, reason, detail ? JSON.stringify(detail) : null])
}

// ── BullMQ delayed-job scheduling (mirrors clientAssistant.js exactly, own
// queue -- see queues.js's own comment on why 'client-assistant' and
// 'owner-assistant' must never be able to collide on a job id) ────────────
async function cancelPendingJob(jobId) {
  if (!jobId) return
  try {
    const job = await QUEUES['owner-assistant'].getJob(jobId)
    if (job) await job.remove()
  } catch (err) {
    log.debug('ownerAssistant: cancelPendingJob remove failed (likely already run)', { err: err.message })
  }
}
// OG-1 exposes this so OG-2 can start scheduling real check-in jobs without
// touching this file's foundation again. Nothing calls it yet.
// `extra` (OG-3 addition): carried through in the job payload so
// runCheck()/worker.js's processor can tell a normal check-in job apart
// from a viewing-reminder job without a second queue -- e.g.
// { kind: 'viewing_reminder', propertyId, viewingDate }. Omitted, a job is
// an ordinary check-in (kind defaults to 'checkin' at read time).
async function scheduleCheck(stateId, delayMs, extra = {}) {
  const job = await addJob('owner-assistant', { stateId, ...extra }, { delay: delayMs })
  await db.query(
    `UPDATE owner_assistant_state SET pending_job_id = $1, updated_at = NOW() WHERE id = $2`,
    [String(job.id), stateId])
  return job.id
}

// ── activation / toggle (mirrors clientAssistant.js's handleToggleCommand,
// minus the ENABLED_UNCONFIGURED step -- there is nothing to configure here,
// the owner/property link is automatic from the chat itself) ─────────────
// Shared by handleToggleCommand's ON branch AND autoActivateOnOwnerReply
// below (Kev, 2026-09-10) -- insert-or-reenable + arm-the-loop + notify,
// pulled out so the manual `!o` door and the automatic first-contact door
// share exactly one activation implementation instead of two copies that
// could drift. `trigger` only changes the notify wording and which
// logEvent kind gets recorded -- the actual state mutation and arming logic
// is identical either way.
async function activateState({ session, chatId, ownerContact, ownerPhone, existing, trigger = 'toggle_command' }) {
  const properties = ownerContact ? await getLinkedProperties(ownerContact.id) : []
  const isAuto = trigger === 'auto_first_contact'
  let stateId
  if (existing) {
    // Re-enable: prior history (whatever OG-2+ hangs off this row) survives.
    await db.query(
      `UPDATE owner_assistant_state
          SET enabled = TRUE, status = 'ENABLED', disabled_at = NULL, disabled_reason = NULL,
              owner_contact_id = COALESCE(owner_contact_id, $2), owner_phone = COALESCE(owner_phone, $3),
              updated_at = NOW()
        WHERE id = $1`,
      [existing.id, ownerContact?.id || null, ownerPhone])
    stateId = existing.id
    log.info('ownerAssistant: re-enabled', { session, chatId, stateId, trigger })
    await notifyControl(session,
      `${isAuto ? '🆕 *OWNERGROUPS* — Owner Assistant auto-activated on reply' : '🔄 *OWNERGROUPS* — Owner Assistant re-enabled'} (O${stateId})\nChat: ${chatId}\nAccount: ${session}\n` +
      `Owner: ${ownerContact?.name || existing.owner_phone || '(unlinked)'}${properties.length ? `\nProperties: ${properties.map(p => p.ref).join(', ')}` : ''}\n` +
      `Status: ENABLED`)
  } else {
    const ins = await db.query(
      `INSERT INTO owner_assistant_state
         (chat_id, session, owner_contact_id, owner_phone, enabled, status)
       VALUES ($1, $2, $3, $4, TRUE, 'ENABLED')
       RETURNING id`,
      [chatId, session, ownerContact?.id || null, ownerPhone])
    stateId = ins.rows[0].id
    log.info('ownerAssistant: activated', { session, chatId, stateId, linked: !!ownerContact, trigger })
    const msgId = await notifyControl(session,
      `${isAuto ? '🆕 *OWNERGROUPS* — Owner Assistant auto-activated (owner replied)' : '🆕 *OWNERGROUPS* — new Owner Assistant activation'} (O${stateId})\n` +
      `Chat: ${chatId}\nAccount: ${session}\n` +
      `Owner: ${ownerContact?.name || '(no owner_contacts match for ' + ownerPhone + ')'}\n` +
      (properties.length ? `Properties: ${properties.map(p => p.ref).join(', ')}\n` : 'Properties: none on file\n') +
      `Status: ENABLED`)
    if (msgId) await db.query(
      `UPDATE owner_assistant_state SET control_message_id = $1 WHERE id = $2`,
      [waha.normalizeMessageId(msgId), stateId])
  }

  // OG-2: arms the actual check-in loop -- the FIRST check still waits a
  // normal interval (never an immediate send right as `!o` is typed, which
  // would read as a canned auto-reply) and status only becomes ARMED once a
  // real job exists, mirroring CLIENTGROUPS' own startAutomation() ->
  // scheduleNextCheck() shape.
  try {
    const listed = ownerContact ? await isCurrentlyListed(ownerContact.id) : false
    const rhythmRow = await db.query(`SELECT checkin_min_days, checkin_max_days FROM owner_assistant_state WHERE id = $1`, [stateId])
    const override = rhythmRow.rows[0] ? { minDays: rhythmRow.rows[0].checkin_min_days, maxDays: rhythmRow.rows[0].checkin_max_days } : null
    const delayMs = computeNextCheckinDelayMs(listed, override)
    const point = shiftIntoQuietWindow(new Date(Date.now() + delayMs))
    await scheduleCheck(stateId, Math.max(60_000, point.getTime() - Date.now()))
    await db.query(`UPDATE owner_assistant_state SET status = 'ARMED', updated_at = NOW() WHERE id = $1`, [stateId])
  } catch (e) {
    log.warn('ownerAssistant: could not arm the check-in loop', { stateId, err: e.message, trigger })
  }

  if (isAuto) await logEvent(stateId, 'auto_activated_first_contact', {})
  return stateId
}

async function handleToggleCommand({ session, chatId, senderPhone }) {
  const existing = await getState(session, chatId)

  if (existing && existing.enabled) {
    await disable(existing, 'toggle command')
    log.info('ownerAssistant: toggled OFF', { session, chatId })
    return { toggledTo: 'OFF' }
  }

  const ownerSendGate = require('./ownerSendGate')
  const ownerPhone = (await ownerSendGate.resolveChatPhone(session, chatId))
    || String(chatId || '').replace(/@.*/, '')
  const ownerContact = await resolveOwnerContactByPhone(ownerPhone)

  // Flow E: refuse to arm at all for a do-not-contact owner, rather than
  // creating a row that silently never fires (see runCheck's own gate for
  // why the loop can't send even if this were skipped) -- telling the human
  // who typed `!o` clearly, right now, beats a confusing armed-but-mute state.
  if (ownerContact && await isDoNotContact(ownerContact.id)) {
    await notifyControl(session,
      `🚫 *OWNERGROUPS* — \`!o\` refused (${chatId})\nOwner: ${ownerContact.name || ownerPhone} is marked DO-NOT-CONTACT.\nRe-enable contact from the owner's CRM profile first.`)
    log.info('ownerAssistant: toggle-ON refused, owner is do-not-contact', { session, chatId, ownerContactId: ownerContact.id })
    return { toggledTo: 'REFUSED', reason: 'do_not_contact' }
  }

  // !o is Kevin's explicit override after an automatic complaint/confusion
  // stand-down. Clear only conversational automation blocks; DNC above is
  // intentionally never overridden here.
  await ownerSendGate.resumeOwnerFlow({ phone: ownerPhone, session, reason: '!o manual resume' })

  const stateId = await activateState({ session, chatId, ownerContact, ownerPhone, existing, trigger: 'toggle_command' })
  return { toggledTo: 'ON', stateId }
}

// ── Kev, 2026-09-10: `!o` auto-activation on first active owner contact ──
// "Sobald ein Owner AKTIV mit uns in Kontakt tritt ... wird der `!o`-Flow
// automatisch aktiviert (kein manuelles !o/!= nötig)." Called from
// handleOwnerMessage below, on every inbound owner DM that does not
// already have an ENABLED state -- resolveOwnerContactByPhone is the same
// owner-contacts match the manual `!o` path already uses, so a reply from a
// number with no owner_contacts row (not a real owner) is left alone rather
// than guessed into an activation. A TRUE no-op -- no DB write, no notify,
// no event log -- whenever the owner is already active: Kev's explicit
// "ändert NICHTS" requirement for that case.
async function autoActivateOnOwnerReply({ session, chatId, existingState } = {}) {
  const existing = existingState !== undefined ? existingState : await getState(session, chatId)
  if (existing && existing.enabled) return { activated: false, reason: 'already_active' }

  const ownerPhone = String(chatId || '').replace(/@.*/, '')
  const ownerContact = await resolveOwnerContactByPhone(ownerPhone)
  if (!ownerContact) return { activated: false, reason: 'no_owner_contact_match' }

  // Same Flow E refusal the manual `!o` path applies -- a do-not-contact
  // owner replying must not silently re-arm an automated loop to them.
  if (await isDoNotContact(ownerContact.id)) {
    log.info('ownerAssistant: auto-activation skipped, owner is do-not-contact', { session, chatId, ownerContactId: ownerContact.id })
    return { activated: false, reason: 'do_not_contact' }
  }

  // HUMAN_REVIEW_REQUIRED / stand-down (2026-09-21): an owner who complained about the
  // automation, was cancelled with !ca / !c, or was flagged for a person must not be
  // re-armed by their very next message — that is exactly what happened live: the
  // frustration stand-down ran, and ~130ms later this hook armed a fresh check-in loop
  // for the same owner. (owner_assistant_disabled / human_active are deliberately NOT
  // in this set: those keep their existing semantics.) Only a human resumes these.
  const standDown = await require('./ownerSendGate').getStandDownReason(ownerPhone)
  if (standDown && ['human_review_required', 'permanent_owner_stop', 'cancelled_chat', 'automation_failure_paused',
      'needs_human_contact', 'automation_disabled'].includes(standDown)) {
    log.info('ownerAssistant: auto-activation skipped, owner is stood down', { session, chatId, ownerContactId: ownerContact.id, standDown })
    return { activated: false, reason: `stand_down_${standDown}` }
  }

  const stateId = await activateState({ session, chatId, ownerContact, ownerPhone, existing, trigger: 'auto_first_contact' })
  return { activated: true, stateId }
}

// ── kill-switch (mirrors clientAssistant.js's disable() exactly) ─────────
async function disable(state, reason) {
  await cancelPendingJob(state.pending_job_id)
  await db.query(
    `UPDATE owner_assistant_state
        SET enabled = FALSE, status = 'DISABLED', pending_job_id = NULL,
            disabled_at = NOW(), disabled_reason = $2, updated_at = NOW()
      WHERE id = $1`,
    [state.id, reason || 'disabled'])
  await notifyControl(state.session,
    `🛑 *OWNERGROUPS* — Owner Assistant disabled (O${state.id})\nChat: ${state.chat_id}\nAccount: ${state.session}\nReason: ${reason || 'toggle'}\nAny queued check-in was cancelled.`)
  log.info('ownerAssistant: disabled, pending job cancelled', { stateId: state.id, hadJob: !!state.pending_job_id })
}

// ── human priority (mirrors clientAssistant.js's handleHumanMessage) ─────
// Kevin/Olga writing a genuine (non-command) message directly into the
// owner's own chat pulls the assistant back, exactly like the client side --
// but this fires ONLY on THIS row (owner_assistant_state), completely
// independent of whatever autoOwnerConversation.js's own hard-stop is doing
// for the SAME chat via owner_auto_conversations. Both react to the same
// underlying WhatsApp event; neither knows the other exists.
// Teil B, Flow D (Kev, 2026-09-08): "temporarily" was never actually true
// before this — HUMAN_ACTIVE was set here and then NEVER cleared anywhere
// in this file. clientAssistant.js's sibling mechanism gets away with the
// same "never cleared here" comment because IT is re-evaluated by a
// recurring scan that calls humanSilenceExpired() independent of any
// per-row job; this file has no such scan, only the one BullMQ job per
// state row -- and that job is exactly what cancelPendingJob just cancelled
// with nothing scheduled to replace it. Left as-is, a human sending even
// one message permanently silenced the loop. Fixed the same way OG-3's
// viewing reminder already proves out: arm a real job that wakes this row
// up again. HUMAN_QUIET_MS mirrors clientAssistant.js's own
// HUMAN_SILENCE_QUIET_MS (3h) for the same relationship, not a new number.
const HUMAN_QUIET_MS = 3 * 60 * 60 * 1000
async function handleHumanMessage({ session, chatId }) {
  const state = await getState(session, chatId)
  if (!state || !state.enabled) return false
  await cancelPendingJob(state.pending_job_id)
  await db.query(
    `UPDATE owner_assistant_state
        SET status = 'HUMAN_ACTIVE', pending_job_id = NULL,
            last_human_message_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [state.id])
  await require('./conversationIntelligence').markHumanActive({ chatId, session, active: true }).catch(() => {})
  await scheduleCheck(state.id, HUMAN_QUIET_MS, { kind: 'resume_check' })
  log.info('ownerAssistant: human takeover -- assistant silenced, resume check armed', { stateId: state.id, resumeInMs: HUMAN_QUIET_MS })
  await logEvent(state.id, 'human_takeover', { resumeCheckInMs: HUMAN_QUIET_MS })
  return true
}

// The resume_check job's body: fires ~3h after the LATEST human message (a
// later human message re-arms this via handleHumanMessage's own
// cancelPendingJob + reschedule, so by the time this actually executes, the
// quiet window has genuinely held). Guards status itself in case a human
// used the CRM's explicit "Resume now" button (resumeFromHumanTakeover
// below) in the meantime, so this never double-resumes or clobbers a
// DISABLED/PAUSED transition that happened after the job was armed.
async function resumeFromHumanTakeover(stateId) {
  const state = await getStateById(stateId)
  if (!state || state.status !== 'HUMAN_ACTIVE') return { resumed: false, reason: 'not_human_active' }
  await db.query(`UPDATE owner_assistant_state SET status = 'ARMED', updated_at = NOW() WHERE id = $1`, [stateId])
  await require('./conversationIntelligence').markHumanActive({ chatId: state.chat_id, session: state.session, active: false }).catch(() => {})
  await scheduleNextOrdinaryCheckin(stateId, state.owner_contact_id)
  await logEvent(stateId, 'human_takeover_resumed', {})
  log.info('ownerAssistant: resumed after human takeover, ordinary loop re-armed', { stateId })
  return { resumed: true }
}

// The owner's OWN reply arriving. OG-1 scope: record the fact only (for
// OG-2's proactive-eligibility timing to read, same foundation-only shape
// CLIENTGROUPS' Prompt-1 handleClientMessage started with). Deliberately
// does NOT clear HUMAN_ACTIVE here -- same asymmetry as the client side:
// an owner replying does not "fix" a human takeover; only OG-2's own
// lazy-expiry check (once it exists) may do that, exactly the way
// clientAssistant.js's humanSilenceExpired() is what actually clears it
// there, not handleClientMessage() itself.
async function handleOwnerMessage({ session, chatId, text = null } = {}) {
  let state = await getState(session, chatId)
  // Kev, 2026-09-10: first-active-contact auto-activation lives right here,
  // before the enabled-gate below -- this is the one inbound hook every
  // owner DM already passes through unconditionally, so it is the natural
  // place to notice "no automation running yet, but a real owner just
  // wrote in" without webhook.js needing a second call site. No-ops
  // instantly (see autoActivateOnOwnerReply's own contract) for a number
  // with no owner_contacts match, a DNC owner, or an owner already active.
  if (!state || !state.enabled) {
    const activation = await autoActivateOnOwnerReply({ session, chatId, existingState: state })
    if (activation.activated) state = await getStateById(activation.stateId)
  }
  if (!state || !state.enabled) return false
  await db.query(
    `UPDATE owner_assistant_state SET last_owner_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [state.id])
  // OG-2 (Kev, 2026-09-04): "Voll-Synchronisation... kritisch." Fire-and-
  // forget, never blocks/consumes the inbound hook -- a sync failure must
  // never be the reason last_owner_message_at didn't get recorded above.
  if (text) {
    detectAndSyncOwnerUpdate({ session, chatId, text, state })
      .catch(e => log.warn('ownerAssistant: update sync failed', { stateId: state.id, err: e.message }))
    // OG-3: a genuine viewing-date mention pauses the ordinary check-in
    // loop and arms a one-time reminder instead. Independent of the sync
    // above -- both may fire off the same incoming message.
    maybeArmViewingReminder({ session, chatId, text, state })
      .catch(e => log.warn('ownerAssistant: viewing reminder arm failed', { stateId: state.id, err: e.message }))
    // Teil B, Flow C: a named future date/timeframe (that isn't a viewing
    // date -- maybeScheduleFutureContact checks that itself, first thing)
    // overrides the generic check-in rhythm instead of being ignored.
    maybeScheduleFutureContact({ session, chatId, text, state })
      .catch(e => log.warn('ownerAssistant: future contact scheduling failed', { stateId: state.id, err: e.message }))
  }
  return true
}

// ── OG-2: full CRM + WhatsApp-category-group sync when the owner gives an
// update in chat ("price, availability, new photos, status change etc must
// automatically propagate... no silo"). Reuses autoOwnerConversation.js's
// existing localExtractAll() for the extraction (pure function, no side
// effects -- safe to share) and handlers/upload.js's runCategoryDistribution
// for the repost (the EXACT mechanism the board's own AV-date-confirm
// button already uses -- routes/crmScheduleBoard.js POST
// .../av-date-confirm, see that route's own header comment). Never rebuilds
// either.
// Owner-wide language ("any of mine", "all my properties", ...) is the ONE
// thing allowed to escalate a preference above the property it was said in
// the context of — the brief's own default-scope rule (Owner Profile V2,
// Teil A §6 / Teil B §12): new observations default to PROPERTY scope,
// promoted to OWNER scope only on an explicit general statement, or (not
// handled here — that's the confidence-based path in
// ownerPreferenceProfile.saveInferred) a preference repeating consistently
// across several properties.
const OWNER_WIDE_RE = /\b(any of mine|all my (?:properties|places|apartments|units)|every property|in general|none of my|both of my|all of my)\b/i
function soundsOwnerWide(text) { return OWNER_WIDE_RE.test(String(text || '')) }

async function detectAndSyncOwnerUpdate({ session, chatId, text, state }) {
  if (!state.owner_contact_id) return { synced: false, reason: 'no_owner_link' }
  const autoOwnerConversation = require('./autoOwnerConversation')
  const extracted = autoOwnerConversation.localExtractAll(text)

  // Multi-property owners are a real ambiguity this file does not guess
  // through -- same conservative stance item 8/the availability classifier
  // takes elsewhere in this codebase: an unclear correlation goes to a
  // human, it never gets silently applied to the wrong listing.
  const properties = await getLinkedProperties(state.owner_contact_id)
  const active = properties.filter(p => p.available_status !== 'rented' && p.available_status !== 'archived')

  // Teil B, Flow B: a warm owner with NOTHING currently active who now
  // volunteers a real listing (a price, or a town+bedroom count together)
  // gets a property, not a dead end that needs a human to rebuild the flow
  // by hand. Created as a DRAFT (pending_check, unpublished, no repost) --
  // same discipline as the 2026-09-07 ghost-listing fix and
  // autoOwnerConversation.js's own writeEntityDraft(): a chat extraction is
  // a LEAD, never published sight-unseen. No separate "move this owner to
  // the Available Flow" step exists or is needed: once a human confirms/
  // completes the draft, isCurrentlyListed() reads 'available' on the very
  // next scheduled check and the SAME loop starts using the listed-cadence
  // rhythm on its own.
  // draftJustCreated: when Flow B fires below, the new property becomes
  // the preference-capture scope for the REST of this same message too —
  // "2 bed Sliema, 1200/month, pets are fine" must not lose the pets half
  // just because the listing half used up the whole function in one
  // early return. Not returned immediately; falls through to preference
  // capture, then returns at the very end of the function instead.
  let draftJustCreated = null
  if (active.length === 0) {
    const strongSignal = extracted.price != null || (extracted.town && extracted.bedrooms != null)
    if (strongSignal) {
      const notes = `Auto-collected via Owner Assistant (!o) check-in reply, ${new Date().toISOString().slice(0, 10)}`
      const ins = await db.query(
        `INSERT INTO properties
           (owner_id, property_type, town, bedrooms, bathrooms, longlet_price, available_date, available_status, listed_by_agent_id, published, internal_notes)
         VALUES ($1,'apartment',$2,$3,$4,$5,$6,'pending_check',1,false,$7)
         RETURNING id, ref`,
        [state.owner_contact_id, extracted.town || null, extracted.bedrooms ?? null, extracted.bathrooms ?? null,
         extracted.price ?? null, extracted.availableDate || null, notes])
      draftJustCreated = ins.rows[0]
      await logEvent(state.id, 'new_listing_draft_created', { propertyId: draftJustCreated.id, extracted })
      await notifyControl(session,
        `🆕 *OWNERGROUPS* — new listing volunteered during a check-in (O${state.id})\n` +
        `Owner: ${state.owner_phone}\nDraft property #${draftJustCreated.id} created (pending_check, unpublished) — review to publish.\n` +
        `Extracted: ${JSON.stringify(extracted)}`)
      log.info('ownerAssistant: new listing draft created from check-in reply', { stateId: state.id, propertyId: draftJustCreated.id, extracted })
    }
  }

  // ── semantic preference capture ("Pets are fine" / "I normally don't
  // allow pets in any of mine" / "price is negotiable") — scoped to the
  // single active property by default, escalated to owner-wide only on
  // explicit general language, or falling back to owner-wide when there is
  // no single active property to scope to at all (still a real signal even
  // when the price/date path below can't touch any one listing from it).
  const ownerWide = soundsOwnerWide(text)
  // draftJustCreated stands in for "the single active property" when Flow B
  // just created one in THIS call — `active` was resolved before that
  // insert, so active.length is still 0 at this point even though there is
  // now obviously exactly one property to scope to.
  const scopeProperty = draftJustCreated ? draftJustCreated
    : (active.length === 1 && !ownerWide) ? active[0] : null
  const prefFields = [
    ['pets', extracted.pets === 'yes' ? 'pets ok' : extracted.pets === 'no' ? 'no pets' : null],
    ['sharing', extracted.sharing === 'yes' ? 'sharing ok' : extracted.sharing === 'no' ? 'no sharing' : null],
    ['subletting', extracted.subletting === 'yes' ? 'subletting ok' : extracted.subletting === 'no' ? 'no subletting' : null],
    ['price_flexibility', extracted.priceFlex === 'yes' ? 'negotiable' : extracted.priceFlex === 'no' ? 'firm' : null],
  ].filter(([, v]) => v != null)
  if (prefFields.length && (scopeProperty || ownerWide)) {
    const ownerPreferenceProfile = require('./ownerPreferenceProfile')
    for (const [field, value] of prefFields) {
      await ownerPreferenceProfile.saveExplicit(
        state.owner_contact_id, field, value, 'owner_assistant_checkin', text, scopeProperty ? scopeProperty.id : null)
    }
    await logEvent(state.id, 'preferences_captured', {
      fields: prefFields.map(([f]) => f),
      scope: scopeProperty ? `property:${scopeProperty.ref}` : 'owner_wide',
    })
    log.info('ownerAssistant: preferences captured from check-in reply', {
      stateId: state.id, fields: prefFields.map(([f]) => f), scope: scopeProperty ? scopeProperty.ref : 'owner_wide',
    })
  }

  if (draftJustCreated) return { synced: true, created: true, propertyId: draftJustCreated.id, preferencesCaptured: prefFields.length }

  const hasUpdate = extracted.price != null || !!extracted.availableDate
  if (!hasUpdate) return { synced: prefFields.length > 0, reason: prefFields.length ? 'preferences_only' : 'no_update_detected' }

  if (active.length !== 1) {
    await logEvent(state.id, 'update_detected_ambiguous', { extracted, propertyCount: active.length })
    log.info('ownerAssistant: update detected but property is ambiguous, not applied', { stateId: state.id, propertyCount: active.length })
    return { synced: prefFields.length > 0, reason: active.length > 1 ? 'ambiguous_multi_property' : 'no_active_property' }
  }
  const property = active[0]

  const sets = [], params = [property.id]
  if (extracted.price != null) { params.push(extracted.price); sets.push(`longlet_price = $${params.length}`) }
  if (extracted.availableDate) { params.push(extracted.availableDate); sets.push(`available_date = $${params.length}`) }
  if (!sets.length) return { synced: false, reason: 'no_applicable_fields' }
  sets.push('updated_at = NOW()')
  await db.query(`UPDATE properties SET ${sets.join(', ')} WHERE id = $1`, params)
  await logEvent(state.id, 'update_synced', { propertyId: property.id, extracted })
  log.info('ownerAssistant: owner update synced to CRM', { stateId: state.id, propertyId: property.id, extracted })

  // Repost into the property's category group(s), same call shape
  // av-date-confirm uses -- session that has been talking to this owner
  // (persona consistency), config.admin.botNumber as the internal reporting
  // chat parameter runCategoryDistribution itself expects.
  try {
    const upload = require('../handlers/upload')
    await db.query(
      `UPDATE property_publishing_status SET status='superseded', updated_at=NOW()
        WHERE property_id=$1 AND channel='category_groups' AND status='posted'`,
      [property.id])
    const pub = await upload.runCategoryDistribution(session, config.admin.botNumber, property.id, property.ref)
    const postedGroups = (pub?.results || []).filter(r => r.status === 'posted')
    if (postedGroups.length) {
      const styleLearning = require('./styleLearning')
      const dateLine = extracted.availableDate
        ? `Available from ${new Date(extracted.availableDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`
        : ''
      const followUp = styleLearning.stripEmDash(`Quick update, this one's still on the market. ${dateLine}`.trim())
      for (const g of postedGroups) {
        try { await waha.sendText(session, g.group_id, followUp) } catch (e) {
          log.warn('ownerAssistant: sync repost follow-up failed', { propertyId: property.id, group: g.group_id, err: e.message })
        }
      }
    }
    return { synced: true, propertyId: property.id, extracted, reposted: postedGroups.length }
  } catch (e) {
    log.warn('ownerAssistant: sync repost failed (CRM update still applied)', { propertyId: property.id, err: e.message })
    return { synced: true, propertyId: property.id, extracted, reposted: 0, repostError: e.message }
  }
}

// ── OG-2: the active listing check-in loop ────────────────────────────────
// "Solange gelistet: alle 2-3 Tage. Nichts gelistet: alle 3-4 Wochen."
// Own small Malta-quiet-window helper -- same shape as clientAssistant.js's
// private maltaOffsetMinutes()/shiftIntoQuietWindow() and
// availabilityReachout.js's own window math, deliberately NOT imported from
// either (both are private/differently-scoped) -- same "small duplication
// over a premature shared module" choice this codebase already made
// elsewhere (see clientAssistant.js's own comment on its two separate
// Gemini helpers).
// Kev, 2026-09-08 (Owner Profile V2, Teil B, Flow A): retargeted from the
// original 2-3 days to "~5 days, adjustable" — still a range (never a fixed
// number, same jitter-against-looking-automated reasoning as everywhere
// else in this file), and still fully overridable per-owner via
// checkin_min_days/checkin_max_days (OGX-2, the CRM's Owner Flows tab).
const CHECKIN_LISTED_MIN_DAYS = 4
const CHECKIN_LISTED_MAX_DAYS = 6
// Kev, 2026-09-10 (Owner-Kadenz precision pass): the unlisted rhythm's
// stated standard is "alle 25 Tage" — corrected from the previous 21-28
// day / "3-4 weeks" range, which had drifted from that spec. Kept as a
// narrow range (not a bare 25), same jitter-against-looking-automated
// reasoning as the listed rhythm just above — 24-26 still centers on and
// reads as "every 25 days" to anyone watching the actual send times.
const CHECKIN_UNLISTED_MIN_DAYS = 24
const CHECKIN_UNLISTED_MAX_DAYS = 26
// Kev, 2026-09-10 (frustration-based cadence extension): once
// detectFrustration (services/autoOwnerConversation.js, Point I, the
// existing Owner Hard-Stop signal) fires for an owner, THIS system's own
// long-term rhythm for that owner is widened from the 25-day standard to
// ~40 days -- see extendCadenceOnFrustrationByPhone below. Same ±1 jitter
// convention as the standard rhythm above, not a bare 40.
const CADENCE_FRUSTRATION_MIN_DAYS = 39
const CADENCE_FRUSTRATION_MAX_DAYS = 41
const QUIET_START_HOUR = 8
const QUIET_END_HOUR = 20

function maltaOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const mh = Number(parts.find(p => p.type === 'hour').value)
  const mm = Number(parts.find(p => p.type === 'minute').value)
  let diff = (mh * 60 + mm) - (date.getUTCHours() * 60 + date.getUTCMinutes())
  if (diff > 720) diff -= 1440
  if (diff < -720) diff += 1440
  return diff
}
function shiftIntoQuietWindow(point) {
  const offsetMin = maltaOffsetMinutes(point)
  const maltaMinutes = (((point.getUTCHours() * 60 + point.getUTCMinutes()) + offsetMin) % 1440 + 1440) % 1440
  const startMin = QUIET_START_HOUR * 60, endMin = QUIET_END_HOUR * 60
  if (maltaMinutes >= startMin && maltaMinutes <= endMin) return point
  const isBeforeWindowToday = maltaMinutes < startMin
  const targetDay = isBeforeWindowToday ? point : new Date(point.getTime() + 86_400_000)
  const y = targetDay.getUTCFullYear(), mo = targetDay.getUTCMonth(), d = targetDay.getUTCDate()
  const randomStartMin = startMin + Math.floor(Math.random() * 150)
  return new Date(Date.UTC(y, mo, d, 0, randomStartMin) - offsetMin * 60_000)
}

async function isCurrentlyListed(ownerContactId) {
  const props = await getLinkedProperties(ownerContactId)
  return props.some(p => p.available_status === 'available' || p.available_status === 'available_confirmed')
}

function computeNextCheckinDelayMs(listed, override) {
  // OGX-2: a per-owner override (set from the CRM's "Owner Flows" tab) wins
  // over the global listed/unlisted defaults when both bounds are present.
  const hasOverride = override && Number.isFinite(override.minDays) && Number.isFinite(override.maxDays) && override.maxDays >= override.minDays
  const [minD, maxD] = hasOverride ? [override.minDays, override.maxDays]
    : listed ? [CHECKIN_LISTED_MIN_DAYS, CHECKIN_LISTED_MAX_DAYS] : [CHECKIN_UNLISTED_MIN_DAYS, CHECKIN_UNLISTED_MAX_DAYS]
  const days = minD + Math.random() * (maxD - minD)
  return days * 86_400_000
}

// Deterministic fallback pool -- used whenever STYLE-1's approved
// phrasing_variants pool for this purpose is still empty (today). No
// em-dash by construction; still run through stripEmDash at send time as
// the same hard-backstop defense-in-depth every other send point in this
// codebase now has.
const FALLBACK_CHECKIN_LISTED = [
  'Hi, quick check, just wanted to see if this one is still on the market so we can repush it if so.',
  'Hi, hope all is well. Quick one, is the property still available? Happy to give it another push if so.',
  'Hi, just checking in on the listing, still on the market or has it moved on?',
]
const FALLBACK_CHECKIN_UNLISTED = [
  'Hi, hope you are well. Just checking in, anything new coming up that you would like listed?',
  'Hi, quick check, do you have anything new available or coming available soon?',
]

async function pickCheckinText(purpose, fallbackPool, lastAction) {
  const styleLearning = require('./styleLearning')
  const approved = await styleLearning.getVariantPool(purpose)
  const pool = approved.length ? approved : fallbackPool
  const notRepeated = pool.filter(t => t !== lastAction)
  const options = notRepeated.length ? notRepeated : pool
  return options[Math.floor(Math.random() * options.length)]
}

// ── OG-3: viewing-date reminder ──────────────────────────────────────────
// Kev's precise correction: NOT "owner mentions any future month during
// fresh outreach" -- specifically a real VIEWING date, inside an
// already-active `!o` conversation about a concrete property. Requires the
// word "viewing(s)" (or "view/visit" as a verb) to actually be in the same
// message as the date -- reminderDetector.js's own detectReminderPhrase()
// does the real date arithmetic (reused, not re-derived; it already covers
// "15th of September", "the 15th", explicit day+month etc. via
// reminderParse.js), this only adds the keyword gate that makes it
// viewing-specific instead of firing on every date mention.
const VIEWING_WORD_RE = /\bview(?:ing)?s?\b|\bvisit(?:ing)?\b/i
// reminderParse.js's parseMonthPhrase only reads the day-of-month off the
// token DIRECTLY before the month name (its own explicit "prev1" check) --
// correct for "15 August"/"24th August", but Kev's own OG-3 example phrasing
// ("15th of September") puts "of" in between, so the day token is never
// adjacent and the whole phrase would silently resolve to day 1 instead --
// a real corruption risk of the exact shape reminderParse.js's own commit
// history today already fixed five other instances of. Rather than touch
// that shared, already-hardened file for one caller's phrasing quirk, this
// strips the "of" locally, in a throwaway copy, before handing off to the
// unmodified shared detector -- "15th of September" -> "15th September".
function stripOrdinalOf(text) {
  return String(text || '').replace(/(\d{1,2}(?:st|nd|rd|th)?)\s+of\s+([A-Za-zÄÖÜäöüß]+)/gi, '$1 $2')
}
function detectViewingDateMention(text) {
  const raw = String(text || '')
  if (!VIEWING_WORD_RE.test(raw)) return null
  const reminderDetector = require('./reminderDetector')
  const hit = reminderDetector.detectReminderPhrase(stripOrdinalOf(raw))
  if (!hit || !hit.dueAt) return null
  return { viewingDate: hit.dueAt, phrase: hit.phrase }
}

const VIEWING_REMINDER_LEAD_DAYS = 3.5 // "~3-4 Tage vorher"

// Chat-history pre-scan (Kev's explicit requirement: "muss den Chat-Verlauf
// VORHER scannen um zu wissen was schon da ist" -- never blindly send both
// messages). A WAHA location message carries `location` (NOWEB) or a
// `type`/`Type` of 'location' (GOWS) depending on engine; a plain-text
// address mention is the textual fallback. Only the OWNER's own messages
// count -- Kevin himself mentioning "location" while asking for it doesn't
// satisfy "already shared".
const LOCATION_TEXT_RE = /\b(location|pin|map|address|street|str\.|road|building|floor)\b/i
async function chatAlreadyHasLocation(session, chatId) {
  const messages = await waha.getChatMessages(session, chatId, 100)
  return messages.some(m => !m.fromMe && (
    m.location || String(m.type || m.Type || '').toLowerCase() === 'location' || LOCATION_TEXT_RE.test(String(m.body || ''))
  ))
}

const VIEWING_CHECKIN_TEMPLATE = (dateLabel) =>
  `Hi, good afternoon, hope you are well. I just wanted to check in regarding your viewings on the ${dateLabel}, do you already know viewing times or how are the plans in general?`
const VIEWING_LOCATION_ASK_TEMPLATE =
  'Could you also send me the map location for the meet up please? So I can forward it to the matching clients and we can sort it out already.'

function dayWithOrdinal(iso) {
  const d = new Date(iso).getUTCDate()
  const suffix = (d % 10 === 1 && d !== 11) ? 'st' : (d % 10 === 2 && d !== 12) ? 'nd' : (d % 10 === 3 && d !== 13) ? 'rd' : 'th'
  return `${d}${suffix}`
}

// Fires once, at T-3/4 days before the viewing date. Sends Kev's exact
// message (phrasing may vary slightly over time via STYLE-1 once a
// 'viewing_checkin' variant pool exists -- fallback is Kev's own literal
// wording, kept close to verbatim rather than paraphrased), the location
// ask ONLY if the chat scan found no location shared yet, then hands
// control back to the ordinary OG-2 loop (never stays paused after this).
async function runViewingReminder(stateId, state, jobData) {
  const styleLearning = require('./styleLearning')
  try {
    const dateLabel = dayWithOrdinal(jobData.viewingDate)
    const approved = await styleLearning.getVariantPool('viewing_checkin')
    const checkinText = approved.length
      ? approved[Math.floor(Math.random() * approved.length)]
      : VIEWING_CHECKIN_TEMPLATE(dateLabel)
    const sent = await intelligenceGuardedSend(state, styleLearning.stripEmDash(checkinText))
    try { waha.markSentByBackend(sent?.id || sent?.key?.id) } catch { /* best-effort */ }

    const hasLocation = await chatAlreadyHasLocation(state.session, state.chat_id)
    if (!hasLocation) {
      const sentLoc = await intelligenceGuardedSend(state, styleLearning.stripEmDash(VIEWING_LOCATION_ASK_TEMPLATE))
      try { waha.markSentByBackend(sentLoc?.id || sentLoc?.key?.id) } catch { /* best-effort */ }
    }
    await logEvent(stateId, 'viewing_reminder_sent', { propertyId: jobData.propertyId, viewingDate: jobData.viewingDate, locationAlreadyKnown: hasLocation })
    await db.query(
      `UPDATE owner_assistant_state SET status='ARMED', last_action='viewing_reminder', last_action_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [stateId])
  } catch (e) {
    log.warn('ownerAssistant: viewing reminder send failed', { stateId, err: e.message })
    await logEvent(stateId, 'viewing_reminder_send_failed', { err: e.message })
  }
  // Hand back to the ordinary loop -- "nach dem Termin nimmt der normale
  // OG-2-Loop wieder normal auf". Schedule-only: the viewing messages just
  // sent above are already this cycle's real send, so the NEXT check must
  // only be armed, never sent immediately (that was a real bug this file's
  // own proof caught -- see scheduleNextOrdinaryCheckin's own comment).
  await scheduleNextOrdinaryCheckin(stateId, state.owner_contact_id)
}

// Called from handleOwnerMessage (OG-1's inbound hook) alongside
// detectAndSyncOwnerUpdate -- same fire-and-forget, never-consumes shape.
// Pauses the ordinary OG-2 loop for this chat (cancels whatever check-in job
// was pending) and arms a ONE-TIME viewing-reminder job instead.
async function maybeArmViewingReminder({ session, chatId, text, state }) {
  const hit = detectViewingDateMention(text)
  if (!hit) return { armed: false }
  const properties = state.owner_contact_id ? await getLinkedProperties(state.owner_contact_id) : []
  const active = properties.filter(p => p.available_status !== 'rented' && p.available_status !== 'archived')
  const propertyId = active.length === 1 ? active[0].id : null

  const fireAt = new Date(new Date(hit.viewingDate).getTime() - VIEWING_REMINDER_LEAD_DAYS * 86_400_000)
  const delayMs = Math.max(60_000, fireAt.getTime() - Date.now())
  await cancelPendingJob(state.pending_job_id)
  await scheduleCheck(state.id, delayMs, { kind: 'viewing_reminder', viewingDate: hit.viewingDate, propertyId })
  await db.query(
    `UPDATE owner_assistant_state SET status='PAUSED', updated_at=NOW() WHERE id=$1`,
    [state.id])
  await logEvent(state.id, 'viewing_reminder_armed', { viewingDate: hit.viewingDate, phrase: hit.phrase, propertyId, fireAt })
  log.info('ownerAssistant: viewing reminder armed, ordinary loop paused', { stateId: state.id, viewingDate: hit.viewingDate, fireAt })
  return { armed: true, viewingDate: hit.viewingDate, fireAt }
}

// ── Teil B, Flow C: future availability / future contact ────────────────
// "available end October", "tenant leaves November 1", "contact me in 3
// weeks" all name a point in time that should REPLACE the generic 2-3/21-28
// day rhythm for this one cycle, not just be logged and ignored while the
// ordinary loop keeps pinging on its own schedule regardless. Reuses
// services/availability.js's extractTimeframe verbatim (already handles
// month names with a from/until/by marker, "next week/month", "in N
// weeks/months") rather than building a second date-phrase parser — this
// only adds turning that label into an approximate target Date and acting
// on it.
function resolveApproxFutureDate(label) {
  if (!label) return null
  const lower = String(label).toLowerCase().trim()
  if (lower === 'now') return null // "now" is not a future date to plan around
  const now = new Date()
  if (lower === 'next week') return new Date(now.getTime() + 7 * 86_400_000)
  if (lower === 'next month' || lower === 'a month') { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() + 1); return d }
  // Kev, 2026-09-10 (system-wide "digital form" audit): a plausible
  // check-in delay, never an arbitrary Number() -- caps out well past any
  // genuine "come back in N weeks/months" phrasing (52 weeks/24 months),
  // so a mis-parsed digit run can never plant a target decades out.
  const wk = lower.match(/^(\d+)\s*weeks?$/)
  if (wk && Number(wk[1]) >= 1 && Number(wk[1]) <= 52) return new Date(now.getTime() + Number(wk[1]) * 7 * 86_400_000)
  const mo = lower.match(/^(\d+)\s*months?$/)
  if (mo && Number(mo[1]) >= 1 && Number(mo[1]) <= 24) { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() + Number(mo[1])); return d }
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const idx = MONTHS.indexOf(lower)
  if (idx >= 0) {
    let d = new Date(Date.UTC(now.getUTCFullYear(), idx, 1))
    if (d.getTime() <= now.getTime()) d = new Date(Date.UTC(now.getUTCFullYear() + 1, idx, 1))
    return d
  }
  return null
}

// Only when no viewing-specific date was found in the SAME message — a real
// viewing date is the more precise case (services/reminderDetector.js's own
// date arithmetic, exact day) and already owns the reschedule via
// maybeArmViewingReminder above; this must not race it for the same job.
// FUTURE_CONTACT_MIN_DAYS_OUT: a timeframe under a week away is close enough
// that the ordinary loop (or a viewing reminder, if that's what it actually
// is) will reach it naturally — overriding the schedule only earns its keep
// for a genuinely distant date.
const FUTURE_CONTACT_MIN_DAYS_OUT = 7
const FUTURE_CONTACT_LEAD_DAYS = 3
const FUTURE_CONTACT_FAR_THRESHOLD_DAYS = 180
const FUTURE_CONTACT_FAR_LEAD_DAYS = 90
async function maybeScheduleFutureContact({ session, chatId, text, state }) {
  if (!state.owner_contact_id) return { scheduled: false, reason: 'no_owner_link' }
  if (detectViewingDateMention(text)) return { scheduled: false, reason: 'viewing_date_takes_precedence' }
  const availability = require('./availability')
  const timeframe = availability.extractTimeframe(text)
  if (!timeframe) return { scheduled: false, reason: 'no_timeframe' }
  const target = resolveApproxFutureDate(timeframe)
  if (!target) return { scheduled: false, reason: 'unresolvable' }
  const daysOut = (target.getTime() - Date.now()) / 86_400_000
  if (daysOut < FUTURE_CONTACT_MIN_DAYS_OUT) return { scheduled: false, reason: 'too_soon_for_override' }

  const leadDays = daysOut >= FUTURE_CONTACT_FAR_THRESHOLD_DAYS
    ? FUTURE_CONTACT_FAR_LEAD_DAYS
    : FUTURE_CONTACT_LEAD_DAYS
  const fireAt = shiftIntoQuietWindow(new Date(target.getTime() - leadDays * 86_400_000))
  await db.query(`UPDATE owner_contacts SET next_reach_at = $2, updated_at = NOW() WHERE id = $1`, [state.owner_contact_id, fireAt])
  const delayMs = Math.max(60_000, fireAt.getTime() - Date.now())
  await cancelPendingJob(state.pending_job_id)
  await scheduleCheck(state.id, delayMs)
  await logEvent(state.id, 'future_contact_scheduled', { timeframe, target, fireAt, leadDays })
  log.info('ownerAssistant: future contact scheduled, ordinary rhythm overridden', { stateId: state.id, timeframe, target, fireAt, leadDays })
  return { scheduled: true, timeframe, target, fireAt, leadDays }
}

// Schedule-only half, split out from the actual send (below) specifically
// so "resume the ordinary loop after a viewing reminder fires" can call
// JUST this -- reusing the full send-and-reschedule function there was a
// real bug caught by this file's own proof: it fired an extra, unwanted
// third "still on the market?" message immediately after the two viewing
// messages, every single time a reminder resolved.
async function scheduleNextOrdinaryCheckin(stateId, ownerContactId) {
  const listed = ownerContactId ? await isCurrentlyListed(ownerContactId) : false
  const row = await db.query(`SELECT checkin_min_days, checkin_max_days FROM owner_assistant_state WHERE id = $1`, [stateId])
  const override = row.rows[0] ? { minDays: row.rows[0].checkin_min_days, maxDays: row.rows[0].checkin_max_days } : null
  const delayMs = computeNextCheckinDelayMs(listed, override)
  const point = shiftIntoQuietWindow(new Date(Date.now() + delayMs))
  await scheduleCheck(stateId, Math.max(60_000, point.getTime() - Date.now()))
}

// ── OGX-2: per-owner check-in rhythm override, set from the CRM ─────────
async function setRhythmOverride(stateId, { minDays, maxDays } = {}) {
  const clean = (minDays == null && maxDays == null) ? [null, null] : [minDays, maxDays]
  await db.query(
    `UPDATE owner_assistant_state SET checkin_min_days = $2, checkin_max_days = $3, updated_at = NOW() WHERE id = $1`,
    [stateId, clean[0], clean[1]])
  await logEvent(stateId, 'rhythm_updated', { minDays: clean[0], maxDays: clean[1] })
}

// ── Kev, 2026-09-10: frustration-based cadence extension ─────────────────
// "Zeigt ein Owner Anzeichen von Verärgerung ... die LANGFRISTIGE Kontakt-
// Kadenz für DIESEN Owner wird vorsichtig von 25 auf 40 Tage verlängert."
// Deliberately separate from -- and additive to -- the EXISTING "pause this
// one conversation immediately" rule (autoOwnerConversation.js's own Point I
// / detectFrustration, unchanged, untouched). That rule reacts to the
// owner_auto_conversations row; this reacts to the completely independent
// owner_assistant_state row for the SAME owner/phone, per this file's own
// "never share a row or a code path" contract. Called from
// autoOwnerConversation.js's Point I handler, fire-and-forget, by phone --
// the two systems have no shared chat_id/session key, only the owner's
// phone number in common, so owner_contacts is the join.
//
// One-shot by construction: an owner already at/above the 40-day cadence
// (whether from a prior frustration signal or a wider manual override an
// admin already set) is left alone -- a second frustration signal can never
// keep stacking the cadence wider and wider, and this never SHRINKS an
// admin's own already-wider choice.
async function extendCadenceOnFrustrationByPhone(phone) {
  const ownerPhone = String(phone || '').replace(/@.*/, '')
  const ownerContact = await resolveOwnerContactByPhone(ownerPhone)
  if (!ownerContact) return { extended: false, reason: 'no_owner_contact_match' }

  const states = (await getStatesByOwnerContactId(ownerContact.id)).filter(s => s.enabled)
  if (!states.length) return { extended: false, reason: 'no_active_owner_assistant' }

  const results = []
  for (const state of states) {
    if (Number.isFinite(state.checkin_max_days) && state.checkin_max_days >= CADENCE_FRUSTRATION_MAX_DAYS) {
      results.push({ stateId: state.id, extended: false, reason: 'already_wide_enough' })
      continue
    }

    const previous = { minDays: state.checkin_min_days, maxDays: state.checkin_max_days }
    await setRhythmOverride(state.id, { minDays: CADENCE_FRUSTRATION_MIN_DAYS, maxDays: CADENCE_FRUSTRATION_MAX_DAYS })
    await logEvent(state.id, 'cadence_extended_frustration', {
      previous, newMinDays: CADENCE_FRUSTRATION_MIN_DAYS, newMaxDays: CADENCE_FRUSTRATION_MAX_DAYS,
    })

    // Reschedule the currently-pending ordinary check-in too -- otherwise a
    // freshly-frustrated owner could still get contacted on the OLD
    // (shorter) schedule before the wider cadence ever gets a chance to
    // apply. Only for the ordinary ARMED loop; a HUMAN_ACTIVE/PAUSED state
    // has no ordinary check-in pending right now and will pick up the new
    // override the next time it DOES compute one (every call re-reads
    // checkin_min_days/max_days fresh from the DB).
    if (state.status === 'ARMED' && state.pending_job_id) {
      await cancelPendingJob(state.pending_job_id)
      await scheduleNextOrdinaryCheckin(state.id, ownerContact.id)
    }

    await notifyControl(state.session,
      `😤 *OWNERGROUPS* — frustration signal detected, check-in cadence widened 25→40 days (O${state.id})\n` +
      `Chat: ${state.chat_id}\nAccount: ${state.session}\nOwner: ${ownerContact.name || ownerPhone}`)
    log.info('ownerAssistant: cadence extended after frustration signal', { stateId: state.id, ownerContactId: ownerContact.id })
    results.push({ stateId: state.id, extended: true })
  }
  return { extended: results.some(r => r.extended), results }
}

// ── OGX-2: manual "price-flexibility follow-up" send, triggered from the CRM ─
// Generic fallback only — used when this owner has no single active
// property to name a real price/town from. The brief is explicit that this
// one-time action must NOT be a generic question that ignores the chat
// ("KEINE generische Frage die den Chat ignoriert"); buildPriceFlexText()
// below composes the real, property-specific version whenever it can.
const PRICE_FLEX_FOLLOWUP_TEXT =
  'Hi, hope you are well. Quick one — given how the market has been, would you be open to a bit of flexibility on the price if it helps close a good tenant faster?'

// Deterministic context interpolation, not an LLM call — same "reliability
// over clever AI behaviour" choice this codebase already makes everywhere
// else outbound owner text gets composed (see clientAssistant.js's own
// composeIntroText header, and this file's pickCheckinText above). The
// property's own price/town are the context that actually makes this read
// as specific rather than generic; a full generative rewrite is not needed
// to satisfy "formulated from context, not a canned question".
async function buildPriceFlexText(state) {
  if (!state.owner_contact_id) return PRICE_FLEX_FOLLOWUP_TEXT
  const properties = await getLinkedProperties(state.owner_contact_id)
  const active = properties.filter(p => p.available_status === 'available' || p.available_status === 'available_confirmed')
  if (active.length !== 1 || active[0].longlet_price == null) return PRICE_FLEX_FOLLOWUP_TEXT
  const p = active[0]
  const price = Number(p.longlet_price).toLocaleString('en-GB')
  return `Hi, hope you are well. Quick one on the ${p.town || 'listing'} place at €${price}/month — ` +
    `given how the market has been, would you be open to a bit of flexibility on the price if it helps close a good tenant faster?`
}
async function sendPriceFlexFollowup(state) {
  const styleLearning = require('./styleLearning')
  const text = styleLearning.stripEmDash(await buildPriceFlexText(state))
  const sent = await intelligenceGuardedSend(state, text)
  try { waha.markSentByBackend(sent?.id || sent?.key?.id) } catch { /* best-effort */ }
  await db.query(
    `UPDATE owner_assistant_state SET last_action = $2, last_action_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [state.id, text])
  await logEvent(state.id, 'price_flex_followup_sent', { text })
  return { ok: true }
}

// ── OGX-2: re-enable from the CRM (mirrors handleToggleCommand's own
// re-enable branch, minus the chat-driven owner-resolution -- the state row
// already has owner_contact_id/owner_phone by the time an admin can see it
// in the dashboard) ───────────────────────────────────────────────────────
async function enable(state) {
  // Flow E: same refusal as handleToggleCommand's own guard -- the CRM
  // button and the `!o` WhatsApp command are two doors onto the exact same
  // mutation, so they share the exact same gate, not two copies of it.
  if (state.owner_contact_id && await isDoNotContact(state.owner_contact_id)) {
    log.info('ownerAssistant: CRM enable refused, owner is do-not-contact', { stateId: state.id, ownerContactId: state.owner_contact_id })
    return { ok: false, reason: 'do_not_contact' }
  }
  await db.query(
    `UPDATE owner_assistant_state SET enabled = TRUE, status = 'ENABLED', disabled_at = NULL, disabled_reason = NULL, updated_at = NOW() WHERE id = $1`,
    [state.id])
  try {
    const listed = state.owner_contact_id ? await isCurrentlyListed(state.owner_contact_id) : false
    const row = await db.query(`SELECT checkin_min_days, checkin_max_days FROM owner_assistant_state WHERE id = $1`, [state.id])
    const override = row.rows[0] ? { minDays: row.rows[0].checkin_min_days, maxDays: row.rows[0].checkin_max_days } : null
    const delayMs = computeNextCheckinDelayMs(listed, override)
    const point = shiftIntoQuietWindow(new Date(Date.now() + delayMs))
    await scheduleCheck(state.id, Math.max(60_000, point.getTime() - Date.now()))
    await db.query(`UPDATE owner_assistant_state SET status = 'ARMED', updated_at = NOW() WHERE id = $1`, [state.id])
  } catch (e) {
    log.warn('ownerAssistant: could not arm the check-in loop on CRM re-enable', { stateId: state.id, err: e.message })
  }
  await notifyControl(state.session,
    `🔄 *OWNERGROUPS* — Owner Assistant re-enabled from the CRM (O${state.id})\nChat: ${state.chat_id}\nAccount: ${state.session}`)
  return { ok: true }
}

async function runOrdinaryCheckin(stateId, state) {
  const listed = state.owner_contact_id ? await isCurrentlyListed(state.owner_contact_id) : false
  const purpose = listed ? 'checkin_listed' : 'checkin_unlisted'
  const fallback = listed ? FALLBACK_CHECKIN_LISTED : FALLBACK_CHECKIN_UNLISTED
  const text = await pickCheckinText(purpose, fallback, state.last_action)

  try {
    const styleLearning = require('./styleLearning')
    const sent = await intelligenceGuardedSend(state, styleLearning.stripEmDash(text))
    try { waha.markSentByBackend(sent?.id || sent?.key?.id) } catch { /* best-effort */ }
    await db.query(
      `UPDATE owner_assistant_state SET status='ARMED', last_action=$2, last_action_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [stateId, text])
    await logEvent(stateId, 'checkin_sent', { listed, purpose })
  } catch (e) {
    log.warn('ownerAssistant: check-in send failed', { stateId, err: e.message })
    await logEvent(stateId, 'checkin_send_failed', { err: e.message })
  }

  // !upload two-package output (Kev, 2026-09-08): "opportunistic address
  // backfill" side effect of routine outreach. This IS that routine pass —
  // the `!o` check-in loop already touches every listed property on its
  // own 4-6 day rhythm regardless of whether the account originally
  // assigned to upload it was live that day. services/ownerChatFieldFill.js's
  // own scanAndFillForProperty() already no-ops cheaply (one query, no
  // Gemini call) when nothing is missing, and already degrades gracefully
  // when no WA account currently has a live session for this owner — so
  // this is just "call it opportunistically", not new gap-detection logic.
  // Fire-and-forget, AFTER the check-in send above: this must never delay,
  // block, or change the actual outreach message.
  if (listed && state.owner_contact_id) {
    getLinkedProperties(state.owner_contact_id).then(props => {
      const active = props.find(p => p.available_status === 'available' || p.available_status === 'available_confirmed')
      if (!active) return
      const chatFieldFill = require('./ownerChatFieldFill')
      return chatFieldFill.scanAndFillForProperty(active.id)
    }).then(r => {
      if (r && r.filled) log.info('ownerAssistant: opportunistic address backfill', { stateId, filled: r.filled, ref: r.ref })
    }).catch(e => log.debug('ownerAssistant: opportunistic address backfill skipped', { stateId, err: e.message }))
  }

  await scheduleNextOrdinaryCheckin(stateId, state.owner_contact_id)
}

// The 'owner-assistant' queue's processor body (worker.js registers this,
// passing the FULL job payload as `jobData` -- OG-3 addition, needed to
// tell a viewing-reminder job apart from an ordinary check-in without a
// second queue). Evaluate -> maybe send -> always reschedule, same
// "continuous adaptive loop, never a one-shot" shape as clientAssistant.js's
// own runProactiveCheck().
// Owner Profile V2, Teil B (Kev, 2026-09-08), Flow E hard gate: this was the
// one automated flow in the whole codebase that never checked
// owner_contacts.do_not_contact -- scheduledOutreach.js and
// availabilityReachout.js's auto-scan both already gate on it (see their own
// `COALESCE(oc.do_not_contact, false) = false` clauses), but this file's
// own `!o` check-in/viewing-reminder loop had no such check anywhere, so a
// DNC owner could still receive a scheduled "still on the market?" message.
// Checked here, in the ONE place every scheduled job (ordinary check-in AND
// viewing reminder) passes through, so no future job kind can reintroduce
// the gap by forgetting to check it itself. Does not touch enabled/status --
// a DNC owner's automation stays "armed" in the DB (a human can inspect why
// nothing is sending), it just never actually sends anything, and the
// pending job is not rescheduled, so the loop goes quiet until DNC lifts and
// a human explicitly re-enables it (reactivation is deliberately never
// automatic here, matching the brief's "Reaktivierung muss explizit sein").
async function isDoNotContact(ownerContactId) {
  if (!ownerContactId) return false
  const r = await db.query(`SELECT do_not_contact FROM owner_contacts WHERE id = $1`, [ownerContactId])
  return !!r.rows[0]?.do_not_contact
}

async function runCheck(stateId, jobData = {}) {
  const state = await getStateById(stateId)
  if (!state || !state.enabled) return

  // resume_check is the one job kind that is SUPPOSED to fire while status
  // is still HUMAN_ACTIVE (that is its entire purpose) -- it must be
  // resolved before the general eligibility gate below, or the gate would
  // discard it every time, and the fix would fix nothing.
  if (jobData.kind === 'resume_check') {
    if (await isDoNotContact(state.owner_contact_id)) {
      log.info('ownerAssistant: resume_check skipped, owner is do-not-contact', { stateId, ownerContactId: state.owner_contact_id })
      await logEvent(stateId, 'skipped_do_not_contact', { jobKind: 'resume_check' })
      return
    }
    await resumeFromHumanTakeover(stateId)
    return
  }

  if (state.status === 'HUMAN_ACTIVE' || state.status === 'PAUSED' || state.status === 'DISABLED') {
    log.debug('ownerAssistant: runCheck skipped, status not eligible', { stateId, status: state.status })
    return
  }
  if (await isDoNotContact(state.owner_contact_id)) {
    log.info('ownerAssistant: runCheck skipped, owner is do-not-contact', { stateId, ownerContactId: state.owner_contact_id })
    await logEvent(stateId, 'skipped_do_not_contact', { jobKind: jobData.kind || 'checkin' })
    return
  }

  // CONTACT PAUSE (2026-09-21): "do not contact until <date>" on the owner or on
  // one of their listings — the check-in is proactive contact, so it waits. One
  // shared gate (services/ownerSendGate.js), not a second pause check.
  {
    const gate = await require('./ownerSendGate').checkOwnerSend({
      phone: state.owner_phone, ownerId: state.owner_contact_id, kind: 'followup', automated: true,
    })
    if (!gate.allow) {
      log.info('ownerAssistant: runCheck skipped by pre-send gate', { stateId, reason: gate.reason })
      await logEvent(stateId, 'skipped_pre_send_gate', { jobKind: jobData.kind || 'checkin', reason: gate.reason })
      return
    }
  }

  if (jobData.kind === 'viewing_reminder') {
    await runViewingReminder(stateId, state, jobData)
    return
  }
  await runOrdinaryCheckin(stateId, state)
}

module.exports = {
  TOGGLE_TOKEN,
  isToggleTrigger,
  controlChannel,
  notifyControl,
  getState,
  getStateById,
  getStatesByOwnerContactId,
  getLinkedProperties,
  getOwnerContactForProperty,
  resolveOwnerContactByPhone,
  logEvent,
  cancelPendingJob,
  scheduleCheck,
  handleToggleCommand,
  disable,
  enable,
  setRhythmOverride,
  sendPriceFlexFollowup,
  handleHumanMessage,
  handleOwnerMessage,
  runCheck,
  // OG-2, exported for the Level-2 proof (real behavior, not re-derived assertions)
  isCurrentlyListed,
  computeNextCheckinDelayMs,
  shiftIntoQuietWindow,
  detectAndSyncOwnerUpdate,
  CHECKIN_LISTED_MIN_DAYS,
  CHECKIN_LISTED_MAX_DAYS,
  CHECKIN_UNLISTED_MIN_DAYS,
  CHECKIN_UNLISTED_MAX_DAYS,
  // OG-3, exported for the Level-2 proof
  detectViewingDateMention,
  chatAlreadyHasLocation,
  maybeArmViewingReminder,
  runViewingReminder,
  VIEWING_REMINDER_LEAD_DAYS,
  // Teil B, exported for the Level-2 proof
  isDoNotContact,
  soundsOwnerWide,
  resolveApproxFutureDate,
  maybeScheduleFutureContact,
  FUTURE_CONTACT_MIN_DAYS_OUT,
  FUTURE_CONTACT_LEAD_DAYS,
  FUTURE_CONTACT_FAR_THRESHOLD_DAYS,
  FUTURE_CONTACT_FAR_LEAD_DAYS,
  resumeFromHumanTakeover,
  HUMAN_QUIET_MS,
  buildPriceFlexText,
  // Kev, 2026-09-10 (Owner-Kadenz), exported for the Level-2 proof
  autoActivateOnOwnerReply,
  extendCadenceOnFrustrationByPhone,
  CADENCE_FRUSTRATION_MIN_DAYS,
  CADENCE_FRUSTRATION_MAX_DAYS,
}
