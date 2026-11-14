'use strict'
// Olga-perspective integration test against a THROW-AWAY copy of the ARGUS
// database (never production) with the Meta Graph API replaced by an
// in-memory fake. Real routes (Express + real JWTs), real SQL, real
// encryption. Synthetic agents and listings only.
//
//   ARGUS_BASE_DIR=<production backend, read-only> NODE_PATH=<base>/node_modules \
//   TEST_DB_HOST=… TEST_DB_NAME=… TEST_DB_USER=… TEST_DB_PASSWORD=… \
//   node --test --test-concurrency=1 test/facebookPages.integration.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { load, loadBase, realFetch } = require('./helpers/overlay')
const { createFakeMeta } = require('./helpers/fakeMeta')

const express = require('express')
const jwt = require('jsonwebtoken')
const db = loadBase('db')
const settings = load('services/facebookPages/settings')
const publisher = load('services/facebookPages/publisher')
const autoPublish = load('services/facebookPages/autoPublish')

const TAG = `FB${process.pid}${Date.now() % 100000}`
const q = (sql, p) => db.query(sql, p)
const fake = createFakeMeta({ appId: process.env.META_APP_ID, appSecret: process.env.META_APP_SECRET, redirectUri: settings.read().redirectUri })
globalThis.fetch = fake.fetch

const queued = []
publisher.setEnqueue(async id => { queued.push(Number(id)) })

let server, base
const A = {}          // agents
const P = {}          // properties
const img = (k, n) => Array.from({ length: n }, (_, i) => ({ url: `https://res.cloudinary.example/${TAG}/${k}-${i}.jpg`, thumbnail: `https://res.cloudinary.example/${TAG}/${k}-${i}_t.jpg` }))

async function agent(name, role, entitled) {
  const { rows: [a] } = await q(
    `INSERT INTO agents (username, name, display_name, role, active, email, public_phone, feature_entitlements)
     VALUES ($1,$2,$2,$3,TRUE,$4,$5,$6::jsonb) RETURNING id, username, name, role`,
    [`${TAG.toLowerCase()}_${name}`, `${name} ${TAG}`, role, `${TAG.toLowerCase()}_${name}@agency.example`, '+356 7900 0' + String(Math.floor(Math.random() * 900) + 100),
     JSON.stringify(entitled ? { facebook_pages: true } : {})])
  a.token = jwt.sign({ id: a.id, username: a.username, role: a.role, name: a.name, aud: role === 'board' ? 'board' : 'crm' }, process.env.JWT_SECRET, { expiresIn: '1h' })
  return a
}
async function property(by, k, fields = {}) {
  const f = {
    ref: `${TAG}-${k}`, property_type: 'apartment', town: 'Sliema', bedrooms: 2, bathrooms: 2, longlet_price: 1850, available_status: 'available',
    published: true, system_online: true, is_staging: false, listed_by_agent_id: by.id, images: JSON.stringify(img(k, 4)),
    feature_tags: ['air_conditioning', 'furnished'], verification_status: null, no_fb: false, ...fields,
  }
  const cols = Object.keys(f)
  const { rows: [p] } = await q(`INSERT INTO properties (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(f))
  await q(`UPDATE properties SET public_payload = jsonb_build_object('description_public', $2::text, 'images', images) WHERE id=$1`,
    [p.id, `${k.toUpperCase()} HEADLINE\n\nBright apartment close to the promenade with an open-plan living area and two comfortable bedrooms.`])
  return p
}
async function api(who, method, path, body) {
  const r = await realFetch(`${base}/api/crm/facebook-pages${path}`, {
    method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  for (const t of fake.S.tokens.keys()) assert.ok(!text.includes(t), `response to ${method} ${path} leaked an access token`)
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
async function connectAs(who, userId) {
  const start = await api(who, 'POST', '/connect')
  assert.equal(start.status, 200)
  const state = new URL(start.body.url).searchParams.get('state')
  return api(who, 'POST', '/connect/complete', { code: fake.issueCode(userId), state })
}
const key = () => crypto.randomBytes(12).toString('hex')
const pubRow = async id => (await q(`SELECT * FROM agent_facebook_publications WHERE id=$1`, [id])).rows[0]
const livePosts = () => [...fake.S.posts.values()].filter(p => !p.deleted)

test.before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/crm/facebook-pages', load('routes/crmFacebookPages'))
  app.use('/api/facebook-pages-meta', load('routes/facebookPagesMeta'))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  A.olga = await agent('olga', 'agent', true)
  A.other = await agent('other', 'agent', true)
  A.plain = await agent('plain', 'agent', false)
  A.board = await agent('board', 'board', true)
  P.main = await property(A.olga, 'main', { verification_status: 'verified', verified_at: new Date(Date.now() - 3600_000) })
  P.second = await property(A.olga, 'second')
  P.others = await property(A.other, 'others')
  P.nofb = await property(A.olga, 'nofb', { no_fb: true })
  P.rented = await property(A.olga, 'rented', { available_status: 'rented' })
  P.scraped = await property(A.olga, 'scraped')
  await q(`INSERT INTO website_source_inventory (source_domain, source_url, canonical_property_id) VALUES ('other-agency.example', $1, $2)`, [`https://other-agency.example/${TAG}`, P.scraped.id])
  fake.addUser(`u_${TAG}_olga`, { name: 'Olga Test', pages: [
    { id: `${TAG}101`, name: 'Olga Homes Malta', tasks: ['CREATE_CONTENT', 'MANAGE', 'MODERATE'] },
    { id: `${TAG}102`, name: 'Olga Analytics Only', tasks: ['ANALYZE'] },
  ] })
  fake.addUser(`u_${TAG}_other`, { name: 'Other Agent', pages: [{ id: `${TAG}201`, name: 'Other Agent Page', tasks: ['CREATE_CONTENT'] }] })
})
test.after(async () => { server && server.close(); await db.end() })

