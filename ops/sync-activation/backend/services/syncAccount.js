'use strict'
// ============================================================================
// services/syncAccount.js — NEXUS SYNC owner accounts (Claude, 2026-11-19).
//
// The login layer for nexussync.one, on top of the existing NEXUS owner link:
//   • accounts (e-mail + password, Facebook), sessions, e-mail codes
//   • mobile confirmation: "SYNC verify CODE" sent to ARGUS Main on WhatsApp
//     (the sender's number is the confirmed number), SMS later
//   • a confirmed mobile that matches ARGUS owners creates a CLAIM on the
//     existing nexus_owner_links (link_state 'claim_pending'). Access to the
//     owner's listings starts only after staff verification
//     (/api/crm/owner-nexus/:ownerId/verify), exactly as for invitations.
//   • owner <-> ARGUS messages in nexus_owner_messages
//   • owner changes go through the existing inbound handlers (passport edit,
//     viewing schedule, availability answer, distribution grant/revoke).
//
// Never: sends WhatsApp to anyone except the single confirmation reply to the
// person who just wrote "SYNC verify", writes to owner_contact_log, or returns
// owner contact data, notes or outreach history.
// ============================================================================
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const db = require('../db')
const log = require('../logger')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { tx, audit, AGENCY_KEY, ensurePropertyLink, PROPERTY_COLUMNS, REAL_PROPERTY } = L._internal

const SESSION_DAYS = 30
const WA_TTL_MIN = 15
const EMAIL_TTL_MIN = 30
const MAX_CODE_ATTEMPTS = 5
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')
const err = (code, message, status = 400) => new LinkError(code, message, status)
const accountRef = a => `sync:${a.public_id}`
const WA_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const WA_RE = /^\s*SYNC\s+(verify|login)\s+([A-Za-z2-9]{6})\s*[.!]?\s*$/i
const LOGIN_TTL_MIN = 10

// ── helpers ─────────────────────────────────────────────────────────────────
function normEmail(e) {
  const s = String(e || '').trim().toLowerCase()
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/.test(s)) throw err('EMAIL_INVALID', 'Please enter a valid e-mail address.')
  return s
}
function passwordProblem(p) {
  const s = String(p || '')
  if (s.length < 10) return 'Use at least 10 characters.'
  if (s.length > 200) return 'That password is too long.'
  if (/^\d+$/.test(s)) return 'Use letters too, not only numbers.'
  return null
}
// digits with country code, no plus — the format of owner_contacts.phone_normalized
function phoneDigits(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '')
  if (d.startsWith('+')) d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  else if (/^[279]\d{7}$/.test(d)) d = `356${d}` // Maltese mobile/landline typed without country code
  d = d.replace(/\D/g, '')
  if (d.length < 8 || d.length > 15) throw err('PHONE_INVALID', 'Please enter your mobile number with country code.')
  return d
}
const masked = d => `+${d.slice(0, 3)} •••• ${d.slice(-2)}`
function waToken() { let t = ''; for (const b of crypto.randomBytes(6)) t += WA_ALPHABET[b % WA_ALPHABET.length]; return t }
function digitCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0') }
function argusMainNumber() { return String(process.env.SYNC_WA_NUMBER || '35679675060').replace(/\D/g, '') }
function argusMainSession() { return process.env.SYNC_WA_SESSION || 'Argus1' }

function accountView(a) {
  return {
    prefs: a.prefs || {},
    id: a.public_id, email: a.email, emailVerified: !!a.email_verified_at, name: a.display_name || '',
    phone: a.phone_e164 ? { e164: `+${a.phone_e164}`, verified: !!a.phone_verified_at, via: a.phone_verified_via || null } : null,
    notifyChannel: a.notify_channel, createdAt: a.created_at,
  }
}

