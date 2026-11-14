'use strict'
// Unit tests: no database, no network (Meta is the in-memory fake).
//   NO_DB=1 ARGUS_BASE_DIR=<production backend copy> node --test test/facebookPages.unit.test.js
process.env.NO_DB = '1'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { load } = require('./helpers/overlay')
const { createFakeMeta } = require('./helpers/fakeMeta')

const settings = load('services/facebookPages/settings')
const secrets = load('services/facebookPages/secrets')
const graph = load('services/facebookPages/graph')
const content = load('services/facebookPages/content')
const meta = load('routes/facebookPagesMeta')

test('settings: names what is missing, never values; version is configurable', () => {
  assert.deepEqual(settings.missing(), [])
  const keep = process.env.META_APP_SECRET
  delete process.env.META_APP_SECRET
  assert.deepEqual(settings.missing(), ['META_APP_SECRET'])
  process.env.META_APP_SECRET = keep
  process.env.META_GRAPH_VERSION = 'v26.0'
  assert.equal(settings.graphVersion(), 'v26.0')
  process.env.META_GRAPH_VERSION = 'latest'
  assert.throws(() => settings.graphVersion())
  process.env.META_GRAPH_VERSION = 'v27.0'
})

test('secrets: AES-256-GCM round trip, tamper and purpose binding are refused', () => {
  const env = secrets.encrypt('EAAtokenvalue123', 'page')
  assert.match(env, /^v1\./)
  assert.ok(!env.includes('EAAtokenvalue123'))
  assert.equal(secrets.decrypt(env, 'page'), 'EAAtokenvalue123')
  assert.throws(() => secrets.decrypt(env, 'user'), /auth|Unsupported/i)
  const parts = env.split('.'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA')
  assert.throws(() => secrets.decrypt(parts.join('.'), 'page'))
  assert.notEqual(secrets.encrypt('same', 'user'), secrets.encrypt('same', 'user'))
  assert.equal(secrets.redact('x?access_token=EAAsecret&client_secret=abc code=XYZ'), 'x?access_token=[redacted]&client_secret=[redacted] code=[redacted]')
})

test('graph: tokens travel in the Authorization header with appsecret_proof, never in the URL', async () => {
  const fake = createFakeMeta({ appId: '1234567890', appSecret: 'test-app-secret-not-real', redirectUri: settings.read().redirectUri })
  fake.addUser('u1', { name: 'Olga', pages: [{ id: '111', name: 'Olga Homes', tasks: ['CREATE_CONTENT', 'MANAGE'] }] })
  globalThis.fetch = fake.fetch
  const code = fake.issueCode('u1')
  const short = await graph.exchangeCode(code)
  const long = await graph.exchangeLongLived(short.access_token)
  const pages = await graph.accounts(long.access_token)
  assert.equal(pages.length, 1)
  const post = await graph.publishFeed(pages[0].access_token, '111', { message: 'Hello', link: 'https://example.com/x' })
  assert.match(post.postId, /^111_/)
  for (const c of fake.S.calls.filter(c => c.path !== 'oauth/access_token')) {
    assert.ok(c.hasBearer, `${c.path} must use the Authorization header`)
    assert.ok(!/access_token=/.test(c.url), `${c.path} must not carry a token in the URL`)
    assert.match(c.url, /appsecret_proof=[0-9a-f]{64}/)
  }
  await assert.rejects(graph.exchangeCode(code), e => e instanceof graph.GraphError)   // codes are single use
})

test('graph: error classification maps Meta codes to actionable kinds', () => {
  const k = (e, s = 400) => graph.classify(e, s, { get: () => null }).kind
  assert.equal(k({ code: 190, error_subcode: 463 }), 'auth')
  assert.equal(k({ code: 190, error_subcode: 460 }), 'auth')
  assert.equal(k({ code: 10 }), 'permission')
  assert.equal(k({ code: 200 }), 'permission')
  assert.equal(k({ code: 4 }), 'rate_limit')
  assert.equal(k({ code: 80001 }), 'rate_limit')
  assert.equal(k({ code: 368 }), 'policy')
  assert.equal(k({ code: 506 }), 'duplicate')
  assert.equal(k({ code: 1609005 }), 'invalid_link')
  assert.equal(k({ code: 324 }), 'invalid_media')
  assert.equal(k({ code: 100, error_subcode: 33, message: 'does not exist' }), 'not_found')
  assert.equal(k({ code: 2 }), 'transient')
  const rl = graph.classify({ code: 32 }, 400, { get: h => (h === 'x-business-use-case-usage' ? JSON.stringify({ 111: [{ type: 'pages', estimated_time_to_regain_access: 7 }] }) : null) })
  assert.equal(rl.retryAfterSec, 420)
  const auth = graph.classify({ code: 190, message: 'token EAAxxxxxxxxxxxxxxxxxxxxxxxxxx expired' }, 400)
  assert.ok(!auth.userMessage.includes('EAA'))
  assert.ok(!auth.detail.includes('EAAxxxxxxxxxxxxxxxxxxxxxxxx'))
})

test('graph: a lost answer to a non-idempotent call is flagged uncertain', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(graph.publishFeed('EAApagetoken', '111', { message: 'x' }), e => e.kind === 'transient' && e.uncertain === true)
  await assert.rejects(graph.getPost('EAApagetoken', '111_1'), e => e.kind === 'transient' && e.uncertain === false)
})