test('1 access: no session, board account and not-yet-enabled agent are refused', async () => {
  assert.equal((await api(null, 'GET', '/status')).status, 401)
  assert.equal((await api(A.board, 'GET', '/status')).status, 403)
  const plain = await api(A.plain, 'GET', '/status')
  assert.equal(plain.status, 403)
  assert.equal(plain.body.kind, 'not_entitled')
  const s = await api(A.olga, 'GET', '/status')
  assert.equal(s.status, 200)
  assert.equal(s.body.configured, true)
  assert.equal(s.body.connection.state, 'not_connected')
  assert.ok(s.body.templates.some(t => t.id === 'classic'))
})

test('2-7 connect: official dialog, one-time state, Pages discovered without ids or tokens', async () => {
  const start = await api(A.olga, 'POST', '/connect')
  const u = new URL(start.body.url)
  assert.equal(u.hostname, 'www.facebook.com')
  assert.equal(u.searchParams.get('client_id'), process.env.META_APP_ID)
  const state = u.searchParams.get('state')
  const wrong = await api(A.olga, 'POST', '/connect/complete', { code: fake.issueCode(`u_${TAG}_olga`), state: 'forged-state-value' })
  assert.equal(wrong.status, 400)
  const stolen = await api(A.other, 'POST', '/connect/complete', { code: fake.issueCode(`u_${TAG}_olga`), state })
  assert.equal(stolen.status, 400, 'a state is bound to the agent who started it')
  const ok = await api(A.olga, 'POST', '/connect/complete', { code: fake.issueCode(`u_${TAG}_olga`), state })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.connection.state, 'active')
  assert.equal(ok.body.connection.facebookName, 'Olga Test')
  assert.equal(ok.body.pages.length, 2, 'both Pages found, following Graph paging')
  const [main, analytics] = [ok.body.pages.find(p => p.name === 'Olga Homes Malta'), ok.body.pages.find(p => p.name === 'Olga Analytics Only')]
  assert.equal(main.canPublish, true)
  assert.equal(main.isDefault, true)
  assert.equal(main.enabled, true)
  assert.equal(analytics.canPublish, false)
  assert.match(analytics.statusReason, /role on this Page/)
  const replay = await api(A.olga, 'POST', '/connect/complete', { code: fake.issueCode(`u_${TAG}_olga`), state })
  assert.equal(replay.status, 400, 'state is single use')
  // Tokens exist only as AES-GCM ciphertext.
  const { rows: creds } = await q(`SELECT c.ciphertext FROM agent_facebook_credentials c`)
  for (const t of fake.S.tokens.keys()) for (const c of creds) assert.ok(!c.ciphertext.includes(t))
  assert.ok(creds.every(c => c.ciphertext.startsWith('v1.')))
  A.olga.page = main.id
  A.olga.analytics = analytics.id
  const blocked = await api(A.olga, 'PATCH', `/pages/${analytics.id}`, { isDefault: true })
  assert.equal(blocked.status, 409)
})

