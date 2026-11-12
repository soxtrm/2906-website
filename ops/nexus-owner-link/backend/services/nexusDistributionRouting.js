'use strict'
// ============================================================================
// services/nexusDistributionRouting.js — agency distribution routing with
// delayed release (Claude, 2026-11-11, queue addendum 01).
//
// An agency decides when and to whom one of ITS listings is released to other
// agencies through NEXUS: immediately, after N days, on a date, to selected
// audiences, or not at all. Rules:
//   • The clock starts at the agency's explicit approval (approved_release_at),
//     never at a source-sync or import timestamp.
//   • An agency rule never overrides a missing owner authorisation. Without a
//     matching owner grant the route waits; it is re-checked at release time.
//   • Release is durable (a row, not a timer), idempotent (one release event
//     per route) and revocable by the agency or by the owner withdrawing.
//   • No rule exists by default, and the default choice offered is
//     "No external distribution". Nothing here is a consent on anyone's behalf.
// Sends no message. Does not touch outreach, swipe links or the public index.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const L = require('./nexusOwnerLink')
const { tx, enqueue, activeGrants, audit, AGENCY_KEY, ensurePropertyLink, PROPERTY_COLUMNS, REAL_PROPERTY } = L._internal
const { LinkError } = L

const MODES = ['immediate', 'delay_days', 'release_at', 'none']
const AUDIENCES = ['all_eligible_agencies', 'selected_agencies', 'approved_large_agencies', 'independent_agents']
const ON_MARKET = ['available', 'available_confirmed', 'upcoming']

// Shown next to each choice so the decision is explained, not implied.
const OPTIONS = {
  defaultMode: 'none',
  modes: [
    { mode: 'none', label: 'No external distribution', explain: 'The listing stays with your agency. Other agencies cannot see it through NEXUS.' },
    { mode: 'immediate', label: 'Release immediately', explain: 'Released to the chosen audience as soon as you approve it and the owner has authorised that audience.' },
    { mode: 'delay_days', label: 'Release after a delay', explain: 'Your agency works the listing first. The delay is counted from your approval, for example 7 days.', suggestedDelayDays: 7 },
    { mode: 'release_at', label: 'Release on a date', explain: 'Released on the date you choose, never before your approval.' },
  ],
  audiences: [
    { type: 'all_eligible_agencies', label: 'All eligible agencies', ownerChannel: 'all_eligible_agencies' },
    { type: 'selected_agencies', label: 'Selected agencies', ownerChannel: 'selected_agency (one per agency) or all_eligible_agencies' },
    { type: 'approved_large_agencies', label: 'Approved large agencies', ownerChannel: 'approved_large_agencies or all_eligible_agencies' },
    { type: 'independent_agents', label: 'Independent agents', ownerChannel: 'independent_agents' },
  ],
  notes: [
    'Your rule does not replace the owner’s authorisation. Without it the listing waits and is not released.',
    'Commercial terms are a reference to an agreement that already exists. Choosing a rule creates no new agreement and no fee.',
    'You can revoke a release at any time. NEXUS is told to withdraw it; copies outside NEXUS cannot be recalled.',
  ],
}

// Does the owner's current authorisation cover this route's audience?
function ownerCovers(grants, route) {
  const has = (channel, ref) => grants.some(g => g.channel === channel && (ref === undefined || (g.audience_ref || '') === ref))
  switch (route.audience_type) {
    case 'all_eligible_agencies': return has('all_eligible_agencies')
    case 'approved_large_agencies': return has('approved_large_agencies') || has('all_eligible_agencies')
    case 'independent_agents': return has('independent_agents')
    case 'selected_agencies': return route.audience_refs.length > 0 && (has('all_eligible_agencies') || route.audience_refs.every(r => has('selected_agency', r)))
    default: return false
  }
}

async function ownerAuthorisation(q, agencyKey, property) {
  const { rows: [link] } = await q.query(
    `SELECT l.link_state, c.claim_state FROM nexus_owner_links l
       LEFT JOIN nexus_owner_property_claims c ON c.owner_link_id=l.id AND c.property_id=$3
      WHERE l.agency_key=$1 AND l.owner_contact_id=$2`, [agencyKey, property.owner_id, property.id])
  const verified = link?.link_state === 'verified' && ['confirmed', 'corrected'].includes(link.claim_state)
  return { verified, grants: verified ? await activeGrants(q, agencyKey, property.id) : [] }
}