async function accountById(q, id, { lock = false } = {}) {
  const { rows: [a] } = await q.query(`SELECT * FROM sync_accounts WHERE id=$1 AND disabled_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id])
  if (!a) throw err('SESSION_INVALID', 'Please sign in again.', 401)
  return a
}

async function newSession(q, accountId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url')
  await q.query(`INSERT INTO sync_sessions (token_hash, account_id, expires_at, user_agent) VALUES ($1,$2, NOW() + ($3 || ' days')::interval, $4)`,
    [sha(token), accountId, String(SESSION_DAYS), String(userAgent || '').slice(0, 200)])
  return { token, maxAgeSeconds: SESSION_DAYS * 86400 }
}

// The session token comes from the SYNC server (httpOnly cookie on nexussync.one).
async function sessionAccount(token) {
  if (typeof token !== 'string' || token.length < 30 || token.length > 100) throw err('SESSION_INVALID', 'Please sign in again.', 401)
  const { rows: [s] } = await db.query(
    `UPDATE sync_sessions SET last_seen_at=NOW() WHERE token_hash=$1 AND expires_at > NOW() RETURNING account_id`, [sha(token)])
  if (!s) throw err('SESSION_INVALID', 'Please sign in again.', 401)
  return accountById(db, s.account_id)
}

// ── accounts ────────────────────────────────────────────────────────────────
async function signup({ email, password, name, userAgent }) {
  const e = normEmail(email)
  const problem = passwordProblem(password)
  if (problem) throw err('PASSWORD_WEAK', problem)
  const hash = await bcrypt.hash(String(password), 12)
  return tx(async q => {
    const { rows: [taken] } = await q.query(`SELECT id FROM sync_accounts WHERE email=$1`, [e])
    // Same answer shape as a fresh sign-up would need would leak existence; say it plainly instead of guessing.
    if (taken) throw err('EMAIL_TAKEN', 'There is already an account with this e-mail. Please sign in.', 409)
    const { rows: [a] } = await q.query(
      `INSERT INTO sync_accounts (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING *`, [e, hash, String(name || '').trim().slice(0, 120) || null])
    await audit(q, null, 'SYNC_ACCOUNT_CREATED', { account: a.public_id, via: 'email' })
    return { account: accountView(a), session: await newSession(q, a.id, userAgent) }
  })
}

let DUMMY_HASH = null
async function login({ email, password, userAgent }) {
  let e
  try { e = normEmail(email) } catch { throw err('LOGIN_FAILED', 'E-mail or password is wrong.', 401) }
  const { rows: [a] } = await db.query(`SELECT * FROM sync_accounts WHERE email=$1 AND disabled_at IS NULL`, [e])
  // Compare against a fixed hash when there is no account, so timing does not tell.
  if (!DUMMY_HASH) DUMMY_HASH = await bcrypt.hash('sync-no-account', 12)
  const ok = await bcrypt.compare(String(password || ''), a?.password_hash || DUMMY_HASH)
  if (!a || !a.password_hash || !ok) throw err('LOGIN_FAILED', 'E-mail or password is wrong.', 401)
  return tx(async q => ({ account: accountView(a), session: await newSession(q, a.id, userAgent) }))
}

async function logout(token) {
  if (typeof token === 'string') await db.query(`DELETE FROM sync_sessions WHERE token_hash=$1`, [sha(token)])
  return { ok: true }
}

async function updateAccount(account, { name, notifyChannel }) {
  const sets = [], vals = [account.id]
  if (name !== undefined) { vals.push(String(name || '').trim().slice(0, 120) || null); sets.push(`display_name=$${vals.length}`) }
  if (notifyChannel !== undefined) {
    if (!['whatsapp', 'sms', 'email', 'app'].includes(notifyChannel)) throw err('CHANNEL_INVALID', 'Unknown channel.')
    vals.push(notifyChannel); sets.push(`notify_channel=$${vals.length}`)
  }
  if (!sets.length) return { account: accountView(account) }
  const { rows: [a] } = await db.query(`UPDATE sync_accounts SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$1 RETURNING *`, vals)
  return { account: accountView(a) }
}

// ── Facebook / Google ───────────────────────────────────────────────────────
let http = (url, init) => fetch(url, init)
function setHttp(fn) { http = fn }

async function facebookProfile(code, redirectUri) {
  const id = process.env.SYNC_FB_APP_ID || process.env.FB_APP_ID
  const secret = process.env.SYNC_FB_APP_SECRET || process.env.FB_APP_SECRET
  if (!id || !secret) throw err('PROVIDER_NOT_CONFIGURED', 'Facebook sign-in is not set up yet.', 503)
  if (!/^https:\/\/(www\.)?nexussync\.one\/api\/auth\/facebook\/callback$/.test(String(redirectUri || ''))) throw err('REDIRECT_INVALID', 'Unexpected redirect address.')
  const tok = await http(`https://graph.facebook.com/v21.0/oauth/access_token?${new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: redirectUri, code: String(code || '') })}`, { signal: AbortSignal.timeout(10000) })
  const t = await tok.json().catch(() => ({}))
  if (!tok.ok || !t.access_token) throw err('FACEBOOK_FAILED', 'Facebook did not confirm the sign-in. Please try again.', 401)
  const me = await http(`https://graph.facebook.com/v21.0/me?${new URLSearchParams({ fields: 'id,name,email', access_token: t.access_token })}`, { signal: AbortSignal.timeout(10000) })
  const p = await me.json().catch(() => ({}))
  if (!me.ok || !p.id) throw err('FACEBOOK_FAILED', 'Facebook did not return your profile.', 401)
  return { uid: String(p.id), name: p.name || null, email: p.email ? String(p.email).toLowerCase() : null }
}

// One identity per provider account. An e-mail that already has a password
// account is NOT merged automatically (that would let anyone who controls a
// Facebook profile with that address into the account): the owner signs in with
// the password and links Facebook from there.
async function socialSignIn({ provider, code, redirectUri, userAgent, linkToToken }) {
  if (provider !== 'facebook') throw err('PROVIDER_NOT_CONFIGURED', 'This sign-in is not set up yet.', 503)
  const prof = await facebookProfile(code, redirectUri)
  const current = linkToToken ? await sessionAccount(linkToToken).catch(() => null) : null
  return tx(async q => {
    const { rows: [idn] } = await q.query(`SELECT * FROM sync_identities WHERE provider=$1 AND provider_uid=$2`, [provider, prof.uid])
    let a
    if (idn) a = await accountById(q, idn.account_id)
    else if (current) {
      a = current
      await q.query(`INSERT INTO sync_identities (account_id, provider, provider_uid, email) VALUES ($1,$2,$3,$4)`, [a.id, provider, prof.uid, prof.email])
      await audit(q, null, 'SYNC_IDENTITY_LINKED', { account: a.public_id, provider })
    } else {
      const { rows: [clash] } = prof.email ? await q.query(`SELECT id FROM sync_accounts WHERE email=$1`, [prof.email]) : { rows: [] }
      const { rows: [created] } = await q.query(
        `INSERT INTO sync_accounts (email, email_verified_at, display_name) VALUES ($1, CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END, $2) RETURNING *`,
        [clash ? null : prof.email, prof.name])
      a = created
      await q.query(`INSERT INTO sync_identities (account_id, provider, provider_uid, email) VALUES ($1,$2,$3,$4)`, [a.id, provider, prof.uid, prof.email])
      await audit(q, null, 'SYNC_ACCOUNT_CREATED', { account: a.public_id, via: provider, emailClash: !!clash })
    }
    return { account: accountView(a), session: await newSession(q, a.id, userAgent) }
  })
}

// ── e-mail confirmation ─────────────────────────────────────────────────────
let mailer = opts => require('./email').sendMail(opts)
function setMailer(fn) { mailer = fn }

async function emailStart(account) {
  if (!account.email) throw err('EMAIL_MISSING', 'Add an e-mail address first.')
  if (account.email_verified_at) return { verified: true }
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM sync_checks WHERE account_id=$1 AND kind='email' AND created_at > NOW() - interval '1 hour'`, [account.id])
  if (n >= 5) throw err('TOO_MANY', 'Too many codes. Please wait an hour.', 429)
  const code = digitCode()
  await db.query(`INSERT INTO sync_checks (account_id, kind, target, code_hash, expires_at) VALUES ($1,'email',$2,$3, NOW() + ($4 || ' minutes')::interval)`,
    [account.id, account.email, sha(`${account.id}:${code}`), String(EMAIL_TTL_MIN)])
  const sent = await mailer({
    to: account.email, subject: `Your SYNC code: ${code}`,
    text: `Your SYNC code is ${code}. It is valid for ${EMAIL_TTL_MIN} minutes.\n\nIf you did not ask for it, ignore this e-mail.`,
    html: `<p>Your SYNC code is <b style="font-size:20px;letter-spacing:2px">${code}</b>.</p><p>It is valid for ${EMAIL_TTL_MIN} minutes. If you did not ask for it, ignore this e-mail.</p>`,
  }).catch(e => { log.warn('sync: email code failed', { err: e.message }); return false })
  if (!sent) throw err('EMAIL_NOT_SENT', 'The e-mail could not be sent. Please try again later.', 503)
  return { sent: true, to: account.email }
}

async function emailConfirm(account, code) {
  return tx(async q => {
    const { rows: [c] } = await q.query(
      `SELECT * FROM sync_checks WHERE account_id=$1 AND kind='email' AND verified_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1 FOR UPDATE`, [account.id])
    if (!c) throw err('CODE_EXPIRED', 'This code has expired. Ask for a new one.')
    if (c.attempts >= MAX_CODE_ATTEMPTS) throw err('TOO_MANY', 'Too many wrong tries. Ask for a new code.', 429)
    if (c.code_hash !== sha(`${account.id}:${String(code || '').trim()}`)) {
      await q.query(`UPDATE sync_checks SET attempts=attempts+1 WHERE id=$1`, [c.id])
      throw err('CODE_WRONG', 'That code is not right.')
    }
    await q.query(`UPDATE sync_checks SET verified_at=NOW() WHERE id=$1`, [c.id])
    const { rows: [a] } = await q.query(`UPDATE sync_accounts SET email_verified_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [account.id])
    return { account: accountView(a) }
  })
}

