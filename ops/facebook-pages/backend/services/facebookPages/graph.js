'use strict'
// ============================================================================
// services/facebookPages/graph.js — the only module that talks to Meta.
//
// Official Graph API only (configurable version, default v27.0). Access tokens
// travel in the Authorization header, never in a URL we build; every call
// carries appsecret_proof (HMAC-SHA256 of the token with the app secret) so the
// app can switch on "Require App Secret". Errors are classified into a small
// set of kinds the publisher can act on, with a plain-language message for
// agents. Raw Meta bodies and tokens never leave this module.
//
// Endpoints (checked against developers.facebook.com on 2026-11-14):
//   GET  /oauth/access_token            code -> short-lived user token
//   GET  /oauth/access_token            fb_exchange_token -> long-lived user token
//   GET  /debug_token                   validity, scopes, expiry
//   GET  /me, /me/permissions, /me/accounts (id,name,access_token,tasks,picture,category)
//   POST /{page-id}/feed                message, link, attached_media[i]
//   POST /{page-id}/photos              url, caption, published
//   GET  /{post-id}?fields=permalink_url,created_time,is_published
//   POST /{post-id}                     message (posts created by this app only)
//   DELETE /{post-id}
// ============================================================================
const crypto = require('crypto')
const settings = require('./settings')
const { redact } = require('./secrets')

const BASE = 'https://graph.facebook.com'

class GraphError extends Error {
  constructor({ kind, code = null, subcode = null, httpStatus = null, retryAfterSec = null, userMessage, uncertain = false, detail = null }) {
    super(userMessage)
    this.name = 'GraphError'
    this.kind = kind            // auth | permission | rate_limit | transient | duplicate | invalid_media | invalid_link | not_found | policy | not_editable | not_configured | unknown
    this.code = code
    this.subcode = subcode
    this.httpStatus = httpStatus
    this.retryAfterSec = retryAfterSec
    this.userMessage = userMessage
    this.uncertain = uncertain  // request may have reached Meta (timeout / connection drop)
    this.detail = detail        // redacted Meta message, for server logs only
  }
}

const MESSAGES = {
  auth: 'Your Facebook connection has expired or was removed. Reconnect Facebook to continue.',
  permission: 'ARGUS no longer has permission to post on this Page. Reconnect Facebook and allow Page posting, or check that you still manage this Page.',
  rate_limit: 'Facebook is limiting how often this Page can post right now. ARGUS will try again later.',
  transient: 'Facebook did not respond properly. Please try again in a moment.',
  duplicate: 'Facebook rejected this as a duplicate of a recent post. Change the text slightly and try again.',
  invalid_media: 'Facebook could not use one of the selected photos. Remove it or choose another photo.',
  invalid_link: 'Facebook could not open the property link. Remove the link or try again later.',
  not_found: 'This post no longer exists on Facebook.',
  policy: 'Facebook has temporarily blocked posting from this account. Wait a while before trying again.',
  not_editable: 'Facebook does not allow this post to be edited through ARGUS. You can publish a replacement post instead.',
  checkpoint: 'Facebook needs you to sign in on facebook.com to confirm your account. Then reconnect Facebook in ARGUS.',
  unknown: 'Facebook returned an unexpected error. Please try again, or contact support if it keeps happening.',
}

function retryAfterFrom(headers) {
  try {
    const raw = headers && headers.get && headers.get('x-business-use-case-usage')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    let minutes = 0
    for (const list of Object.values(parsed)) for (const u of (Array.isArray(list) ? list : [])) minutes = Math.max(minutes, Number(u.estimated_time_to_regain_access) || 0)
    return minutes > 0 ? minutes * 60 : null
  } catch { return null }
}

