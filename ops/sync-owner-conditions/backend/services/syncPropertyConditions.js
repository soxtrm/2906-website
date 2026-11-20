'use strict'
// ============================================================================
// services/syncPropertyConditions.js — owner conditions per property, the first
// part of the NEXUS Property Passport (Claude, 2026-11-21).
//
//   • one set of conditions per PROPERTY (an owner with several homes sets
//     different rules for each). Access: the SYNC account's verified link and a
//     confirmed claim on that property (syncAccount.ownedProperty).
//   • every topic has a status (allowed / not_allowed / conditional / unknown),
//     structured details, an optional note and exceptions.
//   • source says who stated it: owner, ai (extracted from the owner chat, only
//     ever a PROPOSAL until the owner confirms it) or agent. The owner's own
//     statement is state 'confirmed'; superseded versions stay as history.
//   • optimistic concurrency: a write names the version it was based on, so an
//     old device can never overwrite a newer server value.
//   • existing ARGUS owner signals (owner_tenant_preferences: "pets ok",
//     "no smoking" from chats) are shown as hints and never changed here.
//   • nothing is sent to agencies or channels: no distribution grants, no outbox.
//     Agency sharing stays with the separate distribution permissions.
// History: agent_activity_log (SYNC_CONDITION_*), the same log every SYNC action
// writes to, and the source of the owner's activity view.
// ============================================================================
const db = require('../db')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { tx, audit, AGENCY_KEY } = L._internal
const err = (code, message, status = 400) => new LinkError(code, message, status)
// property-level access: verified link + confirmed claim (the same rule as viewing hours)
async function owned(S, account, propertyId) {
  const p = (await S.ownedProperties(account)).find(x => x.id === Number(propertyId))
  if (!p) throw err('PROPERTY_NOT_IN_LINK', 'This home is not confirmed for your account.', 404)
  return p
}

const STATUSES = ['allowed', 'not_allowed', 'conditional', 'unknown']
const PET_CHIPS = ['small_only', 'one_only', 'extra_deposit', 'meet_pet_first', 'cleaning_at_end', 'owner_approval_each_time']
const KEYS = {
  pets_cats: { chips: PET_CHIPS, pet: true },
  pets_dogs: { chips: PET_CHIPS, pet: true },
  pets_other: { chips: PET_CHIPS, pet: true, kinds: true },
  tenancy_duration: { chips: ['renewal_possible', 'fixed_end_date', 'short_lets_ok'], months: true },
  occupancy: { chips: ['sharing_ok', 'company_let_ok', 'no_subletting', 'couples_ok'], people: true },
  smoking: { chips: ['outside_only', 'balcony_only', 'no_vaping'] },
  viewing: { chips: ['owner_present', 'tenant_present', 'weekdays_only', 'daytime_only', 'id_before_viewing'], notice: true },
  other: { chips: [], items: true },
}
// Choosing tenants by these is not allowed; the owner chat refuses them too.
const PROTECTED = /\b(nationalit|national origin|ethnic|race|racial|skin|colou?r of|religio|muslim|islam|christian|catholic|jew|jewish|hindu|buddhis|african|arab|asian|indian|pakistan|nigeria|filipin|chinese|black people|white people|gay|lesbian|homosex|transgender|pregnan|disabilit)/i

const int = (v, lo, hi) => (v === undefined || v === null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : NaN)
const text = (v, max) => { const t = String(v ?? '').trim().replace(/\s+/g, ' '); return t ? t.slice(0, max) : null }

