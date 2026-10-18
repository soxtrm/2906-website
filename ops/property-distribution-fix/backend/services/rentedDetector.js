'use strict'
// ============================================================================
// rentedDetector.js — mark a `properties` listing rented when somebody reacts
// with 😡 / 😠 / 🤬 to the bot's stored category-group listing message, or
// replies to that exact message with "rented" / "schon vermietet" /
// "letzter Tag" (or the English equivalents).
//
// Thin wrapper: every decision is delegated to services/rentedPlan.js so the
// pure logic is unit-testable without a DB or WAHA stub. This file only
// gathers state and applies the side-effects.
//
// Privacy:
//   * Admin text never includes owner phone / email / street / apt.
//   * Only the public ref (`#2906-050`) is echoed back to the admin.
//   * The raw sender phone is recorded only inside the property_activities
//     JSONB column, scoped to a matching agent, never echoed elsewhere.
// ============================================================================

const config = require('../config')
const db = require('../db')
const waha = require('../waha')
const log = require('../logger')
const { cancelAllPending } = require('./killSwitch')
const { syncInventoryTab } = require('./googleAgentSheet')
const plan = require('./rentedPlan')
const { quotedFromPayload } = require('../lib/quotedMessage')
const { withPropertyLink, withAvailableActions } = require('./agentPropertyLinks')

// Known bot session phones — these are the only senders we ever ignore, to
// guard against a future self-reaction path. Kept as a Set so the plan
// helper's `isBotSender` predicate can use it directly.
const BOT_SESSION_PHONES = new Set([
  '35699811819',
  '35699270699',
  '35699655034',
])

// ── Lookup ─────────────────────────────────────────────────────────────────

async function lookupCategoryListing(messageId, chatId = null) {
  if (!messageId) return null
  const r = await db.query(
    `SELECT pps.property_id, p.ref, p.available_status,
            p.town, p.longlet_price, p.sale_price,
            pps.target_ref, pps.external_ref
       FROM property_publishing_status pps
       JOIN properties p ON p.id = pps.property_id
      WHERE pps.channel IN ('category_groups', 'category_groups_agent')
        AND pps.status = 'posted'
        AND pps.external_ref = $1
        AND ($2::text IS NULL OR pps.target_ref = $2)
      LIMIT 1`,
    [messageId, chatId],
  )
  return r.rows[0] || null
}

function rentedConfirmation(row) {
  const price = row?.longlet_price || row?.sale_price
  const priceLabel = price ? `€${Number(price).toLocaleString()}` : '?'
  return `❌ RENTED\n#${row.ref} · ${row.town || '?'} · ${priceLabel}\nRemoved from active inventory.`
}

async function sendRentedConfirmation({ session, chatId, replyToMessageId, row }) {
  if (!session || !chatId || !row?.ref) return null
  return waha.sendText(session, chatId, rentedConfirmation(row), { replyToMessageId })
}

// ── Public entry points (thin) ─────────────────────────────────────────────

async function processReaction(reactionData = {}) {
  const { senderPhone, messageId, reactionEmoji, session, chatId } = reactionData

  const decision = plan.decisionForReaction({
    senderPhone,
    reactionEmoji,
    botPhones: BOT_SESSION_PHONES,
  })
  if (decision.kind !== 'mark') {
    log.debug('processReaction: skip', { reason: decision.reason })
    return { skipped: decision.reason }
  }

  const lookupRow = await lookupCategoryListing(messageId, chatId || null)
  if (!lookupRow) {
    log.debug('processReaction: no matching posted listing', { messageId })
    return { skipped: 'unknown_target' }
  }
  if (lookupRow.available_status === 'rented') {
    log.debug('processReaction: already rented', {
      propertyId: lookupRow.property_id,
      ref: lookupRow.ref,
    })
    return { skipped: 'already_rented' }
  }
  // Kev's 2026-09-16 follow-up: reverted back to a direct auto-mark (see
  // rentedPlan.js's own comment) — the angry emoji is a live !rented
  // shortcut he actually uses, not something to gate behind extra text.
  const result = await markRented(lookupRow.property_id, lookupRow.ref, senderPhone, session, lookupRow)
  if (result.marked && chatId) {
    await sendRentedConfirmation({ session, chatId, replyToMessageId: messageId, row: lookupRow })
  }
  return result
}

