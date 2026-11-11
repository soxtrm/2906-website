'use strict'
// ============================================================================
// services/nexusOwnerLink.js — ARGUS × NEXUS owner activation, first slice
// (Claude, 2026-11-11). Contract: ops/nexus-owner-link/CONTRACT.md.
//
// What this module does:
//   • one stable link per (agency, owner_contacts.id) — never a second owner
//   • revocable invitation tokens (plaintext derived, never stored)
//   • owner claim → explicit verification → dispute, as separate states
//   • a permission gate that decides whether a property may be sent to NEXUS
//   • an idempotent outbox; delivery stays PENDING while no receiver exists
//   • inbound NEXUS events (claim, verification, distribution, availability)
//
// What it never does: send a WhatsApp/e-mail/any message, touch outreach,
// swipe links, websiteSync or the public /api/nexus inventory, or write to a
// property other than through the existing boardAction helpers.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const boardAction = require('./boardAction')
const freshness = require('./availabilityFreshness')
const C = require('./nexusLinkCrypto')

const CONTRACT_VERSION = '2026-11-11.v1'
const AGENCY_KEY = () => process.env.ARGUS_AGENCY_KEY || '2906'
const INVITE_TTL_DAYS = () => { const n = Number(process.env.NEXUS_INVITE_TTL_DAYS); return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 14 }
const PORTAL_URL = () => (process.env.NEXUS_OWNER_PORTAL_URL || 'https://nexuslink.fit/owner/activate').replace(/[#?].*$/, '')
const MAX_ATTEMPTS = 5

const CHANNELS = ['origin_agency', 'selected_agency', 'approved_large_agencies', 'all_eligible_agencies', 'independent_agents', 'nexus_direct_from_owner', 'other_approved']
const SCOPES = ['listing_data', 'photos', 'availability', 'viewing_schedule', 'approved_answers']
const OUTCOMES = ['available', 'available_from', 'temporarily_held', 'reserved', 'rented', 'ask_later']

// Agency routing reacts to owner grant changes; required lazily (it requires this module).
const routing = () => require('./nexusDistributionRouting')

class LinkError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra) }
}

// The same "real listing" rule the owner profile uses (routes/crm.js REAL_PROPERTY_WHERE).
const REAL_PROPERTY = `
  (p.ref IS NOT NULL AND btrim(p.ref) <> '')
  AND (p.town IS NOT NULL AND btrim(p.town) <> '')
  AND COALESCE(p.longlet_price, p.sale_price) IS NOT NULL
  AND (p.property_type IS NOT NULL AND btrim(p.property_type) <> '')
  AND p.archived_at IS NULL AND NOT COALESCE(p.is_staging, false)`
// Deliberately no street, apartment, owner phone/e-mail, notes or coordinates.
const PROPERTY_COLUMNS = `p.id, p.ref, p.owner_id, p.town, p.property_type, p.bedrooms, p.bathrooms, p.size_sqm,
  p.longlet_price, p.sale_price, p.shortlet, p.lease_type, p.rental_modes, p.available_status, p.available_date,
  p.available_until, p.last_confirmed_available_at, p.lifecycle_state, p.duplicate_flagged, p.published,
  p.pets_allowed, p.parking_available, p.created_at, p.listed_by_agent_id`

async function tx(fn) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) { try { await client.query('ROLLBACK') } catch { /* connection already gone */ } throw err } finally { client.release() }
}

async function audit(q, agent, action, details, property) {
  await q.query(
    `INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, target_property_id, target_ref, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [agent?.id || null, agent?.role || 'system', agent?.name || (agent ? null : 'nexus-link'), action, property?.id || null, property?.ref || null, JSON.stringify(details || {})])
}

function externalId(agencyKey, ref) { return `${agencyKey}:${ref}` }
function date(v) { return v ? new Date(v).toISOString().slice(0, 10) : null }

// Rent and sale are never guessed. Both prices, or a "sale" below €20k (the
// upload rule: that is a monthly rent typed into the wrong field), are unclear.
function transactionType(p) {
  const rent = p.longlet_price == null ? null : Number(p.longlet_price)
  const sale = p.sale_price == null ? null : Number(p.sale_price)
  if (rent != null && sale == null) return { type: 'rent', problems: rent > 0 ? [] : ['RENT_PRICE_INVALID'] }
  if (sale != null && rent == null) return sale >= 20000 ? { type: 'sale', problems: [] } : { type: null, problems: ['SALE_PRICE_LOOKS_LIKE_RENT'] }
  if (rent != null && sale != null) return { type: null, problems: ['RENT_AND_SALE_PRICE_BOTH_SET'] }
  return { type: null, problems: ['PRICE_MISSING'] }
}

// ── owner + link ────────────────────────────────────────────────────────────
async function ownerRow(q, ownerId) {
  const { rows: [o] } = await q.query(
    `SELECT id, name, do_not_contact, status FROM owner_contacts WHERE id=$1`, [ownerId])
  if (!o) throw new LinkError('OWNER_NOT_FOUND', 'Owner not found', 404)
  return o
}
const isDnc = o => o.do_not_contact === true || o.status === 'do_not_contact'

async function ensureLink(q, ownerId, agent, { lock = false } = {}) {
  const agency = AGENCY_KEY()
  await q.query(
    `INSERT INTO nexus_owner_links (agency_key, owner_contact_id, created_by_agent_id) VALUES ($1,$2,$3)
     ON CONFLICT (agency_key, owner_contact_id) DO NOTHING`, [agency, ownerId, agent?.id || null])
  const { rows: [link] } = await q.query(
    `SELECT * FROM nexus_owner_links WHERE agency_key=$1 AND owner_contact_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [agency, ownerId])
  return link
}

async function ownerProperties(q, ownerId) {
  const { rows } = await q.query(`SELECT ${PROPERTY_COLUMNS} FROM properties p WHERE p.owner_id=$1 AND ${REAL_PROPERTY} ORDER BY p.id`, [ownerId])
  return rows
}

async function ensurePropertyLink(q, p) {
  const agency = AGENCY_KEY()
  const t = transactionType(p)
  const provenance = { first_agency_origin_at: p.created_at ? new Date(p.created_at).toISOString() : null, origin_agency: agency, argus_ref: p.ref }
  await q.query(
    `INSERT INTO nexus_property_links (agency_key, property_id, external_id, transaction_type, provenance)
     VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (agency_key, property_id) DO NOTHING`,
    [agency, p.id, externalId(agency, p.ref), t.type, JSON.stringify(provenance)])
  const { rows: [l] } = await q.query(`SELECT * FROM nexus_property_links WHERE agency_key=$1 AND property_id=$2 FOR UPDATE`, [agency, p.id])
  return l
}

