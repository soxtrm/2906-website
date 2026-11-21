'use strict'
// ============================================================================
// services/syncDelegates.js — representatives of a NEXUS SYNC owner (Claude, 2026-11-21).
//
//   • the owner invites a person for chosen homes with chosen permissions:
//       view (always), message, schedule (viewing hours, accept/decline viewings),
//       edit (availability, price/description proposals, house rules).
//     Sharing with agencies and documents stay with the owner.
//   • the invitation is a single-use random token (only its SHA-256 is stored),
//     valid 7 days. Accepting needs BOTH the token AND a signed-in SYNC account
//     whose confirmed e-mail or confirmed mobile is exactly the invited one.
//     Knowing an owner's number, or holding a forwarded link, is never enough.
//   • access is re-checked on every request: active delegation, granted home,
//     the owner's link still verified, the claim still confirmed, the inviting
//     account still the owner of that link. Revocation works immediately.
//   • nothing is sent by this service; the owner passes the link on themselves.
// ============================================================================
const crypto = require('crypto')
const db = require('../db')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { tx, audit, AGENCY_KEY } = L._internal
const err = (code, message, status = 400) => new LinkError(code, message, status)
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')

const PERMS = ['view', 'message', 'schedule', 'edit']
const INVITE_DAYS = 7
const MAX_OPEN = 20
const ORIGIN = () => String(process.env.SYNC_PUBLIC_ORIGIN || 'https://nexussync.one').replace(/\/+$/, '')

function normTarget(kind, raw) {
  if (kind === 'email') {
    const e = String(raw || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 200) throw err('INVITE_INVALID', 'Enter a valid e-mail address.')
    return e
  }
  if (kind === 'phone') {
    const d = String(raw || '').replace(/\D/g, '').replace(/^00/, '')
    if (d.length < 8 || d.length > 15) throw err('INVITE_INVALID', 'Enter the mobile number with country code, e.g. +356 7900 1234.')
    return d.length === 8 ? `356${d}` : d
  }
  throw err('INVITE_INVALID', 'Invite by e-mail or by mobile number.')
}
const maskTarget = (kind, t) => (kind === 'email' ? t.replace(/^(.).*?(.?)@/, (m, a, b) => `${a}•••${b}@`) : `+${t.slice(0, 3)} •••• ${t.slice(-2)}`)
function cleanPerms(p) {
  if (!Array.isArray(p) || p.some(x => !PERMS.includes(x))) throw err('PERMISSIONS_INVALID', 'Unknown permission.')
  return PERMS.filter(x => x === 'view' || p.includes(x))
}

// Homes the owner may hand out: their own verified, confirmed homes (never delegated ones).
async function ownHomes(S, account, propertyIds) {
  const ids = [...new Set((Array.isArray(propertyIds) ? propertyIds : []).map(Number))]
  if (!ids.length || ids.length > 50 || ids.some(x => !Number.isInteger(x))) throw err('PROPERTIES_INVALID', 'Choose at least one home.')
  const own = await S.ownedProperties(account)
  const picked = ids.map(id => own.find(p => p.id === id))
  if (picked.some(x => !x)) throw err('PROPERTY_NOT_IN_LINK', 'One of these homes is not confirmed for your account.', 404)
  const owners = [...new Set(picked.map(p => p.owner_contact_id))]
  if (owners.length !== 1) throw err('PROPERTIES_INVALID', 'Invite separately for homes registered under different owner records.')
  const { rows: [link] } = await db.query(`SELECT * FROM nexus_owner_links WHERE agency_key=$1 AND owner_contact_id=$2 AND nexus_account_ref=$3 AND link_state='verified'`,
    [AGENCY_KEY(), owners[0], `sync:${account.public_id}`])
  if (!link) throw err('OWNER_LINK_NOT_VERIFIED', 'An agent has to confirm these homes for you first.', 409)
  return { link, ids }
}

