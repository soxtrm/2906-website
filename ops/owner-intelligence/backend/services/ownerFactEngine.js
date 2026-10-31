'use strict'
// ============================================================================
// services/ownerFactEngine.js — owner chat → canonical CRM facts.
// ARGUS dynamic facts (Kev, 2026-09-23).
//
// ROOT CAUSE this replaces: services/ownerChatFieldFill.js only ever filled a
// field that was EMPTY ("never overwrites") and only ran when triggered by
// hand, so a pet/sharing/viewing answer from three weeks ago stayed on the
// property forever, even after the owner said the opposite. Here every owner
// message is read for every fact (services/ownerFacts.js), and a fact is
// written when it is NEWER than the evidence the CRM already holds —
// field_provenance's latest entry per field carries that timestamp.
//
// Rules:
//   * newest explicit statement wins (by the owner message's own timestamp,
//     so a rescan of older messages can never undo a newer answer)
//   * every write appends a provenance entry: value, evidence, observed_at,
//     confidence, source
//   * a fact is only applied to a property the owner message unambiguously
//     belongs to — one live listing, or a ref/town named in the text, or the
//     listing the latest bot conversation with this owner was about
//
// Entry points:
//   handleOwnerMessage()  — webhook, every inbound owner DM (never consumes)
//   rescanProperty()      — re-read the recent owner chat for one listing
//                           (called on Ask / availability / Book)
// ============================================================================
const db = require('../db')
const log = require('../logger')
const { extractFacts } = require('./ownerFacts')
const vw = require('./viewingWindows')

const FIELD_COLUMNS = {
  pets: 'pets_allowed',
  sharing: 'sharing_allowed',
  subletting: 'subletting_allowed',
  price: 'longlet_price',
  sharing_price: 'sharing_price',   // conditional sharing rent — never the general rent
  available_from: 'available_date',
  contact_pause_until: 'property_contact_paused_until',
  // Scorecard (Kev, 2026-10-31; migration 20261031_scorecard_fields)
  floor: 'floor_level',
  parking: 'parking_available',
  parking_type: 'parking_type',
  rental_modes: 'rental_modes',
}

const LIVE = `p.ref IS NOT NULL AND COALESCE(p.available_status,'available') NOT IN ('rented','archived')`

function last8(s) { return String(s || '').replace(/\D/g, '').slice(-8) }

// Owner contact for an inbound DM: by phone, else by the chat id a previous
// bot conversation with this owner used (LID chats carry no phone).
async function resolveOwner({ phone, chatId }) {
  const l8 = last8(phone)
  if (l8.length === 8) {
    const r = await db.query(
      `SELECT id FROM owner_contacts
        WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 8) = $1
        ORDER BY id DESC LIMIT 1`, [l8])
    if (r.rows[0]) return r.rows[0].id
  }
  if (chatId) {
    const r = await db.query(
      `SELECT owner_id FROM (
         SELECT owner_id, updated_at AS at FROM availability_checks WHERE owner_chat_id = $1 AND owner_id IS NOT NULL
         UNION ALL
         SELECT owner_id, updated_at FROM book_relay_threads WHERE owner_chat_id = $1 AND owner_id IS NOT NULL
       ) x ORDER BY at DESC NULLS LAST LIMIT 1`, [chatId]).catch(() => ({ rows: [] }))
    if (r.rows[0]) return r.rows[0].owner_id
  }
  return null
}