// ── invitations ─────────────────────────────────────────────────────────────
function invitationView(inv, { withUrl = false } = {}) {
  if (!inv) return null
  const state = inv.revoked_at ? 'revoked' : inv.consumed_at ? 'consumed' : new Date(inv.expires_at) <= new Date() ? 'expired' : 'active'
  const out = { id: Number(inv.id), state, createdAt: inv.created_at, expiresAt: inv.expires_at, openedAt: inv.opened_at, consumedAt: inv.consumed_at, revokedAt: inv.revoked_at, copyCount: inv.copy_count, lastCopiedAt: inv.last_copied_at }
  // The token travels in the URL fragment so it is not sent to servers in the
  // request line, logs or Referer headers.
  if (withUrl && state === 'active') out.url = `${PORTAL_URL()}#t=${C.inviteToken(inv.id, inv.nonce)}`
  return out
}

async function createInvitation(ownerId, agent, { rotate = false } = {}) {
  return tx(async q => {
    const owner = await ownerRow(q, ownerId)
    if (isDnc(owner)) throw new LinkError('OWNER_DO_NOT_CONTACT', 'This owner is marked do-not-contact. No invitation is prepared.', 409)
    const link = await ensureLink(q, ownerId, agent, { lock: true })
    if (link.link_state === 'verified') throw new LinkError('ALREADY_LINKED', 'This owner already has a verified NEXUS account.', 409)
    if (link.link_state === 'disputed') throw new LinkError('LINK_DISPUTED', 'Resolve the open dispute before inviting again.', 409)
    const props = await ownerProperties(q, ownerId)
    if (!props.length) throw new LinkError('NO_ELIGIBLE_PROPERTY', 'This owner has no complete, active listing to review.', 409)

    const { rows: [active] } = await q.query(
      `SELECT * FROM nexus_owner_invitations WHERE owner_link_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL FOR UPDATE`, [link.id])
    const expired = active && new Date(active.expires_at) <= new Date()
    if (active && !rotate && !expired) return { link: linkView(link), invitation: invitationView(active, { withUrl: true }), created: false }
    if (active) {
      await q.query(`UPDATE nexus_owner_invitations SET revoked_at=NOW(), revoked_reason=$2 WHERE id=$1`, [active.id, expired ? 'expired' : 'rotated'])
    }
    const { rows: [{ id }] } = await q.query(`SELECT nextval('nexus_owner_invitations_id_seq') AS id`)
    const nonce = C.newNonce()
    const { rows: [inv] } = await q.query(
      `INSERT INTO nexus_owner_invitations (id, owner_link_id, agency_key, nonce, token_hash, expires_at, created_by_agent_id)
       VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' days')::interval, $7) RETURNING *`,
      [id, link.id, link.agency_key, nonce, C.tokenHash(C.inviteToken(id, nonce)), String(INVITE_TTL_DAYS()), agent?.id || null])
    for (const p of props) {
      await q.query(`INSERT INTO nexus_owner_property_claims (owner_link_id, property_id) VALUES ($1,$2) ON CONFLICT (owner_link_id, property_id) DO NOTHING`, [link.id, p.id])
      await ensurePropertyLink(q, p)
    }
    const { rows: [updated] } = await q.query(
      `UPDATE nexus_owner_links SET link_state = CASE WHEN link_state IN ('not_invited','revoked') THEN 'invited' ELSE link_state END, updated_at=NOW() WHERE id=$1 RETURNING *`, [link.id])
    await audit(q, agent, 'NEXUS_OWNER_INVITE_CREATED', { owner_contact_id: ownerId, invitation_id: Number(inv.id), rotated: !!active, properties: props.length })
    return { link: linkView(updated), invitation: invitationView(inv, { withUrl: true }), created: true }
  })
}

// "Copy invitation link": recompute the URL, count the copy. Sends nothing.
async function copyInvitationLink(ownerId, agent) {
  return tx(async q => {
    const link = await ensureLink(q, ownerId, agent, { lock: true })
    const { rows: [inv] } = await q.query(
      `UPDATE nexus_owner_invitations SET copy_count=copy_count+1, last_copied_at=NOW()
        WHERE owner_link_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() RETURNING *`, [link.id])
    if (!inv) throw new LinkError('NO_ACTIVE_INVITATION', 'There is no active invitation. Create one first.', 404)
    await audit(q, agent, 'NEXUS_OWNER_INVITE_COPIED', { owner_contact_id: ownerId, invitation_id: Number(inv.id) })
    return { invitation: invitationView(inv, { withUrl: true }) }
  })
}