test('13 isolation: another agent can neither see nor use Olga\'s Page', async () => {
  const s = await api(A.other, 'GET', '/status')
  assert.equal(s.body.pages.length, 0)
  const r = await api(A.other, 'POST', '/publications', { propertyId: P.others.id, pageRowId: A.olga.page, message: 'x', images: [], idempotencyKey: key() })
  assert.equal(r.status, 404)
  const d = await api(A.other, 'GET', `/properties/${P.main.id}/draft`)
  assert.equal(d.status, 403, 'only the listing agent may publish a listing')
})

test('8-13 draft: prefilled ad from real listing data, eligibility and image rights', async () => {
  const d = await api(A.olga, 'GET', `/properties/${P.main.id}/draft`)
  assert.equal(d.status, 200)
  assert.deepEqual(d.body.blockers, [])
  assert.match(d.body.message, /2-BEDROOM APARTMENT FOR RENT — SLIEMA/)
  assert.match(d.body.message, /Bright apartment close to the promenade/)
  assert.match(d.body.link, /^https:\/\/www\.2906\.estate\/swipe\//)
  assert.equal(d.body.images.length, 4)
  assert.ok(!/Olga|ARGUS/.test(d.body.message), 'no agent or ARGUS branding unless chosen')
  const de = await api(A.olga, 'GET', `/properties/${P.main.id}/draft?language=de&emojis=0&contact=1`)
  assert.match(de.body.message, /ZU VERMIETEN/)
  assert.match(de.body.message, /Kontakt: olga/)
  assert.equal((await api(A.olga, 'GET', `/properties/${P.nofb.id}/draft`)).body.blockers[0].code, 'no_fb')
  assert.equal((await api(A.olga, 'GET', `/properties/${P.rented.id}/draft`)).body.blockers[0].code, 'unavailable')
  const sc = await api(A.olga, 'GET', `/properties/${P.scraped.id}/draft`)
  assert.equal(sc.body.imagesAllowed, false)
  assert.equal(sc.body.images.length, 0)
})

test('14-18 publish: multi-photo post confirmed by Meta, idempotent, real post id and permalink', async () => {
  const d = await api(A.olga, 'GET', `/properties/${P.main.id}/draft`)
  const images = d.body.images.slice(0, 3).map(i => i.url).reverse()
  const message = d.body.message.replace('Contact us to arrange a viewing.', 'Message me to arrange a viewing this week.')
  const k = key()
  const body = { propertyId: P.main.id, pageRowId: A.olga.page, message, images, includeLink: true, idempotencyKey: k, language: 'en', templateId: 'classic' }
  const foreign = await api(A.olga, 'POST', '/publications', { ...body, images: ['https://evil.example/x.jpg'], idempotencyKey: key() })
  assert.equal(foreign.status, 400, 'only the listing\'s own photos can be attached')
  const leak = await api(A.olga, 'POST', '/publications', { ...body, message: message + '\nOwner: +356 9912 3456', idempotencyKey: key() })
  assert.equal(leak.status, 400)
  const c1 = await api(A.olga, 'POST', '/publications', body)
  assert.equal(c1.status, 200)
  assert.equal(c1.body.publication.state, 'queued')
  assert.equal(c1.body.publication.publicationType, 'multi_photo')
  const c2 = await api(A.olga, 'POST', '/publications', body)
  assert.equal(c2.body.replayed, true)
  assert.equal(c2.body.publication.id, c1.body.publication.id, 'a double click returns the same publication')
  const id = c1.body.publication.id
  const before = livePosts().length
  const out = await publisher.run(id)
  assert.equal(out.state, 'published')
  assert.equal(livePosts().length, before + 1)
  const post = fake.S.posts.get(out.postId)
  assert.equal(post.media.length, 3)
  assert.deepEqual(post.media.map(m => fake.S.photos.get(m).url), images, 'photo order is kept')
  assert.match(post.message, /Message me to arrange a viewing this week\./)
  assert.match(post.message, /utm_source=facebook/)
  assert.equal(out.permalinkUrl, post.permalink, 'permalink comes from Meta')
  assert.equal((await publisher.run(id)).state, 'published', 're-running the job does not post again')
  assert.equal(livePosts().length, before + 1)
  const hist = await api(A.olga, 'GET', '/publications')
  assert.equal(hist.body.publications[0].id, id)
  assert.equal(hist.body.publications[0].stateLabel, 'Published')
  assert.equal((await api(A.other, 'GET', '/publications')).body.publications.length, 0)
  A.olga.firstPub = id
})

test('19 duplicate protection: same listing and Page needs explicit confirmation', async () => {
  const d = await api(A.olga, 'GET', `/properties/${P.main.id}/draft`)
  const body = { propertyId: P.main.id, pageRowId: A.olga.page, message: d.body.message, images: [], includeLink: true, idempotencyKey: key() }
  const r = await api(A.olga, 'POST', '/publications', body)
  assert.equal(r.status, 409)
  assert.equal(r.body.kind, 'duplicate')
  assert.equal(r.body.existing[0].id, A.olga.firstPub)
  const ok = await api(A.olga, 'POST', '/publications', { ...body, confirmDuplicate: true })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.publication.publicationType, 'link')
  A.olga.linkPub = ok.body.publication.id
})

