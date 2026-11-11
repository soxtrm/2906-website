'use strict'
// ============================================================================
// services/nexusLinkCrypto.js — invitation tokens and service-to-service
// request signing for the ARGUS × NEXUS owner link (Claude, 2026-11-11).
// Pure crypto, no I/O. Secrets come from the environment only.
// ============================================================================
const crypto = require('crypto')

const b64url = buf => Buffer.from(buf).toString('base64url')
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex')

function inviteKey(env = process.env) {
  const base = env.NEXUS_INVITE_SECRET || env.JWT_SECRET
  if (!base) throw new Error('NEXUS_INVITE_SECRET or JWT_SECRET must be set')
  // Domain-separated: an invitation token can never double as a CRM JWT key.
  return crypto.createHmac('sha256', base).update('nexus-owner-invite-v1').digest()
}

function newNonce() { return b64url(crypto.randomBytes(24)) }

// The plaintext token is derived, never stored: "<id36>.<HMAC(id.nonce)>".
// A database leak alone therefore discloses no usable invitation link.
function inviteToken(id, nonce, env) {
  const mac = crypto.createHmac('sha256', inviteKey(env)).update(`${id}.${nonce}`).digest()
  return `${Number(id).toString(36)}.${b64url(mac)}`
}
const tokenHash = token => sha256(String(token))
const TOKEN_RE = /^[0-9a-z]{1,12}\.[A-Za-z0-9_-]{43}$/

// Deterministic JSON: object keys sorted recursively, no whitespace. Both sides
// sign and hash this form, so key order on the wire never matters.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}
const payloadHash = value => sha256(canonicalJson(value))

// Signature: v1=HMAC_SHA256(secret, "<timestamp>.<METHOD>.<path>.<sha256(canonical body)>")
function sign(secret, { timestamp, method, path, body }) {
  const base = `${timestamp}.${String(method).toUpperCase()}.${path}.${payloadHash(body ?? null)}`
  return `v1=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`
}
function verify(secret, parts, signature, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  if (!secret || typeof signature !== 'string') return { ok: false, reason: 'SIGNATURE_MISSING' }
  const ts = Number(parts.timestamp)
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds) return { ok: false, reason: 'TIMESTAMP_OUT_OF_RANGE' }
  const expected = Buffer.from(sign(secret, parts))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'SIGNATURE_INVALID' }
  return { ok: true }
}

module.exports = { inviteToken, tokenHash, newNonce, TOKEN_RE, canonicalJson, payloadHash, sign, verify, sha256 }