// Which of the owner's live listings does this message talk about?
async function resolveProperty(ownerId, text) {
  const r = await db.query(
    `SELECT p.id, p.ref, p.town, p.sub_location FROM properties p WHERE p.owner_id = $1 AND ${LIVE} ORDER BY p.id`, [ownerId])
  const props = r.rows
  if (!props.length) return { property: null, reason: 'no_live_listing' }
  if (props.length === 1) return { property: props[0], reason: 'single' }
  const t = String(text || '')
  const byRef = props.filter(p => p.ref && new RegExp(`\\b${p.ref.replace('2906-', '(?:2906-)?')}\\b`, 'i').test(t))
  if (byRef.length === 1) return { property: byRef[0], reason: 'ref_in_text' }
  const byTown = props.filter(p => [p.town, p.sub_location].filter(Boolean)
    .some(n => new RegExp(`\\b${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)))
  if (byTown.length === 1) return { property: byTown[0], reason: 'town_in_text' }
  // the listing the most recent bot conversation with this owner was about
  const ctx = await db.query(
    `SELECT property_id FROM (
       SELECT property_id, updated_at AS at FROM availability_checks
        WHERE owner_id = $1 AND property_id IS NOT NULL AND updated_at > NOW() - INTERVAL '7 days'
       UNION ALL
       SELECT property_id, updated_at FROM book_relay_threads
        WHERE owner_id = $1 AND property_id IS NOT NULL AND updated_at > NOW() - INTERVAL '7 days'
     ) x ORDER BY at DESC LIMIT 1`, [ownerId]).catch(() => ({ rows: [] }))
  const hit = ctx.rows[0] && props.find(p => p.id === ctx.rows[0].property_id)
  if (hit) return { property: hit, reason: 'recent_context' }
  return { property: null, reason: 'ambiguous', candidates: props.map(p => p.ref) }
}

function latestEntry(prov, field) {
  const arr = prov && Array.isArray(prov[field]) ? prov[field] : []
  return arr.length ? arr[arr.length - 1] : null
}
function sameValue(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) }

// Column value for a fact.
function columnValue(fact) {
  if (fact.field === 'pets') {
    return { yes: true, no: false, cats_only: true, small_only: true, no_dogs: true, case_by_case: null }[fact.value]
  }
  return fact.value
}

// Apply facts to one property. Returns [{ field, action, value }].
async function applyFacts(propertyId, facts, { observedAt = new Date(), sourceType = 'owner_chat', reference = null } = {}) {
  const results = []
  if (!facts.length) return results
  const cur = (await db.query(
    `SELECT id, ref, field_provenance, longlet_price, sale_price, chat_extracted_fields FROM properties WHERE id = $1`,
    [propertyId])).rows[0]
  if (!cur) return results
  const prov = cur.field_provenance || {}

  for (const fact of facts) {
    try {
      if (fact.field === 'viewing_window' || fact.field === 'viewings_from') {
        const res = await vw.addWindow(propertyId,
          fact.field === 'viewing_window'
            ? { kind: 'window', start: fact.value.start, end: fact.value.end, confirmation: fact.confirmation || 'start_only' }
            : { kind: 'from_date', fromDate: fact.value },
          { sourceType, evidence: fact.evidence, confidence: fact.confidence, observedAt, reference, createdBy: 'owner' })
        results.push({ field: fact.field, action: res.action, value: fact.value })
        continue
      }
      const column = FIELD_COLUMNS[fact.field]
      if (!column) continue
      if (fact.field === 'price' && !cur.longlet_price && cur.sale_price) {
        results.push({ field: fact.field, action: 'skipped_sale_listing', value: fact.value }); continue
      }
      const last = latestEntry(prov, fact.field)
      if (last && last.observed_at && new Date(last.observed_at) > observedAt) {
        results.push({ field: fact.field, action: 'stale', value: fact.value }); continue
      }
      if (last && sameValue(last.value, fact.value)) {
        results.push({ field: fact.field, action: 'unchanged', value: fact.value }); continue
      }
      const entry = vw.provenanceEntry({
        value: fact.value, sourceType, reference, observedAt, confidence: fact.confidence, evidence: fact.evidence,
      })
      // Price: the same canonical step !price uses (services/priceChange.js) —
      // column, public_payload and the live ad prose stay consistent; no repost.
      if (fact.field === 'price') {
        await require('./priceChange').applyCanonicalPrice(propertyId, Number(fact.value), {
          source: sourceType, details: { evidence: fact.evidence, reference },
        })
        await vw.appendProvenance(db, propertyId, 'price', entry)
        prov.price = [...(prov.price || []), entry]
        results.push({ field: 'price', action: 'updated', value: fact.value })
        try {
          const pub = (await db.query('SELECT published FROM properties WHERE id = $1', [propertyId])).rows[0]
          if (pub && pub.published) await require('./websiteSync').syncPropertyToWebsite(propertyId)
        } catch (err) { log.warn('[ownerFactEngine] website re-sync after price change failed', { propertyId, err: err.message }) }
        continue
      }
      const sets = [`${column} = $2`]
      const params = [propertyId, columnValue(fact)]
      if (fact.field === 'subletting') sets.push(`subletting_considered = $2`)
      if (fact.field === 'pets') {
        params.push(JSON.stringify({ pets_policy: fact.value }))
        sets.push(`chat_extracted_fields = COALESCE(chat_extracted_fields, '{}'::jsonb) || $${params.length}::jsonb`)
      }
      if (fact.field === 'contact_pause_until') {
        params.push(String(fact.evidence || '').slice(0, 300))
        sets.push(`property_contact_pause_note = $${params.length}`, `property_contact_paused_by = 'owner_chat'`, `property_contact_paused_at = NOW()`)
      }
      params.push(fact.field, JSON.stringify([entry]))
      sets.push(`field_provenance = jsonb_set(COALESCE(field_provenance,'{}'::jsonb), ARRAY[$${params.length - 1}::text],
                   COALESCE(field_provenance -> $${params.length - 1}, '[]'::jsonb) || $${params.length}::jsonb, true)`)
      await db.query(`UPDATE properties SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params)
      await db.query(
        `INSERT INTO property_activities (property_id, activity_type, details, is_significant, created_at)
         VALUES ($1, 'fact_updated_from_chat', $2::jsonb, $3, NOW())`,
        [propertyId, JSON.stringify({
          field: fact.field, old: last ? last.value : null, new: fact.value,
          evidence: fact.evidence, source: sourceType, observed_at: observedAt.toISOString(),
        }), fact.field === 'price'])
      prov[fact.field] = [...(prov[fact.field] || []), entry]
      results.push({ field: fact.field, action: 'updated', value: fact.value })
    } catch (err) {
      log.warn('[ownerFactEngine] fact apply failed', { propertyId, field: fact.field, err: err.message })
      results.push({ field: fact.field, action: 'error', error: err.message })
    }
  }
  const changed = results.filter(r => r.action === 'updated' || r.action === 'created')
  if (changed.length) {
    log.info('[ownerFactEngine] facts applied', { propertyId, ref: cur.ref, changed: changed.map(c => c.field) })
    if (changed.some(c => c.field === 'price' || c.field === 'pets' || c.field === 'sharing')) {
      try {
        require('./matchEngine').invalidateMatchesForProperty(propertyId, 'ownerFactEngine')
          .catch(err => log.warn('[ownerFactEngine] match invalidation failed', { err: err.message }))
      } catch (err) { log.warn('[ownerFactEngine] match invalidation failed', { err: err.message }) }
    }
  }
  return results
}