test('17 lost response: the post is found on the Page instead of being posted twice', async () => {
  fake.fail(({ method, path }) => method === 'POST' && path === `${TAG}101/feed`, 'drop-after')
  const before = livePosts().length
  const r1 = await publisher.run(A.olga.linkPub)
  assert.equal(r1.state, 'reconciling')
  assert.equal(livePosts().length, before + 1, 'Meta did create the post')
  await q(`UPDATE agent_facebook_publications SET next_attempt_at=NOW() WHERE id=$1`, [A.olga.linkPub])
  const r2 = await publisher.run(A.olga.linkPub)
  assert.equal(r2.state, 'published')
  assert.equal(livePosts().length, before + 1, 'and ARGUS did not post it a second time')
  assert.ok(fake.S.posts.get(r2.postId).link, 'a text post carries the link for the preview')
})

test('rate limit waits for Meta; a bad photo fails cleanly without a partial post', async () => {
  const d = await api(A.olga, 'GET', `/properties/${P.second.id}/draft`)
  const one = await api(A.olga, 'POST', '/publications', { propertyId: P.second.id, pageRowId: A.olga.page, message: d.body.message, images: [d.body.images[0].url], idempotencyKey: key() })
  fake.fail(({ method, path, form }) => method === 'POST' && path === `${TAG}101/photos` && form.published === 'true', { status: 400, body: { error: { code: 32, message: 'Page request limit reached' } }, headers: { 'x-business-use-case-usage': JSON.stringify({ [`${TAG}101`]: [{ type: 'pages', estimated_time_to_regain_access: 5 }] }) } })
  const r1 = await publisher.run(one.body.publication.id)
  assert.equal(r1.state, 'queued')
  assert.ok(new Date(r1.nextAttemptAt).getTime() > Date.now() + 4 * 60_000, 'waits for Meta\'s estimate')
  assert.equal((await publisher.run(one.body.publication.id)).state, 'queued', 'not claimed before it is due')
  await q(`UPDATE agent_facebook_publications SET next_attempt_at=NOW() WHERE id=$1`, [one.body.publication.id])
  const r2 = await publisher.run(one.body.publication.id)
  assert.equal(r2.state, 'published')
  assert.equal(r2.publicationType, 'photo')

  const before = livePosts().length
  const multi = await api(A.olga, 'POST', '/publications', { propertyId: P.second.id, pageRowId: A.olga.page, message: d.body.message + ' ', images: d.body.images.slice(0, 3).map(i => i.url), idempotencyKey: key(), confirmDuplicate: true })
  let n = 0
  fake.fail(({ method, path, form }) => method === 'POST' && path === `${TAG}101/photos` && form.published === 'false' && ++n === 2, { status: 400, body: { error: { code: 324, message: 'Missing or invalid image file' } } })
  const bad = await publisher.run(multi.body.publication.id)
  assert.equal(bad.state, 'failed')
  assert.match(bad.error.message, /photo 2 of 3/)
  assert.equal(livePosts().length, before, 'nothing was published')
})

