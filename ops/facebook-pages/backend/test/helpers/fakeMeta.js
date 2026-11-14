'use strict'
// A small in-memory stand-in for the Meta Graph API, installed as global fetch.
// It enforces what the real API enforces for our flow: client secret and
// redirect_uri on the code exchange, Bearer tokens, a correct appsecret_proof,
// Page tokens bound to their Page, CREATE_CONTENT for posting, and it records
// every call so tests can assert that no token ever travels in a URL.
const crypto = require('crypto')

function createFakeMeta({ appId, appSecret, redirectUri, version = 'v27.0' }) {
  const S = {
    codes: new Map(), tokens: new Map(), users: new Map(), posts: new Map(), photos: new Map(),
    calls: [], failures: [], seq: 0,
  }
  const tok = (prefix) => `EA${prefix}${crypto.randomBytes(18).toString('hex')}`
  const err = (status, code, message, extra = {}) => ({ status, body: { error: { message, type: 'OAuthException', code, ...extra, fbtrace_id: 'TRACE' } } })

  function addUser(id, { name, granted = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management', 'public_profile'], declined = [], pages = [] }) {
    S.users.set(id, { id, name, granted, declined, pages })
    return id
  }
  function issueCode(userId) { const c = `CODE_${++S.seq}`; S.codes.set(c, userId); return c }
  function expireUserTokens(userId) { for (const t of S.tokens.values()) if (t.user === userId) t.valid = false }
  function revokePage(userId, pageId) { for (const t of S.tokens.values()) if (t.user === userId && t.page === pageId) t.valid = false }
  function fail(match, response, times = 1) { S.failures.push({ match, response, times }) }

  function auth(headers, url) {
    const h = headers.authorization || ''
    if (!h.startsWith('Bearer ')) return { e: err(400, 2500, 'An active access token must be used') }
    const token = h.slice(7)
    const expected = crypto.createHmac('sha256', appSecret).update(token).digest('hex')
    if (url.searchParams.get('appsecret_proof') !== expected) return { e: err(400, 100, 'Invalid appsecret_proof provided in the API argument') }
    if (token === `${appId}|${appSecret}`) return { t: { type: 'app', valid: true } }
    const t = S.tokens.get(token)
    if (!t || !t.valid) return { e: err(400, 190, 'Error validating access token: Session has expired', { error_subcode: 463 }) }
    return { t, token }
  }

  async function handle(method, url, headers, form) {
    const p = url.pathname.replace(`/${version}/`, '')
    const q = url.searchParams
    if (p === 'oauth/access_token') {
      if (q.get('client_id') !== appId || q.get('client_secret') !== appSecret) return err(400, 1, 'Error validating client secret.')
      if (q.get('grant_type') === 'fb_exchange_token') {
        const old = S.tokens.get(q.get('fb_exchange_token'))
        if (!old || !old.valid) return err(400, 190, 'Error validating access token', { error_subcode: 463 })
        const t = tok('LL'); S.tokens.set(t, { type: 'user', user: old.user, valid: true, long: true })
        return { status: 200, body: { access_token: t, token_type: 'bearer', expires_in: 5183944 } }
      }
      if (q.get('redirect_uri') !== redirectUri) return err(400, 100, 'redirect_uri isn\'t an absolute URI or does not match')
      const user = S.codes.get(q.get('code'))
      if (!user) return err(400, 100, 'This authorization code has been used.', { error_subcode: 36009 })
      S.codes.delete(q.get('code'))
      const t = tok('SL'); S.tokens.set(t, { type: 'user', user, valid: true })
      return { status: 200, body: { access_token: t, token_type: 'bearer', expires_in: 5400 } }
    }
    const a = auth(headers, url)
    if (a.e) return a.e
    if (p === 'debug_token') {
      const t = S.tokens.get(q.get('input_token'))
      const u = t && S.users.get(t.user)
      return { status: 200, body: { data: { app_id: appId, type: 'USER', is_valid: !!(t && t.valid), user_id: t ? t.user : null, scopes: u ? u.granted : [],
        expires_at: Math.floor(Date.now() / 1000) + 60 * 86400, data_access_expires_at: Math.floor(Date.now() / 1000) + 90 * 86400 } } }
    }
    const user = a.t.user && S.users.get(a.t.user)
    if (p === 'me' && method === 'GET') return { status: 200, body: { id: user.id, name: user.name } }
    if (p === 'me/permissions' && method === 'GET') return { status: 200, body: { data: [...user.granted.map(x => ({ permission: x, status: 'granted' })), ...user.declined.map(x => ({ permission: x, status: 'declined' }))] } }
    if (p === 'me/permissions' && method === 'DELETE') { expireUserTokens(user.id); return { status: 200, body: { success: true } } }
    if (p === 'me/accounts') {
      const all = user.pages.map(pg => {
        const t = tok('PG'); S.tokens.set(t, { type: 'page', user: user.id, page: pg.id, valid: true, tasks: pg.tasks })
        return { id: pg.id, name: pg.name, category: 'Real Estate', tasks: pg.tasks, access_token: t, picture: { data: { url: `https://scontent.example/${pg.id}.jpg` } } }
      })
      const after = q.get('after')
      const start = after ? Number(after) : 0
      const chunk = all.slice(start, start + 1)
      const more = start + 1 < all.length
      return { status: 200, body: { data: chunk, paging: { cursors: { before: String(start), after: String(start + 1) }, ...(more ? { next: 'https://graph.facebook.com/next' } : {}) } } }
    }
    const m = p.match(/^(\w+)\/(photos|feed|posts)$/)
    if (m) {
      const pageId = m[1]
      if (a.t.type !== 'page' || a.t.page !== pageId) return err(403, 200, 'Requires pages_manage_posts permission to manage the object')
      if (!(a.t.tasks || []).includes('CREATE_CONTENT') && method === 'POST') return err(403, 200, 'User does not have sufficient administrative permission for this action on this page')
      if (m[2] === 'posts') return { status: 200, body: { data: [...S.posts.values()].filter(x => x.page === pageId && !x.deleted && x.created >= Number(q.get('since') || 0)).map(x => ({ id: x.id, message: x.message, created_time: new Date(x.created * 1000).toISOString(), permalink_url: x.permalink })) } }
      if (m[2] === 'photos') {
        if (!/^https:\/\//.test(form.url || '')) return err(400, 324, 'Missing or invalid image file')
        const id = `photo${++S.seq}`
        S.photos.set(id, { page: pageId, url: form.url, published: form.published !== 'false' })
        if (form.published === 'false') return { status: 200, body: { id } }
        const post = makePost(pageId, form.caption, [id])
        return { status: 200, body: { id, post_id: post.id } }
      }
      if (!form.message && !form.link) return err(400, 100, 'Either link or message must be supplied')
      const media = Object.keys(form).filter(k => /^attached_media\[\d+\]$/.test(k)).sort((x, y) => Number(x.match(/\d+/)[0]) - Number(y.match(/\d+/)[0])).map(k => JSON.parse(form[k]).media_fbid)
      for (const id of media) { const ph = S.photos.get(id); if (!ph || ph.page !== pageId || ph.published) return err(400, 100, 'Invalid media_fbid') }
      const post = makePost(pageId, form.message, media, form.link)
      return { status: 200, body: { id: post.id } }
    }
    const post = S.posts.get(p)
    if (post) {
      if (a.t.type !== 'page' || a.t.page !== post.page) return err(403, 200, 'Permissions error')
      if (post.deleted) return err(400, 100, 'Object with ID does not exist, cannot be loaded due to missing permissions', { error_subcode: 33 })
      if (method === 'GET') return { status: 200, body: { id: post.id, permalink_url: post.permalink, created_time: new Date(post.created * 1000).toISOString(), is_published: true, message: post.message } }
      if (method === 'POST') { post.message = form.message; return { status: 200, body: { success: true } } }
      if (method === 'DELETE') { post.deleted = true; return { status: 200, body: { success: true } } }
    }
    if (/^\w+_\w+$/.test(p)) return err(400, 100, 'Object with ID does not exist, cannot be loaded due to missing permissions', { error_subcode: 33 })
    return err(400, 2500, 'Unknown path components')
  }

  function makePost(pageId, message, media, link = null) {
    const n = ++S.seq
    const id = `${pageId}_${9000 + n}`
    const post = { id, page: pageId, message, media, link, created: Math.floor(Date.now() / 1000), permalink: `https://www.facebook.com/${pageId}/posts/${9000 + n}`, deleted: false }
    S.posts.set(id, post)
    return post
  }

  async function fakeFetch(input, init = {}) {
    const url = new URL(String(input))
    if (url.hostname !== 'graph.facebook.com') throw new Error('unexpected host ' + url.hostname)
    const method = (init.method || 'GET').toUpperCase()
    const headers = {}
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {}
    const path = url.pathname.replace(`/${version}/`, '')
    S.calls.push({ method, path, url: url.toString(), hasBearer: !!headers.authorization, form })
    const f = S.failures.find(x => x.times > 0 && (typeof x.match === 'function' ? x.match({ method, path, form }) : x.match === `${method} ${path}`))
    if (f) {
      f.times--
      if (f.response === 'drop-before') throw new TypeError('fetch failed')
      if (f.response === 'drop-after') { await handle(method, url, headers, form); throw new TypeError('fetch failed') }
      return new Response(JSON.stringify(f.response.body), { status: f.response.status, headers: { 'content-type': 'application/json', ...(f.response.headers || {}) } })
    }
    const r = await handle(method, url, headers, form)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }

  return { S, addUser, issueCode, expireUserTokens, revokePage, fail, fetch: fakeFetch, err }
}

module.exports = { createFakeMeta }