function view(d, props, { withTarget = true } = {}) {
  return {
    id: d.public_id, name: d.invite_name, kind: d.invite_kind, target: withTarget ? maskTarget(d.invite_kind, d.invite_target) : undefined,
    permissions: d.permissions, propertyIds: props, state: d.state === 'invited' && new Date(d.expires_at) < new Date() ? 'expired' : d.state,
    expiresAt: d.expires_at, acceptedAt: d.accepted_at, revokedAt: d.revoked_at, createdAt: d.created_at,
  }
}
async function propsOf(ids) {
  if (!ids.length) return {}
  const { rows } = await db.query(`SELECT delegate_id, array_agg(property_id ORDER BY property_id) AS ids FROM nexus_owner_delegate_properties WHERE delegate_id = ANY($1::bigint[]) GROUP BY 1`, [ids])
  return Object.fromEntries(rows.map(r => [String(r.delegate_id), r.ids]))
}

async function invite(S, account, { name, kind, target, propertyIds, permissions }) {
  const who = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (!who) throw err('INVITE_INVALID', 'Enter the name of the person.')
  const t = normTarget(kind, target)
  if ((kind === 'email' && account.email && t === String(account.email).toLowerCase()) || (kind === 'phone' && account.phone_e164 === t)) throw err('INVITE_INVALID', 'That is your own account.')
  const perms = cleanPerms(permissions || ['view'])
  const { link, ids } = await ownHomes(S, account, propertyIds)
  const token = crypto.randomBytes(32).toString('base64url')
  return tx(async q => {
    const { rows: [{ n }] } = await q.query(`SELECT COUNT(*)::int n FROM nexus_owner_delegates WHERE owner_link_id=$1 AND (state='active' OR (state='invited' AND expires_at > NOW()))`, [link.id])
    if (n >= MAX_OPEN) throw err('TOO_MANY', 'You have reached the limit of 20 representatives and open invitations.', 429)
    const { rows: [d] } = await q.query(
      `INSERT INTO nexus_owner_delegates (agency_key, owner_link_id, invited_by_account_id, invite_name, invite_kind, invite_target, token_hash, permissions, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[], NOW() + ($9 || ' days')::interval) RETURNING *`,
      [AGENCY_KEY(), link.id, account.id, who, kind, t, sha(token), perms, String(INVITE_DAYS)])
    for (const id of ids) await q.query(`INSERT INTO nexus_owner_delegate_properties (delegate_id, property_id) VALUES ($1,$2)`, [d.id, id])
    await audit(q, null, 'SYNC_DELEGATE_INVITED', { account: account.public_id, delegate: d.public_id, permissions: perms, properties: ids.length })
    return { delegate: view(d, ids), link: `${ORIGIN()}/invite/${token}` }
  })
}

/** Owner: everyone they invited. Representative: whom they act for. */
async function list(account) {
  const { rows: mine } = await db.query(`SELECT * FROM nexus_owner_delegates WHERE invited_by_account_id=$1 AND agency_key=$2 ORDER BY created_at DESC LIMIT 100`, [account.id, AGENCY_KEY()])
  const { rows: forOthers } = await db.query(
    `SELECT d.*, a.display_name AS owner_name FROM nexus_owner_delegates d JOIN sync_accounts a ON a.id=d.invited_by_account_id
      WHERE d.delegate_account_id=$1 AND d.agency_key=$2 AND d.state='active' ORDER BY d.accepted_at DESC`, [account.id, AGENCY_KEY()])
  const p = await propsOf([...mine, ...forOthers].map(d => d.id))
  return {
    delegates: mine.map(d => view(d, p[String(d.id)] || [])),
    actingFor: forOthers.map(d => ({ ...view(d, p[String(d.id)] || [], { withTarget: false }), ownerName: d.owner_name || 'Owner' })),
  }
}

async function byToken(token, q = db, lock = false) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token || ''))) throw err('INVITE_NOT_FOUND', 'This invitation link is not valid.', 404)
  const { rows: [d] } = await q.query(`SELECT * FROM nexus_owner_delegates WHERE token_hash=$1 AND agency_key=$2${lock ? ' FOR UPDATE' : ''}`, [sha(token), AGENCY_KEY()])
  if (!d) throw err('INVITE_NOT_FOUND', 'This invitation link is not valid or was already used.', 404)
  if (d.state !== 'invited') throw err('INVITE_CLOSED', 'This invitation is no longer open.', 410)
  if (new Date(d.expires_at) < new Date()) throw err('INVITE_EXPIRED', 'This invitation has expired. Ask the owner for a new one.', 410)
  return d
}