// ── mobile confirmation over WhatsApp ───────────────────────────────────────
async function phoneStart(account, { phone, channel }) {
  if (channel === 'sms') throw err('PROVIDER_NOT_CONFIGURED', 'SMS codes are not available yet. Please use WhatsApp or e-mail.', 503)
  if (channel !== 'whatsapp') throw err('CHANNEL_INVALID', 'Choose WhatsApp.')
  const wanted = phone ? phoneDigits(phone) : null
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM sync_checks WHERE account_id=$1 AND kind='phone_whatsapp' AND created_at > NOW() - interval '1 hour'`, [account.id])
  if (n >= 6) throw err('TOO_MANY', 'Too many tries. Please wait an hour.', 429)
  let token, tries = 0
  // tokens are short; make sure no open one collides
  do {
    token = waToken(); tries++
    const { rows } = await db.query(`SELECT 1 FROM sync_checks WHERE kind='phone_whatsapp' AND code_hash=$1 AND verified_at IS NULL AND expires_at > NOW()`, [sha(token)])
    if (!rows.length) break
  } while (tries < 5)
  await db.query(`INSERT INTO sync_checks (account_id, kind, target, code_hash, expires_at) VALUES ($1,'phone_whatsapp',$2,$3, NOW() + ($4 || ' minutes')::interval)`,
    [account.id, wanted, sha(token), String(WA_TTL_MIN)])
  const text = `SYNC verify ${token}`
  return { token, text, waLink: `https://wa.me/${argusMainNumber()}?text=${encodeURIComponent(text)}`, expiresInMinutes: WA_TTL_MIN, number: `+${argusMainNumber()}` }
}

async function phoneStatus(account) {
  const { rows: [a] } = await db.query(`SELECT * FROM sync_accounts WHERE id=$1`, [account.id])
  return { verified: !!a.phone_verified_at, phone: a.phone_e164 ? `+${a.phone_e164}` : null, account: accountView(a) }
}

// Called from routes/webhook.js for every incoming 1:1 message. Returns true
// when the message was a SYNC confirmation (handled or not), so nothing else
// (AI replies, lead intake, outreach accounting) ever sees it.
const _seen = new Map()
let sender = (session, chat, text) => require('../waha').sendText(session, chat, text)
function setSender(fn) { sender = fn }

async function handleWhatsAppVerify({ session, payload }) {
  const body = String(payload?.body || '')
  const m = WA_RE.exec(body)
  if (!m) return false
  if (payload.fromMe === true || String(payload.from || '').includes('@g.us')) return false
  if (session !== argusMainSession()) return false
  const msgId = String(payload.id?._serialized || payload.id || '')
  if (msgId) { if (_seen.has(msgId)) return true; _seen.set(msgId, Date.now()); if (_seen.size > 500) for (const [k, t] of _seen) if (Date.now() - t > 3600e3) _seen.delete(k) }
  const { realSenderJid, phoneFromJid } = require('./senderIdentity')
  const jid = realSenderJid(payload, false) || payload.from
  let digits = phoneFromJid(jid)
  if (!digits) digits = await require('./contactTouch').resolvePhone(session, payload.from).catch(() => null) || ''
  const reply = t => sender(session, payload.from, t).catch(e => log.warn('sync verify reply failed', { err: e.message }))
  if (!digits) { await reply('We could not read your number from this chat. Please confirm with an e-mail code in SYNC instead.'); return true }
  const verb = m[1].toLowerCase()
  const token = m[2].toUpperCase()
  if (verb === 'login') {
    let res
    try {
      res = await tx(async q => {
        const { rows: [c] } = await q.query(
          `SELECT * FROM sync_checks WHERE kind='login_whatsapp' AND code_hash=$1 AND verified_at IS NULL AND expires_at > NOW() FOR UPDATE`, [sha(token)])
        if (!c) return 'unknown'
        if (c.target !== digits) { await q.query(`UPDATE sync_checks SET attempts=attempts+1 WHERE id=$1`, [c.id]); return 'other_number' }
        await q.query(`UPDATE sync_checks SET verified_at=NOW(), sender=$2 WHERE id=$1`, [c.id, digits])
        return 'ok'
      })
    } catch (e) { log.warn('sync login failed', { err: e.message }); res = 'error' }
    await reply({
      ok: 'You are signed in to SYNC. Go back to the page, it opens by itself.',
      unknown: 'This SYNC sign-in code is not valid any more. Please start again on nexussync.one.',
      other_number: 'This sign-in was started for a different number. Please send it from your own number.',
      error: 'Something went wrong. Please try again in a minute.',
    }[res])
    return true
  }
  let outcome
  try {
    outcome = await tx(async q => {
      const { rows: [c] } = await q.query(
        `SELECT * FROM sync_checks WHERE kind='phone_whatsapp' AND code_hash=$1 AND verified_at IS NULL AND expires_at > NOW() FOR UPDATE`, [sha(token)])
      if (!c) return 'unknown'
      if (c.target && c.target !== digits) {
        await q.query(`UPDATE sync_checks SET attempts=attempts+1 WHERE id=$1`, [c.id])
        return 'other_number'
      }
      const { rows: [owner] } = await q.query(`SELECT id FROM sync_accounts WHERE phone_e164=$1 AND phone_verified_at IS NOT NULL AND id<>$2`, [digits, c.account_id])
      if (owner) return 'taken'
      await q.query(`UPDATE sync_checks SET verified_at=NOW(), sender=$2 WHERE id=$1`, [c.id, digits])
      const { rows: [a] } = await q.query(
        `UPDATE sync_accounts SET phone_e164=$2, phone_verified_at=NOW(), phone_verified_via='whatsapp', updated_at=NOW() WHERE id=$1 RETURNING *`, [c.account_id, digits])
      await audit(q, null, 'SYNC_PHONE_VERIFIED', { account: a.public_id, via: 'whatsapp' })
      const claim = await claimByPhone(q, a)
      return claim.matched ? 'ok_matched' : 'ok'
    })
  } catch (e) { log.warn('sync verify failed', { err: e.message }); outcome = 'error' }
  const texts = {
    ok_matched: 'Your number is confirmed for SYNC. We found homes linked to this number; an agent will confirm them shortly. You can go back to SYNC now.',
    ok: 'Your number is confirmed for SYNC. You can go back to SYNC now.',
    unknown: 'This SYNC code is not valid any more. Please open SYNC and start the confirmation again.',
    other_number: 'This code was requested for a different number. Please send it from the number you entered in SYNC.',
    taken: 'This number is already confirmed on another SYNC account. Please sign in there, or contact us.',
    error: 'Something went wrong. Please try again in a minute.',
  }
  await reply(texts[outcome])
  return true
}

