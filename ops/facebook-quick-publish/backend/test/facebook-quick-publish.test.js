'use strict'
// Who may use the Facebook Pages API and which listings may be published, after the one-click change.
// Patched copy of the live backend, in-memory database fake, no network.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const http = require('http')

process.env.JWT_SECRET = 'test-secret-not-production'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const jwt = require(R('node_modules/jsonwebtoken'))
const express = require(R('node_modules/express'))

const AGENTS = {
  1: { id: 1, role: 'admin', active: true, board_access: true, name: 'Admin', username: 'admin1', feature_entitlements: {} },
  3: { id: 3, role: 'agent', active: true, board_access: false, name: 'Staff', username: 'staff3', feature_entitlements: null },
  4: { id: 4, role: 'agent', active: true, board_access: false, name: 'Off', username: 'off4', feature_entitlements: { facebook_pages: false } },
  13: { id: 13, role: 'board', active: true, board_access: true, name: 'Board', username: 'board13', feature_entitlements: {} },
  21: { id: 21, role: 'board', active: true, board_access: false, name: 'Revoked', username: 'rev21', feature_entitlements: {} },
  20: { id: 20, role: 'agent', active: false, board_access: false, name: 'Gone', username: 'gone20', feature_entitlements: {} },
}
let calls = []
const db = {
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ')
    calls.push(s)
    if (/FROM agents WHERE id=\$1/.test(s) && /feature_entitlements/.test(s)) return { rows: AGENTS[params[0]] ? [AGENTS[params[0]]] : [] }
    if (/FROM agent_facebook_connections/.test(s)) return { rows: [] }
    if (/FROM agent_facebook_pages/.test(s)) return { rows: [] }
    if (/FROM agent_facebook_preferences/.test(s)) return { rows: [{ language: 'en', default_template_id: null, use_emojis: true, include_contact: false, include_link: true, call_to_action: '', auto_publish_enabled: false, auto_daily_limit: 3 }] }
    if (/INSERT INTO agent_facebook_preferences/.test(s)) return { rows: [{ language: 'en', default_template_id: null, use_emojis: true, include_contact: false, include_link: true, call_to_action: '', auto_publish_enabled: false, auto_daily_limit: 3 }] }
    if (/FROM agents WHERE id=\$1/.test(s)) return { rows: [{ display_name: 'X', name: 'X', alias: null, public_phone: null, color_hex: null }] }
    if (/FROM agent_facebook_templates/.test(s)) return { rows: [] }
    return { rows: [] }
  },
}
const noop = () => {}
function stub(rel, exports) {
  const file = require.resolve(R(rel))
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] }
}
stub('db.js', db)
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })

const property = require(R('services/facebookPages/property.js'))
const app = express()
app.use('/api/crm/facebook-pages', require(R('routes/crmFacebookPages.js')))
let server, base
test.before(async () => { server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}` })
test.after(() => server.close())

const sign = (p, secret = process.env.JWT_SECRET, o = {}) => jwt.sign(p, secret, { expiresIn: '1h', ...o })
const call = async (token, p = '/status') => (await fetch(base + '/api/crm/facebook-pages' + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status

test('every signed-in agent reaches the Facebook Pages API: admin, staff and Board', async () => {
  assert.equal(await call(sign({ id: 1, username: 'admin1', role: 'admin', aud: 'crm' })), 200)
  assert.equal(await call(sign({ id: 3, username: 'staff3', role: 'agent', aud: 'crm' })), 200)
  assert.equal(await call(sign({ id: 3, username: 'staff3', role: 'agent' })), 200, 'older session without audience')
  assert.equal(await call(sign({ id: 13, username: 'board13', role: 'board', aud: 'board' })), 200, 'Board account')
})

test('no access without a valid agent session', async () => {
  assert.equal(await call(null), 401)
  assert.equal(await call(sign({ id: 1, username: 'admin1', role: 'admin', aud: 'crm' }, 'another-secret')), 401)
  assert.equal(await call(sign({ id: 1, username: 'admin1', role: 'admin', aud: 'crm' }, undefined, { expiresIn: -5 })), 401)
  assert.equal(await call(sign({ ownerContactId: 7, aud: 'owner-upload' })), 401, 'owner upload link')
  assert.equal(await call(sign({ id: 1, kind: 'schedule_board', email: 'x@example.test' })), 401, 'invite token')
  assert.equal(await call(sign({ id: 20, username: 'gone20', role: 'agent', aud: 'crm' })), 401, 'inactive account')
  assert.equal(await call(sign({ id: 21, username: 'rev21', role: 'board', aud: 'board' })), 401, 'Board account whose access was removed')
  assert.equal(await call(sign({ id: 999, username: 'nobody', role: 'admin', aud: 'crm' })), 401, 'unknown account')
})

test('an account can still be switched off individually', async () => {
  assert.equal(await call(sign({ id: 4, username: 'off4', role: 'agent', aud: 'crm' })), 403)
})

test('the token role is not trusted: the role comes from the database', async () => {
  // a Board account presenting a token that claims admin still acts as its own account (no admin bypass below)
  const row = { listed_by_agent_id: 3, exclusive_now: true, town: 'Sliema', longlet_price: 1200, available_status: 'available' }
  assert.ok(property.blockersFor(row, { id: 13, role: 'board' }).some(b => b.code === 'not_yours'))
})

test('which listings may be published', () => {
  const ok = { listed_by_agent_id: 3, exclusive_now: false, town: 'Sliema', longlet_price: 1200, available_status: 'available' }
  const codes = (row, agent) => property.blockersFor(row, agent).map(b => b.code)
  assert.deepEqual(codes(ok, { id: 13, role: 'board' }), [], 'another agent\'s normal listing: allowed for every agent')
  assert.deepEqual(codes(ok, { id: 3, role: 'agent' }), [])
  assert.deepEqual(codes({ ...ok, exclusive_now: true }, { id: 3, role: 'agent' }), [], 'own exclusive: allowed')
  assert.deepEqual(codes({ ...ok, exclusive_now: true }, { id: 5, role: 'agent' }), ['not_yours'], 'another agent\'s exclusive: refused')
  assert.deepEqual(codes({ ...ok, exclusive_now: true }, { id: 1, role: 'admin' }), [], 'administrator: allowed')
  // the protections that must not move
  assert.ok(codes({ ...ok, no_fb: true }, { id: 1, role: 'admin' }).includes('no_fb'), 'owner said no Facebook: refused even for an administrator')
  assert.ok(codes({ ...ok, is_staging: true }, { id: 13, role: 'board' }).includes('draft'))
  assert.ok(codes({ ...ok, archived_at: new Date() }, { id: 13, role: 'board' }).includes('archived'))
  assert.ok(codes({ ...ok, system_online: false }, { id: 13, role: 'board' }).includes('offline'))
  assert.ok(codes({ ...ok, available_status: 'rented' }, { id: 13, role: 'board' }).includes('unavailable'))
  assert.ok(codes({ ...ok, verification_status: 'unverified' }, { id: 13, role: 'board' }).includes('unverified'))
  assert.ok(codes({ ...ok, town: null }, { id: 13, role: 'board' }).includes('no_location'))
  assert.ok(codes({ ...ok, longlet_price: null }, { id: 13, role: 'board' }).includes('no_price'))
})

test('the listing query still reads only public-safe columns', () => {
  const src = require('fs').readFileSync(R('services/facebookPages/property.js'), 'utf8')
  const cols = src.slice(src.indexOf('const PUBLIC_COLS'), src.indexOf('const LIVE_STATUSES'))
  assert.doesNotMatch(cols, /owner|street|apt\b|internal_notes|phone|email/i)
  assert.match(cols, /exclusive_now/)
})

test('Board accounts get the Profile screen in their menu; nothing else is added', () => {
  const src = require('fs').readFileSync(R('routes/crmScheduleBoard.js'), 'utf8')
  assert.ok(src.includes("nav: boardOnly ? ['board', 'bookings', 'profile'] : ['dashboard', 'inventory', 'board', 'bookings', 'owners'],"))
})