/** What the invited person sees before accepting. No owner contact data, no addresses. */
async function preview({ token }) {
  const d = await byToken(token)
  const { rows: [o] } = await db.query(`SELECT display_name FROM sync_accounts WHERE id=$1`, [d.invited_by_account_id])
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int n FROM nexus_owner_delegate_properties WHERE delegate_id=$1`, [d.id])
  return { invite: { ownerName: (o?.display_name || 'An owner').split(' ')[0], name: d.invite_name, kind: d.invite_kind, target: maskTarget(d.invite_kind, d.invite_target), homes: n, permissions: d.permissions, expiresAt: d.expires_at } }
}

async function accept(account, { token }) {
  return tx(async q => {
    const d = await byToken(token, q, true)
    if (Number(d.invited_by_account_id) === Number(account.id)) throw err('INVITE_INVALID', 'You cannot accept your own invitation.')
    const ok = d.invite_kind === 'email'
      ? !!account.email_verified_at && String(account.email || '').toLowerCase() === d.invite_target
      : !!account.phone_verified_at && account.phone_e164 === d.invite_target
    if (!ok) {
      await audit(q, null, 'SYNC_DELEGATE_IDENTITY_MISMATCH', { account: account.public_id, delegate: d.public_id })
      throw err('IDENTITY_MISMATCH', d.invite_kind === 'email'
        ? 'Sign in with the e-mail address this invitation was sent to, and confirm that address first.'
        : 'Confirm the mobile number this invitation was sent to in your SYNC account first.', 403)
    }
    const { rows: [u] } = await q.query(`UPDATE nexus_owner_delegates SET state='active', delegate_account_id=$2, accepted_at=NOW(), token_hash=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [d.id, account.id])
    const { rows: [o] } = await q.query(`SELECT public_id FROM sync_accounts WHERE id=$1`, [d.invited_by_account_id])
    await audit(q, null, 'SYNC_DELEGATE_ACCEPTED', { account: account.public_id, owner: o?.public_id, delegate: d.public_id })
    return { accepted: true, delegate: view(u, [], { withTarget: false }) }
  })
}

async function decline(account, { token }) {
  return tx(async q => {
    const d = await byToken(token, q, true)
    await q.query(`UPDATE nexus_owner_delegates SET state='declined', token_hash=NULL, updated_at=NOW() WHERE id=$1`, [d.id])
    const { rows: [o] } = await q.query(`SELECT public_id FROM sync_accounts WHERE id=$1`, [d.invited_by_account_id])
    await audit(q, null, 'SYNC_DELEGATE_DECLINED', { account: account.public_id, owner: o?.public_id, delegate: d.public_id })
    return { declined: true }
  })
}

/** The owner revokes (or withdraws an invitation); a representative can also step down. Immediate. */
async function revoke(account, { delegateId }) {
  return tx(async q => {
    const { rows: [d] } = await q.query(`SELECT * FROM nexus_owner_delegates WHERE public_id::text=$1 AND agency_key=$2 FOR UPDATE`, [String(delegateId || ''), AGENCY_KEY()])
    const isOwner = d && Number(d.invited_by_account_id) === Number(account.id)
    const isSelf = d && Number(d.delegate_account_id) === Number(account.id)
    if (!d || (!isOwner && !isSelf)) throw err('DELEGATE_NOT_FOUND', 'Not found.', 404)
    if (d.state === 'revoked' || d.state === 'declined') return { revoked: true, already: true }
    await q.query(`UPDATE nexus_owner_delegates SET state='revoked', token_hash=NULL, revoked_at=NOW(), revoked_by=$2, updated_at=NOW() WHERE id=$1`, [d.id, isOwner ? 'owner' : 'delegate'])
    const { rows: [o] } = await q.query(`SELECT public_id FROM sync_accounts WHERE id=$1`, [d.invited_by_account_id])
    await audit(q, null, 'SYNC_DELEGATE_REVOKED', { account: account.public_id, owner: o?.public_id, delegate: d.public_id, by: isOwner ? 'owner' : 'delegate' })
    return { revoked: true }
  })
}