// Map a Meta error object to one of our kinds. Codes per the Graph API error
// handling guide (190/subcodes, 10, 200-299, 4/17/32/613/80001, 368, 506, 1609005).
function classify(err, httpStatus, headers) {
  const code = Number(err && err.code)
  const sub = Number(err && err.error_subcode)
  const msg = String((err && err.message) || '')
  const base = { code: code || null, subcode: sub || null, httpStatus, detail: redact(msg).slice(0, 300) }
  if (code === 190 || code === 102) {
    if (sub === 459 || sub === 464) return new GraphError({ ...base, kind: 'auth', userMessage: MESSAGES.checkpoint })
    return new GraphError({ ...base, kind: 'auth', userMessage: MESSAGES.auth })
  }
  if (code === 10 || (code >= 200 && code <= 299) || code === 283) return new GraphError({ ...base, kind: 'permission', userMessage: MESSAGES.permission })
  if ([4, 17, 32, 613, 80001, 341].includes(code)) return new GraphError({ ...base, kind: 'rate_limit', retryAfterSec: retryAfterFrom(headers) || 15 * 60, userMessage: MESSAGES.rate_limit })
  if (code === 368) return new GraphError({ ...base, kind: 'policy', retryAfterSec: 6 * 3600, userMessage: MESSAGES.policy })
  if (code === 506) return new GraphError({ ...base, kind: 'duplicate', userMessage: MESSAGES.duplicate })
  if (code === 1609005) return new GraphError({ ...base, kind: 'invalid_link', userMessage: MESSAGES.invalid_link })
  if (code === 324 || code === 352 || (code === 100 && /photo|image|url.*(fetch|download)|media/i.test(msg))) return new GraphError({ ...base, kind: 'invalid_media', userMessage: MESSAGES.invalid_media })
  if (code === 100 && (sub === 33 || /does not exist|cannot be loaded due to missing permissions/i.test(msg))) return new GraphError({ ...base, kind: 'not_found', userMessage: MESSAGES.not_found })
  if (/editing.*not supported|cannot be edited|not editable/i.test(msg)) return new GraphError({ ...base, kind: 'not_editable', userMessage: MESSAGES.not_editable })
  if (code === 1 || code === 2 || (err && err.is_transient) || httpStatus >= 500) return new GraphError({ ...base, kind: 'transient', userMessage: MESSAGES.transient })
  return new GraphError({ ...base, kind: 'unknown', userMessage: MESSAGES.unknown })
}

function proof(token) {
  const { appSecret } = settings.read()
  if (!appSecret) throw new GraphError({ kind: 'not_configured', userMessage: 'Facebook is not set up on this ARGUS server yet.' })
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex')
}

// One request. `token` goes in the Authorization header; `form` is sent
// url-encoded in the body (POST); `query` is for non-secret parameters only.
async function request(method, path, { token = null, query = {}, form = null, timeoutMs = 30000, idempotent = method === 'GET' } = {}) {
  const v = settings.graphVersion()
  const url = new URL(`${BASE}/${v}/${String(path).replace(/^\//, '')}`)
  for (const [k, val] of Object.entries(query)) if (val != null) url.searchParams.set(k, String(val))
  const headers = { accept: 'application/json' }
  if (token) {
    headers.authorization = `Bearer ${token}`
    url.searchParams.set('appsecret_proof', proof(token))
  }
  let body
  if (form) {
    const p = new URLSearchParams()
    for (const [k, val] of Object.entries(form)) if (val != null) p.set(k, typeof val === 'object' ? JSON.stringify(val) : String(val))
    body = p.toString()
    headers['content-type'] = 'application/x-www-form-urlencoded'
  }
  let res
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    // The request may or may not have reached Meta. For a non-idempotent call
    // the caller must reconcile instead of retrying blindly.
    throw new GraphError({ kind: 'transient', uncertain: !idempotent, detail: redact(e && e.message), userMessage: MESSAGES.transient })
  }
  let data = null
  try { data = await res.json() } catch { data = null }
  if (!res.ok || (data && data.error)) {
    if (!data || !data.error) throw new GraphError({ kind: 'transient', httpStatus: res.status, uncertain: !idempotent && res.status >= 500, userMessage: MESSAGES.transient })
    const ge = classify(data.error, res.status, res.headers)
    if (ge.kind === 'transient' && !idempotent) ge.uncertain = true
    throw ge
  }
  return data
}

// ── OAuth ────────────────────────────────────────────────────────────────────
function dialogUrl({ state, rerequest = false }) {
  const s = settings.read()
  const u = new URL(`https://www.facebook.com/${s.graphVersion}/dialog/oauth`)
  u.searchParams.set('client_id', s.appId)
  u.searchParams.set('redirect_uri', s.redirectUri)
  u.searchParams.set('state', state)
  u.searchParams.set('response_type', 'code')
  if (s.loginConfigId) u.searchParams.set('config_id', s.loginConfigId)
  else u.searchParams.set('scope', [...settings.REQUIRED_SCOPES, ...settings.OPTIONAL_SCOPES].join(','))
  if (rerequest) u.searchParams.set('auth_type', 'rerequest')
  return u.toString()
}