async function propertyRow(q, propertyId, { lock = false } = {}) {
  const { rows: [p] } = await q.query(`SELECT ${PROPERTY_COLUMNS} FROM properties p WHERE p.id=$1 AND ${REAL_PROPERTY} ${lock ? 'FOR UPDATE' : ''}`, [propertyId])
  if (!p) throw new LinkError('PROPERTY_NOT_FOUND', 'Listing not found', 404)
  return p
}
async function currentRoute(q, agencyKey, propertyId, { lock = false } = {}) {
  const { rows: [r] } = await q.query(`SELECT * FROM nexus_distribution_routes WHERE agency_key=$1 AND property_id=$2 AND release_state <> 'revoked' ${lock ? 'FOR UPDATE' : ''}`, [agencyKey, propertyId])
  return r || null
}
// Staff may route a listing they listed; admins any listing of the agency.
function assertMayRoute(agent, p) {
  if (agent.role !== 'admin' && p.listed_by_agent_id !== agent.id) throw new LinkError('NOT_LISTING_AGENT', 'Only an administrator or the listing agent may set distribution for this listing.', 403)
}

function view(r, extra = {}) {
  if (!r) return { state: 'none', mode: 'none', explain: 'No external distribution. Nothing is shared with other agencies.', ...extra }
  return {
    id: Number(r.id), state: r.release_state, mode: r.mode, delayDays: r.delay_days, releaseAt: r.release_at,
    audienceType: r.audience_type, audienceRefs: r.audience_refs, commercialTermsRef: r.commercial_terms_ref,
    approvedReleaseAt: r.approved_release_at, scheduledReleaseAt: r.scheduled_release_at, releasedAt: r.released_at,
    revokedAt: r.revoked_at, revokedBy: r.revoked_by, revokedReason: r.revoked_reason, originAgentId: r.origin_agent_id, ...extra,
  }
}

function validate(body) {
  const mode = body?.mode
  if (!MODES.includes(mode)) throw new LinkError('MODE_REQUIRED', 'Choose how this listing is distributed.')
  if (mode === 'none') return { mode, delay_days: null, release_at: null, audience_type: 'none', audience_refs: [], commercial_terms_ref: null }
  if (!AUDIENCES.includes(body.audienceType)) throw new LinkError('AUDIENCE_REQUIRED', 'Choose who the listing is released to.')
  const refs = [...new Set((Array.isArray(body.audienceRefs) ? body.audienceRefs : []).map(r => String(r).trim()).filter(Boolean))]
  if (body.audienceType === 'selected_agencies' && (!refs.length || refs.length > 50 || refs.some(r => !/^[A-Za-z0-9_:-]{2,80}$/.test(r)))) throw new LinkError('AUDIENCE_REFS_INVALID', 'Name 1–50 agencies.')
  let delay = null, at = null
  if (mode === 'delay_days') {
    delay = Number(body.delayDays)
    if (!Number.isInteger(delay) || delay < 1 || delay > 365) throw new LinkError('DELAY_INVALID', 'Delay must be 1–365 days.')
  }
  if (mode === 'release_at') {
    at = new Date(body.releaseAt)
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) throw new LinkError('RELEASE_AT_INVALID', 'Release date must be in the future.')
  }
  const terms = body.commercialTermsRef == null || body.commercialTermsRef === '' ? null : String(body.commercialTermsRef).slice(0, 120)
  return { mode, delay_days: delay, release_at: at, audience_type: body.audienceType, audience_refs: body.audienceType === 'selected_agencies' ? refs : [], commercial_terms_ref: terms }
}