async function processReply(replyData = {}) {
  const { senderPhone, parentMessageId, replyText, session, chatId, triggerMessageId } = replyData

  const decision = plan.decisionForReply({
    senderPhone,
    text: replyText,
    botPhones: BOT_SESSION_PHONES,
  })
  if (decision.kind === 'skip') {
    log.debug('processReply: skip', { reason: decision.reason })
    return { skipped: decision.reason }
  }

  const lookupRow = await lookupCategoryListing(parentMessageId, chatId || null)
  if (!lookupRow) {
    log.debug('processReply: no matching posted listing', { parentMessageId })
    return { skipped: 'unknown_target' }
  }

  // Kev, 2026-09-01 ("Duplicate Listing" option): a duplicate reply is
  // handled entirely separately from the rented path below -- it never
  // checks/touches available_status at all, on purpose (a duplicate is not
  // a rented property, and the underlying real listing this one might be a
  // copy of is never identified or touched here either -- only the exact
  // ref that was replied to).
  if (decision.kind === 'duplicate') {
    return markDuplicate(lookupRow.property_id, lookupRow.ref, senderPhone, session)
  }

  if (lookupRow.available_status === 'rented') {
    log.debug('processReply: already rented', {
      propertyId: lookupRow.property_id,
      ref: lookupRow.ref,
    })
    if (chatId) {
      await waha.sendText(
        session,
        chatId,
        `ℹ️ #${lookupRow.ref} is already marked RENTED.`,
        { replyToMessageId: triggerMessageId || parentMessageId },
      )
    }
    return { skipped: 'already_rented' }
  }
  const result = await markRented(
    lookupRow.property_id,
    lookupRow.ref,
    senderPhone,
    session,
    lookupRow,
    { source: 'quoted_reply', trigger: decision.trigger },
  )
  if (result.marked && chatId) {
    await sendRentedConfirmation({
      session,
      chatId,
      replyToMessageId: triggerMessageId || parentMessageId,
      row: lookupRow,
    })
  }
  return result
}

// ── Duplicate Listing (Kev, 2026-09-01) ────────────────────────────────────
// Admin/Kev: the ref is deleted outright, Board + CRM in one row (the board
// is a live query over `properties`, so removing the row removes it from
// both surfaces at once). Agent: never deletes -- hides from the board
// (duplicate_flagged excluded from every board query, see
// routes/crmScheduleBoard.js) and marks the CRM entry unpublic, leaving a
// clear, queryable trail (?duplicate_flagged=1) for Kev to review and
// delete himself. Neither path ever writes available_status.
const ADMIN_NUMBERS = new Set((config.admin?.adminNumbers || []).map(n => String(n).replace(/\D/g, '')))
function isAdminSender(phone) {
  return ADMIN_NUMBERS.has(String(phone || '').replace(/\D/g, ''))
}

async function resolveAgentForFlag(senderPhone) {
  const digits = String(senderPhone || '').replace(/\D/g, '')
  if (!digits) return null
  const candidates = [digits]
  if (digits.length === 8 && /^[79]/.test(digits)) candidates.push('356' + digits)
  const r = await db.query(
    `SELECT id FROM agents WHERE whatsapp_phones && $1::text[] AND active = TRUE LIMIT 1`,
    [candidates])
  return r.rows[0] || null
}

async function markDuplicate(propertyId, ref, senderPhone, session) {
  const admin = isAdminSender(senderPhone)

  if (admin) {
    await db.query('DELETE FROM properties WHERE id = $1', [propertyId])
    log.info('markDuplicate: admin deleted duplicate listing', { propertyId, ref })
    await waha.sendText(session, config.admin.botNumber,
      `🗑️ #${ref} deleted as a duplicate listing — removed from the Schedule Board and the CRM.`)
    return { duplicateDeleted: true, ref }
  }

  const agentRow = await resolveAgentForFlag(senderPhone)
  await db.query(
    `UPDATE properties
        SET published = FALSE, duplicate_flagged = TRUE,
            duplicate_flagged_at = NOW(), duplicate_flagged_by_agent_id = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [propertyId, agentRow?.id || null])
  await db.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant, created_at)
     VALUES ($1, $2, 'flagged_duplicate', $3::jsonb, TRUE, NOW())`,
    [propertyId, agentRow?.id || null, JSON.stringify({
      source: 'quoted_reply', trigger: 'duplicate', timestamp: new Date().toISOString(),
    })])
  log.info('markDuplicate: agent flagged duplicate listing', { propertyId, ref, agentId: agentRow?.id || null })
  await waha.sendText(session, config.admin.botNumber,
    `🟡 #${ref} flagged as a possible duplicate by an agent — hidden from the Schedule Board, marked unpublic. Review with ?duplicate_flagged=1 and delete once confirmed.`)
  return { duplicateFlagged: true, ref }
}