// ── sign in with the mobile number (WhatsApp) ──────────────────────────────
// The owner types the number; WhatsApp opens with "SYNC login CODE" to ARGUS
// Main; the page waits with a separate poll key and gets the session once the
// message arrived from exactly that number. No password needed.
async function loginPhoneStart({ phone }) {
  const digits = phoneDigits(phone)
  const { rows: [a] } = await db.query(`SELECT * FROM sync_accounts WHERE phone_e164=$1 AND phone_verified_at IS NOT NULL AND disabled_at IS NULL`, [digits])
  if (!a) throw err('NO_ACCOUNT', 'There is no SYNC account with this mobile number yet. Please create one first.', 404)
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM sync_checks WHERE account_id=$1 AND kind='login_whatsapp' AND created_at > NOW() - interval '1 hour'`, [a.id])
  if (n >= 8) throw err('TOO_MANY', 'Too many sign-in attempts. Please wait an hour.', 429)
  const token = waToken()
  const pollKey = crypto.randomBytes(24).toString('base64url')
  await db.query(`INSERT INTO sync_checks (account_id, kind, target, code_hash, poll_hash, expires_at) VALUES ($1,'login_whatsapp',$2,$3,$4, NOW() + ($5 || ' minutes')::interval)`,
    [a.id, digits, sha(token), sha(pollKey), String(LOGIN_TTL_MIN)])
  const text = `SYNC login ${token}`
  return { pollKey, text, waLink: `https://wa.me/${argusMainNumber()}?text=${encodeURIComponent(text)}`, number: `+${argusMainNumber()}`, expiresInMinutes: LOGIN_TTL_MIN }
}

async function loginPhoneStatus({ pollKey, userAgent }) {
  if (typeof pollKey !== 'string' || pollKey.length < 20 || pollKey.length > 60) throw err('CODE_EXPIRED', 'Please start the sign-in again.')
  return tx(async q => {
    const { rows: [c] } = await q.query(`SELECT * FROM sync_checks WHERE kind='login_whatsapp' AND poll_hash=$1 FOR UPDATE`, [sha(pollKey)])
    if (!c || c.attempts < 0) throw err('CODE_EXPIRED', 'Please start the sign-in again.')
    if (!c.verified_at) {
      if (new Date(c.expires_at) <= new Date()) throw err('CODE_EXPIRED', 'That took too long. Please start the sign-in again.')
      return { waiting: true }
    }
    await q.query(`UPDATE sync_checks SET attempts=-1, expires_at=NOW() WHERE id=$1`, [c.id])
    const a = await accountById(q, c.account_id)
    await audit(q, null, 'SYNC_LOGIN_WHATSAPP', { account: a.public_id })
    return { waiting: false, account: accountView(a), session: await newSession(q, a.id, userAgent) }
  })
}

// ── owner preferences: nicknames, sharing defaults ──────────────────────────
async function setPrefs(account, patch) {
  const cur = account.prefs || {}
  const next = { ...cur }
  if (patch && typeof patch.nicknames === 'object' && patch.nicknames) {
    const nn = { ...(cur.nicknames || {}) }
    for (const [k, v] of Object.entries(patch.nicknames).slice(0, 50)) {
      if (!/^\d{1,9}$/.test(k)) continue
      const t = String(v || '').trim().slice(0, 60)
      if (t) nn[k] = t; else delete nn[k]
    }
    next.nicknames = nn
  }
  if (patch && patch.sharingDefaults !== undefined) {
    const d = patch.sharingDefaults
    const ok = ['origin_agency', 'all_eligible_agencies', 'nexus_direct_from_owner', 'private']
    if (!Array.isArray(d) || d.some(x => !ok.includes(x))) throw err('PREFS_INVALID', 'Unknown sharing option.')
    next.sharingDefaults = [...new Set(d)]
  }
  if (JSON.stringify(next).length > 8000) throw err('PREFS_INVALID', 'Too much data.')
  const { rows: [a] } = await db.query(`UPDATE sync_accounts SET prefs=$2::jsonb, updated_at=NOW() WHERE id=$1 RETURNING *`, [account.id, JSON.stringify(next)])
  return { prefs: a.prefs }
}

// The listings this account may act on: verified link, confirmed claim, active listing.
async function ownedProperties(account) {
  const { rows } = await db.query(
    `SELECT p.id, p.ref, o.owner_contact_id FROM nexus_owner_links o
       JOIN nexus_owner_property_claims c ON c.owner_link_id=o.id AND c.claim_state IN ('confirmed','corrected')
       JOIN properties p ON p.id=c.property_id AND p.owner_id=o.owner_contact_id
      WHERE o.agency_key=$1 AND o.nexus_account_ref=$2 AND o.link_state='verified'
        AND p.archived_at IS NULL AND NOT COALESCE(p.is_staging,false)`, [AGENCY_KEY(), accountRef(account)])
  return rows
}
async function ownedProperty(account, propertyId) {
  const p = (await ownedProperties(account)).find(x => x.id === Number(propertyId))
  if (!p) throw err('PROPERTY_NOT_IN_LINK', 'This home is not confirmed for your account.', 404)
  return p
}