/** The owner changes homes or permissions of an open invitation or an active representative. */
async function update(S, account, { delegateId, propertyIds, permissions }) {
  const perms = cleanPerms(permissions || ['view'])
  return tx(async q => {
    const { rows: [d] } = await q.query(`SELECT * FROM nexus_owner_delegates WHERE public_id::text=$1 AND invited_by_account_id=$2 AND agency_key=$3 AND state IN ('invited','active') FOR UPDATE`,
      [String(delegateId || ''), account.id, AGENCY_KEY()])
    if (!d) throw err('DELEGATE_NOT_FOUND', 'Not found.', 404)
    const { link, ids } = await ownHomes(S, account, propertyIds)
    if (Number(link.id) !== Number(d.owner_link_id)) throw err('PROPERTIES_INVALID', 'These homes belong to another owner record.')
    await q.query(`UPDATE nexus_owner_delegates SET permissions=$2::text[], updated_at=NOW() WHERE id=$1`, [d.id, perms])
    await q.query(`DELETE FROM nexus_owner_delegate_properties WHERE delegate_id=$1`, [d.id])
    for (const id of ids) await q.query(`INSERT INTO nexus_owner_delegate_properties (delegate_id, property_id) VALUES ($1,$2)`, [d.id, id])
    await audit(q, null, 'SYNC_DELEGATE_UPDATED', { account: account.public_id, delegate: d.public_id, permissions: perms, properties: ids.length })
    return { delegate: view({ ...d, permissions: perms }, ids) }
  })
}

/** Homes this account may act on as a representative, with the given permission. Checked on every request. */
async function delegatedProperties(account, perm) {
  if (!account?.id || !PERMS.includes(perm)) return []
  const { rows } = await db.query(
    `SELECT p.id, p.ref, o.owner_contact_id, d.id AS delegate_id, d.public_id AS delegate_public_id, d.permissions, o.id AS owner_link_id,
            o.public_id AS owner_link_public_id, o.nexus_account_ref, d.invited_by_account_id AS owner_account_id, pl.external_id
       FROM nexus_owner_delegates d
       JOIN sync_accounts inviter ON inviter.id=d.invited_by_account_id AND inviter.disabled_at IS NULL
       JOIN nexus_owner_links o ON o.id=d.owner_link_id AND o.link_state='verified' AND o.nexus_account_ref = 'sync:' || inviter.public_id
       JOIN nexus_owner_delegate_properties dp ON dp.delegate_id=d.id
       JOIN nexus_owner_property_claims c ON c.owner_link_id=o.id AND c.property_id=dp.property_id AND c.claim_state IN ('confirmed','corrected')
       JOIN properties p ON p.id=dp.property_id AND p.owner_id=o.owner_contact_id AND p.archived_at IS NULL AND NOT COALESCE(p.is_staging,false)
       LEFT JOIN nexus_property_links pl ON pl.property_id=p.id AND pl.agency_key=o.agency_key
      WHERE d.state='active' AND d.delegate_account_id=$1 AND d.agency_key=$2 AND $3 = ANY(d.permissions)`, [account.id, AGENCY_KEY(), perm])
  return rows.map(r => ({ id: r.id, ref: r.ref, owner_contact_id: r.owner_contact_id, role: 'delegate', delegateId: r.delegate_public_id,
    permissions: r.permissions, ownerLinkId: Number(r.owner_link_id), ownerLinkPublicId: r.owner_link_public_id, ownerRef: r.nexus_account_ref,
    ownerAccountId: Number(r.owner_account_id), externalId: r.external_id }))
}

module.exports = { invite, list, preview, accept, decline, revoke, update, delegatedProperties, PERMS, _test: { sha, normTarget, maskTarget } }