async function revokeInvitation(ownerId, agent, reason) {
  return tx(async q => {
    const link = await ensureLink(q, ownerId, agent, { lock: true })
    const { rows } = await q.query(
      `UPDATE nexus_owner_invitations SET revoked_at=NOW(), revoked_reason=$2 WHERE owner_link_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [link.id, String(reason || 'revoked by staff').slice(0, 200)])
    if (rows.length && link.link_state === 'invited') await q.query(`UPDATE nexus_owner_links SET link_state='not_invited', updated_at=NOW() WHERE id=$1`, [link.id])
    await audit(q, agent, 'NEXUS_OWNER_INVITE_REVOKED', { owner_contact_id: ownerId, revoked: rows.length })
    return { revoked: rows.length }
  })
}

async function findInvitationByToken(q, token, { lock = false } = {}) {
  if (typeof token !== 'string' || !C.TOKEN_RE.test(token)) throw new LinkError('INVITATION_INVALID', 'Invitation not valid', 404)
  const { rows: [inv] } = await q.query(`SELECT * FROM nexus_owner_invitations WHERE token_hash=$1 ${lock ? 'FOR UPDATE' : ''}`, [C.tokenHash(token)])
  // One answer for unknown, revoked and expired: nothing about the owner leaks.
  if (!inv || inv.revoked_at || new Date(inv.expires_at) <= new Date()) throw new LinkError('INVITATION_INVALID', 'Invitation not valid', 404)
  return inv
}

function publicProperty(p, claim, agency) {
  const t = transactionType(p)
  return { externalId: externalId(agency, p.ref), ref: p.ref, town: p.town, propertyType: p.property_type, bedrooms: p.bedrooms, transactionType: t.type, claimState: claim?.claim_state || 'proposed' }
}

// NEXUS server → ARGUS: what should the activation screen show for this token?
// Returns the owner's display name and locality-level listing facts only.
async function resolveInvitation(token) {
  return tx(async q => {
    const inv = await findInvitationByToken(q, token, { lock: true })
    const { rows: [link] } = await q.query(`SELECT * FROM nexus_owner_links WHERE id=$1`, [inv.owner_link_id])
    if (!inv.opened_at) await q.query(`UPDATE nexus_owner_invitations SET opened_at=NOW() WHERE id=$1`, [inv.id])
    const owner = await ownerRow(q, link.owner_contact_id)
    const props = await ownerProperties(q, link.owner_contact_id)
    const { rows: claims } = await q.query(`SELECT * FROM nexus_owner_property_claims WHERE owner_link_id=$1`, [link.id])
    return {
      contractVersion: CONTRACT_VERSION,
      agencyKey: link.agency_key,
      invitation: { state: inv.consumed_at ? 'consumed' : 'active', expiresAt: inv.expires_at },
      owner: { linkId: link.public_id, displayName: owner.name || null, linkState: link.link_state },
      properties: props.map(p => publicProperty(p, claims.find(c => c.property_id === p.id), link.agency_key)),
    }
  })
}

// ── inbound events (NEXUS → ARGUS) ──────────────────────────────────────────
async function linkByPublicId(q, agencyKey, linkId, { lock = true } = {}) {
  const { rows: [link] } = await q.query(
    `SELECT * FROM nexus_owner_links WHERE public_id::text=$1 AND agency_key=$2 ${lock ? 'FOR UPDATE' : ''}`, [String(linkId || ''), agencyKey])
  // A link of another agency is indistinguishable from a link that does not exist.
  if (!link) throw new LinkError('LINK_NOT_FOUND', 'Owner link not found', 404)
  return link
}
async function claimedProperty(q, link, extId) {
  const { rows: [row] } = await q.query(
    `SELECT ${PROPERTY_COLUMNS}, c.claim_state, c.id AS claim_id
       FROM nexus_property_links l JOIN properties p ON p.id=l.property_id
       JOIN nexus_owner_property_claims c ON c.property_id=p.id AND c.owner_link_id=$1
      WHERE l.agency_key=$2 AND l.external_id=$3 AND p.owner_id=$4`, [link.id, link.agency_key, String(extId || ''), link.owner_contact_id])
  if (!row) throw new LinkError('PROPERTY_NOT_IN_LINK', 'Property is not part of this owner link', 404)
  return row
}

async function applyClaim(q, agencyKey, data) {
  const inv = await findInvitationByToken(q, data.token, { lock: true })
  if (inv.agency_key !== agencyKey) throw new LinkError('INVITATION_INVALID', 'Invitation not valid', 404)
  if (inv.consumed_at) throw new LinkError('INVITATION_CONSUMED', 'Invitation already used', 409)
  const account = String(data.nexusAccountRef || '').trim()
  if (!/^[A-Za-z0-9_:-]{4,80}$/.test(account)) throw new LinkError('ACCOUNT_REF_INVALID', 'nexusAccountRef is required')
  const { rows: [link] } = await q.query(`SELECT * FROM nexus_owner_links WHERE id=$1 FOR UPDATE`, [inv.owner_link_id])
  const { rows: [taken] } = await q.query(
    `SELECT id FROM nexus_owner_links WHERE agency_key=$1 AND nexus_account_ref=$2 AND id<>$3`, [agencyKey, account, link.id])
  if (taken) throw new LinkError('ACCOUNT_ALREADY_LINKED', 'This NEXUS account is already linked to another owner of this agency.', 409)
  const decisions = Array.isArray(data.decisions) ? data.decisions : []
  const map = { confirm: 'confirmed', correct: 'corrected', reject: 'rejected' }
  let decided = 0
  for (const d of decisions) {
    if (!map[d?.decision]) throw new LinkError('DECISION_INVALID', 'decision must be confirm, correct or reject')
    const p = await claimedProperty(q, link, d.externalId)
    await q.query(`UPDATE nexus_owner_property_claims SET claim_state=$2, owner_note=$3, decided_at=NOW(), decided_via='nexus_owner_portal', updated_at=NOW() WHERE id=$1`,
      [p.claim_id, map[d.decision], d.note ? String(d.note).slice(0, 1000) : null])
    decided++
  }
  await q.query(`UPDATE nexus_owner_invitations SET consumed_at=NOW() WHERE id=$1`, [inv.id])
  // Claimed, NOT verified: holding the link is not proof of ownership.
  await q.query(`UPDATE nexus_owner_links SET nexus_account_ref=$2, link_state='claim_pending', updated_at=NOW() WHERE id=$1`, [link.id, account])
  await audit(q, null, 'NEXUS_OWNER_CLAIM_SUBMITTED', { owner_contact_id: link.owner_contact_id, decided })
  return { linkState: 'claim_pending', decided }
}

async function markVerified(q, link, { method, agent = null, evidenceRef = null }) {
  if (!link.nexus_account_ref) throw new LinkError('NOT_CLAIMED', 'The owner has not claimed this profile yet.', 409)
  if (link.link_state === 'disputed') throw new LinkError('LINK_DISPUTED', 'Resolve the open dispute first.', 409)
  if (!method || !String(method).trim()) throw new LinkError('VERIFICATION_METHOD_REQUIRED', 'State how ownership was verified.')
  await q.query(
    `UPDATE nexus_owner_links SET link_state='verified', verified_at=COALESCE(verified_at, NOW()), verification_method=$2, verified_by_agent_id=$3, dispute_reason=NULL, updated_at=NOW() WHERE id=$1`,
    [link.id, String(method).slice(0, 200), agent?.id || null])
  // Only associations the owner confirmed become owner-verified. Rejected ones are recorded as such.
  await q.query(
    `UPDATE nexus_property_links l SET owner_review_state = CASE c.claim_state WHEN 'confirmed' THEN 'verified' WHEN 'corrected' THEN 'verified'
            WHEN 'rejected' THEN 'rejected' WHEN 'disputed' THEN 'disputed' ELSE 'pending' END, updated_at=NOW()
       FROM nexus_owner_property_claims c WHERE c.owner_link_id=$1 AND c.property_id=l.property_id AND l.agency_key=$2`, [link.id, link.agency_key])
  await audit(q, agent, 'NEXUS_OWNER_VERIFIED', { owner_contact_id: link.owner_contact_id, method: String(method).slice(0, 200), evidence_ref: evidenceRef })
  return { linkState: 'verified' }
}

async function openDispute(q, link, { reason, externalId: extId = null, agent = null }) {
  const why = String(reason || '').trim().slice(0, 500)
  if (!why) throw new LinkError('DISPUTE_REASON_REQUIRED', 'A dispute needs a reason.')
  if (extId) {
    const p = await claimedProperty(q, link, extId)
    await q.query(`UPDATE nexus_owner_property_claims SET claim_state='disputed', owner_note=$2, updated_at=NOW() WHERE id=$1`, [p.claim_id, why])
    await q.query(`UPDATE nexus_property_links SET owner_review_state='disputed', sync_state='blocked', updated_at=NOW() WHERE agency_key=$1 AND property_id=$2`, [link.agency_key, p.id])
    await supersedePending(q, 'property', p.id, 'property.upserted')
  } else {
    await q.query(`UPDATE nexus_owner_links SET link_state='disputed', dispute_reason=$2, updated_at=NOW() WHERE id=$1`, [link.id, why])
  }
  await audit(q, agent, 'NEXUS_OWNER_DISPUTE_OPENED', { owner_contact_id: link.owner_contact_id, external_id: extId, reason: why })
  return { disputed: true }
}

async function applyGrant(q, link, data, eventId) {
  if (link.link_state !== 'verified') throw new LinkError('OWNER_LINK_NOT_VERIFIED', 'Distribution can only be authorised by a verified owner.', 409)
  if (!CHANNELS.includes(data.channel)) throw new LinkError('CHANNEL_INVALID', 'Unknown distribution channel')
  const scopes = [...new Set(Array.isArray(data.scopes) ? data.scopes : [])]
  if (!scopes.length || scopes.some(s => !SCOPES.includes(s))) throw new LinkError('SCOPES_INVALID', 'scopes must name exactly what is shared')
  const audience = String(data.audienceRef || '').slice(0, 80)
  if (data.channel === 'selected_agency' && !audience) throw new LinkError('AUDIENCE_REQUIRED', 'selected_agency needs audienceRef')
  const p = await claimedProperty(q, link, data.externalId)
  if (!['confirmed', 'corrected'].includes(p.claim_state)) throw new LinkError('OWNER_CLAIM_NOT_CONFIRMED', 'The owner has not confirmed this property.', 409)
  const grantedAt = data.grantedAt ? new Date(data.grantedAt) : new Date()
  if (Number.isNaN(grantedAt.getTime())) throw new LinkError('GRANTED_AT_INVALID', 'grantedAt is not a date')
  // Replace an active grant for the same audience (scopes may have changed).
  await q.query(`UPDATE nexus_distribution_grants SET revoked_at=NOW() WHERE agency_key=$1 AND property_id=$2 AND channel=$3 AND audience_ref=$4 AND revoked_at IS NULL`,
    [link.agency_key, p.id, data.channel, audience])
  await q.query(
    `INSERT INTO nexus_distribution_grants (agency_key, owner_link_id, property_id, channel, audience_ref, scopes, granted_at, source, source_event_id, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'nexus_owner_portal',$8,$9::jsonb)`,
    [link.agency_key, link.id, p.id, data.channel, audience, scopes, grantedAt, eventId, JSON.stringify({ nexus_account_ref: link.nexus_account_ref, terms_version: data.termsVersion || null })])
  await q.query(`UPDATE nexus_property_links SET distribution_state='approved', updated_at=NOW() WHERE agency_key=$1 AND property_id=$2`, [link.agency_key, p.id])
  await audit(q, null, 'NEXUS_DISTRIBUTION_GRANTED', { channel: data.channel, audience_ref: audience, scopes }, p)
  await routing().onOwnerAuthorizationChanged(q, link.agency_key, p.id)
  return { distributionState: 'approved' }
}

async function applyRevoke(q, link, data) {
  const p = await claimedProperty(q, link, data.externalId)
  const all = !data.channel
  if (!all && !CHANNELS.includes(data.channel)) throw new LinkError('CHANNEL_INVALID', 'Unknown distribution channel')
  const { rowCount } = await q.query(
    `UPDATE nexus_distribution_grants SET revoked_at=NOW() WHERE agency_key=$1 AND property_id=$2 AND revoked_at IS NULL
        AND ($3::text IS NULL OR (channel=$3 AND audience_ref=$4))`, [link.agency_key, p.id, all ? null : data.channel, String(data.audienceRef || '')])
  const { rows: [{ n }] } = await q.query(`SELECT COUNT(*)::int AS n FROM nexus_distribution_grants WHERE agency_key=$1 AND property_id=$2 AND revoked_at IS NULL`, [link.agency_key, p.id])
  let withdrawal = null
  if (n === 0) {
    // Nothing is authorised any more: stop further sharing now and tell NEXUS to
    // withdraw what it holds. External systems ARGUS cannot control are not promised.
    await supersedePending(q, 'property', p.id, 'property.upserted')
    const { rows: [l] } = await q.query(
      `UPDATE nexus_property_links SET distribution_state='withdrawn', publication_state = CASE WHEN publication_state='published' THEN 'withdrawn' ELSE publication_state END,
              sync_state='blocked', blocked_reasons=ARRAY['NO_DISTRIBUTION_AUTHORIZATION'], updated_at=NOW()
        WHERE agency_key=$1 AND property_id=$2 RETURNING *`, [link.agency_key, p.id])
    if (l?.last_payload_hash) withdrawal = await enqueue(q, { aggregateType: 'property', aggregateId: p.id, eventType: 'property.withdrawn', payload: { externalId: l.external_id, canonicalPropertyId: l.canonical_property_id, reason: 'owner_authorization_withdrawn' } })
  }
  await routing().onOwnerAuthorizationChanged(q, link.agency_key, p.id)
  await audit(q, null, 'NEXUS_DISTRIBUTION_REVOKED', { channel: data.channel || 'all', revoked: rowCount, remaining: n }, p)
  return { revoked: rowCount, remaining: n, withdrawalQueued: !!withdrawal }
}

// Structured owner answer about availability. ONLY an explicit availability
// confirmation moves properties.last_confirmed_available_at, and it does so
// through the existing board helpers so every reader sees one truth.
async function recordAvailabilityAnswer(q, { agencyKey, property, ownerContactId, outcome, availableFrom = null, askAgainAt = null, source, sourceEventId = null, agent = null }) {
  if (!OUTCOMES.includes(outcome)) throw new LinkError('OUTCOME_INVALID', 'Unknown availability outcome')
  if (outcome === 'available_from' && !/^\d{4}-\d{2}-\d{2}$/.test(String(availableFrom || ''))) throw new LinkError('AVAILABLE_FROM_REQUIRED', 'available_from needs a date (YYYY-MM-DD)')
  const changedBy = agent ? 'agent' : 'owner_reply'
  let action = null
  if (outcome === 'available') action = await boardAction.checkIn({ propertyId: property.id, agentId: agent?.id || null, method: source, oldStatus: property.available_status, changedBy })
  else if (outcome === 'available_from') action = await boardAction.markUpcoming({ propertyId: property.id, agentId: agent?.id || null, availableDate: availableFrom, reason: 'Owner: available from ' + availableFrom, changedBy, oldStatus: property.available_status })
  // "Rented" follows the existing rule: it becomes "Rented?" for an agent to
  // confirm; nothing public flips on the owner's word alone.
  else if (outcome === 'rented') action = await boardAction.markPendingCheck({ propertyId: property.id, agentId: agent?.id || null, reason: 'Possibly rented — owner said: rented (NEXUS)', oldStatus: property.available_status, changedBy })
  let counted = false
  if (action) {
    if (!action.ok) throw new LinkError('AVAILABILITY_ACTION_REFUSED', action.reason, 409)
    const r = await q.query(action.update.sql, action.update.params)
    if (r.rowCount) { await q.query(action.activity.sql, action.activity.params); counted = outcome === 'available' || outcome === 'available_from' }
  }
  if (['temporarily_held', 'reserved', 'rented'].includes(outcome)) {
    await q.query(`UPDATE nexus_property_links SET publication_state='held', updated_at=NOW() WHERE agency_key=$1 AND property_id=$2 AND publication_state IN ('unpublished','published')`, [agencyKey, property.id])
  }
  await q.query(
    `INSERT INTO owner_availability_answers (agency_key, property_id, owner_contact_id, outcome, available_from, ask_again_at, source, source_event_id, counted_as_confirmation, recorded_by_agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [agencyKey, property.id, ownerContactId, outcome, outcome === 'available_from' ? availableFrom : null, askAgainAt || null, source, sourceEventId, counted, agent?.id || null])
  return { outcome, countedAsConfirmation: counted }
}

const HANDLERS = {
  'owner.claim_submitted': (q, agency, data) => applyClaim(q, agency, data),
  'owner.verified': async (q, agency, data) => {
    const link = await linkByPublicId(q, agency, data.linkId)
    if (link.nexus_account_ref !== data.nexusAccountRef) throw new LinkError('ACCOUNT_MISMATCH', 'Account does not match the claimed profile', 409)
    return markVerified(q, link, { method: `nexus:${data.method || ''}`.slice(0, 200), evidenceRef: data.evidenceRef || null })
  },
  'owner.dispute_opened': async (q, agency, data) => openDispute(q, await linkByPublicId(q, agency, data.linkId), { reason: data.reason, externalId: data.externalId || null }),
  'distribution.granted': async (q, agency, data, eventId) => applyGrant(q, await linkByPublicId(q, agency, data.linkId), data, eventId),
  'distribution.revoked': async (q, agency, data) => applyRevoke(q, await linkByPublicId(q, agency, data.linkId), data),
  'availability.answered': async (q, agency, data, eventId) => {
    const link = await linkByPublicId(q, agency, data.linkId)
    if (link.link_state !== 'verified') throw new LinkError('OWNER_LINK_NOT_VERIFIED', 'Only a verified owner can confirm availability.', 409)
    const p = await claimedProperty(q, link, data.externalId)
    if (!['confirmed', 'corrected'].includes(p.claim_state)) throw new LinkError('OWNER_CLAIM_NOT_CONFIRMED', 'The owner has not confirmed this property.', 409)
    return recordAvailabilityAnswer(q, { agencyKey: agency, property: p, ownerContactId: link.owner_contact_id, outcome: data.outcome, availableFrom: data.availableFrom, askAgainAt: data.askAgainAt, source: 'nexus_owner_portal', sourceEventId: eventId })
  },
}

// Idempotent on eventId: the same event applied twice changes nothing the second time.
async function applyInboundEvent(envelope) {
  const e = envelope || {}
  if (e.contractVersion !== CONTRACT_VERSION) throw new LinkError('CONTRACT_VERSION_UNSUPPORTED', `Supported contract version: ${CONTRACT_VERSION}`, 400)
  if (typeof e.eventId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(e.eventId)) throw new LinkError('EVENT_ID_INVALID', 'eventId is required')
  if (e.agencyKey !== AGENCY_KEY()) throw new LinkError('AGENCY_MISMATCH', 'This ARGUS instance does not serve that agency', 403)
  const handler = HANDLERS[e.eventType]
  if (!handler) throw new LinkError('EVENT_TYPE_UNKNOWN', 'Unknown event type')
  const hash = C.payloadHash(e.data ?? null)
  return tx(async q => {
    const ins = await q.query(
      `INSERT INTO nexus_inbound_events (event_id, agency_key, event_type, payload_hash, outcome) VALUES ($1,$2,$3,$4,'applying') ON CONFLICT (event_id) DO NOTHING`,
      [e.eventId, e.agencyKey, e.eventType, hash])
    if (!ins.rowCount) {
      const { rows: [prev] } = await q.query(`SELECT payload_hash, outcome, detail FROM nexus_inbound_events WHERE event_id=$1`, [e.eventId])
      if (prev.payload_hash !== hash) throw new LinkError('EVENT_ID_REUSED', 'eventId was already used with different content', 409)
      return { duplicate: true, result: prev.detail }
    }
    const result = await handler(q, e.agencyKey, e.data || {}, e.eventId)
    await q.query(`UPDATE nexus_inbound_events SET outcome='applied', detail=$2::jsonb WHERE event_id=$1`, [e.eventId, JSON.stringify(result || {})])
    return { duplicate: false, result }
  })
}

// ── outbound: gate, payload, outbox ─────────────────────────────────────────
async function activeGrants(q, agencyKey, propertyId) {
  const { rows } = await q.query(
    `SELECT channel, audience_ref, scopes, granted_at FROM nexus_distribution_grants WHERE agency_key=$1 AND property_id=$2 AND revoked_at IS NULL ORDER BY channel, audience_ref`, [agencyKey, propertyId])
  return rows
}

// May this property be sent to NEXUS right now? Every "no" names its reason.
function evaluateGate({ property, link, claim, grants }) {
  const reasons = []
  const t = transactionType(property)
  if (!property.ref) reasons.push('PROPERTY_NOT_IDENTIFIED')
  if (property.duplicate_flagged) reasons.push('DUPLICATE_REVIEW_PENDING')
  reasons.push(...t.problems)
  if (!link || link.link_state !== 'verified') reasons.push(link?.link_state === 'disputed' ? 'OWNER_LINK_DISPUTED' : 'OWNER_LINK_NOT_VERIFIED')
  if (!claim || !['confirmed', 'corrected'].includes(claim.claim_state)) reasons.push(claim?.claim_state === 'disputed' ? 'OWNER_CLAIM_DISPUTED' : claim?.claim_state === 'rejected' ? 'OWNER_CLAIM_REJECTED' : 'OWNER_CLAIM_NOT_CONFIRMED')
  if (!grants || !grants.length) reasons.push('NO_DISTRIBUTION_AUTHORIZATION')
  return { allowed: reasons.length === 0, reasons, transactionType: t.type }
}

function propertyPayload(p, link, plink, grants) {
  const t = transactionType(p)
  const scopes = new Set(grants.flatMap(g => g.scopes))
  const listing = scopes.has('listing_data')
  return {
    externalId: plink.external_id,
    originAgency: link.agency_key,
    ownerLinkId: link.public_id,
    transactionType: t.type,
    // A rent is only ever a rent, a sale only ever a sale.
    rent: t.type === 'rent' && listing ? { amount: Number(p.longlet_price), currency: 'EUR', period: 'month' } : null,
    sale: t.type === 'sale' && listing ? { amount: Number(p.sale_price), currency: 'EUR' } : null,
    locality: p.town,
    propertyType: p.property_type,
    bedrooms: listing ? p.bedrooms : null,
    bathrooms: listing ? p.bathrooms : null,
    sizeSqm: listing && p.size_sqm != null ? Number(p.size_sqm) : null,
    availability: scopes.has('availability') || listing ? {
      status: p.available_status,
      availableFrom: date(p.available_date),
      availableUntil: date(p.available_until),
      // Contract name for properties.last_confirmed_available_at.
      availability_last_confirmed_at: p.last_confirmed_available_at ? new Date(p.last_confirmed_available_at).toISOString() : null,
    } : null,
    distribution: grants.map(g => ({ channel: g.channel, audienceRef: g.audience_ref || null, scopes: g.scopes, grantedAt: new Date(g.granted_at).toISOString() })),
    provenance: { ...plink.provenance, owner_verified_at: link.verified_at ? new Date(link.verified_at).toISOString() : null },
  }
}

// Only undelivered events of the SAME type are replaced. A queued withdrawal is
// never cancelled by a later "blocked" evaluation, and vice versa.
async function supersedePending(q, aggregateType, aggregateId, eventType) {
  await q.query(`UPDATE nexus_sync_outbox SET state='superseded', updated_at=NOW() WHERE aggregate_type=$1 AND aggregate_id=$2 AND agency_key=$3 AND event_type=$4 AND state IN ('pending','failed')`,
    [aggregateType, aggregateId, AGENCY_KEY(), eventType])
}

// Insert once per content. The same payload queued again returns the row that is
// already waiting; a changed payload supersedes the undelivered older one.
async function enqueue(q, { aggregateType, aggregateId, eventType, payload, agent = null }) {
  const agency = AGENCY_KEY()
  const hash = C.payloadHash(payload)
  const { rows: [waiting] } = await q.query(
    `SELECT * FROM nexus_sync_outbox WHERE agency_key=$1 AND aggregate_type=$2 AND aggregate_id=$3 AND event_type=$4 AND payload_hash=$5 AND state IN ('pending','delivering','failed') ORDER BY id DESC LIMIT 1`,
    [agency, aggregateType, aggregateId, eventType, hash])
  if (waiting) return { row: waiting, created: false }
  await supersedePending(q, aggregateType, aggregateId, eventType)
  const { rows: [{ n }] } = await q.query(`SELECT COUNT(*)::int AS n FROM nexus_sync_outbox WHERE agency_key=$1 AND aggregate_type=$2 AND aggregate_id=$3`, [agency, aggregateType, aggregateId])
  const { rows: [row] } = await q.query(
    `INSERT INTO nexus_sync_outbox (agency_key, aggregate_type, aggregate_id, event_type, contract_version, idempotency_key, payload, payload_hash, created_by_agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
    [agency, aggregateType, aggregateId, eventType, CONTRACT_VERSION, `${agency}:${eventType}:${aggregateId}:${n}:${hash.slice(0, 16)}`, JSON.stringify(payload), hash, agent?.id || null])
  return { row, created: true }
}

async function syncOwner(ownerId, agent) {
  const out = await tx(async q => {
    const owner = await ownerRow(q, ownerId)
    const link = await ensureLink(q, ownerId, agent, { lock: true })
    if (link.link_state !== 'verified') {
      await q.query(`UPDATE nexus_owner_links SET sync_state='blocked', last_sync_error=NULL, updated_at=NOW() WHERE id=$1`, [link.id])
      return { queued: false, blockedReasons: [link.link_state === 'disputed' ? 'OWNER_LINK_DISPUTED' : 'OWNER_LINK_NOT_VERIFIED'] }
    }
    // Only what activation needs: the link, the claimed account and a display
    // name. No phone, e-mail, address, notes or conversation data.
    const payload = { ownerLinkId: link.public_id, nexusAccountRef: link.nexus_account_ref, originAgency: link.agency_key, displayName: owner.name || null, verifiedAt: new Date(link.verified_at).toISOString() }
    const { rows: [last] } = await q.query(`SELECT payload_hash FROM nexus_sync_outbox WHERE aggregate_type='owner' AND aggregate_id=$1 AND agency_key=$2 AND state='delivered' ORDER BY id DESC LIMIT 1`, [link.id, link.agency_key])
    if (last?.payload_hash === C.payloadHash(payload)) return { queued: false, unchanged: true, blockedReasons: [] }
    const { created } = await enqueue(q, { aggregateType: 'owner', aggregateId: link.id, eventType: 'owner.profile_upserted', payload, agent })
    await q.query(`UPDATE nexus_owner_links SET sync_state='pending', updated_at=NOW() WHERE id=$1`, [link.id])
    await audit(q, agent, 'NEXUS_OWNER_SYNC_QUEUED', { owner_contact_id: ownerId, created })
    return { queued: true, created, blockedReasons: [] }
  })
  return { ...out, delivery: out.queued ? await deliverDue() : null }
}

async function syncProperties(ownerId, agent) {
  const results = await tx(async q => {
    await ownerRow(q, ownerId)
    const link = await ensureLink(q, ownerId, agent, { lock: true })
    const props = await ownerProperties(q, ownerId)
    const { rows: claims } = await q.query(`SELECT * FROM nexus_owner_property_claims WHERE owner_link_id=$1`, [link.id])
    const list = []
    for (const p of props) {
      const plink = await ensurePropertyLink(q, p)
      const grants = await activeGrants(q, link.agency_key, p.id)
      const gate = evaluateGate({ property: p, link, claim: claims.find(c => c.property_id === p.id), grants })
      if (!gate.allowed) {
        await supersedePending(q, 'property', p.id, 'property.upserted')
        await q.query(`UPDATE nexus_property_links SET sync_state='blocked', blocked_reasons=$3, transaction_type=$4, updated_at=NOW() WHERE agency_key=$1 AND property_id=$2`, [link.agency_key, p.id, gate.reasons, gate.transactionType])
        list.push({ ref: p.ref, queued: false, blockedReasons: gate.reasons })
        continue
      }
      const payload = propertyPayload(p, link, plink, grants)
      if (plink.last_payload_hash === C.payloadHash(payload) && plink.sync_state === 'synced') { list.push({ ref: p.ref, queued: false, unchanged: true, blockedReasons: [] }); continue }
      const { created } = await enqueue(q, { aggregateType: 'property', aggregateId: p.id, eventType: 'property.upserted', payload, agent })
      await q.query(`UPDATE nexus_property_links SET sync_state='pending', blocked_reasons='{}', transaction_type=$3, last_sync_error=NULL, updated_at=NOW() WHERE agency_key=$1 AND property_id=$2`, [link.agency_key, p.id, gate.transactionType])
      list.push({ ref: p.ref, queued: true, created, blockedReasons: [] })
    }
    await audit(q, agent, 'NEXUS_PROPERTY_SYNC_REQUESTED', { owner_contact_id: ownerId, queued: list.filter(r => r.queued).length, blocked: list.filter(r => r.blockedReasons.length).length })
    return list
  })
  return { properties: results, delivery: results.some(r => r.queued) ? await deliverDue() : null }
}

// ── delivery ────────────────────────────────────────────────────────────────
function receiver(env = process.env) {
  const url = (env.NEXUS_OWNER_LINK_URL || '').replace(/\/+$/, '')
  const secret = env.NEXUS_LINK_OUTBOUND_SECRET || ''
  const ok = /^https:\/\//.test(url) && secret.length >= 32
  return { configured: ok, url, secret, keyId: env.NEXUS_LINK_KEY_ID || `argus-${AGENCY_KEY()}` }
}

let transport = async (url, init) => fetch(url, init)
function setTransport(fn) { transport = fn }

async function markAggregate(q, row, { ok, error = null, response = null }) {
  if (row.aggregate_type === 'owner') {
    await q.query(`UPDATE nexus_owner_links SET sync_state=$2, last_sync_attempt_at=NOW(), last_sync_at = CASE WHEN $2='synced' THEN NOW() ELSE last_sync_at END, last_sync_error=$3, updated_at=NOW() WHERE id=$1`,
      [row.aggregate_id, ok ? 'synced' : 'error', error])
    return
  }
  if (!ok) {
    await q.query(`UPDATE nexus_property_links SET sync_state='error', last_sync_attempt_at=NOW(), last_sync_error=$3, updated_at=NOW() WHERE agency_key=$1 AND property_id=$2`, [row.agency_key, row.aggregate_id, error])
    return
  }
  if (row.event_type === 'property.withdrawn') {
    await q.query(`UPDATE nexus_property_links SET publication_state='withdrawn', last_payload_hash=NULL, last_sync_attempt_at=NOW(), last_sync_at=NOW(), last_sync_error=NULL, updated_at=NOW() WHERE agency_key=$1 AND property_id=$2`, [row.agency_key, row.aggregate_id])
    return
  }
  // NEXUS owns the canonical id and the publication decision; ARGUS records what it was told.
  const canonical = typeof response?.canonicalPropertyId === 'string' ? response.canonicalPropertyId.slice(0, 120) : null
  const publication = ['unpublished', 'published', 'held', 'withdrawn'].includes(response?.publicationState) ? response.publicationState : null
  await q.query(
    `UPDATE nexus_property_links SET sync_state='synced', last_payload_hash=$3, last_sync_attempt_at=NOW(), last_sync_at=NOW(), last_sync_error=NULL,
            canonical_property_id=COALESCE($4, canonical_property_id), link_state = CASE WHEN COALESCE($4, canonical_property_id) IS NOT NULL THEN 'linked' ELSE link_state END,
            publication_state=COALESCE($5, publication_state), updated_at=NOW()
      WHERE agency_key=$1 AND property_id=$2`, [row.agency_key, row.aggregate_id, row.payload_hash, canonical, publication])
}

// Deliver due outbox rows. With no receiver configured nothing is sent and
// nothing is marked delivered: the rows simply stay pending.
async function deliverDue({ limit = 25, ids = null } = {}) {
  const rc = receiver()
  const agency = AGENCY_KEY()
  if (!rc.configured) {
    const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM nexus_sync_outbox WHERE agency_key=$1 AND state IN ('pending','failed')`, [agency])
    return { receiverConfigured: false, delivered: 0, failed: 0, pending: n, note: 'NEXUS receiver not configured — events stay pending.' }
  }
  const { rows: claimed } = await db.query(
    `UPDATE nexus_sync_outbox SET state='delivering', attempts=attempts+1, updated_at=NOW()
      WHERE id IN (SELECT id FROM nexus_sync_outbox WHERE agency_key=$1 AND state IN ('pending','failed') AND next_attempt_at <= NOW()
                     AND ($3::bigint[] IS NULL OR id = ANY($3)) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`, [agency, limit, ids])
  let delivered = 0, failed = 0
  for (const row of claimed.sort((a, b) => Number(a.id) - Number(b.id))) {
    const path = '/events'
    const body = { eventId: row.event_id, eventType: row.event_type, contractVersion: row.contract_version, agencyKey: row.agency_key, occurredAt: new Date(row.created_at).toISOString(), idempotencyKey: row.idempotency_key, data: row.payload }
    const timestamp = Math.floor(Date.now() / 1000)
    let ok = false, error = null, response = null, permanent = false
    try {
      const res = await transport(rc.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Nexus-Link-Key': rc.keyId, 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(rc.secret, { timestamp, method: 'POST', path, body }) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      })
      response = await res.json().catch(() => null)
      ok = res.status >= 200 && res.status < 300
      if (!ok) { error = `HTTP ${res.status}${response?.error ? ` ${String(response.error).slice(0, 120)}` : ''}`; permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 }
    } catch (err) { error = `Transport: ${String(err.message || err).slice(0, 160)}` }
    await tx(async q => {
      if (ok) {
        await q.query(`UPDATE nexus_sync_outbox SET state='delivered', delivered_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=$1`, [row.id])
      } else {
        const dead = permanent || row.attempts >= MAX_ATTEMPTS
        await q.query(`UPDATE nexus_sync_outbox SET state=$2, last_error=$3, next_attempt_at = NOW() + ($4 || ' minutes')::interval, updated_at=NOW() WHERE id=$1`,
          [row.id, dead ? 'dead' : 'failed', error, String(Math.min(240, 2 ** row.attempts))])
      }
      await markAggregate(q, row, { ok, error, response })
    })
    ok ? delivered++ : failed++
    if (!ok) log.warn('nexus-owner-link delivery failed', { id: Number(row.id), type: row.event_type, error })
  }
  return { receiverConfigured: true, delivered, failed, pending: 0 }
}

// "Retry sync": make failed/dead rows of this owner due again, then deliver.
async function retrySync(ownerId, agent) {
  const ids = await tx(async q => {
    const link = await ensureLink(q, ownerId, agent, { lock: true })
    const { rows } = await q.query(
      `UPDATE nexus_sync_outbox o SET state='pending', attempts=0, next_attempt_at=NOW(), updated_at=NOW()
        WHERE o.agency_key=$1 AND o.state IN ('failed','dead','pending')
          AND ((o.aggregate_type='owner' AND o.aggregate_id=$2)
            OR (o.aggregate_type='property' AND o.aggregate_id IN (SELECT id FROM properties WHERE owner_id=$3)))
          -- never resurrect an event that a later decision made obsolete
          AND NOT EXISTS (SELECT 1 FROM nexus_sync_outbox n WHERE n.aggregate_type=o.aggregate_type AND n.aggregate_id=o.aggregate_id AND n.agency_key=o.agency_key AND n.id > o.id AND n.state <> 'superseded')
        RETURNING o.id`, [link.agency_key, link.id, ownerId])
    await audit(q, agent, 'NEXUS_SYNC_RETRY', { owner_contact_id: ownerId, events: rows.length })
    return rows.map(r => r.id)
  })
  return { retried: ids.length, delivery: ids.length ? await deliverDue({ ids }) : null }
}

// ── staff verification / dispute / manual availability answer ───────────────
const verifyOwner = (ownerId, agent, body) => tx(async q => markVerified(q, await ensureLink(q, ownerId, agent, { lock: true }), { method: body?.method, agent, evidenceRef: body?.evidenceRef || null }))
const disputeOwner = (ownerId, agent, body) => tx(async q => openDispute(q, await ensureLink(q, ownerId, agent, { lock: true }), { reason: body?.reason, externalId: body?.externalId || null, agent }))
async function resolveDispute(ownerId, agent, body) {
  return tx(async q => {
    const link = await ensureLink(q, ownerId, agent, { lock: true })
    if (link.link_state !== 'disputed') throw new LinkError('NO_OPEN_DISPUTE', 'There is no open owner-level dispute.', 409)
    const note = String(body?.note || '').trim().slice(0, 500)
    if (!note) throw new LinkError('RESOLUTION_NOTE_REQUIRED', 'Say how the dispute was resolved.')
    // Back to "claimed": verification is a separate, explicit step.
    await q.query(`UPDATE nexus_owner_links SET link_state = CASE WHEN nexus_account_ref IS NULL THEN 'not_invited' ELSE 'claim_pending' END, dispute_reason=NULL, verified_at=NULL, updated_at=NOW() WHERE id=$1`, [link.id])
    await audit(q, agent, 'NEXUS_OWNER_DISPUTE_RESOLVED', { owner_contact_id: ownerId, note })
    return { resolved: true }
  })
}

// ── status for the owner profile ────────────────────────────────────────────
function linkView(link) {
  return { id: link.public_id, state: link.link_state, nexusAccountRef: link.nexus_account_ref, verifiedAt: link.verified_at, verificationMethod: link.verification_method, disputeReason: link.dispute_reason,
    sync: { state: link.sync_state, lastSyncAt: link.last_sync_at, lastAttemptAt: link.last_sync_attempt_at, lastError: link.last_sync_error } }
}

async function status(ownerId, agent) {
  const owner = await ownerRow(db, ownerId)
  const agency = AGENCY_KEY()
  const { rows: [link] } = await db.query(`SELECT * FROM nexus_owner_links WHERE agency_key=$1 AND owner_contact_id=$2`, [agency, ownerId])
  const props = await ownerProperties(db, ownerId)
  const ids = props.map(p => p.id)
  const [{ rows: plinks }, { rows: claims }, { rows: grants }, { rows: outbox }, { rows: [inv] }] = await Promise.all([
    db.query(`SELECT * FROM nexus_property_links WHERE agency_key=$1 AND property_id = ANY($2::int[])`, [agency, ids]),
    link ? db.query(`SELECT * FROM nexus_owner_property_claims WHERE owner_link_id=$1`, [link.id]) : { rows: [] },
    db.query(`SELECT property_id, channel, audience_ref, scopes, granted_at FROM nexus_distribution_grants WHERE agency_key=$1 AND property_id = ANY($2::int[]) AND revoked_at IS NULL`, [agency, ids]),
    db.query(`SELECT aggregate_type, aggregate_id, event_type, state, attempts, last_error, created_at, delivered_at FROM nexus_sync_outbox
               WHERE agency_key=$1 AND state <> 'superseded' AND ((aggregate_type='property' AND aggregate_id = ANY($2::bigint[])) OR (aggregate_type='owner' AND aggregate_id=$3)) ORDER BY id DESC LIMIT 100`, [agency, ids, link?.id || 0]),
    link ? db.query(`SELECT * FROM nexus_owner_invitations WHERE owner_link_id=$1 ORDER BY id DESC LIMIT 1`, [link.id]) : { rows: [] },
  ])
  const rc = receiver()
  const properties = props.map(p => {
    const pl = plinks.find(l => l.property_id === p.id)
    const claim = claims.find(c => c.property_id === p.id)
    const g = grants.filter(x => x.property_id === p.id)
    const gate = evaluateGate({ property: p, link, claim, grants: g })
    const events = outbox.filter(o => o.aggregate_type === 'property' && Number(o.aggregate_id) === p.id)
    return {
      id: p.id, ref: p.ref, town: p.town, transactionType: gate.transactionType,
      // Independent dimensions — never one collapsed "status".
      statuses: {
        imported: true,
        linked: pl?.link_state === 'linked',
        canonicalPropertyId: pl?.canonical_property_id || null,
        ownerReview: pl?.owner_review_state || 'pending',
        claim: claim?.claim_state || null,
        availability: p.available_status,
        freshness: freshness.classify(p.last_confirmed_available_at),
        distribution: pl?.distribution_state || 'not_authorized',
        publication: pl?.publication_state || 'unpublished',
        sync: pl?.sync_state || 'never',
      },
      eligible: gate.allowed, blockedReasons: gate.reasons,
      distribution: g.map(x => ({ channel: x.channel, audienceRef: x.audience_ref || null, scopes: x.scopes, grantedAt: x.granted_at })),
      lastSyncAt: pl?.last_sync_at || null, lastSyncError: pl?.last_sync_error || null,
      pendingEvents: events.filter(e => ['pending', 'failed', 'delivering'].includes(e.state)).length,
    }
  })
  const waiting = outbox.filter(o => ['pending', 'failed', 'delivering'].includes(o.state)).length
  const errors = outbox.filter(o => ['failed', 'dead'].includes(o.state)).length
  return {
    contractVersion: CONTRACT_VERSION,
    owner: { id: owner.id, doNotContact: isDnc(owner) },
    link: link ? linkView(link) : { id: null, state: 'not_invited', nexusAccountRef: null, sync: { state: 'never' } },
    invitation: invitationView(inv),
    // Honest transport state: without a verified NEXUS receiver nothing is "synced".
    receiver: { configured: rc.configured, note: rc.configured ? null : 'NEXUS receiver not connected yet — approved changes are queued, not delivered.' },
    queue: { waiting, errors },
    properties,
    nexusProfileUrl: link?.link_state === 'verified' && link.nexus_account_ref && process.env.NEXUS_OWNER_PROFILE_URL ? `${process.env.NEXUS_OWNER_PROFILE_URL.replace(/\/+$/, '')}/${encodeURIComponent(link.nexus_account_ref)}` : null,
    can: { manage: !!agent },
  }
}

// Staff records what the owner said on a call. Same rule: only an explicit
// availability answer counts; this endpoint exists for nothing else.
async function recordAnswerByStaff(ownerId, agent, body) {
  return tx(async q => {
    const { rows: [p] } = await q.query(`SELECT ${PROPERTY_COLUMNS} FROM properties p WHERE p.id=$1 AND p.owner_id=$2 AND ${REAL_PROPERTY} FOR UPDATE`, [Number(body?.propertyId) || 0, ownerId])
    if (!p) throw new LinkError('PROPERTY_NOT_FOUND', 'Property does not belong to this owner', 404)
    const out = await recordAvailabilityAnswer(q, { agencyKey: AGENCY_KEY(), property: p, ownerContactId: ownerId, outcome: body?.outcome, availableFrom: body?.availableFrom, askAgainAt: body?.askAgainAt, source: 'agent_recorded', agent })
    await audit(q, agent, 'NEXUS_AVAILABILITY_ANSWER', { outcome: out.outcome, counted: out.countedAsConfirmation }, p)
    return out
  })
}

module.exports = {
  CONTRACT_VERSION, CHANNELS, SCOPES, OUTCOMES, LinkError,
  status, createInvitation, copyInvitationLink, revokeInvitation, resolveInvitation,
  verifyOwner, disputeOwner, resolveDispute, syncOwner, syncProperties, retrySync, deliverDue,
  applyInboundEvent, recordAnswerByStaff, evaluateGate, transactionType, propertyPayload, receiver, setTransport,
  _internal: { tx, enqueue, activeGrants, audit, AGENCY_KEY, ensurePropertyLink, PROPERTY_COLUMNS, REAL_PROPERTY },
}