test('edit and delete: only ARGUS posts, delete needs confirmation', async () => {
  const id = A.olga.firstPub
  const ed = await api(A.olga, 'PATCH', `/publications/${id}`, { message: 'Updated text for the apartment in Sliema.' })
  assert.equal(ed.status, 200)
  assert.equal(fake.S.posts.get(ed.body.publication.postId).message, 'Updated text for the apartment in Sliema.')
  assert.ok(ed.body.publication.editedAt)
  assert.equal((await api(A.other, 'PATCH', `/publications/${id}`, { message: 'hijack' })).status, 404)
  assert.equal((await api(A.olga, 'DELETE', `/publications/${id}`)).status, 400)
  const del = await api(A.olga, 'DELETE', `/publications/${id}`, { confirm: true })
  assert.equal(del.body.publication.state, 'removed')
  assert.equal(fake.S.posts.get(del.body.publication.postId).deleted, true)
  const chk = await api(A.olga, 'POST', `/publications/${A.olga.linkPub}/check`)
  assert.equal(chk.body.publication.state, 'published')
  fake.S.posts.get(chk.body.publication.postId).deleted = true
  const gone = await api(A.olga, 'POST', `/publications/${A.olga.linkPub}/check`)
  assert.equal(gone.body.publication.state, 'removed', 'a post deleted on Facebook shows as removed')
})

test('20 expired or revoked login: reconnect required, then reconnect and retry', async () => {
  fake.expireUserTokens(`u_${TAG}_olga`)
  const d = await api(A.olga, 'GET', `/properties/${P.scraped.id}/draft`)
  const r = await api(A.olga, 'POST', '/publications', { propertyId: P.scraped.id, pageRowId: A.olga.page, message: d.body.message, images: [], idempotencyKey: key() })
  const out = await publisher.run(r.body.publication.id)
  assert.equal(out.state, 'reconnect_required')
  const s = await api(A.olga, 'GET', '/status')
  assert.equal(s.body.connection.state, 'reconnect_required')
  const blocked = await api(A.olga, 'POST', '/publications', { propertyId: P.second.id, pageRowId: A.olga.page, message: 'x', images: [], idempotencyKey: key(), confirmDuplicate: true })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.kind, 'auth')
  const re = await connectAs(A.olga, `u_${TAG}_olga`)
  assert.equal(re.body.connection.state, 'active')
  assert.equal(re.body.pages.find(p => p.id === A.olga.page).isDefault, true, 'settings survive a reconnect')
  const retry = await api(A.olga, 'POST', `/publications/${r.body.publication.id}/retry`)
  assert.equal(retry.body.publication.state, 'queued')
  assert.equal((await publisher.run(r.body.publication.id)).state, 'published')
})