/** Validate one topic. Returns the clean { status, details, note }. */
function clean(key, input) {
  const spec = KEYS[key]
  if (!spec) throw err('CONDITION_UNKNOWN', 'Unknown condition.')
  const status = String(input?.status || '')
  if (!STATUSES.includes(status)) throw err('STATUS_INVALID', 'Choose allowed, not allowed, conditional or unknown.')
  const d = input?.details && typeof input.details === 'object' ? input.details : {}
  const out = {}
  if (d.chips !== undefined) {
    if (!Array.isArray(d.chips) || d.chips.some(c => !spec.chips.includes(c))) throw err('DETAILS_INVALID', 'Unknown option.')
    if (d.chips.length) out.chips = [...new Set(d.chips)]
  }
  if (spec.pet) {
    if (d.insurance !== undefined && d.insurance !== null) {
      if (!['required', 'not_required', 'unknown'].includes(d.insurance)) throw err('DETAILS_INVALID', 'Pet insurance: required, not required or unknown.')
      out.insurance = d.insurance
    }
    const n = int(d.maxCount, 1, 10); if (Number.isNaN(n)) throw err('DETAILS_INVALID', 'Number of pets: 1 to 10.'); if (n) out.maxCount = n
  }
  if (spec.kinds) { const k = text(d.kinds, 120); if (k) out.kinds = k }
  if (spec.months) {
    const a = int(d.minMonths, 1, 120), b = int(d.maxMonths, 1, 120)
    if (Number.isNaN(a) || Number.isNaN(b)) throw err('DETAILS_INVALID', 'Months: 1 to 120.')
    if (a && b && b < a) throw err('DETAILS_INVALID', 'The longest stay cannot be shorter than the shortest.')
    if (a) out.minMonths = a; if (b) out.maxMonths = b
  }
  if (spec.people) { const n = int(d.maxPeople, 1, 20); if (Number.isNaN(n)) throw err('DETAILS_INVALID', 'People: 1 to 20.'); if (n) out.maxPeople = n }
  if (spec.notice) { const n = int(d.noticeHours, 0, 168); if (Number.isNaN(n)) throw err('DETAILS_INVALID', 'Notice: 0 to 168 hours.'); if (n !== null) out.noticeHours = n }
  if (spec.items && d.items !== undefined) {
    if (!Array.isArray(d.items) || d.items.length > 10) throw err('DETAILS_INVALID', 'Up to 10 own conditions.')
    const items = d.items.map(x => text(typeof x === 'string' ? x : x?.text, 200)).filter(Boolean)
    if (items.length) out.items = items
  }
  const exceptions = text(d.exceptions, 500); if (exceptions) out.exceptions = exceptions
  const note = text(input?.note, 1000)
  const all = [note, out.exceptions, out.kinds, ...(out.items || [])].filter(Boolean).join(' ')
  if (PROTECTED.test(all)) throw err('PROTECTED_CHARACTERISTIC', 'Nationality, origin, religion and similar characteristics cannot be used to choose tenants, so this is not saved.')
  return { status, details: out, note }
}

const view = r => ({
  id: Number(r.id), key: r.condition_key, status: r.status, details: r.details || {}, note: r.note || null,
  source: r.source, state: r.state, version: r.version, at: r.updated_at, decidedAt: r.decided_at || null,
  evidence: r.state === 'proposed' && r.evidence ? { quote: r.evidence.quote || null, messageId: r.evidence.messageId || null } : undefined,
})

async function read(propertyId, q = db) {
  const { rows } = await q.query(
    `SELECT * FROM nexus_property_conditions WHERE agency_key=$1 AND property_id=$2 AND state IN ('confirmed','proposed') ORDER BY condition_key, state`, [AGENCY_KEY(), propertyId])
  return { conditions: rows.filter(r => r.state === 'confirmed').map(view), proposals: rows.filter(r => r.state === 'proposed').map(view) }
}

// Signals ARGUS already holds from earlier owner chats (owner-wide or for this home). Read only.
async function hints(ownerContactId, propertyId) {
  if (!ownerContactId) return []
  const { rows } = await db.query(
    `SELECT DISTINCT ON (field, COALESCE(property_id,0)) field, value, property_id, updated_at FROM owner_tenant_preferences
      WHERE owner_contact_id=$1 AND is_explicit AND field IN ('pets','smoking','sharing','tenant_type') AND (property_id IS NULL OR property_id=$2)
      ORDER BY field, COALESCE(property_id,0), updated_at DESC`, [ownerContactId, propertyId])
  return rows.map(r => ({ field: r.field, value: r.value, scope: r.property_id ? 'property' : 'owner', at: r.updated_at }))
}