// What the owner sees about each confirmed home beyond the facts: status, what
// they proposed and whether it was taken, who may share it, viewing hours.
async function propertyState(account, ids) {
  if (!ids.length) return {}
  const agency = AGENCY_KEY()
  const [p, u, g, w] = await Promise.all([
    db.query(`SELECT id, available_status, available_date, published FROM properties WHERE id = ANY($1::int[])`, [ids]),
    db.query(`SELECT DISTINCT ON (property_id) property_id, version, review_state, fields, created_at, reviewed_at FROM nexus_owner_property_updates
               WHERE agency_key=$1 AND property_id = ANY($2::int[]) ORDER BY property_id, version DESC`, [agency, ids]),
    db.query(`SELECT property_id, channel, audience_ref, scopes, granted_at FROM nexus_distribution_grants WHERE agency_key=$1 AND property_id = ANY($2::int[]) AND revoked_at IS NULL`, [agency, ids]),
    db.query(`SELECT id, property_id, starts_at, ends_at FROM property_viewing_windows WHERE property_id = ANY($1::int[]) AND status='active' AND kind='window' AND ends_at > NOW() ORDER BY starts_at LIMIT 400`, [ids]),
  ])
  const nick = (account.prefs && account.prefs.nicknames) || {}
  const out = {}
  for (const id of ids) {
    const r = p.rows.find(x => x.id === id) || {}
    const up = u.rows.find(x => x.property_id === id)
    out[id] = {
      nickname: nick[String(id)] || null,
      availability: r.available_status || null,
      published: !!r.published,
      update: up ? { version: up.version, state: up.review_state, fields: up.fields, at: up.created_at, reviewedAt: up.reviewed_at } : null,
      sharing: g.rows.filter(x => x.property_id === id).map(x => ({ channel: x.channel, audienceRef: x.audience_ref || null, scopes: x.scopes, grantedAt: x.granted_at })),
      windows: w.rows.filter(x => x.property_id === id).map(x => ({ id: x.id, start: x.starts_at, end: x.ends_at })),
    }
  }
  return out
}

// ── viewings: the existing ARGUS booking (property_viewings) ────────────────
// Same states and the same SQL as the owner schedule link (ownerBookingPortal).
// Never returns the client's name, phone or nationality.
async function ownerViewings(account) {
  const props = await ownedProperties(account)
  if (!props.length) return { viewings: [] }
  const { rows } = await db.query(
    `SELECT pv.id, pv.property_id, p.ref, pv.starts_at, pv.duration_min, pv.status, pv.owner_survey_status, pv.request_round,
            pv.agent_justification, pv.owner_decline_text, pv.party_size, pv.viewing_agent_name, c.group_type, c.profession
       FROM property_viewings pv JOIN properties p ON p.id=pv.property_id LEFT JOIN clients c ON c.id=pv.client_id
      WHERE pv.property_id = ANY($1::int[]) AND pv.starts_at >= NOW() - INTERVAL '30 days'
      ORDER BY pv.starts_at LIMIT 300`, [props.map(x => x.id)])
  return { viewings: rows.map(v => ({
    id: v.id, propertyId: v.property_id, ref: v.ref, startsAt: v.starts_at, durationMin: v.duration_min || 20,
    status: v.status, decision: v.owner_survey_status || 'pending', round: v.request_round || 1,
    note: v.agent_justification || null, declineText: v.owner_decline_text || null,
    party: { size: v.party_size || null, type: v.group_type || null, job: v.profession || null },
    agent: v.viewing_agent_name || null,
  })) }
}

let windows = () => require('./viewingWindows')
async function ownerDecide(account, { viewingId, decision, note, proposeStart }) {
  const props = await ownedProperties(account)
  const { rows: [v] } = await db.query(`SELECT id, property_id, status FROM property_viewings WHERE id=$1`, [Number(viewingId) || 0])
  if (!v || !props.some(p => p.id === v.property_id)) throw err('VIEWING_NOT_FOUND', 'Viewing not found.', 404)
  const text = String(note || '').trim().slice(0, 500)
  if (decision === 'accept') {
    const u = await db.query(
      `UPDATE property_viewings SET status='confirmed', owner_survey_status='confirmed', owner_decision_at=NOW(), confirmed_at=COALESCE(confirmed_at,NOW()),
              confirmation_method='owner_sync', owner_decline_text=NULL, updated_at=NOW()
        WHERE id=$1 AND status='pending' RETURNING id`, [v.id])
    if (u.rows[0]) await windows().windowFromConfirmedViewing(v.id, { ownerText: text })
    await audit(db, null, 'SYNC_VIEWING_ACCEPTED', { account: account.public_id, viewing: v.id }, { id: v.property_id })
    return { ok: true, status: 'confirmed', alreadyFinal: !u.rows[0] }
  }
  if (decision === 'decline' || decision === 'propose') {
    let msg = text
    if (decision === 'propose') {
      const at = new Date(proposeStart)
      if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() || at.getTime() > Date.now() + 60 * 86400e3) throw err('TIME_INVALID', 'Choose a time in the next 60 days.')
      const end = new Date(at.getTime() + 30 * 60e3)
      await windows().addWindow(v.property_id, { kind: 'window', start: at.toISOString(), end: end.toISOString(), confirmation: 'full_window' },
        { sourceType: 'owner_sync', evidence: 'Owner proposed another viewing time in SYNC', reference: `sync:${account.public_id}:propose:${v.id}`, createdBy: 'owner', confidence: 'explicit' })
      msg = `Owner suggests ${at.toLocaleString('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${text ? `: ${text}` : ''}`
    }
    await db.query(
      `UPDATE property_viewings SET status='cancelled', owner_survey_status='declined', owner_decision_at=NOW(), owner_decline_text=$2, cancelled_at=NOW(),
              cancel_reason=$3, updated_at=NOW() WHERE id=$1 AND status IN ('pending','confirmed')`,
      [v.id, msg || null, decision === 'propose' ? 'owner proposed another time in SYNC' : 'owner declined in SYNC'])
    await audit(db, null, decision === 'propose' ? 'SYNC_VIEWING_PROPOSED' : 'SYNC_VIEWING_DECLINED', { account: account.public_id, viewing: v.id }, { id: v.property_id })
    return { ok: true, status: 'cancelled', proposed: decision === 'propose' }
  }
  throw err('DECISION_INVALID', 'Accept, decline or propose another time.')
}