test('graph: login dialog uses state, the configured redirect and minimal scopes (or config_id)', () => {
  const u = new URL(graph.dialogUrl({ state: 'abc' }))
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/v27.0/dialog/oauth')
  assert.equal(u.searchParams.get('state'), 'abc')
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.deepEqual(u.searchParams.get('scope').split(','), ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management'])
  process.env.META_LOGIN_CONFIG_ID = '999'
  const v = new URL(graph.dialogUrl({ state: 'abc', rerequest: true }))
  assert.equal(v.searchParams.get('config_id'), '999')
  assert.equal(v.searchParams.get('scope'), null)
  assert.equal(v.searchParams.get('auth_type'), 'rerequest')
  delete process.env.META_LOGIN_CONFIG_ID
})

const FACTS = { id: 1, ref: '2906-1', type: 'apartment', town: 'Sliema', island: 'Malta', bedrooms: 2, bathrooms: 2, sizeSqm: null, rent: 1850, sale: null, shortlet: false, availableStatus: 'available', availableDate: null, availableUntil: null, featureTags: ['air_conditioning', 'furnished'], petsAllowed: null, balcony: null, parking: null, description: 'SHORT HEADLINE\n\nBright apartment close to the promenade, with an open-plan living area and two comfortable bedrooms.' }

test('content: classic template uses only real facts', () => {
  const m = content.render({ facts: FACTS, link: 'https://2906.estate/property/x', language: 'en' })
  assert.match(m, /^🏡 2-BEDROOM APARTMENT FOR RENT — SLIEMA/)
  assert.match(m, /📍 Sliema, Malta/)
  assert.match(m, /💶 €1,850 \/ month/)
  assert.match(m, /🛏 2 Bedrooms/)
  assert.match(m, /❄️ Air-conditioning/)
  assert.match(m, /🛋 Furnished/)
  assert.match(m, /Bright apartment close to the promenade/)
  assert.match(m, /🔗 https:\/\/2906\.estate\/property\/x/)
  assert.ok(!/m²|Parking|Pets|ARGUS/i.test(m), 'no invented or branded lines')
  const plain = content.render({ facts: { ...FACTS, featureTags: [], description: '' }, emojis: false })
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(plain))
  assert.ok(!/Bright/.test(plain))
})

test('content: Maltese and German templates, custom placeholders, CTA and contact', () => {
  assert.match(content.render({ facts: FACTS, language: 'de' }), /2-ZIMMER-WOHNUNG ZU VERMIETEN — SLIEMA/)
  assert.match(content.render({ facts: FACTS, language: 'mt' }), /GĦALL-KIRI/)
  const c = content.render({ facts: FACTS, custom: '{{headline}}\n{{price}} {{unknown}}\n{{cta}}', cta: 'Call me today.' })
  assert.equal(c, '2-BEDROOM APARTMENT FOR RENT — SLIEMA\n€1,850 / month\nCall me today.')
  const withContact = content.render({ facts: FACTS, includeContact: true, agent: { display_name: 'Olga', public_phone: '+356 7900 0000' } })
  assert.match(withContact, /📞 Contact: Olga · \+356 7900 0000/)
})

test('content: validation allows the agent\'s own number, refuses other numbers, addresses and e-mails', () => {
  const agent = { public_phone: '+356 7900 0000', email: 'olga@agency.example' }
  assert.equal(content.validateMessage('Call +356 7900 0000 for a viewing', { agent }).ok, true)
  assert.equal(content.validateMessage('Call 7900 0000', { agent }).ok, true)
  assert.equal(content.validateMessage('Owner: +356 9912 3456', { agent }).ok, false)
  assert.equal(content.validateMessage('Flat at 66, Triq Sir Frederick, Gzira', { agent }).ok, false)
  assert.equal(content.validateMessage('Write to owner@mail.example', { agent }).ok, false)
  assert.equal(content.validateMessage('Write to olga@agency.example', { agent }).ok, true)
  assert.equal(content.validateMessage('€1,850 / month, 2 bedrooms, ref 2906-1234', { agent }).ok, true)
  assert.equal(content.validateMessage('', { agent }).ok, false)
  assert.equal(content.validateMessage('x'.repeat(6000), { agent }).ok, false)
})

test('meta callbacks: signed_request is verified with the app secret', () => {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'u1', issued_at: 1 })).toString('base64url')
  const sig = crypto.createHmac('sha256', 'test-app-secret-not-real').update(payload).digest('base64url')
  assert.equal(meta.parseSignedRequest(`${sig}.${payload}`).user_id, 'u1')
  const bad = crypto.createHmac('sha256', 'wrong').update(payload).digest('base64url')
  assert.equal(meta.parseSignedRequest(`${bad}.${payload}`), null)
  assert.equal(meta.parseSignedRequest('garbage'), null)
})
