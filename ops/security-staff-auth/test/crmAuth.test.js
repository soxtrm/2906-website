'use strict'
// Runs the REAL auth() from a crm.js (default: the newest repo snapshot) before
// and after apply-crm-auth-fix.js. Needs jsonwebtoken on NODE_PATH.
//   CRM_JS=/path/to/routes/crm.js node --test ops/security-staff-auth/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')
const { patch } = require('../apply-crm-auth-fix')

const FILE = process.env.CRM_JS || path.join(__dirname, '..', '..', 'property-inbox', 'backend', 'routes', 'crm.js')
const SECRET = 'test-secret-not-production'

function extractAuth(src) {
  src = src.replace(/\r\n/g, '\n')
  const start = src.indexOf('function auth(req, res, next) {')
  const end = src.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, 'auth() not found')
  return src.slice(start, end + 2)
}
function load(src) {
  const code = extractAuth(src)
  const db = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) }
  const log = { warn() {}, info() {}, error() {} }
  return new Function('jwt', 'JWT_SECRET', 'db', 'log', `${code}\nreturn auth`)(jwt, SECRET, db, log)
}
function run(auth, token) {
  return new Promise(resolve => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} }
    const res = { status(s) { this.s = s; return this }, json(b) { resolve({ status: this.s, body: b }) } }
    auth(req, res, () => resolve({ status: 200, agent: req.agent }))
  })
}
const sign = (payload, opts = { expiresIn: '1h' }) => jwt.sign(payload, SECRET, opts)
const ownerUpload = sign({ ownerContactId: 42, aud: 'owner-upload' }, { expiresIn: '90d' })
const staff = sign({ id: 7, username: 'kev', role: 'admin', name: 'Kev', aud: 'crm' })
const board = sign({ id: 8, username: 'b', role: 'board', aud: 'board' })
const legacy = sign({ id: 9, username: 'old', role: 'agent' })
const legacyNoId = sign({ username: 'x', role: 'admin' })
const otherAud = sign({ id: 7, role: 'admin', aud: 'owner-portal' })

test('BEFORE the fix: an owner-upload token passes the staff auth() (the vulnerability)', async () => {
  const auth = load(fs.readFileSync(FILE, 'utf8'))
  const r = await run(auth, ownerUpload)
  assert.equal(r.status, 200)
  assert.equal(r.agent.aud, 'owner-upload')
})

test('AFTER the fix: only staff sessions pass', async () => {
  const out = patch(fs.readFileSync(FILE, 'utf8'))
  assert.equal(out.changed, true)
  const auth = load(out.src)
  assert.equal((await run(auth, ownerUpload)).status, 401)
  assert.equal((await run(auth, otherAud)).status, 401)
  assert.equal((await run(auth, legacyNoId)).status, 401)
  assert.equal((await run(auth, null)).status, 401)
  assert.equal((await run(auth, sign({ id: 7, aud: 'crm' }, { expiresIn: -10 }))).status, 401)
  assert.equal((await run(auth, jwt.sign({ id: 7, aud: 'crm' }, 'other-secret'))).status, 401)
  assert.equal((await run(auth, board)).status, 403) // unchanged
  const s = await run(auth, staff)
  assert.equal(s.status, 200); assert.equal(s.agent.id, 7)
  assert.equal((await run(auth, legacy)).status, 200) // pre-audience staff tokens keep working until they expire
})

test('patch is idempotent and refuses unknown shapes', () => {
  const once = patch(fs.readFileSync(FILE, 'utf8')).src
  assert.equal(patch(once).changed, false)
  assert.throws(() => patch('function auth(req, res, next) {\n  next()\n}\n'), /differs from the reviewed snapshot/)
})