// Viewing hours: the owner sets whole days (several ranges per day). Each day
// is one statement, so its ranges stay siblings; an empty day blocks it.
async function ownerSetDays(account, { propertyId, days }) {
  const p = await ownedProperty(account, propertyId)
  if (!Array.isArray(days) || !days.length || days.length > 62) throw err('DAYS_INVALID', 'Choose between 1 and 62 days.')
  const now = Date.now(), max = now + 92 * 86400e3
  let created = 0, cleared = 0
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d?.date || ''))) throw err('DAYS_INVALID', 'A day is missing its date.')
    const ranges = Array.isArray(d.ranges) ? d.ranges.slice(0, 8) : []
    const ref = `sync:${account.public_id}:${d.date}:${Date.now()}`
    // whatever this owner set in SYNC for that day before is replaced
    const { rows: old } = await db.query(
      `SELECT id FROM property_viewing_windows WHERE property_id=$1 AND status='active' AND kind='window' AND source_type='owner_sync'
          AND (starts_at AT TIME ZONE 'Europe/Malta')::date = $2::date`, [p.id, d.date])
    if (!ranges.length) {
      for (const o of old) { await windows().cancelWindow(p.id, o.id, `sync:${account.public_id}`); cleared++ }
      continue
    }
    for (const r of ranges) {
      const a = new Date(r.start), b = new Date(r.end)
      if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || b <= a || b - a > 14 * 3600e3 || a.getTime() < now - 3600e3 || a.getTime() > max) throw err('RANGE_INVALID', 'One of the time ranges is not valid.')
      await windows().addWindow(p.id, { kind: 'window', start: a.toISOString(), end: b.toISOString(), confirmation: 'full_window' },
        { sourceType: 'owner_sync', evidence: 'Owner set viewing hours in SYNC', reference: ref, createdBy: 'owner', confidence: 'explicit' })
      created++
    }
  }
  await audit(db, null, 'SYNC_VIEWING_HOURS', { account: account.public_id, days: days.length, created, cleared }, { id: p.id, ref: p.ref })
  return { created, cleared }
}

// ── claim by confirmed mobile ───────────────────────────────────────────────
// Finds ARGUS owners with this number and attaches the account as a CLAIM.
// Nothing becomes visible to the account before staff verify the link.
async function claimByPhone(q, account) {
  if (!account.phone_verified_at || !account.phone_e164) return { matched: 0 }
  const agency = AGENCY_KEY()
  const ref = accountRef(account)
  const { rows: owners } = await q.query(
    `SELECT DISTINCT oc.id, oc.do_not_contact, oc.status FROM owner_contacts oc
      WHERE oc.phone_normalized=$1 OR oc.id IN (SELECT contact_id FROM owner_phone_variants WHERE phone_normalized=$1)`, [account.phone_e164])
  let matched = 0
  for (const o of owners) {
    await q.query(`INSERT INTO nexus_owner_links (agency_key, owner_contact_id) VALUES ($1,$2) ON CONFLICT (agency_key, owner_contact_id) DO NOTHING`, [agency, o.id])
    const { rows: [link] } = await q.query(`SELECT * FROM nexus_owner_links WHERE agency_key=$1 AND owner_contact_id=$2 FOR UPDATE`, [agency, o.id])
    if (link.nexus_account_ref && link.nexus_account_ref !== ref) {
      // Someone else already claimed this owner: staff decide, nothing is overwritten.
      await audit(q, null, 'SYNC_CLAIM_CONFLICT', { owner_contact_id: o.id, account: account.public_id })
      continue
    }
    if (link.link_state === 'disputed') continue
    const { rows: props } = await q.query(`SELECT ${PROPERTY_COLUMNS} FROM properties p WHERE p.owner_id=$1 AND ${REAL_PROPERTY} ORDER BY p.id`, [o.id])
    for (const p of props) {
      await q.query(`INSERT INTO nexus_owner_property_claims (owner_link_id, property_id) VALUES ($1,$2) ON CONFLICT (owner_link_id, property_id) DO NOTHING`, [link.id, p.id])
      await ensurePropertyLink(q, p)
    }
    if (link.link_state !== 'verified') {
      await q.query(`UPDATE nexus_owner_links SET nexus_account_ref=$2, link_state='claim_pending', updated_at=NOW() WHERE id=$1`, [link.id, ref])
    }
    await audit(q, null, 'NEXUS_OWNER_CLAIM_SUBMITTED', { owner_contact_id: o.id, via: 'sync_phone_whatsapp', properties: props.length })
    matched++
  }
  return { matched }
}

async function linksOf(q, account) {
  const { rows } = await q.query(`SELECT * FROM nexus_owner_links WHERE agency_key=$1 AND nexus_account_ref=$2 ORDER BY id`, [AGENCY_KEY(), accountRef(account)])
  return rows
}

// What the owner sees. Before verification: locality-level facts of the
// proposed listings, to confirm or reject. After: the full owner view.
async function ownerView(account) {
  const agency = AGENCY_KEY()
  const links = await linksOf(db, account)
  const out = []
  for (const link of links) {
    if (link.link_state === 'verified') {
      const v = await require('./nexusOwnerInbound').readOwnerLink({ linkId: link.public_id, nexusAccountRef: link.nexus_account_ref })
      const st = await propertyState(account, v.properties.map(x => x.sourcePropertyId))
      out.push({ linkId: link.public_id, agencyKey: agency, state: 'verified', properties: v.properties.map(x => ({ ...x, state: st[x.sourcePropertyId] || null })) })
    } else {
      const { rows } = await db.query(
        `SELECT p.ref, p.town, p.property_type, p.bedrooms, c.claim_state FROM nexus_owner_property_claims c
           JOIN properties p ON p.id=c.property_id AND p.owner_id=$2 WHERE c.owner_link_id=$1 AND ${REAL_PROPERTY} ORDER BY p.id`, [link.id, link.owner_contact_id])
      out.push({ linkId: link.public_id, agencyKey: agency, state: link.link_state,
        proposed: rows.map(r => ({ externalId: `${agency}:${r.ref}`, ref: r.ref, town: r.town, propertyType: r.property_type, bedrooms: r.bedrooms, claimState: r.claim_state })) })
    }
  }
  return { agencyKey: agency, links: out }
}

// The owner confirms or rejects proposed listings before staff verification.
async function decideClaims(account, decisions) {
  const map = { confirm: 'confirmed', reject: 'rejected' }
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > 200) throw err('DECISIONS_INVALID', 'Nothing to decide.')
  return tx(async q => {
    const links = (await linksOf(q, account)).filter(l => l.link_state === 'claim_pending' || l.link_state === 'verified')
    let n = 0
    for (const d of decisions) {
      if (!map[d?.decision]) throw err('DECISION_INVALID', 'decision must be confirm or reject')
      const ref = String(d.externalId || '').split(':').slice(1).join(':')
      const { rowCount } = await q.query(
        `UPDATE nexus_owner_property_claims c SET claim_state=$3, decided_at=NOW(), decided_via='nexus_sync', updated_at=NOW()
           FROM properties p WHERE c.property_id=p.id AND p.ref=$2 AND c.owner_link_id = ANY($1::bigint[]) AND c.claim_state IN ('proposed','confirmed','rejected')`,
        [links.map(l => l.id), ref, map[d.decision]])
      n += rowCount
    }
    await audit(q, null, 'SYNC_CLAIM_DECISIONS', { account: account.public_id, decided: n })
    return { decided: n }
  })
}