// ── Side-effect applier ────────────────────────────────────────────────────
//
// Exported so the unit-test contract (`svc.markRented(...)`) can target the
// side-effect applier directly. The signature requires a `lookupRow` so a
// bare `markRented(id, ref, phone, session)` call without a prior category-
// listing match refuses to act (throws) — protecting us from accidentally
// flipping a property whose posted listing we never confirmed.
//
// Defect 2 (prior version): the atomic-claim branch used
//     if (!claimed.rowCount && !claimed.rows?.length)
// which is always false (both operands evaluate to false) and therefore
// never short-circuited to "already_rented". The correct guard is just
// `if (!claimed.rows.length)`.
async function markRented(propertyId, ref, senderPhone, session, lookupRow, extra = {}) {
  if (!lookupRow || !lookupRow.property_id) {
    throw new Error(
      'markRented: lookupRow is required (call processReaction / processReply first)',
    )
  }
  if (lookupRow.property_id !== propertyId) {
    throw new Error('markRented: lookupRow.property_id does not match propertyId')
  }

  log.info('markRented', {
    propertyId,
    ref,
    sender: senderPhone ? senderPhone.slice(-4) : null,
    source: extra.source || 'group_reaction',
    trigger: extra.trigger || null,
  })

  // ── Atomic claim: flip properties.available_status to 'rented' only if it
  // is currently anything other than 'rented'. RETURNING id tells us whether
  // the row actually transitioned (vs. a concurrent winner already rented it).
  const claimed = await db.query(
    `UPDATE properties
        SET available_status = 'rented', updated_at = NOW()
      WHERE id = $1 AND available_status IS DISTINCT FROM 'rented'
      RETURNING id`,
    [propertyId],
  )
  if (!claimed.rows.length) {
    // Re-entry guard: a concurrent detector already won the race.
    return { skipped: 'already_rented' }
  }

  // Kev's Prompt C, event PROPERTY RENTED — the automatic path fires this
  // just as much as an agent's own click, so it gets the same invalidation.
  require('./matchEngine').invalidateMatchesForProperty(propertyId, 'rentedDetector')
    .catch(err => log.warn('rentedDetector: match invalidation failed', { propertyId, err: err.message }))

  // ── Record the trigger evidence in property_activities ────────────────
  // Live schema: (property_id, agent_id, activity_type, details, is_significant).
  // `details` carries the source so we never need to leak the raw sender
  // phone into the public surface.
  //
  // The agent lookup is a scalar subquery, NOT the driving table. It used to be
  // `INSERT … SELECT … FROM agents WHERE a.whatsapp_phones && $2` — which
  // inserts ZERO rows whenever the sender is not one of our agents, and in a
  // category group the sender is usually a landlord or an outside agent. The
  // result: every rented flip through this path went completely unlogged
  // (property_activities held 0 status rows on 2026-08-12 despite 3 rented
  // listings). The status change is the thing worth recording; who triggered it
  // is a nice-to-have and NULL is an honest answer.
  await db.query(
    `INSERT INTO property_activities
       (property_id, agent_id, activity_type, details, is_significant, created_at)
     VALUES ($1,
             (SELECT a.id FROM agents a
               WHERE a.whatsapp_phones && $2::text[]
               ORDER BY a.id ASC LIMIT 1),
             'marked_rented_via_group',
             $3::jsonb, TRUE, NOW())`,
    [propertyId,
     senderPhone ? [senderPhone] : [],
     JSON.stringify({
       source: extra.source || 'group_reaction',
       // 'emoji' for the 😡 reaction, 'owner_reply' for a quoted "rented" —
       // the same changed_by vocabulary the manual buttons and the AI path use.
       changed_by: extra.source === 'quoted_reply' ? 'owner_reply' : 'emoji',
       trigger: extra.trigger || null,
       old_status: lookupRow.available_status || null,
       new_status: 'rented',
       timestamp: new Date().toISOString(),
     })],
  )

  // ── Cancel future publishing for this property ────────────────────────
  // cancelAllPending also sets properties.published=FALSE (kills the website
  // listing) and removes any queued FB jobs.
  const result = await cancelAllPending(propertyId, 'marked_rented_via_group_reaction')

  // ── Privacy-respecting admin alert ────────────────────────────────────
  // Only the public ref + a count of cancellations. NEVER owner phone,
  // email, street, or apartment number.
  await waha.sendText(
    session,
    config.admin.botNumber,
    withPropertyLink(`🔴 #${ref} marked as RENTED\n` +
      `${result.cancelledFb || 0} pending Facebook posts cancelled\n` +
      (result.unpublishedWeb ? 'Website listing unpublished' : 'No website listing to unpublish'), ref),
  )

  // Fire-and-forget sheet sync — errors logged inside.
  syncInventoryTab().catch(err => log.error('markRented: sheet sync failed', err.message))
  return { marked: true }
}