// Save a rule as a DRAFT. Saving never releases anything; approval is separate.
async function setRoute(propertyId, agent, body) {
  const v = validate(body)
  return tx(async q => {
    const p = await propertyRow(q, propertyId, { lock: true })
    assertMayRoute(agent, p)
    const agency = AGENCY_KEY()
    const cur = await currentRoute(q, agency, propertyId, { lock: true })
    if (cur?.release_state === 'released') throw new LinkError('ALREADY_RELEASED', 'This listing is already released. Revoke the release before changing the rule.', 409)
    if (cur) await q.query(`UPDATE nexus_distribution_routes SET release_state='revoked', revoked_at=NOW(), revoked_by='agency', revoked_reason='replaced by a new rule', updated_at=NOW() WHERE id=$1`, [cur.id])
    const { rows: [r] } = await q.query(
      `INSERT INTO nexus_distribution_routes (agency_key, property_id, mode, delay_days, release_at, audience_type, audience_refs, commercial_terms_ref, origin_agent_id, created_by_agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [agency, propertyId, v.mode, v.delay_days, v.release_at, v.audience_type, v.audience_refs, v.commercial_terms_ref, p.listed_by_agent_id || agent.id, agent.id])
    await audit(q, agent, 'NEXUS_ROUTE_SET', { mode: v.mode, delay_days: v.delay_days, audience_type: v.audience_type, audience_refs: v.audience_refs, replaced: cur ? Number(cur.id) : null }, p)
    return { route: view(r) }
  })
}

function scheduleFor(route, approvedAt) {
  if (route.mode === 'immediate') return approvedAt
  if (route.mode === 'delay_days') return new Date(approvedAt.getTime() + route.delay_days * 86400000)
  const at = new Date(route.release_at)
  return at > approvedAt ? at : approvedAt
}

// The approved release event. This — and only this — starts the delay.
async function approveRelease(propertyId, agent) {
  return tx(async q => {
    const p = await propertyRow(q, propertyId, { lock: true })
    assertMayRoute(agent, p)
    const agency = AGENCY_KEY()
    const r = await currentRoute(q, agency, propertyId, { lock: true })
    if (!r) throw new LinkError('NO_ROUTE', 'Set a distribution rule first.', 404)
    if (r.mode === 'none') throw new LinkError('ROUTE_IS_NONE', 'This listing is set to no external distribution.', 409)
    if (r.release_state !== 'draft') return { route: view(r), changed: false } // approving twice never restarts the clock
    const { rows: [{ now }] } = await q.query(`SELECT NOW() AS now`)
    const auth = await ownerAuthorisation(q, agency, p)
    const state = auth.verified && ownerCovers(auth.grants, r) ? 'scheduled' : 'awaiting_owner_authorization'
    const { rows: [u] } = await q.query(
      `UPDATE nexus_distribution_routes SET approved_release_at=$2, approved_by_agent_id=$3, scheduled_release_at=$4, release_state=$5, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [r.id, now, agent.id, scheduleFor(r, new Date(now)), state])
    await audit(q, agent, 'NEXUS_ROUTE_APPROVED', { route_id: Number(r.id), state, scheduled_release_at: u.scheduled_release_at }, p)
    return { route: view(u), changed: true }
  })
}

async function revokeRoute(propertyId, agent, reason) {
  return tx(async q => {
    const p = await propertyRow(q, propertyId, { lock: true })
    assertMayRoute(agent, p)
    const r = await currentRoute(q, AGENCY_KEY(), propertyId, { lock: true })
    if (!r) throw new LinkError('NO_ROUTE', 'There is no distribution rule to revoke.', 404)
    const out = await revoke(q, r, p, { by: 'agency', reason: String(reason || 'revoked by agency').slice(0, 300) })
    await audit(q, agent, 'NEXUS_ROUTE_REVOKED', { route_id: Number(r.id), was: r.release_state, withdrawal_queued: out.withdrawalQueued }, p)
    return out
  })
}

async function revoke(q, r, p, { by, reason }) {
  const { rows: [u] } = await q.query(
    `UPDATE nexus_distribution_routes SET release_state='revoked', revoked_at=NOW(), revoked_by=$2, revoked_reason=$3, updated_at=NOW() WHERE id=$1 RETURNING *`, [r.id, by, reason])
  let withdrawalQueued = false
  if (r.release_state === 'released') {
    // The listing may be archived by now, so read the link that the release created.
    const { rows: [plink] } = await q.query(`SELECT external_id FROM nexus_property_links WHERE agency_key=$1 AND property_id=$2`, [r.agency_key, r.property_id])
    await enqueue(q, { aggregateType: 'property', aggregateId: r.property_id, eventType: 'distribution.release_revoked', payload: { externalId: plink.external_id, routeId: Number(r.id), revokedBy: by, reason } })
    withdrawalQueued = true
  }
  return { route: view(u), withdrawalQueued }
}