// Webhook entry: one inbound owner DM. Never throws, never consumes.
async function handleOwnerMessage({ phone, chatId, text, timestamp, messageId }) {
  try {
    const observedAt = timestamp ? new Date(Number(timestamp) * 1000) : new Date()
    const facts = extractFacts(text, observedAt)
    if (!facts.length) return { facts: 0 }
    const ownerId = await resolveOwner({ phone, chatId })
    if (!ownerId) return { facts: facts.length, skipped: 'unknown_owner' }
    const { property, reason, candidates } = await resolveProperty(ownerId, text)
    if (!property) {
      log.info('[ownerFactEngine] facts found but listing ambiguous — not applied', { ownerId, reason, candidates, fields: facts.map(f => f.field) })
      return { facts: facts.length, skipped: reason }
    }
    const results = await applyFacts(property.id, facts, { observedAt, sourceType: 'owner_chat', reference: messageId || chatId || null })
    return { facts: facts.length, propertyId: property.id, ref: property.ref, results }
  } catch (err) {
    log.warn('[ownerFactEngine] handleOwnerMessage failed', { err: err.message })
    return { error: err.message }
  }
}

// Re-read the recent owner chat for one listing, oldest first, so the newest
// statement is the one left standing. Called on Ask / availability / Book.
async function rescanProperty(propertyId, { limit = 40 } = {}) {
  try {
    const r = await db.query(
      `SELECT p.id, p.ref, p.owner_id, oc.phone_normalized
         FROM properties p LEFT JOIN owner_contacts oc ON oc.id = p.owner_id WHERE p.id = $1`, [propertyId])
    const prop = r.rows[0]
    if (!prop || !prop.owner_id || !prop.phone_normalized) return { skipped: 'no_owner_contact' }
    const { pickOwnerAccount } = require('./availability')
    const picked = await pickOwnerAccount(prop.owner_id, null)
    if (!picked || !picked.session) return { skipped: 'no_live_account' }
    const waha = require('../waha')
    const chatId = `${String(prop.phone_normalized).replace(/\D/g, '')}@c.us`
    const msgs = await waha.getChatMessages(picked.session, chatId, limit)
    const ownerMsgs = (Array.isArray(msgs) ? msgs : [])
      .filter(m => !m.fromMe && String(m.body || '').trim())
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    let applied = 0
    for (const m of ownerMsgs) {
      const observedAt = new Date((m.timestamp || 0) * 1000)
      const facts = extractFacts(m.body, observedAt)
      if (!facts.length) continue
      const { property } = await resolveProperty(prop.owner_id, m.body)
      if (!property || property.id !== prop.id) continue
      const res = await applyFacts(prop.id, facts, { observedAt, sourceType: 'owner_chat_rescan', reference: m.id || null })
      applied += res.filter(x => x.action === 'updated' || x.action === 'created').length
    }
    return { ref: prop.ref, scanned: ownerMsgs.length, applied }
  } catch (err) {
    log.warn('[ownerFactEngine] rescan failed', { propertyId, err: err.message })
    return { error: err.message }
  }
}

module.exports = { handleOwnerMessage, rescanProperty, applyFacts, resolveOwner, resolveProperty, columnValue }