// ── !rented command (Kev's 2026-09-15 hotfix, spec items 4+16) ─────────────
// "I often personally talk to Owners and discover something is rented. I
// should NOT need to open CRM manually." A THIRD way to reach markRented()
// above -- not a second implementation of what "rented" means. The other
// two paths (emoji reaction, quoted "rented" text) already funnel through
// it; this just adds an explicit admin command with its own target
// resolution, reusing lookupCategoryListing for the reply case and a plain
// ref lookup for the "!rented 2906-9276" case.
// Unambiguous-or-nothing lookup used by the reply-context / DM fallbacks below.
// `rows` are live listings (ref set, not rented/archived). Exactly one → that
// property; several → { ambiguous } so the caller lists them instead of
// guessing; none → null.
function _pickUnique(rows) {
  if (!rows || !rows.length) return null
  if (rows.length === 1) return rows[0]
  return { ambiguous: rows }
}

const _LIVE_PROP = `p.ref IS NOT NULL AND COALESCE(p.available_status,'') NOT IN ('rented','archived')`

async function _liveByOwnerPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 8) return null
  const r = await db.query(
    `SELECT p.id AS property_id, p.ref, p.available_status, p.town
       FROM properties p
       JOIN owner_contacts oc ON oc.id = p.owner_id
      WHERE ${_LIVE_PROP}
        AND (right(regexp_replace(COALESCE(oc.phone_normalized,''),'\\D','','g'), 8) = $1
             OR right(regexp_replace(COALESCE(p.listed_by_phone,''),'\\D','','g'), 8) = $1)
      ORDER BY p.id DESC LIMIT 6`,
    [digits.slice(-8)])
  return _pickUnique(r.rows)
}

// "!rented Alex F Mosta": every word must start a word in owner name / town.
async function _liveByNameTown(words) {
  const toks = words.map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).slice(0, 5)
  if (!toks.length) return null
  const conds = toks.map((_, i) => `(COALESCE(oc.name,'') || ' ' || COALESCE(p.town,'') || ' ' || COALESCE(p.sub_location,'')) ~* $${i + 1}`)
  const r = await db.query(
    `SELECT p.id AS property_id, p.ref, p.available_status, p.town
       FROM properties p
       LEFT JOIN owner_contacts oc ON oc.id = p.owner_id
      WHERE ${_LIVE_PROP} AND ${conds.join(' AND ')}
      ORDER BY p.id DESC LIMIT 6`,
    toks.map(t => '\\m' + t))
  return _pickUnique(r.rows)
}