function schema() {
  return Object.fromEntries(Object.entries(KEYS).map(([k, s]) => [k, { chips: s.chips, pet: !!s.pet, kinds: !!s.kinds, months: !!s.months, people: !!s.people, notice: !!s.notice, items: !!s.items }]))
}

/** The owner's view of one home: confirmed conditions, open proposals, ARGUS hints. */
async function get(S, account, { propertyId }) {
  const p = await owned(S, account, propertyId)
  return { propertyId: p.id, ...(await read(p.id)), hints: await hints(p.owner_contact_id, p.id), schema: schema() }
}

/** The owner sets one topic. baseVersion = the version the screen showed (0 = none yet). */
async function set(S, account, { propertyId, key, status, details, note, baseVersion }) {
  const p = await owned(S, account, propertyId)
  const c = clean(key, { status, details, note })
  return tx(async q => {
    const { rows: [cur] } = await q.query(
      `SELECT * FROM nexus_property_conditions WHERE agency_key=$1 AND property_id=$2 AND condition_key=$3 AND state='confirmed' FOR UPDATE`, [AGENCY_KEY(), p.id, key])
    const curVersion = cur ? cur.version : 0
    if (baseVersion === undefined || baseVersion === null || Number(baseVersion) !== curVersion) {
      throw err('VERSION_CONFLICT', 'This was changed on another device. Here is the newest version.', 409)
    }
    const { rows: [link] } = await q.query(`SELECT id FROM nexus_owner_links WHERE agency_key=$1 AND nexus_account_ref=$2 AND link_state='verified' AND owner_contact_id=$3`,
      [AGENCY_KEY(), `sync:${account.public_id}`, p.owner_contact_id])
    if (cur) await q.query(`UPDATE nexus_property_conditions SET state='superseded', updated_at=NOW() WHERE id=$1`, [cur.id])
    // a fresh owner statement answers any open ARGUS proposal for the same topic
    await q.query(`UPDATE nexus_property_conditions SET state='superseded', decided_at=NOW(), updated_at=NOW() WHERE agency_key=$1 AND property_id=$2 AND condition_key=$3 AND state='proposed'`, [AGENCY_KEY(), p.id, key])
    const { rows: [row] } = await q.query(
      `INSERT INTO nexus_property_conditions (agency_key, property_id, condition_key, status, details, note, source, state, version, account_id, owner_link_id, decided_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'owner','confirmed',$7,$8,$9,NOW()) RETURNING *`,
      [AGENCY_KEY(), p.id, key, c.status, JSON.stringify(c.details), c.note, curVersion + 1, account.id, link?.id || null])
    await audit(q, null, 'SYNC_CONDITION_SET', { account: account.public_id, key, version: row.version,
      before: cur ? { status: cur.status, details: cur.details, note: cur.note } : null, after: c }, { id: p.id, ref: p.ref })
    return { condition: view(row) }
  })
}

/** ARGUS (owner chat, Smart Agent) proposes a condition. Never confirmed by itself, never shared. Internal only. */
async function propose({ propertyId, key, status, details, note, source = 'ai', evidence = null }) {
  if (!['ai', 'agent'].includes(source)) throw err('SOURCE_INVALID', 'Proposals come from ARGUS or an agent.')
  const c = clean(key, { status, details, note })
  return tx(async q => {
    await q.query(`UPDATE nexus_property_conditions SET state='superseded', updated_at=NOW() WHERE agency_key=$1 AND property_id=$2 AND condition_key=$3 AND state='proposed'`, [AGENCY_KEY(), propertyId, key])
    const { rows: [row] } = await q.query(
      `INSERT INTO nexus_property_conditions (agency_key, property_id, condition_key, status, details, note, source, state, version, evidence)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'proposed',1,$8::jsonb) RETURNING *`,
      [AGENCY_KEY(), propertyId, key, c.status, JSON.stringify(c.details), c.note, source, evidence ? JSON.stringify({ quote: text(evidence.quote, 300), messageId: evidence.messageId || null }) : null])
    await audit(q, null, 'SYNC_CONDITION_PROPOSED', { key, source, proposal: Number(row.id) }, { id: propertyId })
    return { proposal: view(row) }
  })
}