// Owner changes go through the existing, validated inbound handlers. The link
// is taken from the account, never from the request.
const OWNER_EVENTS = ['property.owner_updated', 'viewing.schedule_updated', 'availability.answered', 'distribution.granted', 'distribution.revoked', 'qa.answer_approved', 'qa.answer_withdrawn']
async function ownerEvent(account, { eventType, eventId, data }) {
  if (!OWNER_EVENTS.includes(eventType)) throw err('EVENT_TYPE_UNKNOWN', 'Unknown change.')
  const links = (await linksOf(db, account)).filter(l => l.link_state === 'verified')
  const ext = String(data?.externalId || '')
  // find the verified link that holds this listing
  let link = null
  for (const l of links) {
    const { rows } = await db.query(
      `SELECT 1 FROM nexus_property_links pl JOIN nexus_owner_property_claims c ON c.property_id=pl.property_id AND c.owner_link_id=$1 WHERE pl.agency_key=$2 AND pl.external_id=$3`, [l.id, l.agency_key, ext])
    if (rows.length) { link = l; break }
  }
  if (!link) throw err('OWNER_LINK_NOT_VERIFIED', 'An agent has to confirm this home for you first.', 409)
  return L.applyInboundEvent({
    contractVersion: L.CONTRACT_VERSION, agencyKey: link.agency_key, eventType,
    eventId: /^[A-Za-z0-9_-]{8,80}$/.test(String(eventId || '')) ? String(eventId) : `sync-${crypto.randomUUID()}`,
    occurredAt: new Date().toISOString(),
    data: { ...(data || {}), linkId: link.public_id },
  })
}

// ── messages ────────────────────────────────────────────────────────────────
function messageView(m) {
  return { id: Number(m.id), at: m.created_at, from: m.direction === 'in' ? 'owner' : 'argus',
    sender: { kind: m.sender_kind, name: m.sender_name || null, org: m.sender_org || null },
    text: m.body, propertyId: m.property_id, attachment: m.attachment || null }
}

async function messages(account, { after } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM nexus_owner_messages WHERE agency_key=$1 AND account_id=$2 AND id > $3 ORDER BY id LIMIT 300`, [AGENCY_KEY(), account.id, Number(after) || 0])
  if (rows.length) await db.query(`UPDATE nexus_owner_messages SET read_by_owner_at=NOW() WHERE agency_key=$1 AND account_id=$2 AND direction='out' AND read_by_owner_at IS NULL`, [AGENCY_KEY(), account.id])
  return { messages: rows.map(messageView) }
}

async function postMessage(account, { text, propertyId }) {
  const body = String(text || '').trim()
  if (!body || body.length > 4000) throw err('MESSAGE_INVALID', 'Write a message (up to 4000 characters).')
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM nexus_owner_messages WHERE account_id=$1 AND direction='in' AND created_at > NOW() - interval '10 minutes'`, [account.id])
  if (n >= 30) throw err('TOO_MANY', 'Too many messages. Please wait a few minutes.', 429)
  const links = await linksOf(db, account)
  const { rows: [m] } = await db.query(
    `INSERT INTO nexus_owner_messages (agency_key, account_id, owner_link_id, property_id, direction, sender_kind, sender_name, body)
     VALUES ($1,$2,$3,$4,'in','owner',$5,$6) RETURNING *`,
    [AGENCY_KEY(), account.id, links[0]?.id || null, Number.isInteger(propertyId) ? propertyId : null, account.display_name || null, body])
  notifyStaff(account, body).catch(() => {})
  return { message: messageView(m) }
}

// Optional heads-up to one staff chat (operator session -> staff number). Off until SYNC_STAFF_NOTIFY_TO is set.
async function notifyStaff(account, body) {
  const to = String(process.env.SYNC_STAFF_NOTIFY_TO || '').replace(/\D/g, '')
  if (!to) return
  await sender(argusMainSession(), `${to}@c.us`, `SYNC message from ${account.display_name || account.email || 'an owner'}:\n${body.slice(0, 500)}\n\nReply in the CRM: SYNC inbox.`)
}

// ── staff side (CRM) ────────────────────────────────────────────────────────
async function staffThreads() {
  const { rows } = await db.query(
    `SELECT a.public_id, a.display_name, a.email, a.phone_e164, a.phone_verified_at, a.created_at,
            (SELECT json_agg(json_build_object('ownerId', l.owner_contact_id, 'state', l.link_state) ORDER BY l.id) FROM nexus_owner_links l WHERE l.agency_key=$1 AND l.nexus_account_ref = 'sync:' || a.public_id) AS links,
            m.last_at, m.last_text, m.unread
       FROM sync_accounts a
       LEFT JOIN LATERAL (SELECT MAX(created_at) AS last_at,
                                 (SELECT body FROM nexus_owner_messages x WHERE x.account_id=a.id AND x.agency_key=$1 ORDER BY id DESC LIMIT 1) AS last_text,
                                 COUNT(*) FILTER (WHERE direction='in' AND read_by_staff_at IS NULL)::int AS unread
                            FROM nexus_owner_messages WHERE account_id=a.id AND agency_key=$1) m ON TRUE
      WHERE a.disabled_at IS NULL
      ORDER BY m.last_at DESC NULLS LAST, a.created_at DESC LIMIT 200`, [AGENCY_KEY()])
  return { threads: rows.map(r => ({ accountId: r.public_id, name: r.display_name, email: r.email, phone: r.phone_e164 ? `+${r.phone_e164}` : null, phoneVerified: !!r.phone_verified_at,
    links: r.links || [], lastAt: r.last_at, lastText: r.last_text ? String(r.last_text).slice(0, 140) : null, unread: r.unread || 0, createdAt: r.created_at })) }
}

