'use strict'
// ARGUS Owner Portal + Owner Viewing Desk — domain service (Claude, 2026-11-16).
//
// Separation of identities is enforced HERE, in SQL, not in the UI:
//  * an owner principal only ever reaches rows WHERE properties.owner_id is the
//    account's owner, a delegate additionally only its listed property ids and
//    scopes; anything else answers 404 (no enumeration);
//  * owner projections are allow-lists (no compliance notes, ratings, outreach,
//    commission or internal notes); the agent-facing share projection is a
//    smaller allow-list (no street, no owner identity, no contact data);
//  * a share link is a read-only capability plus structured requests, never a
//    session; sessions, invitations, share and request tokens are stored as
//    SHA-256 hashes only.
//
// Time is held only in property_viewings; availability is materialised into
// property_viewing_windows (source_type 'owner_portal'). Nothing is sent to
// anyone: agent notifications are recorded as message text on the event and
// delivered by the existing notification layer once it is wired (see README).

const crypto = require('crypto')
const S = require('./ownerSchedule')
const V = require('./viewingStates')

class PortalError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra) }
}

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex')
const mint = prefix => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`
const TOKEN_RE = /^(inv|ses|shr|req)_[A-Za-z0-9_-]{43}$/
const DAY = 86400000

const OWNER_FIELDS = ['id', 'ref', 'town', 'sub_location', 'street', 'property_type', 'bedrooms', 'bathrooms', 'size_sqm',
  'longlet_price', 'sale_price', 'available_status', 'available_date', 'description', 'feature_tags', 'images', 'last_confirmed_available_at']
const SHARE_FIELDS = ['ref', 'town', 'sub_location', 'property_type', 'bedrooms', 'bathrooms', 'size_sqm',
  'longlet_price', 'sale_price', 'available_status', 'available_date', 'description', 'feature_tags', 'images']
const STATUSES = ['available', 'rented', 'sold', 'on_hold', 'off_market']
const DESTINATIONS = ['argus_agency', 'partner_agencies', 'authorized_agents', 'nexus_marketplace', 'owner_direct']
const NOT_YET_AVAILABLE = ['nexus_marketplace', 'owner_direct']
const PILOT = ['interested', 'pilot_invited', 'onboarding', 'active_pilot', 'feedback_received']
const SCOPES = ['schedule', 'requests', 'inventory', 'sharing']
const GROUP_TYPES = ['single', 'couple', 'family', 'sharers', 'company', 'other']
const MEDIA_TYPES = { photo: ['image/jpeg', 'image/png', 'image/webp'], document: ['application/pdf', 'image/jpeg', 'image/png'] }

const pick = (row, fields) => Object.fromEntries(fields.filter(f => row[f] !== undefined).map(f => [f, row[f]]))
const str = (v, max, label, { required = false, min = 0 } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw new PortalError('FIELD_REQUIRED', `${label} is required`); return null }
  const s = String(v).trim()
  if (s.length < min || s.length > max) throw new PortalError('FIELD_INVALID', `${label} must be ${min}–${max} characters`)
  return s
}

function createOwnerPortal({ db, now = () => new Date(), portalUrl = 'https://2906.estate/owner-portal', shareUrl = 'https://2906.estate/property-link', inviteTtlDays = 14, sessionDays = 30 } = {}) {
  if (!db) throw new Error('db is required')
  const q = (text, params) => db.query(text, params)

  async function tx(fn) {
    const c = await db.connect()
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
    finally { c.release() }
  }

  async function audit(c, accountId, actor, action, propertyId = null, details = {}) {
    await c.query(`INSERT INTO owner_portal_audit (account_id, actor_kind, actor_ref, action, property_id, details) VALUES ($1,$2,$3,$4,$5,$6)`,
      [accountId, actor.kind, actor.ref || null, action, propertyId, JSON.stringify(details)])
  }
  const staffActor = agentId => ({ kind: 'staff', ref: `agent:${agentId}` })
  const principalActor = p => ({ kind: p.delegateId ? 'delegate' : 'owner', ref: p.delegateId ? `delegate:${p.delegateId}` : `owner:${p.ownerId}` })

  // ── Staff ────────────────────────────────────────────────────────────────
  async function ensureAccount(c, ownerId, agentId) {
    const { rows: [o] } = await c.query(`SELECT id, do_not_contact FROM owner_contacts WHERE id=$1`, [ownerId])
    if (!o) throw new PortalError('OWNER_NOT_FOUND', 'Owner not found', 404)
    const { rows: [a] } = await c.query(`INSERT INTO owner_portal_accounts (owner_id, created_by_agent_id) VALUES ($1,$2)
      ON CONFLICT (owner_id) DO UPDATE SET updated_at = owner_portal_accounts.updated_at RETURNING *`, [ownerId, agentId])
    return { account: a, owner: o }
  }

  // Creates (or replaces) the owner's invitation. Sends nothing: staff hand the
  // link over personally once they have confirmed who the owner is.
  async function inviteOwner({ ownerId, agentId, identityMethod, purpose = 'invite' }) {
    if (!['invite', 'recovery'].includes(purpose)) throw new PortalError('FIELD_INVALID', 'purpose must be invite or recovery')
    const method = str(identityMethod, 200, 'How you confirmed the owner\'s identity', { required: true, min: 3 })
    return tx(async c => {
      const { account, owner } = await ensureAccount(c, ownerId, agentId)
      if (owner.do_not_contact) throw new PortalError('OWNER_DO_NOT_CONTACT', 'This owner is marked do-not-contact.', 409)
      if (['suspended', 'revoked'].includes(account.state)) throw new PortalError('ACCOUNT_BLOCKED', `The portal account is ${account.state}. Reactivate it first.`, 409)
      const { rows: [{ n }] } = await c.query(`SELECT COUNT(*)::int AS n FROM properties WHERE owner_id=$1 AND NOT is_staging`, [ownerId])
      if (!n) throw new PortalError('OWNER_HAS_NO_PROPERTY', 'This owner has no property in ARGUS yet.', 409)
      await c.query(`UPDATE owner_portal_invitations SET revoked_at=NOW() WHERE account_id=$1 AND delegate_id IS NULL AND consumed_at IS NULL AND revoked_at IS NULL`, [account.id])
      const token = mint('inv')
      const expiresAt = new Date(now().getTime() + inviteTtlDays * DAY)
      await c.query(`INSERT INTO owner_portal_invitations (account_id, purpose, token_hash, expires_at, created_by_agent_id) VALUES ($1,$2,$3,$4,$5)`,
        [account.id, purpose, sha(token), expiresAt, agentId])
      await c.query(`UPDATE owner_portal_accounts SET identity_method=$2, updated_at=NOW() WHERE id=$1`, [account.id, method])
      await audit(c, account.id, staffActor(agentId), purpose === 'recovery' ? 'recovery_link_created' : 'invitation_created', null, { identityMethod: method, expiresAt })
      return { url: `${portalUrl}#t=${token}`, token, expiresAt: expiresAt.toISOString(), purpose }
    })
  }

  async function revokeInvitation({ ownerId, agentId }) {
    return tx(async c => {
      const { rows: [a] } = await c.query(`SELECT id FROM owner_portal_accounts WHERE owner_id=$1`, [ownerId])
      if (!a) throw new PortalError('ACCOUNT_NOT_FOUND', 'No portal account', 404)
      const r = await c.query(`UPDATE owner_portal_invitations SET revoked_at=NOW() WHERE account_id=$1 AND delegate_id IS NULL AND consumed_at IS NULL AND revoked_at IS NULL`, [a.id])
      await audit(c, a.id, staffActor(agentId), 'invitation_revoked', null, { count: r.rowCount })
      return { revoked: r.rowCount }
    })
  }

  async function setAccountState({ ownerId, agentId, state }) {
    if (!['active', 'suspended', 'revoked'].includes(state)) throw new PortalError('FIELD_INVALID', 'state must be active, suspended or revoked')
    return tx(async c => {
      const { rows: [a] } = await c.query(`UPDATE owner_portal_accounts SET state=$2, updated_at=NOW() WHERE owner_id=$1 RETURNING id`, [ownerId, state])
      if (!a) throw new PortalError('ACCOUNT_NOT_FOUND', 'No portal account', 404)
      if (state !== 'active') {
        await c.query(`UPDATE owner_portal_sessions SET revoked_at=NOW() WHERE account_id=$1 AND revoked_at IS NULL`, [a.id])
        await c.query(`UPDATE owner_portal_invitations SET revoked_at=NOW() WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, [a.id])
      }
      await audit(c, a.id, staffActor(agentId), `account_${state}`)
      return { state }
    })
  }

  async function revokeSessions({ ownerId, agentId }) {
    return tx(async c => {
      const { rows: [a] } = await c.query(`SELECT id FROM owner_portal_accounts WHERE owner_id=$1`, [ownerId])
      if (!a) throw new PortalError('ACCOUNT_NOT_FOUND', 'No portal account', 404)
      const r = await c.query(`UPDATE owner_portal_sessions SET revoked_at=NOW() WHERE account_id=$1 AND revoked_at IS NULL`, [a.id])
      await audit(c, a.id, staffActor(agentId), 'sessions_revoked', null, { count: r.rowCount })
      return { revoked: r.rowCount }
    })
  }

  async function setPilotState({ ownerId, agentId, state, note }) {
    if (!PILOT.includes(state)) throw new PortalError('FIELD_INVALID', `state must be one of ${PILOT.join(', ')}`)
    const n = str(note, 500, 'Note')
    return tx(async c => {
      const { rows: [o] } = await c.query(`SELECT id FROM owner_contacts WHERE id=$1`, [ownerId])
      if (!o) throw new PortalError('OWNER_NOT_FOUND', 'Owner not found', 404)
      const { rows: [row] } = await c.query(`INSERT INTO owner_pilot_states (owner_id, state, note, updated_by_agent_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT (owner_id) DO UPDATE SET state=EXCLUDED.state, note=EXCLUDED.note, updated_by_agent_id=EXCLUDED.updated_by_agent_id, updated_at=NOW() RETURNING *`,
      [ownerId, state, n, agentId])
      const { rows: [a] } = await c.query(`SELECT id FROM owner_portal_accounts WHERE owner_id=$1`, [ownerId])
      await c.query(`INSERT INTO agent_activity_log (agent_id, action_type, target_type, target_id, details) VALUES ($1,'OWNER_PILOT_STATE','owner',$2,$3)`,
        [agentId, String(ownerId), JSON.stringify({ state })])
      if (a) await audit(c, a.id, staffActor(agentId), 'pilot_state', null, { state })
      return { state: row.state, note: row.note, updatedAt: row.updated_at }
    })
  }

  async function staffOverview(ownerId) {
    const { rows: [o] } = await q(`SELECT id, name FROM owner_contacts WHERE id=$1`, [ownerId])
    if (!o) throw new PortalError('OWNER_NOT_FOUND', 'Owner not found', 404)
    const { rows: [a] } = await q(`SELECT * FROM owner_portal_accounts WHERE owner_id=$1`, [ownerId])
    const { rows: [pilot] } = await q(`SELECT state, note, updated_at FROM owner_pilot_states WHERE owner_id=$1`, [ownerId])
    const out = { ownerId, account: null, pilot: pilot || null, invitation: null, sessions: 0, pendingProposals: 0, delegates: [] }
    if (!a) return out
    out.account = { state: a.state, identityMethod: a.identity_method, propertiesConfirmedAt: a.properties_confirmed_at, notifyMode: a.notify_mode, createdAt: a.created_at }
    const { rows: [inv] } = await q(`SELECT purpose, expires_at, consumed_at, revoked_at, created_at FROM owner_portal_invitations WHERE account_id=$1 AND delegate_id IS NULL ORDER BY id DESC LIMIT 1`, [a.id])
    if (inv) out.invitation = { purpose: inv.purpose, createdAt: inv.created_at, expiresAt: inv.expires_at,
      state: inv.revoked_at ? 'revoked' : inv.consumed_at ? 'used' : new Date(inv.expires_at) < now() ? 'expired' : 'open' }
    out.sessions = (await q(`SELECT COUNT(*)::int AS n FROM owner_portal_sessions WHERE account_id=$1 AND revoked_at IS NULL AND expires_at > NOW()`, [a.id])).rows[0].n
    out.pendingProposals = (await q(`SELECT COUNT(*)::int AS n FROM owner_property_proposals WHERE account_id=$1 AND review_state='pending'`, [a.id])).rows[0].n
    out.delegates = (await q(`SELECT id, name, role, property_ids, scopes, state FROM owner_portal_delegates WHERE account_id=$1 ORDER BY id`, [a.id])).rows
    return out
  }

  async function listProposals({ state = 'pending' } = {}) {
    const { rows } = await q(`SELECT pr.id, pr.property_id, p.ref, pr.fields, pr.actor_kind, pr.review_state, pr.created_at, a.owner_id
      FROM owner_property_proposals pr JOIN properties p ON p.id=pr.property_id JOIN owner_portal_accounts a ON a.id=pr.account_id
      WHERE pr.review_state=$1 ORDER BY pr.id DESC LIMIT 200`, [state])
    return rows
  }

  // Staff decide. Accepting records the decision; the listing itself is then
  // edited in the existing property editor, so agent-owned commercial terms
  // and publication stay with the agency.
  async function reviewProposal({ id, agentId, decision, note }) {
    if (!['accepted', 'rejected'].includes(decision)) throw new PortalError('FIELD_INVALID', 'decision must be accepted or rejected')
    return tx(async c => {
      const { rows: [pr] } = await c.query(`UPDATE owner_property_proposals SET review_state=$2, reviewed_by_agent_id=$3, reviewed_at=NOW(), review_note=$4
        WHERE id=$1 AND review_state='pending' RETURNING *`, [id, decision, agentId, str(note, 500, 'Note')])
      if (!pr) throw new PortalError('PROPOSAL_NOT_PENDING', 'Proposal is not pending', 409)
      await c.query(`UPDATE owner_distribution_settings SET sync_state = CASE WHEN owner_allowed THEN 'synced' ELSE sync_state END, updated_at=NOW()
        WHERE property_id=$1 AND sync_state='update_pending'`, [pr.property_id])
      await audit(c, pr.account_id, staffActor(agentId), `proposal_${decision}`, pr.property_id, { proposalId: pr.id })
      return { id: pr.id, reviewState: pr.review_state }
    })
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  async function claimInvitation({ token, userAgent }) {
    const invalid = () => new PortalError('INVITATION_INVALID', 'This link is not valid any more. Ask your ARGUS contact for a new one.', 404)
    if (!TOKEN_RE.test(String(token || '')) || !String(token).startsWith('inv_')) throw invalid()
    return tx(async c => {
      const { rows: [inv] } = await c.query(`SELECT * FROM owner_portal_invitations WHERE token_hash=$1 FOR UPDATE`, [sha(token)])
      if (!inv || inv.consumed_at || inv.revoked_at || new Date(inv.expires_at) <= now()) throw invalid()
      const { rows: [a] } = await c.query(`SELECT * FROM owner_portal_accounts WHERE id=$1 FOR UPDATE`, [inv.account_id])
      if (!a || ['suspended', 'revoked'].includes(a.state)) throw invalid()
      if (inv.delegate_id) {
        const { rows: [d] } = await c.query(`UPDATE owner_portal_delegates SET state='active' WHERE id=$1 AND state<>'revoked' RETURNING id`, [inv.delegate_id])
        if (!d) throw invalid()
      } else if (a.state === 'invited') {
        await c.query(`UPDATE owner_portal_accounts SET state='active', updated_at=NOW() WHERE id=$1`, [a.id])
      }
      await c.query(`UPDATE owner_portal_invitations SET consumed_at=NOW() WHERE id=$1`, [inv.id])
      const session = mint('ses')
      const expiresAt = new Date(now().getTime() + sessionDays * DAY)
      await c.query(`INSERT INTO owner_portal_sessions (account_id, delegate_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)`,
        [a.id, inv.delegate_id, sha(session), expiresAt, userAgent ? String(userAgent).slice(0, 200) : null])
      await audit(c, a.id, inv.delegate_id ? { kind: 'delegate', ref: `delegate:${inv.delegate_id}` } : { kind: 'owner', ref: `owner:${a.owner_id}` }, 'signed_in', null, { via: inv.purpose })
      return { sessionToken: session, expiresAt: expiresAt.toISOString(), delegate: !!inv.delegate_id }
    })
  }

  async function authenticate(token) {
    if (!TOKEN_RE.test(String(token || '')) || !String(token).startsWith('ses_')) return null
    const { rows: [r] } = await q(`SELECT s.id, s.account_id, s.delegate_id, s.last_seen_at, a.owner_id, a.state AS account_state,
        d.property_ids, d.scopes, d.state AS delegate_state
      FROM owner_portal_sessions s JOIN owner_portal_accounts a ON a.id=s.account_id
      LEFT JOIN owner_portal_delegates d ON d.id=s.delegate_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > $2`, [sha(token), now()])
    if (!r || r.account_state !== 'active') return null
    if (r.delegate_id && r.delegate_state !== 'active') return null
    if (!r.last_seen_at || now() - new Date(r.last_seen_at) > 5 * 60000) q(`UPDATE owner_portal_sessions SET last_seen_at=NOW() WHERE id=$1`, [r.id]).catch(() => {})
    return { sessionId: r.id, accountId: r.account_id, ownerId: r.owner_id, delegateId: r.delegate_id || null,
      propertyIds: r.delegate_id ? r.property_ids : null, scopes: r.delegate_id ? r.scopes : null }
  }

  async function logout(token) {
    if (!TOKEN_RE.test(String(token || ''))) return { ok: true }
    await q(`UPDATE owner_portal_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL`, [sha(token)])
    return { ok: true }
  }

  // ── Scoped property access (the authorisation boundary) ──────────────────
  const can = (p, scope) => !p.delegateId || (p.scopes || []).includes(scope)
  const ownerOnly = p => { if (p.delegateId) throw new PortalError('OWNER_ONLY', 'Only the owner can do this.', 403) }

  async function scopedProperties(p, propertyId = null, c = db) {
    const { rows } = await c.query(`SELECT p.* FROM properties p
      WHERE p.owner_id=$1 AND NOT p.is_staging AND ($2::int[] IS NULL OR p.id = ANY($2)) AND ($3::int IS NULL OR p.id=$3) ORDER BY p.id`,
    [p.ownerId, p.propertyIds, propertyId])
    return rows
  }
  async function requireProperty(p, propertyId, scope, c = db) {
    const id = Number(propertyId)
    if (!Number.isInteger(id) || id <= 0 || !can(p, scope)) throw new PortalError('NOT_FOUND', 'Property not found', 404)
    const [row] = await scopedProperties(p, id, c)
    if (!row) throw new PortalError('NOT_FOUND', 'Property not found', 404)
    return row
  }

  async function rulesFor(propertyId, c = db) {
    const { rows: [r] } = await c.query(`SELECT schedule, version, updated_at FROM owner_viewing_rules WHERE property_id=$1`, [propertyId])
    return r ? { schedule: S.validateSchedule(r.schedule), version: r.version, updatedAt: r.updated_at } : null
  }

  async function distributionFor(propertyId, c = db) {
    const { rows } = await c.query(`SELECT destination, owner_allowed, sync_state, updated_at FROM owner_distribution_settings WHERE property_id=$1`, [propertyId])
    return DESTINATIONS.map(d => {
      const r = rows.find(x => x.destination === d)
      if (r) return { destination: d, allowed: r.owner_allowed, state: r.sync_state, available: !NOT_YET_AVAILABLE.includes(d) }
      // The listing already lives with this agency: connected unless the owner paused it.
      return d === 'argus_agency' ? { destination: d, allowed: true, state: 'connected', available: true }
        : { destination: d, allowed: false, state: 'not_connected', available: !NOT_YET_AVAILABLE.includes(d) }
    })
  }

  async function me(p) {
    const { rows: [a] } = await q(`SELECT a.state, a.properties_confirmed_at, a.notify_mode, a.urgent_separately, o.name
      FROM owner_portal_accounts a JOIN owner_contacts o ON o.id=a.owner_id WHERE a.id=$1`, [p.accountId])
    let delegate = null
    if (p.delegateId) {
      const { rows: [d] } = await q(`SELECT name, role, scopes FROM owner_portal_delegates WHERE id=$1`, [p.delegateId])
      delegate = d
    }
    const props = await scopedProperties(p)
    const pending = (await q(`SELECT property_id, COUNT(*)::int AS n FROM viewing_coordination WHERE property_id = ANY($1) AND state IN ('REQUESTED','RESCHEDULE_REQUESTED') GROUP BY property_id`, [props.map(x => x.id)])).rows
    return {
      owner: { name: a.name }, delegate, role: p.delegateId ? 'property_manager' : 'owner', scopes: p.delegateId ? p.scopes : SCOPES,
      propertiesConfirmedAt: a.properties_confirmed_at, notifyMode: a.notify_mode, urgentSeparately: a.urgent_separately,
      properties: props.map(x => ({ ...pick(x, ['id', 'ref', 'town', 'property_type', 'bedrooms', 'available_status', 'longlet_price', 'sale_price']),
        cover: Array.isArray(x.images) && x.images[0] ? (x.images[0].url || x.images[0]) : null,
        openRequests: (pending.find(r => r.property_id === x.id) || { n: 0 }).n })),
    }
  }

  async function confirmProperties(p, { notMine = [] } = {}) {
    ownerOnly(p)
    const own = new Set((await scopedProperties(p)).map(x => x.id))
    const flagged = (Array.isArray(notMine) ? notMine : []).map(Number).filter(id => own.has(id))
    return tx(async c => {
      await c.query(`UPDATE owner_portal_accounts SET properties_confirmed_at=NOW(), updated_at=NOW() WHERE id=$1`, [p.accountId])
      await audit(c, p.accountId, principalActor(p), 'properties_confirmed', null, { notMine: flagged })
      return { confirmed: own.size - flagged.length, flaggedForStaff: flagged }
    })
  }

  async function propertyDetail(p, propertyId) {
    const row = await requireProperty(p, propertyId, p.delegateId ? (p.scopes.includes('inventory') ? 'inventory' : 'schedule') : 'inventory')
    const { rows: proposals } = await q(`SELECT id, fields, review_state, created_at, reviewed_at FROM owner_property_proposals WHERE property_id=$1 AND account_id=$2 ORDER BY id DESC LIMIT 10`, [row.id, p.accountId])
    const { rows: media } = await q(`SELECT id, kind, filename, content_type, position, visibility, review_state, created_at FROM owner_property_media WHERE property_id=$1 AND review_state<>'removed' ORDER BY kind, position, id`, [row.id])
    return { property: pick(row, OWNER_FIELDS), proposals, media, rules: await rulesFor(row.id), distribution: await distributionFor(row.id) }
  }

  // ── Inventory changes (review queue) ─────────────────────────────────────
  function cleanFields(f) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new PortalError('FIELD_INVALID', 'fields must be an object')
    const out = {}
    for (const [k, v] of Object.entries(f)) {
      if (k === 'description') out[k] = str(v, 4000, 'Description')
      else if (k === 'available_status') { if (!STATUSES.includes(v)) throw new PortalError('FIELD_INVALID', `available_status must be one of ${STATUSES.join(', ')}`); out[k] = v }
      else if (k === 'available_date') { if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new PortalError('FIELD_INVALID', 'available_date must be YYYY-MM-DD'); out[k] = v }
      else if (k === 'asking_rent' || k === 'asking_price') { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 100000000) throw new PortalError('FIELD_INVALID', `${k} must be a positive amount`); out[k] = Math.round(n) }
      else if (k === 'amenities') { if (!Array.isArray(v) || v.length > 60 || v.some(a => typeof a !== 'string' || !a.trim() || a.length > 40)) throw new PortalError('FIELD_INVALID', 'amenities must be up to 60 short labels'); out[k] = [...new Set(v.map(a => a.trim()))] }
      else if (k === 'conditions') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PortalError('FIELD_INVALID', 'conditions must be an object')
        const c = {}
        for (const [ck, cv] of Object.entries(v)) {
          if (!['pets', 'smoking', 'min_lease_months', 'furnished', 'other'].includes(ck)) throw new PortalError('FIELD_INVALID', `Unknown condition: ${ck.slice(0, 30)}`)
          c[ck] = ck === 'min_lease_months' ? Math.max(0, Math.min(120, parseInt(cv, 10) || 0)) : str(cv, 200, ck)
        }
        out[k] = c
      } else if (k === 'photo_order') { if (!Array.isArray(v) || v.length > 80) throw new PortalError('FIELD_INVALID', 'photo_order must be a list'); out[k] = v.map(String).slice(0, 80) }
      else throw new PortalError('FIELD_NOT_EDITABLE', `${k.slice(0, 40)} cannot be changed by the owner`)
    }
    if (!Object.keys(out).length) throw new PortalError('FIELD_REQUIRED', 'Nothing to change')
    return out
  }

  async function proposeChange(p, propertyId, fields) {
    const row = await requireProperty(p, propertyId, 'inventory')
    const clean = cleanFields(fields)
    return tx(async c => {
      const { rows: prev } = await c.query(`UPDATE owner_property_proposals SET review_state='superseded' WHERE property_id=$1 AND account_id=$2 AND review_state='pending' RETURNING fields`, [row.id, p.accountId])
      const merged = Object.assign({}, ...prev.reverse().map(x => x.fields), clean)
      const actor = principalActor(p)
      const { rows: [pr] } = await c.query(`INSERT INTO owner_property_proposals (property_id, account_id, actor_kind, actor_ref, fields) VALUES ($1,$2,$3,$4,$5) RETURNING id, fields, review_state, created_at`,
        [row.id, p.accountId, actor.kind, actor.ref, JSON.stringify(merged)])
      await c.query(`UPDATE owner_distribution_settings SET sync_state='update_pending', updated_at=NOW() WHERE property_id=$1 AND owner_allowed AND sync_state IN ('connected','synced')`, [row.id])
      await audit(c, p.accountId, actor, 'change_proposed', row.id, { proposalId: pr.id, fields: Object.keys(clean) })
      return pr
    })
  }

  async function submitProperty(p, fields) {
    ownerOnly(p)
    const f = {
      town: str(fields?.town, 80, 'Town', { required: true, min: 2 }),
      property_type: str(fields?.property_type, 40, 'Property type', { required: true, min: 2 }),
      bedrooms: fields?.bedrooms === undefined ? null : Math.max(0, Math.min(20, parseInt(fields.bedrooms, 10) || 0)),
      asking_rent: fields?.asking_rent ? Math.round(Number(fields.asking_rent)) || null : null,
      asking_price: fields?.asking_price ? Math.round(Number(fields.asking_price)) || null : null,
      available_date: fields?.available_date && /^\d{4}-\d{2}-\d{2}$/.test(fields.available_date) ? fields.available_date : null,
      description: str(fields?.description, 4000, 'Description'),
    }
    return tx(async c => {
      const { rows: [s] } = await c.query(`INSERT INTO owner_property_submissions (account_id, fields) VALUES ($1,$2) RETURNING id, review_state, created_at`, [p.accountId, JSON.stringify(f)])
      await audit(c, p.accountId, principalActor(p), 'property_submitted', null, { submissionId: s.id })
      return s
    })
  }

  async function addMedia(p, propertyId, { kind, filename, contentType, bytes, visibility = 'agency' }) {
    const row = await requireProperty(p, propertyId, 'inventory')
    if (!MEDIA_TYPES[kind]) throw new PortalError('FIELD_INVALID', 'kind must be photo or document')
    if (!MEDIA_TYPES[kind].includes(contentType)) throw new PortalError('FILE_TYPE', `This file type is not accepted for a ${kind}`)
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8 * 1024 * 1024) throw new PortalError('FILE_SIZE', 'Files must be up to 8 MB')
    if (!['agency', 'shared'].includes(visibility)) throw new PortalError('FIELD_INVALID', 'visibility must be agency or shared')
    return tx(async c => {
      const { rows: [{ n }] } = await c.query(`SELECT COUNT(*)::int AS n FROM owner_property_media WHERE property_id=$1 AND review_state IN ('pending','accepted')`, [row.id])
      if (n >= 60) throw new PortalError('MEDIA_LIMIT', 'This property already has 60 files', 409)
      const { rows: [m] } = await c.query(`INSERT INTO owner_property_media (property_id, account_id, kind, filename, content_type, bytes, position, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id, kind, filename, content_type, position, visibility, review_state, created_at`,
      [row.id, p.accountId, kind, str(filename, 160, 'File name', { required: true }), contentType, bytes, n, visibility])
      await audit(c, p.accountId, principalActor(p), 'media_added', row.id, { mediaId: m.id, kind })
      return m
    })
  }

  async function mediaFile(p, mediaId) {
    const { rows: [m] } = await q(`SELECT m.* FROM owner_property_media m JOIN properties pr ON pr.id=m.property_id
      WHERE m.id=$1 AND pr.owner_id=$2 AND ($3::int[] IS NULL OR pr.id = ANY($3)) AND m.review_state<>'removed'`, [Number(mediaId) || 0, p.ownerId, p.propertyIds])
    if (!m || !can(p, 'inventory')) throw new PortalError('NOT_FOUND', 'File not found', 404)
    return { contentType: m.content_type, filename: m.filename, bytes: m.bytes }
  }

  async function arrangeMedia(p, propertyId, { order = [], remove = [] }) {
    const row = await requireProperty(p, propertyId, 'inventory')
    return tx(async c => {
      for (const [i, id] of (Array.isArray(order) ? order : []).entries()) await c.query(`UPDATE owner_property_media SET position=$3 WHERE id=$1 AND property_id=$2`, [Number(id) || 0, row.id, i])
      const r = await c.query(`UPDATE owner_property_media SET review_state='removed' WHERE property_id=$1 AND id = ANY($2::bigint[])`, [row.id, (Array.isArray(remove) ? remove : []).map(Number).filter(Boolean)])
      await audit(c, p.accountId, principalActor(p), 'media_arranged', row.id, { reordered: order.length, removed: r.rowCount })
      return { ok: true }
    })
  }

  // ── Viewing rules → windows (one calendar) ───────────────────────────────
  async function materialise(c, propertyId, schedule) {
    const today = S.dayKey(now().getTime())
    await c.query(`DELETE FROM property_viewing_windows WHERE property_id=$1 AND source_type='owner_portal' AND ends_at > $2`, [propertyId, now()])
    const windows = S.windowsFor(schedule, today, schedule.horizonDays).filter(w => Date.parse(w.end) > now().getTime())
    for (const w of windows) {
      await c.query(`INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, status, confirmation, source_type, evidence, confidence)
        VALUES ($1,'window',$2,$3,'active','full_window','owner_portal','Owner portal weekly availability','explicit')`, [propertyId, w.start, w.end])
    }
    return windows
  }

  async function saveRules(p, propertyId, input) {
    const row = await requireProperty(p, propertyId, 'schedule')
    const schedule = S.validateSchedule(input)
    return tx(async c => {
      const actor = principalActor(p)
      const { rows: [r] } = await c.query(`INSERT INTO owner_viewing_rules (property_id, account_id, schedule, updated_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (property_id) DO UPDATE SET schedule=EXCLUDED.schedule, version=owner_viewing_rules.version+1, updated_by=EXCLUDED.updated_by, updated_at=NOW()
        RETURNING version`, [row.id, p.accountId, JSON.stringify(schedule), actor.ref])
      const windows = await materialise(c, row.id, schedule)
      await audit(c, p.accountId, actor, 'availability_updated', row.id, { version: r.version, windows: windows.length })
      return { schedule, version: r.version, windows: windows.length }
    })
  }

  async function copyRules(p, fromId, toIds) {
    const from = await rulesFor((await requireProperty(p, fromId, 'schedule')).id)
    if (!from) throw new PortalError('NO_RULES', 'Set availability on this property first', 409)
    const out = []
    for (const id of (Array.isArray(toIds) ? toIds : []).slice(0, 50)) out.push({ propertyId: Number(id), ...(await saveRules(p, id, from.schedule)) })
    return out
  }

  // ── Viewing desk ─────────────────────────────────────────────────────────
  const CLIENT_KEYS = ['people', 'groupType', 'moveIn', 'pets', 'budgetNote', 'notes', 'clientRef']
  function shapeRequest(r, audience) {
    const base = { id: Number(r.id), propertyId: r.property_id, state: r.state, label: V.LABEL[r.state], durationMin: r.duration_min,
      preferred: r.preferred, proposedStart: r.proposed_start, proposedEnd: r.proposed_end, expiresAt: r.expires_at, createdAt: r.created_at, updatedAt: r.updated_at }
    if (audience === 'owner') return { ...base, agent: { name: r.requester_name, agency: r.requester_agency, kind: r.requester_kind }, client: pick(r.client || {}, CLIENT_KEYS), note: r.decision_note }
    return base // agents see their own request without anyone else's data
  }

  async function busyFor(c, propertyId, excludeViewingId = null) {
    const { rows } = await c.query(`SELECT id, starts_at, duration_min, status, source FROM property_viewings
      WHERE property_id=$1 AND status IN ('pending','confirmed') AND starts_at IS NOT NULL AND starts_at > NOW() - INTERVAL '1 day' AND ($2::int IS NULL OR id <> $2)`,
    [propertyId, excludeViewingId])
    return rows.map(r => ({ viewingId: r.id, start: new Date(r.starts_at).toISOString(), end: new Date(new Date(r.starts_at).getTime() + r.duration_min * 60000).toISOString(), status: r.status, source: r.source }))
  }

  async function desk(p, { days = 7 } = {}) {
    if (!can(p, 'requests') && !can(p, 'schedule')) throw new PortalError('NOT_FOUND', 'Not found', 404)
    const props = await scopedProperties(p)
    const ids = props.map(x => x.id)
    const { rows: reqs } = await q(`SELECT * FROM viewing_coordination WHERE property_id = ANY($1) AND (state = ANY($2) OR updated_at > NOW() - INTERVAL '14 days') ORDER BY created_at`, [ids, V.OPEN])
    // Bookings made through the existing board flow (WhatsApp owner ask) are
    // shown read-only: that flow keeps owning them.
    const { rows: legacy } = await q(`SELECT v.id, v.property_id, v.starts_at, v.duration_min, v.status FROM property_viewings v
      WHERE v.property_id = ANY($1) AND v.status IN ('pending','confirmed') AND v.starts_at > NOW() - INTERVAL '1 day'
        AND NOT EXISTS (SELECT 1 FROM viewing_coordination c WHERE c.viewing_id = v.id) ORDER BY v.starts_at`, [ids])
    const today = S.dayKey(now().getTime())
    const n = Math.max(1, Math.min(31, Number(days) || 7))
    const calendars = []
    for (const prop of props) {
      const rules = await rulesFor(prop.id)
      const busy = await busyFor(db, prop.id)
      calendars.push({ propertyId: prop.id, ref: prop.ref, town: prop.town, rules: rules ? rules.schedule : null,
        windows: rules ? S.windowsFor(rules.schedule, today, n) : [],
        slots: rules ? S.slotsFor(rules.schedule, { fromDate: today, days: n, busy, now: now().getTime() }) : [] })
    }
    return {
      timezone: S.TZ, from: today, days: n,
      requests: reqs.map(r => shapeRequest(r, 'owner')),
      external: legacy.map(v => ({ viewingId: v.id, propertyId: v.property_id, startsAt: v.starts_at, durationMin: v.duration_min, status: v.status, managedBy: 'board_booking' })),
      calendars,
    }
  }

  async function lockProperty(c, propertyId) { await c.query(`SELECT pg_advisory_xact_lock(907716, $1)`, [propertyId]) }

  async function event(c, coord, from, to, action, actor, details = {}) {
    await c.query(`INSERT INTO viewing_coordination_events (coordination_id, from_state, to_state, action, actor_kind, actor_ref, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [coord.id, from, to, action, actor.kind, actor.ref || null, JSON.stringify(details)])
  }

  async function releaseViewing(c, coord, reason) {
    if (!coord.viewing_id) return
    await c.query(`UPDATE property_viewings SET status='cancelled', cancelled_at=NOW(), cancel_reason=$2 WHERE id=$1 AND status IN ('pending','confirmed')`, [coord.viewing_id, reason])
  }

  // Owner (or auto-approval) puts a request onto a slot. Holds the time in
  // property_viewings as 'pending'; it is NOT confirmed until the agent
  // reconfirms with the client.
  async function proposeSlot(c, coord, { start, actor, allowOutsideRules = false, allowBufferOverlap = false }) {
    const s = Date.parse(start)
    if (!Number.isFinite(s)) throw new PortalError('FIELD_INVALID', 'start must be an ISO time')
    const e = s + coord.duration_min * 60000
    await lockProperty(c, coord.property_id)
    const rules = await rulesFor(coord.property_id, c)
    const busy = await busyFor(c, coord.property_id, coord.viewing_id)
    const hard = busy.find(b => s < Date.parse(b.end) && e > Date.parse(b.start))
    if (hard) throw new PortalError('SLOT_CONFLICT', 'Another viewing already holds this time.', 409, { conflict: hard })
    if (rules) {
      const fit = S.fitsSchedule(rules.schedule, new Date(s).toISOString(), new Date(e).toISOString(), { busy, now: now().getTime() })
      if (!fit.ok) {
        const overridable = (fit.reason === 'OUTSIDE_AVAILABILITY' && allowOutsideRules) || (fit.reason === 'CONFLICT' && allowBufferOverlap)
        if (!overridable) throw new PortalError(fit.reason === 'CONFLICT' ? 'BUFFER_CONFLICT' : fit.reason, {
          OUTSIDE_AVAILABILITY: 'This time is outside your availability.', NOTICE_TOO_SHORT: 'This is sooner than your notice period.',
          CONFLICT: 'This is inside the buffer of another viewing.', INVALID_RANGE: 'Invalid time' }[fit.reason], 409, { overridable: fit.reason !== 'NOTICE_TOO_SHORT' })
      }
    } else if (s < now().getTime()) throw new PortalError('IN_THE_PAST', 'This time has passed.', 409)
    const startIso = new Date(s).toISOString()
    const day = S.dayKey(s)
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: S.TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s))
    let viewingId = coord.viewing_id
    try {
      if (viewingId) {
        await c.query(`UPDATE property_viewings SET starts_at=$2, duration_min=$3, viewing_date=$4, viewing_time=$5, status='pending', cancelled_at=NULL, cancel_reason=NULL WHERE id=$1`,
          [viewingId, startIso, coord.duration_min, day, time])
      } else {
        const { rows: [v] } = await c.query(`INSERT INTO property_viewings (property_id, starts_at, duration_min, viewing_date, viewing_time, status, source, requester_name, viewing_agent_id, notes)
          VALUES ($1,$2,$3,$4,$5,'pending','owner_portal',$6,$7,$8) RETURNING id`,
        [coord.property_id, startIso, coord.duration_min, day, time, coord.requester_name, coord.requester_agent_id,
          'Owner portal: slot proposed by the owner, awaiting agent and client reconfirmation'])
        viewingId = v.id
      }
    } catch (err) {
      if (err.code === '23P01') throw new PortalError('SLOT_CONFLICT', 'Another viewing already holds this time.', 409)
      throw err
    }
    // The agent has until 2 h before the viewing (at most 48 h) to reconfirm.
    const expires = new Date(Math.max(now().getTime() + 30 * 60000, Math.min(s - 2 * 3600000, now().getTime() + 48 * 3600000)))
    const to = V.transition(coord.state, 'propose', actor.kind === 'system' ? 'system' : 'owner')
    const { rows: [u] } = await c.query(`UPDATE viewing_coordination SET state=$2, viewing_id=$3, proposed_start=$4, proposed_end=$5, expires_at=$6, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [coord.id, to, viewingId, startIso, new Date(e).toISOString(), expires])
    const { rows: [prop] } = await c.query(`SELECT ref FROM properties WHERE id=$1`, [coord.property_id])
    const message = V.proposalMessage({ ref: prop.ref, startsAt: startIso })
    await event(c, coord, coord.state, to, 'propose', actor, { start: startIso, agentMessage: message, delivered: false })
    return { coordination: u, agentMessage: message }
  }

  async function ownerAct(p, coordinationId, action, body = {}) {
    if (!can(p, 'requests')) throw new PortalError('NOT_FOUND', 'Not found', 404)
    return tx(async c => {
      const { rows: [coord] } = await c.query(`SELECT vc.* FROM viewing_coordination vc JOIN properties pr ON pr.id=vc.property_id
        WHERE vc.id=$1 AND pr.owner_id=$2 AND ($3::int[] IS NULL OR pr.id = ANY($3)) FOR UPDATE OF vc`, [Number(coordinationId) || 0, p.ownerId, p.propertyIds])
      if (!coord) throw new PortalError('NOT_FOUND', 'Request not found', 404)
      const actor = principalActor(p)
      let result
      if (action === 'propose') {
        result = await proposeSlot(c, coord, { start: body.start, actor, allowOutsideRules: body.allowOutsideRules === true, allowBufferOverlap: body.allowBufferOverlap === true })
      } else {
        const map = { decline: 'decline', cancel: 'cancel', complete: 'complete', no_show: 'no_show', reschedule: 'owner_reschedule' }
        if (!map[action]) throw new PortalError('UNKNOWN_ACTION', 'Unknown action', 400)
        const to = V.transition(coord.state, map[action], 'owner')
        const note = str(body.note, 300, 'Note')
        if (['DECLINED', 'CANCELLED', 'RESCHEDULE_REQUESTED'].includes(to)) await releaseViewing(c, coord, `owner_${action}`)
        if (to === 'COMPLETED' || to === 'NO_SHOW') await c.query(`UPDATE property_viewings SET status=$2 WHERE id=$1`, [coord.viewing_id, V.legacyStatus(to)])
        const { rows: [u] } = await c.query(`UPDATE viewing_coordination SET state=$2, decision_note=COALESCE($3, decision_note), updated_at=NOW() WHERE id=$1 RETURNING *`, [coord.id, to, note])
        await event(c, coord, coord.state, to, action, actor, { note, urgent: coord.state === 'CONFIRMED' })
        result = { coordination: u }
      }
      await audit(c, p.accountId, actor, `viewing_${action}`, coord.property_id, { coordinationId: coord.id })
      return { request: shapeRequest(result.coordination, 'owner'), agentMessage: result.agentMessage || null }
    })
  }

  // ── Share links (agent-facing, never a login) ────────────────────────────
  async function createShareLink(p, { propertyIds, label, allowRequests = true, expiresInDays = null }) {
    if (!can(p, 'sharing')) throw new PortalError('NOT_FOUND', 'Not found', 404)
    const own = new Set((await scopedProperties(p)).map(x => x.id))
    const ids = [...new Set((Array.isArray(propertyIds) ? propertyIds : []).map(Number))].filter(id => own.has(id))
    if (!ids.length) throw new PortalError('FIELD_REQUIRED', 'Choose at least one of your properties')
    const days = expiresInDays === null || expiresInDays === undefined ? null : Math.max(1, Math.min(365, parseInt(expiresInDays, 10) || 30))
    const token = mint('shr')
    return tx(async c => {
      const { rows: [l] } = await c.query(`INSERT INTO owner_share_links (account_id, token_hash, label, property_ids, allow_requests, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, label, property_ids, allow_requests, expires_at, created_at`,
        [p.accountId, sha(token), str(label, 80, 'Label'), ids, allowRequests !== false, days ? new Date(now().getTime() + days * DAY) : null])
      await audit(c, p.accountId, principalActor(p), 'share_link_created', null, { linkId: l.id, properties: ids })
      return { ...l, url: `${shareUrl}/${token}`, token }
    })
  }

  async function listShareLinks(p) {
    if (!can(p, 'sharing')) throw new PortalError('NOT_FOUND', 'Not found', 404)
    const { rows } = await q(`SELECT id, label, property_ids, allow_requests, expires_at, revoked_at, views, created_at FROM owner_share_links WHERE account_id=$1 ORDER BY id DESC`, [p.accountId])
    return rows
  }

  async function revokeShareLink(p, id) {
    if (!can(p, 'sharing')) throw new PortalError('NOT_FOUND', 'Not found', 404)
    return tx(async c => {
      const r = await c.query(`UPDATE owner_share_links SET revoked_at=NOW() WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL`, [Number(id) || 0, p.accountId])
      if (!r.rowCount) throw new PortalError('NOT_FOUND', 'Link not found', 404)
      await audit(c, p.accountId, principalActor(p), 'share_link_revoked', null, { linkId: Number(id) })
      return { revoked: true }
    })
  }

  async function shareLink(token, c = db) {
    if (!TOKEN_RE.test(String(token || '')) || !String(token).startsWith('shr_')) throw new PortalError('NOT_FOUND', 'This link is not available.', 404)
    const { rows: [l] } = await c.query(`SELECT l.*, a.owner_id, a.state AS account_state FROM owner_share_links l JOIN owner_portal_accounts a ON a.id=l.account_id
      WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > $2)`, [sha(token), now()])
    if (!l || l.account_state !== 'active') throw new PortalError('NOT_FOUND', 'This link is not available.', 404)
    return l
  }

  async function shareView(token) {
    const l = await shareLink(token)
    q(`UPDATE owner_share_links SET views = views + 1 WHERE id=$1`, [l.id]).catch(() => {})
    // Properties still owned by this owner only; a sold-on property drops out.
    const { rows } = await q(`SELECT * FROM properties WHERE id = ANY($1) AND owner_id=$2 AND NOT is_staging ORDER BY id`, [l.property_ids, l.owner_id])
    const today = S.dayKey(now().getTime())
    const properties = []
    for (const r of rows) {
      const rules = await rulesFor(r.id)
      const busy = await busyFor(db, r.id)
      const { rows: docs } = await q(`SELECT id, filename, kind FROM owner_property_media WHERE property_id=$1 AND visibility='shared' AND review_state='accepted' ORDER BY position`, [r.id])
      properties.push({ id: r.id, ...pick(r, SHARE_FIELDS),
        viewing: rules ? { durationMin: rules.schedule.durationMin, approval: rules.schedule.approval,
          // free slots only: who holds the busy ones is never shown
          slots: S.slotsFor(rules.schedule, { fromDate: today, days: 14, busy, now: now().getTime() }).filter(x => x.state === 'free').slice(0, 120).map(x => ({ start: x.start, end: x.end })) } : null,
        sharedFiles: docs.map(d => ({ id: d.id, filename: d.filename, kind: d.kind })) })
    }
    return { label: l.label, allowRequests: l.allow_requests, timezone: S.TZ, properties,
      terms: 'Viewings are coordinated by ARGUS. Owner contact details are not shared through this link. Agency terms and referral fees follow your agreement with the listing agency.' }
  }

  async function shareRequest(token, body = {}) {
    return tx(async c => {
      const l = await shareLink(token, c)
      if (!l.allow_requests) throw new PortalError('REQUESTS_CLOSED', 'This link does not accept viewing requests.', 409)
      const propertyId = Number(body.propertyId)
      if (!l.property_ids.includes(propertyId)) throw new PortalError('NOT_FOUND', 'Property not found', 404)
      const { rows: [prop] } = await c.query(`SELECT id, ref FROM properties WHERE id=$1 AND owner_id=$2 AND NOT is_staging`, [propertyId, l.owner_id])
      if (!prop) throw new PortalError('NOT_FOUND', 'Property not found', 404)
      const agent = body.agent || {}, client = body.client || {}
      const name = str(agent.name, 80, 'Your name', { required: true, min: 2 })
      const agency = str(agent.agency, 80, 'Agency', { required: true, min: 2 })
      const people = client.people === undefined ? null : parseInt(client.people, 10)
      if (people !== null && (!Number.isInteger(people) || people < 1 || people > 20)) throw new PortalError('FIELD_INVALID', 'people must be 1–20')
      if (client.groupType && !GROUP_TYPES.includes(client.groupType)) throw new PortalError('FIELD_INVALID', `groupType must be one of ${GROUP_TYPES.join(', ')}`)
      const cleanClient = Object.fromEntries(Object.entries({
        people, groupType: client.groupType || null,
        moveIn: client.moveIn && /^\d{4}-\d{2}-\d{2}$/.test(client.moveIn) ? client.moveIn : null,
        pets: str(client.pets, 100, 'Pets'), budgetNote: str(client.budgetNote, 200, 'Budget'), notes: str(client.notes, 500, 'Notes'),
        clientRef: str(client.clientRef, 40, 'Client reference'),
      }).filter(([, v]) => v !== null))
      const rules = await rulesFor(propertyId, c)
      const duration = rules ? rules.schedule.durationMin : 20
      const preferred = (Array.isArray(body.preferred) ? body.preferred : []).slice(0, 3).map(x => Date.parse(x && x.start))
        .filter(t => Number.isFinite(t) && t > now().getTime()).map(t => ({ start: new Date(t).toISOString(), end: new Date(t + duration * 60000).toISOString() }))
      const requestToken = mint('req')
      let coord
      try {
        ({ rows: [coord] } = await c.query(`INSERT INTO viewing_coordination (property_id, requester_kind, requester_name, requester_agency, requester_token_hash, share_link_id, client, preferred, duration_min, expires_at)
          VALUES ($1,'external_agent',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [propertyId, name, agency, sha(requestToken), l.id, JSON.stringify(cleanClient), JSON.stringify(preferred), duration, new Date(now().getTime() + 7 * DAY)]))
      } catch (err) {
        if (err.code === '23505') throw new PortalError('DUPLICATE_REQUEST', 'You already have an open request for this property and client.', 409)
        throw err
      }
      const actor = { kind: 'external_agent', ref: `${agency}:${name}`.slice(0, 120) }
      await event(c, coord, null, 'REQUESTED', 'request', actor, { preferred: preferred.length })
      await audit(c, l.account_id, actor, 'viewing_requested', propertyId, { coordinationId: coord.id })
      // Auto-approval: the first preferred time that fits the owner's rules is
      // proposed by the system. Still needs the agent's client reconfirmation.
      let auto = null
      if (rules && rules.schedule.approval === 'auto') {
        for (const pref of preferred) {
          try {
            await c.query('SAVEPOINT auto_propose')
            auto = await proposeSlot(c, coord, { start: pref.start, actor: { kind: 'system', ref: 'auto_approval' } })
            await c.query('RELEASE SAVEPOINT auto_propose')
            break
          } catch (err) {
            await c.query('ROLLBACK TO SAVEPOINT auto_propose')
            if (!(err instanceof PortalError)) throw err
          }
        }
      }
      const current = auto ? auto.coordination : coord
      return { request: shapeRequest(current, 'agent'), requestToken, url: `${shareUrl}/request/${requestToken}`, agentMessage: auto ? auto.agentMessage : null, ref: prop.ref }
    })
  }

  async function requestByToken(c, token, lock = false) {
    if (!TOKEN_RE.test(String(token || '')) || !String(token).startsWith('req_')) throw new PortalError('NOT_FOUND', 'Request not found', 404)
    const { rows: [coord] } = await c.query(`SELECT * FROM viewing_coordination WHERE requester_token_hash=$1 ${lock ? 'FOR UPDATE' : ''}`, [sha(token)])
    if (!coord) throw new PortalError('NOT_FOUND', 'Request not found', 404)
    return coord
  }

  async function requestStatus(token) {
    const coord = await requestByToken(db, token)
    const { rows: [prop] } = await q(`SELECT ref, town, property_type FROM properties WHERE id=$1`, [coord.property_id])
    const { rows: evs } = await q(`SELECT to_state, action, created_at, details->>'agentMessage' AS message FROM viewing_coordination_events WHERE coordination_id=$1 ORDER BY id`, [coord.id])
    return { request: shapeRequest(coord, 'agent'), property: prop, timezone: S.TZ,
      history: evs.map(e => ({ state: e.to_state, label: V.LABEL[e.to_state], action: e.action, at: e.created_at, message: e.message || null })) }
  }

  async function requestAct(token, action, body = {}) {
    return tx(async c => {
      const coord = await requestByToken(c, token, true)
      const actor = { kind: 'external_agent', ref: `${coord.requester_agency}:${coord.requester_name}`.slice(0, 120) }
      const map = { checking: 'ack_checking', confirm: 'confirm', other_time: 'request_other', cancel: 'cancel' }
      if (!map[action]) throw new PortalError('UNKNOWN_ACTION', 'Unknown action', 400)
      if (['confirm', 'checking'].includes(action) && coord.expires_at && new Date(coord.expires_at) <= now()) throw new PortalError('EXPIRED', 'The proposed slot has expired. Request another time.', 409)
      const to = V.transition(coord.state, map[action], 'agent')
      let preferred = coord.preferred
      if (to === 'RESCHEDULE_REQUESTED' || to === 'CANCELLED') await releaseViewing(c, coord, `agent_${action}`)
      if (to === 'CONFIRMED') await c.query(`UPDATE property_viewings SET status='confirmed' WHERE id=$1`, [coord.viewing_id])
      if (to === 'RESCHEDULE_REQUESTED') {
        preferred = (Array.isArray(body.preferred) ? body.preferred : []).slice(0, 3).map(x => Date.parse(x && x.start)).filter(t => Number.isFinite(t) && t > now().getTime())
          .map(t => ({ start: new Date(t).toISOString(), end: new Date(t + coord.duration_min * 60000).toISOString() }))
      }
      const { rows: [u] } = await c.query(`UPDATE viewing_coordination SET state=$2, preferred=$3, expires_at=CASE WHEN $2='RESCHEDULE_REQUESTED' THEN $4 WHEN $2='CONFIRMED' THEN NULL ELSE expires_at END, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [coord.id, to, JSON.stringify(preferred), new Date(now().getTime() + 7 * DAY)])
      await event(c, coord, coord.state, to, action, actor, { note: str(body.note, 300, 'Note') })
      const { rows: [a] } = await c.query(`SELECT a.id FROM owner_portal_accounts a JOIN properties p ON p.owner_id=a.owner_id WHERE p.id=$1`, [coord.property_id])
      if (a) await audit(c, a.id, actor, `agent_${action}`, coord.property_id, { coordinationId: coord.id, urgent: coord.state === 'CONFIRMED' })
      return { request: shapeRequest(u, 'agent') }
    })
  }

  // Housekeeping: proposals the agent did not reconfirm in time free the slot.
  async function expireDue() {
    return tx(async c => {
      const { rows } = await c.query(`SELECT * FROM viewing_coordination WHERE state = ANY($1) AND expires_at IS NOT NULL AND expires_at <= $2 FOR UPDATE`, [V.OPEN, now()])
      for (const coord of rows) {
        await releaseViewing(c, coord, 'expired')
        await c.query(`UPDATE viewing_coordination SET state='EXPIRED', updated_at=NOW() WHERE id=$1`, [coord.id])
        await event(c, coord, coord.state, 'EXPIRED', 'expire', { kind: 'system', ref: 'expiry' })
      }
      return { expired: rows.length }
    })
  }

  // ── Distribution, delegates, preferences, audit ──────────────────────────
  async function setDistribution(p, propertyId, { destination, allowed }) {
    ownerOnly(p)
    const row = await requireProperty(p, propertyId, 'inventory')
    if (!DESTINATIONS.includes(destination)) throw new PortalError('FIELD_INVALID', 'Unknown destination')
    if (typeof allowed !== 'boolean') throw new PortalError('FIELD_INVALID', 'allowed must be true or false')
    // Allowing never connects by itself: the agency approves (or the
    // destination does not exist yet). Pausing the own agency stops updates.
    const state = destination === 'argus_agency' ? (allowed ? 'connected' : 'paused') : (allowed ? 'pending_approval' : 'not_connected')
    return tx(async c => {
      await c.query(`INSERT INTO owner_distribution_settings (property_id, destination, owner_allowed, sync_state) VALUES ($1,$2,$3,$4)
        ON CONFLICT (property_id, destination) DO UPDATE SET owner_allowed=EXCLUDED.owner_allowed, sync_state=EXCLUDED.sync_state, updated_at=NOW()`, [row.id, destination, allowed, state])
      await audit(c, p.accountId, principalActor(p), 'distribution_changed', row.id, { destination, allowed })
      return distributionFor(row.id, c)
    })
  }

  async function createDelegate(p, { name, propertyIds, scopes }) {
    ownerOnly(p)
    const n = str(name, 80, 'Name', { required: true, min: 2 })
    const own = new Set((await scopedProperties(p)).map(x => x.id))
    const ids = [...new Set((Array.isArray(propertyIds) ? propertyIds : []).map(Number))].filter(id => own.has(id))
    if (!ids.length) throw new PortalError('FIELD_REQUIRED', 'Choose at least one of your properties')
    const sc = [...new Set(Array.isArray(scopes) ? scopes : ['schedule', 'requests'])]
    if (!sc.length || sc.some(s => !SCOPES.includes(s))) throw new PortalError('FIELD_INVALID', `scopes must be from ${SCOPES.join(', ')}`)
    return tx(async c => {
      const { rows: [d] } = await c.query(`INSERT INTO owner_portal_delegates (account_id, name, property_ids, scopes) VALUES ($1,$2,$3,$4) RETURNING id, name, role, property_ids, scopes, state`, [p.accountId, n, ids, sc])
      const token = mint('inv')
      const expiresAt = new Date(now().getTime() + inviteTtlDays * DAY)
      await c.query(`INSERT INTO owner_portal_invitations (account_id, delegate_id, purpose, token_hash, expires_at) VALUES ($1,$2,'delegate',$3,$4)`, [p.accountId, d.id, sha(token), expiresAt])
      await audit(c, p.accountId, principalActor(p), 'delegate_invited', null, { delegateId: d.id, properties: ids, scopes: sc })
      return { delegate: d, url: `${portalUrl}#t=${token}`, token, expiresAt: expiresAt.toISOString() }
    })
  }

  async function listDelegates(p) {
    ownerOnly(p)
    return (await q(`SELECT id, name, role, property_ids, scopes, state, created_at, revoked_at FROM owner_portal_delegates WHERE account_id=$1 ORDER BY id`, [p.accountId])).rows
  }

  async function revokeDelegate(p, id) {
    ownerOnly(p)
    return tx(async c => {
      const { rows: [d] } = await c.query(`UPDATE owner_portal_delegates SET state='revoked', revoked_at=NOW() WHERE id=$1 AND account_id=$2 AND state<>'revoked' RETURNING id`, [Number(id) || 0, p.accountId])
      if (!d) throw new PortalError('NOT_FOUND', 'Not found', 404)
      await c.query(`UPDATE owner_portal_sessions SET revoked_at=NOW() WHERE delegate_id=$1 AND revoked_at IS NULL`, [d.id])
      await c.query(`UPDATE owner_portal_invitations SET revoked_at=NOW() WHERE delegate_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL`, [d.id])
      await audit(c, p.accountId, principalActor(p), 'delegate_revoked', null, { delegateId: d.id })
      return { revoked: true }
    })
  }

  async function setPreferences(p, { notifyMode, urgentSeparately }) {
    ownerOnly(p)
    if (!['immediate', 'digest_2h', 'daily', 'off'].includes(notifyMode)) throw new PortalError('FIELD_INVALID', 'notifyMode must be immediate, digest_2h, daily or off')
    await q(`UPDATE owner_portal_accounts SET notify_mode=$2, urgent_separately=$3, updated_at=NOW() WHERE id=$1`, [p.accountId, notifyMode, urgentSeparately !== false])
    return { notifyMode, urgentSeparately: urgentSeparately !== false }
  }

  async function auditLog(p) {
    const { rows } = await q(`SELECT action, actor_kind, property_id, created_at FROM owner_portal_audit WHERE account_id=$1
      AND ($2::int[] IS NULL OR property_id = ANY($2)) ORDER BY id DESC LIMIT 100`, [p.accountId, p.propertyIds])
    return rows
  }

  return {
    // staff
    inviteOwner, revokeInvitation, setAccountState, revokeSessions, setPilotState, staffOverview, listProposals, reviewProposal,
    // sessions
    claimInvitation, authenticate, logout,
    // owner / delegate
    me, confirmProperties, propertyDetail, proposeChange, submitProperty, addMedia, mediaFile, arrangeMedia,
    saveRules, copyRules, desk, ownerAct, createShareLink, listShareLinks, revokeShareLink,
    setDistribution, createDelegate, listDelegates, revokeDelegate, setPreferences, auditLog,
    // agents
    shareView, shareRequest, requestStatus, requestAct,
    // jobs
    expireDue,
  }
}

module.exports = { createOwnerPortal, PortalError, OWNER_FIELDS, SHARE_FIELDS, PILOT, SCOPES, DESTINATIONS }