async function _byRef(refToken) {
  const raw = String(refToken).replace(/^#/, '')
  const ref = /^\d{1,6}$/.test(raw) ? `2906-${raw.padStart(3, '0')}` : raw
  const r = await db.query(
    `SELECT id AS property_id, ref, available_status FROM properties WHERE ref = $1 LIMIT 1`, [ref])
  return r.rows[0] || null
}

// REGRESSION FIX (Kev, 2026-09-23, ARGUS file-first hotfix): the canonical
// `!rented REF` and the reply form only resolved through two exact channels —
// a bare ref (nothing else allowed in the text) or the quoted message's id in
// property_publishing_status. A reply to the owner's PDF/upload message, to a
// bot confirmation card, or a command carrying the owner's name/town matched
// neither, so it died with "Usage:". Same command, same syntax — the target
// resolution now also reads: a ref anywhere in the text or quoted body, the
// owner phone in the quoted body / DM chat, and owner-name+town words. Any
// fallback that yields more than one live property returns { ambiguous }.
async function resolveRentedTarget({ text, quotedMessageId, quotedBody, chatId, mode }) {
  // !available restores rented rows, so the "live listing" fallbacks below
  // (which exclude rented/archived) do not apply — ref / message-id only.
  const refOnly = mode === 'available'
  const arg = String(text || '').replace(/^!(rented|available)\s*/i, '').trim()

  // 1. explicit ref (bare, or embedded: "!rented #2906-9276 thanks")
  const bare = arg.match(/^#?(2906-\d{2,6}|\d{1,6})$/i)
  if (bare) return _byRef(bare[1])
  const embedded = arg.match(/(?:^|[\s#])(2906-\d{2,6})\b/i)
  if (embedded) return _byRef(embedded[1])

  // 2. reply-context by message id (posted listings)
  if (quotedMessageId) {
    const viaCategory = await lookupCategoryListing(quotedMessageId, chatId || null)
    if (viaCategory) return viaCategory
    // Broader fallback: category_groups is the one channel CONFIRMED to
    // populate external_ref reliably, but any other publishing channel that
    // happens to record the same message id resolves the same way here —
    // one lookup, not a per-channel copy.
    const r = await db.query(
      `SELECT pps.property_id, p.ref, p.available_status
         FROM property_publishing_status pps
         JOIN properties p ON p.id = pps.property_id
        WHERE pps.external_ref = $1
        ORDER BY pps.posted_at DESC NULLS LAST LIMIT 1`,
      [quotedMessageId])
    if (r.rows[0]) return r.rows[0]
  }

  // 3. reply-context by the quoted text (bot cards carry the ref; owner PDFs /
  //    forwarded listings carry the owner's phone)
  if (refOnly) return null
  if (quotedBody) {
    const qr = String(quotedBody).match(/(?:^|[\s#])(2906-\d{2,6})\b/i)
    if (qr) { const hit = await _byRef(qr[1]); if (hit) return hit }
    const ph = String(quotedBody).match(/(?:\+|00)?\s?(356\s?)?([79]\d{3}\s?\d{4})\b/)
    if (ph) { const hit = await _liveByOwnerPhone(ph[2]); if (hit) return hit }
  }

  // 4. free words after the command: owner name / town
  if (arg) {
    const hit = await _liveByNameTown(arg.split(/\s+/))
    if (hit) return hit
  }

  // 5. the command was typed inside an owner's own 1:1 chat
  const dm = String(chatId || '').match(/^(\d{8,15})@c\.us$/)
  if (dm) { const hit = await _liveByOwnerPhone(dm[1]); if (hit) return hit }

  return null
}

// Shared "couldn't resolve / several match" reply for !rented and !available.
async function _replyUnresolved(sessionRouter, session, chatId, target, cmdName) {
  if (target && target.ambiguous) {
    const list = target.ambiguous.map(r => `• #${r.ref}${r.town ? ' · ' + r.town : ''}`).join('\n')
    await sessionRouter.sendVia(session, chatId,
      `❓ More than one listing matches — send !${cmdName} with the exact ref:\n${list}`)
    return
  }
  await sessionRouter.sendVia(session, chatId,
    `❌ Usage: !${cmdName} [ref]  or reply to a property/listing message with !${cmdName}`)
}

async function handleRentedCommand(payload, session, senderPhone) {
  const sessionRouter = require('../lib/sessionRouter')
  const chatId = payload.from
  const text = (payload.body || '').trim()
  // REGRESSION FIX (Kev, 2026-09-22): this used to read only the pre-GOWS
  // fields (quotedMessageId/quotedMsgId/_data.quotedStanzaID), the exact
  // pattern matchEngine.js's own 2026-09-21 header comment documents as
  // broken on every session since GOWS (2026-07-29) — a real quoted reply
  // arrives as `payload.replyTo.id`, never seen here, so "reply to a
  // listing with !rented" silently fell through to "no target found".
  // Now shares the same lib/quotedMessage.js resolution !match already
  // carries.
  const { id: quotedMessageId, body: quotedBody } = quotedFromPayload(payload)

  const target = await resolveRentedTarget({ text, quotedMessageId, quotedBody, chatId })
  if (!target || target.ambiguous) {
    await _replyUnresolved(sessionRouter, session, chatId, target, 'rented')
    return
  }
  if (target.available_status === 'rented') {
    await sessionRouter.sendVia(
      session,
      chatId,
      withPropertyLink(`ℹ️ #${target.ref} is already marked RENTED.`, target.ref),
      { replyToMessageId: payload.id || quotedMessageId || null },
    )
    return
  }

  const propR = await db.query(
    `SELECT town, longlet_price, sale_price FROM properties WHERE id = $1`, [target.property_id])
  const p = propR.rows[0] || {}
  const price = p.longlet_price || p.sale_price
  const priceLabel = price ? `€${Number(price).toLocaleString()}` : '?'

  const result = await markRented(target.property_id, target.ref, senderPhone, session, target,
    { source: 'manual_command', trigger: '!rented' })
  if (result.skipped) {
    await sessionRouter.sendVia(session, chatId, `ℹ️ #${target.ref} — ${String(result.skipped).replace(/_/g, ' ')}.`)
    return
  }

  await sessionRouter.sendVia(
    session,
    chatId,
    withPropertyLink(
      `❌ RENTED\n#${target.ref} · ${p.town || '?'} · ${priceLabel}\nRemoved from active inventory.`,
      target.ref),
    { replyToMessageId: payload.id || quotedMessageId || null },
  )
  log.info('rentedDetector: !rented command applied', { propertyId: target.property_id, ref: target.ref, session })
}

// !available [ref] — an explicit admin confirmation, not merely a request to
// restore a rented row.  It refreshes last_confirmed_available_at even when the
// property was already available, closes stale availability checks and never
// contacts the owner.  Never creates a new property.
async function handleAvailableCommand(payload, session, senderPhone) {
  const sessionRouter = require('../lib/sessionRouter')
  const chatId = payload.from
  const text = (payload.body || '').trim().replace(/^!available\s*/i, '!rented ') // reuse the same ref-token parser
  // Same GOWS regression fix as handleRentedCommand above.
  const { id: quotedMessageId } = quotedFromPayload(payload)

  const target = await resolveRentedTarget({ text, quotedMessageId, chatId, mode: 'available' })
  if (!target || target.ambiguous) {
    await _replyUnresolved(sessionRouter, session, chatId, target, 'available')
    return
  }
  const { confirmAvailable } = require('./killSwitch')
  const result = await confirmAvailable(target.property_id, { senderPhone, source: 'manual_command' })
  if (result.skipped) {
    await sessionRouter.sendVia(session, chatId, `ℹ️ #${target.ref} — ${String(result.skipped).replace(/_/g, ' ')}.`)
    return
  }

  await sessionRouter.sendVia(session, chatId,
    withAvailableActions(
      `✅ AVAILABLE CONFIRMED\n#${target.ref}\nConfirmation refreshed now${result.closedChecks ? ` · ${result.closedChecks} old check${result.closedChecks === 1 ? '' : 's'} closed` : ''}. No message was sent to the owner.`,
      target.ref))
  log.info('rentedDetector: !available confirmation applied', {
    propertyId: target.property_id,
    ref: target.ref,
    session,
    confirmedAt: result.confirmedAt,
    closedChecks: result.closedChecks,
  })
}

module.exports = {
  processReaction,
  processReply,
  markRented,
  markDuplicate, // test-only / direct-call access
  isAdminSender, // test-only
  // !rented command (2026-09-15)
  handleRentedCommand,
  resolveRentedTarget, // test-only
  // !available command (Phase E, 2026-09-17)
  handleAvailableCommand,
}