// Unread owner messages and claims waiting for a decision: the inbox counter.
async function staffSummary() {
  const agency = AGENCY_KEY()
  const [{ rows: [m] }, { rows: [c] }] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM nexus_owner_messages WHERE agency_key=$1 AND direction='in' AND read_by_staff_at IS NULL`, [agency]),
    db.query(`SELECT COUNT(*)::int AS n FROM nexus_owner_links WHERE agency_key=$1 AND link_state='claim_pending' AND nexus_account_ref LIKE 'sync:%'`, [agency]),
  ])
  return { unread: m.n, pendingClaims: c.n }
}

// Owner and listing context for one SYNC account: who the owner is in ARGUS,
// the claimed listings and the agent responsible for each.
async function staffContext(publicId) {
  const a = await staffAccount(publicId)
  const { rows: links } = await db.query(
    `SELECT l.id, l.owner_contact_id, l.link_state, l.verified_at, oc.name AS owner_name FROM nexus_owner_links l
       JOIN owner_contacts oc ON oc.id=l.owner_contact_id WHERE l.agency_key=$1 AND l.nexus_account_ref=$2 ORDER BY l.id`, [AGENCY_KEY(), accountRef(a)])
  const out = []
  for (const l of links) {
    const { rows } = await db.query(
      `SELECT p.id, p.ref, p.town, p.property_type, p.bedrooms, p.longlet_price, p.sale_price, p.available_status, c.claim_state, ag.name AS agent_name
         FROM nexus_owner_property_claims c JOIN properties p ON p.id=c.property_id LEFT JOIN agents ag ON ag.id=p.listed_by_agent_id
        WHERE c.owner_link_id=$1 ORDER BY p.id`, [l.id])
    out.push({ ownerId: l.owner_contact_id, ownerName: l.owner_name, state: l.link_state, verifiedAt: l.verified_at,
      properties: rows.map(r => ({ id: r.id, ref: r.ref, town: r.town, type: r.property_type, bedrooms: r.bedrooms, rent: r.longlet_price == null ? null : Number(r.longlet_price), sale: r.sale_price == null ? null : Number(r.sale_price), availability: r.available_status, claim: r.claim_state, agent: r.agent_name || null })) })
  }
  return { account: accountView(a), links: out }
}

// Staff approve or reject a SYNC claim. Approval uses the existing verification
// (markVerified via verifyOwner); rejection detaches the account, nothing else.
async function staffDecideClaim(publicId, agent, { ownerId, decision }) {
  const a = await staffAccount(publicId)
  if (!(agent?.role === 'admin' || agent?.nexusOwnerLink === true)) throw err('FORBIDDEN', 'Only admins or agents with NEXUS owner controls can decide claims.', 403)
  const oid = Number(ownerId)
  const { rows: [l] } = await db.query(`SELECT * FROM nexus_owner_links WHERE agency_key=$1 AND owner_contact_id=$2 AND nexus_account_ref=$3`, [AGENCY_KEY(), oid, accountRef(a)])
  if (!l) throw err('CLAIM_NOT_FOUND', 'This account has no claim on that owner.', 404)
  if (decision === 'approve') {
    await tx(async q => q.query(`UPDATE nexus_owner_property_claims SET claim_state='confirmed', decided_at=COALESCE(decided_at,NOW()), decided_via=COALESCE(decided_via,'staff_sync_inbox'), updated_at=NOW()
                                  WHERE owner_link_id=$1 AND claim_state='proposed'`, [l.id]))
    const r = await L.verifyOwner(oid, agent, { method: `sync_phone_${a.phone_verified_via || 'confirmed'}_staff_approved` })
    return { ...r, ownerId: oid }
  }
  if (decision === 'reject') {
    await tx(async q => {
      await q.query(`UPDATE nexus_owner_links SET nexus_account_ref=NULL, link_state='not_invited', verified_at=NULL, updated_at=NOW() WHERE id=$1`, [l.id])
      await q.query(`UPDATE nexus_owner_property_claims SET claim_state='proposed', decided_at=NULL, updated_at=NOW() WHERE owner_link_id=$1`, [l.id])
      await audit(q, agent, 'SYNC_CLAIM_REJECTED', { owner_contact_id: oid, account: a.public_id })
    })
    return { linkState: 'not_invited', ownerId: oid }
  }
  throw err('DECISION_INVALID', 'approve or reject')
}

async function staffAccount(publicId) {
  const { rows: [a] } = await db.query(`SELECT * FROM sync_accounts WHERE public_id::text=$1`, [String(publicId || '')])
  if (!a) throw err('ACCOUNT_NOT_FOUND', 'Account not found', 404)
  return a
}

async function staffMessages(publicId) {
  const a = await staffAccount(publicId)
  const { rows } = await db.query(`SELECT * FROM nexus_owner_messages WHERE agency_key=$1 AND account_id=$2 ORDER BY id LIMIT 500`, [AGENCY_KEY(), a.id])
  await db.query(`UPDATE nexus_owner_messages SET read_by_staff_at=NOW() WHERE agency_key=$1 AND account_id=$2 AND direction='in' AND read_by_staff_at IS NULL`, [AGENCY_KEY(), a.id])
  return { account: accountView(a), messages: rows.map(messageView) }
}

async function staffReply(publicId, agent, { text, propertyId }) {
  const a = await staffAccount(publicId)
  const body = String(text || '').trim()
  if (!body || body.length > 4000) throw err('MESSAGE_INVALID', 'Write a message (up to 4000 characters).')
  const links = await linksOf(db, a)
  const org = process.env.SYNC_AGENCY_NAME || '2906 Real Estate'
  const { rows: [m] } = await db.query(
    `INSERT INTO nexus_owner_messages (agency_key, account_id, owner_link_id, property_id, direction, sender_kind, agent_id, sender_name, sender_org, body)
     VALUES ($1,$2,$3,$4,'out','agent',$5,$6,$7,$8) RETURNING *`,
    [AGENCY_KEY(), a.id, links[0]?.id || null, Number.isInteger(propertyId) ? propertyId : null, agent?.id || null, agent?.name || agent?.username || 'Agent', org, body])
  return { message: messageView(m) }
}

module.exports = {
  signup, login, logout, sessionAccount, updateAccount, socialSignIn,
  emailStart, emailConfirm, phoneStart, phoneStatus, handleWhatsAppVerify,
  loginPhoneStart, loginPhoneStatus, setPrefs, ownerViewings, ownerDecide, ownerSetDays, ownedProperties,
  ownerView, decideClaims, ownerEvent, messages, postMessage,
  staffThreads, staffMessages, staffReply, staffSummary, staffContext, staffDecideClaim,
  accountView, claimByPhone, phoneDigits, passwordProblem, WA_RE,
  _test: { setHttp, setMailer, setSender, sha, waToken, setWindows: fn => { windows = () => fn } },
}