// Called by the owner link whenever the owner's grants for a listing change.
async function onOwnerAuthorizationChanged(q, agencyKey, propertyId) {
  const r = await currentRoute(q, agencyKey, propertyId, { lock: true })
  if (!r || !['awaiting_owner_authorization', 'scheduled', 'released'].includes(r.release_state)) return null
  const p = await propertyRow(q, propertyId)
  const auth = await ownerAuthorisation(q, agencyKey, p)
  const covered = auth.verified && ownerCovers(auth.grants, r)
  if (covered && r.release_state === 'awaiting_owner_authorization') {
    // The agency's clock keeps running from ITS approval; late owner consent does not restart it.
    await q.query(`UPDATE nexus_distribution_routes SET release_state='scheduled', updated_at=NOW() WHERE id=$1`, [r.id])
    return 'scheduled'
  }
  if (!covered && r.release_state === 'scheduled') {
    await q.query(`UPDATE nexus_distribution_routes SET release_state='awaiting_owner_authorization', updated_at=NOW() WHERE id=$1`, [r.id])
    return 'awaiting_owner_authorization'
  }
  if (!covered && r.release_state === 'released') {
    await revoke(q, r, p, { by: 'owner', reason: 'owner authorisation withdrawn' })
    return 'revoked'
  }
  return null
}

// A listing that is over for good: nothing may stay scheduled or released for it.
const ENDED_STATUS = ['rented', 'archived', 'not_available']
const ended = p => ENDED_STATUS.includes(p.available_status) || ['rented', 'archived'].includes(p.lifecycle_state)
// Unlike propertyRow this also returns archived or incomplete listings.
async function anyPropertyRow(q, propertyId) {
  const { rows: [p] } = await q.query(`SELECT ${PROPERTY_COLUMNS}, p.archived_at FROM properties p WHERE p.id=$1`, [propertyId])
  return p || null
}
const active = p => !!p && !p.archived_at && !!p.ref && !!p.town && !!p.property_type && (p.longlet_price != null || p.sale_price != null)
const over = p => !active(p) || ended(p)