// Documented server-side exchange. The secret only travels server-to-server
// over TLS to graph.facebook.com; it is never logged (errors are redacted).
async function exchangeCode(code) {
  const s = settings.read()
  return request('GET', 'oauth/access_token', { query: { client_id: s.appId, client_secret: s.appSecret, redirect_uri: s.redirectUri, code } })
}
async function exchangeLongLived(shortToken) {
  const s = settings.read()
  return request('GET', 'oauth/access_token', { query: { grant_type: 'fb_exchange_token', client_id: s.appId, client_secret: s.appSecret, fb_exchange_token: shortToken } })
}
async function debugToken(inputToken) {
  const s = settings.read()
  // App access token "{app-id}|{app-secret}" in the header, the inspected token as input_token.
  const appToken = `${s.appId}|${s.appSecret}`
  const r = await request('GET', 'debug_token', { token: appToken, query: { input_token: inputToken } })
  return r && r.data ? r.data : {}
}

// ── user / pages ─────────────────────────────────────────────────────────────
const me = token => request('GET', 'me', { token, query: { fields: 'id,name' } })
async function permissions(token) {
  const r = await request('GET', 'me/permissions', { token })
  const granted = [], declined = []
  for (const p of (r && r.data) || []) (p.status === 'granted' ? granted : declined).push(p.permission)
  return { granted, declined }
}
async function accounts(token) {
  const out = []
  let after = null
  for (let i = 0; i < 20; i++) {           // follow paging, bounded
    const r = await request('GET', 'me/accounts', { token, query: { fields: 'id,name,access_token,tasks,category,picture{url}', limit: 100, after } })
    for (const p of (r && r.data) || []) out.push(p)
    after = r && r.paging && r.paging.cursors && r.paging.next ? r.paging.cursors.after : null
    if (!after) break
  }
  return out
}

// ── publishing ───────────────────────────────────────────────────────────────
// Unpublished photo for a multi-photo post. Safe to retry: an unused
// unpublished photo is discarded by Meta after about 24 hours.
async function uploadUnpublishedPhoto(pageToken, pageId, imageUrl) {
  const r = await request('POST', `${pageId}/photos`, { token: pageToken, form: { url: imageUrl, published: 'false' }, timeoutMs: 60000, idempotent: true })
  if (!r || !r.id) throw new GraphError({ kind: 'invalid_media', userMessage: MESSAGES.invalid_media })
  return r.id
}
// Single published photo post (non-idempotent).
async function publishPhoto(pageToken, pageId, imageUrl, caption) {
  const r = await request('POST', `${pageId}/photos`, { token: pageToken, form: { url: imageUrl, caption, published: 'true' }, timeoutMs: 60000 })
  return { postId: r.post_id || null, photoId: r.id || null }
}
// Feed post: text, text+link, or text + attached unpublished photos (non-idempotent).
async function publishFeed(pageToken, pageId, { message, link = null, mediaFbids = [] }) {
  const form = { message }
  if (link && !mediaFbids.length) form.link = link
  mediaFbids.forEach((id, i) => { form[`attached_media[${i}]`] = { media_fbid: id } })
  const r = await request('POST', `${pageId}/feed`, { token: pageToken, form })
  return { postId: r.id || null }
}
const getPost = (pageToken, postId) => request('GET', postId, { token: pageToken, query: { fields: 'id,permalink_url,created_time,is_published,message' } })
const updatePost = (pageToken, postId, message) => request('POST', postId, { token: pageToken, form: { message } })
const deletePost = (pageToken, postId) => request('DELETE', postId, { token: pageToken, idempotent: true })
// Recent Page posts, used to reconcile a feed call whose response was lost.
async function recentPosts(pageToken, pageId, sinceEpoch) {
  const r = await request('GET', `${pageId}/posts`, { token: pageToken, query: { fields: 'id,message,created_time,permalink_url', since: sinceEpoch, limit: 25 } })
  return (r && r.data) || []
}

module.exports = {
  GraphError, MESSAGES, classify, request, dialogUrl, exchangeCode, exchangeLongLived, debugToken,
  me, permissions, accounts, uploadUnpublishedPhoto, publishPhoto, publishFeed, getPost, updatePost, deletePost, recentPosts,
}