test('optional automation: off by default, opt-in only, idempotent, stops on disconnect', async () => {
  assert.equal((await autoPublish.scan()).queued, 0, 'nothing happens while the agent has not opted in')
  const on = await api(A.olga, 'PATCH', '/preferences', { autoPublishEnabled: true })
  assert.equal(on.body.preferences.autoPublishEnabled, true)
  await api(A.olga, 'PATCH', `/pages/${A.olga.page}`, { autoPublish: true })
  assert.equal((await autoPublish.scan()).queued, 0, 'listings verified before opting in are not posted')
  P.fresh = await property(A.olga, 'fresh', { verification_status: 'verified', verified_at: new Date(Date.now() + 1000) })
  await q(`UPDATE properties SET verified_at = NOW() + INTERVAL '1 second' WHERE id=$1`, [P.fresh.id])
  const s1 = await autoPublish.scan({ now: new Date(Date.now() + 5000) })
  assert.equal(s1.queued, 1)
  const s2 = await autoPublish.scan({ now: new Date(Date.now() + 5000) })
  assert.equal(s2.queued, 0, 'a retried scan does not queue it again')
  const { rows: [auto] } = await q(`SELECT * FROM agent_facebook_publications WHERE property_id=$1 AND trigger='auto_verified'`, [P.fresh.id])
  await q(`UPDATE agent_facebook_publications SET next_attempt_at=NOW() WHERE id=$1`, [auto.id])
  assert.equal((await publisher.run(auto.id)).state, 'published')

  P.fresh2 = await property(A.olga, 'fresh2', { verification_status: 'verified' })
  await q(`UPDATE properties SET verified_at = NOW() + INTERVAL '1 second' WHERE id=$1`, [P.fresh2.id])
  assert.equal((await autoPublish.scan({ now: new Date(Date.now() + 5000) })).queued, 1)
  const { rows: [pending] } = await q(`SELECT * FROM agent_facebook_publications WHERE property_id=$1 AND trigger='auto_verified'`, [P.fresh2.id])

  // 21-22: disconnect stops future automated jobs immediately.
  const posts = livePosts().length
  const dc = await api(A.olga, 'POST', '/disconnect')
  assert.equal(dc.body.disconnected, true)
  assert.equal(dc.body.revokedAtMeta, true)
  assert.equal(dc.body.status.connection.state, 'not_connected')
  assert.equal((await pubRow(pending.id)).state, 'cancelled')
  await q(`UPDATE agent_facebook_publications SET state='queued', next_attempt_at=NOW() WHERE id=$1`, [pending.id])   // even a stray job
  assert.equal((await publisher.run(pending.id)).state, 'cancelled')
  assert.equal(livePosts().length, posts)
  assert.equal((await autoPublish.scan({ now: new Date(Date.now() + 5000) })).queued, 0)
  const { rows: left } = await q(
    `SELECT 1 FROM agent_facebook_credentials c WHERE c.id IN (SELECT user_credential_id FROM agent_facebook_connections WHERE agent_id=$1
       UNION SELECT page_credential_id FROM agent_facebook_pages WHERE agent_id=$1)`, [A.olga.id])
  assert.equal(left.length, 0, 'credentials are deleted on disconnect')
  const hist = await api(A.olga, 'GET', '/publications')
  assert.ok(hist.body.publications.length >= 5, 'publication history is kept')
})

test('Meta data-deletion callback: signed, removes the connection, returns a status code', async () => {
  await connectAs(A.olga, `u_${TAG}_olga`)
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: `u_${TAG}_olga`, issued_at: Math.floor(Date.now() / 1000) })).toString('base64url')
  const sig = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(payload).digest('base64url')
  const bad = await realFetch(`${base}/api/facebook-pages-meta/data-deletion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `signed_request=x${sig}.${payload}` })
  assert.equal(bad.status, 400)
  const r = await realFetch(`${base}/api/facebook-pages-meta/data-deletion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `signed_request=${sig}.${payload}` })
  const j = await r.json()
  assert.match(j.confirmation_code, /^[0-9a-f]{24}$/)
  assert.match(j.url, /integrations\/facebook\/deletion\?code=/)
  assert.equal((await api(A.olga, 'GET', '/status')).body.connection.state, 'not_connected')
  const st = await (await realFetch(`${base}/api/facebook-pages-meta/data-deletion/${j.confirmation_code}`)).json()
  assert.equal(st.status, 'completed')
})

test('audit trail: connects, publishes and disconnects are logged without secrets', async () => {
  const { rows } = await q(`SELECT action_type, details::text d FROM agent_activity_log WHERE actor_agent_id=$1`, [A.olga.id])
  const types = new Set(rows.map(r => r.action_type))
  for (const t of ['facebook_connect', 'facebook_reconnect', 'facebook_publish_requested', 'facebook_published', 'facebook_post_edited', 'facebook_post_deleted', 'facebook_disconnect', 'facebook_auto_publish_on']) assert.ok(types.has(t), `missing audit ${t}`)
  for (const r of rows) for (const t of fake.S.tokens.keys()) assert.ok(!r.d.includes(t))
})