/** The owner accepts or rejects an ARGUS proposal. Accepting makes it the owner's confirmed condition. */
async function decide(S, account, { propertyId, proposalId, decision }) {
  const p = await owned(S, account, propertyId)
  if (!['accept', 'reject'].includes(decision)) throw err('DECISION_INVALID', 'Accept or reject.')
  return tx(async q => {
    const { rows: [pr] } = await q.query(
      `SELECT * FROM nexus_property_conditions WHERE id=$1 AND agency_key=$2 AND property_id=$3 AND state='proposed' FOR UPDATE`, [Number(proposalId) || 0, AGENCY_KEY(), p.id])
    if (!pr) throw err('PROPOSAL_NOT_FOUND', 'This suggestion is no longer open.', 404)
    if (decision === 'reject') {
      await q.query(`UPDATE nexus_property_conditions SET state='rejected', decided_at=NOW(), account_id=$2, updated_at=NOW() WHERE id=$1`, [pr.id, account.id])
      await audit(q, null, 'SYNC_CONDITION_REJECTED', { account: account.public_id, key: pr.condition_key, proposal: Number(pr.id) }, { id: p.id, ref: p.ref })
      return { rejected: true }
    }
    const { rows: [cur] } = await q.query(
      `SELECT * FROM nexus_property_conditions WHERE agency_key=$1 AND property_id=$2 AND condition_key=$3 AND state='confirmed' FOR UPDATE`, [AGENCY_KEY(), p.id, pr.condition_key])
    if (cur) await q.query(`UPDATE nexus_property_conditions SET state='superseded', updated_at=NOW() WHERE id=$1`, [cur.id])
    const { rows: [row] } = await q.query(
      `UPDATE nexus_property_conditions SET state='confirmed', version=$2, decided_at=NOW(), account_id=$3, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [pr.id, (cur ? cur.version : 0) + 1, account.id])
    await audit(q, null, 'SYNC_CONDITION_ACCEPTED', { account: account.public_id, key: pr.condition_key, version: row.version, source: pr.source,
      before: cur ? { status: cur.status, details: cur.details, note: cur.note } : null }, { id: p.id, ref: p.ref })
    return { condition: view(row) }
  })
}

// ── owner-visible activity: what this account did, from the shared ARGUS log ──
const LABEL = {
  SYNC_ACCOUNT_CREATED: 'Account created', SYNC_LOGIN_WHATSAPP: 'Signed in with WhatsApp',
  SYNC_CLAIM_DECISIONS: 'Confirmed which homes are yours', SYNC_VIEWING_ACCEPTED: 'Accepted a viewing',
  SYNC_VIEWING_DECLINED: 'Declined a viewing', SYNC_VIEWING_PROPOSED: 'Suggested another viewing time',
  SYNC_VIEWING_HOURS: 'Updated viewing hours', SYNC_CONDITION_SET: 'Updated house rules',
  SYNC_CONDITION_ACCEPTED: 'Accepted a suggested house rule', SYNC_CONDITION_REJECTED: 'Rejected a suggested house rule',
  SYNC_OWNER_EVENT: 'Updated a home',
}
async function activity(S, account, { before } = {}) {
  const props = await S.ownedProperties(account)
  const ids = props.map(p => p.id)
  const { rows } = await db.query(
    `SELECT id, action_type, target_property_id, target_ref, details, created_at FROM agent_activity_log
      WHERE action_type = ANY($1::text[]) AND details->>'account' = $2 AND ($3::bigint IS NULL OR id < $3)
      ORDER BY id DESC LIMIT 100`, [Object.keys(LABEL), account.public_id, Number(before) || null])
  return { activity: rows.map(r => ({
    id: Number(r.id), at: r.created_at, kind: r.action_type, label: LABEL[r.action_type],
    propertyId: r.target_property_id && ids.includes(Number(r.target_property_id)) ? Number(r.target_property_id) : null,
    ref: r.target_property_id && ids.includes(Number(r.target_property_id)) ? r.target_ref : null,
    topic: r.details?.key || r.details?.eventType || null,
  })) }
}

module.exports = { get, set, propose, decide, activity, clean, KEYS, STATUSES }