// Release everything that is due. Safe to call from the scheduler, a button or
// twice at once: each route is locked, re-checked and released exactly once.
// One broken route never stops the others.
async function processDueReleases({ now = null, limit = 100 } = {}) {
  const agency = AGENCY_KEY()
  const { rows: due } = await db.query(
    `SELECT id FROM nexus_distribution_routes WHERE agency_key=$1 AND release_state='scheduled' AND scheduled_release_at <= COALESCE($2::timestamptz, NOW())
      ORDER BY COALESCE(last_checked_at, scheduled_release_at), id LIMIT $3`, [agency, now, limit])
  const out = { due: due.length, released: 0, waitingForOwner: 0, heldOffMarket: 0, revokedEnded: 0, errors: 0 }
  for (const { id } of due) {
    try {
      await tx(async q => {
        const { rows: [r] } = await q.query(`SELECT * FROM nexus_distribution_routes WHERE id=$1 AND release_state='scheduled' FOR UPDATE SKIP LOCKED`, [id])
        if (!r) return // another worker has it, or it changed
        const p = await anyPropertyRow(q, r.property_id)
        if (over(p)) {
          // Archived, rented or withdrawn before the release date: the rule ends, nothing was shared.
          await revoke(q, r, p, { by: 'system', reason: 'listing ended before release' })
          await audit(q, null, 'NEXUS_ROUTE_REVOKED', { route_id: Number(r.id), was: 'scheduled', by: 'system' }, p)
          out.revokedEnded++; return
        }
        const auth = await ownerAuthorisation(q, agency, p)
        if (!(auth.verified && ownerCovers(auth.grants, r))) {
          await q.query(`UPDATE nexus_distribution_routes SET release_state='awaiting_owner_authorization', last_checked_at=NOW(), updated_at=NOW() WHERE id=$1`, [r.id])
          out.waitingForOwner++; return
        }
        // Not on the market right now (for example "Rented?" pending a check): stays scheduled, looked at again later.
        if (!ON_MARKET.includes(p.available_status)) {
          await q.query(`UPDATE nexus_distribution_routes SET last_checked_at=NOW() WHERE id=$1`, [r.id])
          out.heldOffMarket++; return
        }
        const plink = await ensurePropertyLink(q, p)
        const { rows: [u] } = await q.query(`UPDATE nexus_distribution_routes SET release_state='released', released_at=NOW(), last_checked_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [r.id])
        await enqueue(q, { aggregateType: 'property', aggregateId: p.id, eventType: 'distribution.released', payload: {
          externalId: plink.external_id, routeId: Number(r.id), originAgency: agency, originAgentId: r.origin_agent_id,
          audienceType: r.audience_type, audienceRefs: r.audience_refs, commercialTermsRef: r.commercial_terms_ref,
          approvedReleaseAt: new Date(r.approved_release_at).toISOString(), scheduledReleaseAt: new Date(r.scheduled_release_at).toISOString(),
        } })
        await audit(q, null, 'NEXUS_ROUTE_RELEASED', { route_id: Number(r.id), released_at: u.released_at }, p)
        out.released++
      })
    } catch (err) {
      out.errors++
      log.error('nexus routing: release failed', { route_id: Number(id), err: err.message })
    }
  }
  return out
}

// A released listing that has since ended (rented, archived, withdrawn) is taken
// back: the route is revoked and NEXUS is told once. Temporary states are left alone.
async function withdrawEndedReleases({ limit = 100 } = {}) {
  const agency = AGENCY_KEY()
  const { rows } = await db.query(
    `SELECT r.id FROM nexus_distribution_routes r JOIN properties p ON p.id=r.property_id
      WHERE r.agency_key=$1 AND r.release_state='released'
        AND (p.archived_at IS NOT NULL OR p.available_status = ANY($2::text[]) OR p.lifecycle_state IN ('rented','archived'))
      ORDER BY r.id LIMIT $3`, [agency, ENDED_STATUS, limit])
  const out = { withdrawn: 0, errors: 0 }
  for (const { id } of rows) {
    try {
      await tx(async q => {
        const { rows: [r] } = await q.query(`SELECT * FROM nexus_distribution_routes WHERE id=$1 AND release_state='released' FOR UPDATE SKIP LOCKED`, [id])
        if (!r) return
        const p = await anyPropertyRow(q, r.property_id)
        if (!over(p)) return // changed back in the meantime
        await revoke(q, r, p, { by: 'system', reason: 'listing ended' })
        await audit(q, null, 'NEXUS_ROUTE_REVOKED', { route_id: Number(r.id), was: 'released', by: 'system' }, p)
        out.withdrawn++
      })
    } catch (err) {
      out.errors++
      log.error('nexus routing: withdrawal failed', { route_id: Number(id), err: err.message })
    }
  }
  return out
}

// One scheduler pass.
async function tick(opts = {}) {
  const releases = await processDueReleases(opts)
  const gone = await withdrawEndedReleases(opts)
  return { ...releases, withdrawnEnded: gone.withdrawn, errors: releases.errors + gone.errors }
}

async function findListing(ref, agent) {
  const { rows } = await db.query(`SELECT p.id, p.ref, p.listed_by_agent_id, p.available_status FROM properties p WHERE p.ref=$1 AND ${REAL_PROPERTY} LIMIT 2`, [String(ref || '').slice(0, 80)])
  const p = rows.length === 1 ? rows[0] : null
  if (!p || (agent.role !== 'admin' && p.listed_by_agent_id !== agent.id)) throw new LinkError('PROPERTY_NOT_FOUND', 'Listing not found', 404)
  return { propertyId: p.id, ref: p.ref, onMarket: ON_MARKET.includes(p.available_status) }
}

async function getRoute(propertyId, agent) {
  const p = await propertyRow(db, propertyId)
  const agency = AGENCY_KEY()
  const r = await currentRoute(db, agency, propertyId)
  const auth = await ownerAuthorisation(db, agency, p)
  const { rows: history } = await db.query(`SELECT * FROM nexus_distribution_routes WHERE agency_key=$1 AND property_id=$2 AND release_state='revoked' ORDER BY id DESC LIMIT 10`, [agency, propertyId])
  return {
    property: { id: p.id, ref: p.ref, onMarket: ON_MARKET.includes(p.available_status) },
    route: view(r, r ? { ownerAuthorised: auth.verified && ownerCovers(auth.grants, r) } : {}),
    owner: { verified: auth.verified, channels: auth.grants.map(g => ({ channel: g.channel, audienceRef: g.audience_ref || null })) },
    canEdit: agent.role === 'admin' || p.listed_by_agent_id === agent.id,
    options: OPTIONS,
    defaults: await require('./nexusSmartDefaults').routeDefaults(db, agent),
    history: history.map(h => view(h)),
  }
}

module.exports = { OPTIONS, MODES, AUDIENCES, setRoute, approveRelease, revokeRoute, getRoute, processDueReleases, withdrawEndedReleases, tick, findListing, onOwnerAuthorizationChanged, ownerCovers, scheduleFor }
