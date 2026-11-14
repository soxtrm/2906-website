'use strict'
// ============================================================================
// services/facebookPages/secrets.js — encryption at rest for Meta tokens.
//
// AES-256-GCM, random 96-bit IV per value, auth tag checked on decrypt.
// Envelope: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>". The key comes
// from ARGUS_FB_TOKEN_KEY (32 bytes as base64/base64url or 64 hex chars) and is
// never written to the database. The additional authenticated data binds a
// ciphertext to its purpose ("user"/"page"), so a page token row cannot be
// swapped into a user token slot.
// ============================================================================
const crypto = require('crypto')
const settings = require('./settings')

const VERSION = 'v1'

function parseKey(raw) {
  if (!raw) throw Object.assign(new Error('Facebook token encryption key is not configured'), { status: 503, kind: 'not_configured' })
  let buf = null
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex')
  else {
    try { buf = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64') } catch { buf = null }
  }
  if (!buf || buf.length !== 32) throw Object.assign(new Error('ARGUS_FB_TOKEN_KEY must be 32 bytes (base64 or hex)'), { status: 503, kind: 'not_configured' })
  return buf
}

function key() { return parseKey(settings.read().tokenKey) }

function encrypt(plaintext, purpose) {
  if (typeof plaintext !== 'string' || !plaintext) throw new Error('nothing to encrypt')
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv)
  c.setAAD(Buffer.from(`argus-fb:${purpose}`))
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

function decrypt(envelope, purpose) {
  const parts = String(envelope || '').split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unrecognised credential envelope')
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'))
  d.setAAD(Buffer.from(`argus-fb:${purpose}`))
  d.setAuthTag(Buffer.from(parts[2], 'base64url'))
  return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8')
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex')
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')

// Mask anything token-shaped before it can reach a log line or an error message.
function redact(value) {
  return String(value == null ? '' : value)
    .replace(/(access_token|input_token|fb_exchange_token|client_secret|appsecret_proof|code)=([^&\s"']+)/gi, '$1=[redacted]')
    .replace(/\bEA[A-Za-z0-9]{20,}\b/g, '[redacted-token]')
}

module.exports = { encrypt, decrypt, sha256, randomToken, redact, parseKey, VERSION }
