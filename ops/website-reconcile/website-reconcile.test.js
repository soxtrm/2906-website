'use strict'
// Website reconcile against a throwaway PostgreSQL with the live SCHEMA only (no rows). Synthetic listings.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
const errors = []
function stub(rel, exports) { const f = require.resolve(R(rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, debug: noop, error: (m, d) => errors.push([m, d]) })
const syncCalls = []
stub('services/websiteSync.js', {
  syncPropertyToWebsite: async id => {
    syncCalls.push(id)
    const p = (await pool.query(`SELECT ref, longlet_price, images FROM properties WHERE id = $1`, [id])).rows[0]
    if (!p || p.ref === 'T-NOTREADY') return { ok: false, reason: 'not_ready' }
    await pool.query(`UPDATE website_properties SET status = 'available', price = $2, is_published = TRUE, updated_at = NOW() WHERE property_reference = $1`, [p.ref, p.longlet_price])
    return { ok: true }
  },
})
const W = require(R('services/websiteReconcile.js'))

async function insertRow(table, row) {
  const cols = (await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [table])).rows
  const full = { ...row }
  for (const { column_name: c, data_type: t } of cols) {
    if (c in full) continue
    full[c] = /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false : /json/.test(t) ? '{}' : t === 'ARRAY' ? '{}' : /timestamp|date/.test(t) ? new Date() : t === 'uuid' ? require('crypto').randomUUID() : 'x'
  }
  const keys = Object.keys(full)
  await pool.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')})`, keys.map(k => full[k]))
}
const OLD = new Date('2026-09-01T10:00:00Z')
let pid = 950000
async function listing(ref, argus, web, { ownerReply = null, confirmed = null } = {}) {
  pid++
  let ownerId = null
  if (ownerReply !== undefined && argus) {
    ownerId = (await pool.query(`INSERT INTO owner_contacts (phone_normalized, name, last_reply_at) VALUES ($1, 'Test', $2) RETURNING id`, ['3569' + pid, ownerReply])).rows[0].id
  }
  if (argus) await insertRow('properties', { id: pid, ref, town: 'Sliema', property_type: 'apartment', bedrooms: 2, longlet_price: argus.price ?? 1500, available_status: argus.status,
    system_online: true, published: argus.published !== false, images: '[]', owner_id: ownerId, last_confirmed_available_at: confirmed })
  if (web) await insertRow('website_properties', { title: ref, slug: ref.toLowerCase(), price: web.price ?? 1500, status: web.status || 'available', is_published: web.published !== false,
    property_reference: ref, location: 'Sliema', category: 'letting', price_type: 'month', created_at: OLD, updated_at: OLD })
}
const web = async ref => (await pool.query(`SELECT status, is_published, price::numeric AS price, updated_at FROM website_properties WHERE property_reference = $1`, [ref])).rows[0]
const days = n => new Date(Date.now() - n * 86400000)

test.before(async () => {
  await listing('T-OK', { status: 'available' }, {})
  await listing('T-RENTED', { status: 'rented' }, {})
  await listing('T-RENTED-OK', { status: 'rented' }, { status: 'rented' })
  await listing('T-ARCHIVED', { status: 'archived' }, {})
  await listing('T-NOTAVAIL', { status: 'not_available' }, {})
  await listing('T-UNPUBLISHED', { status: 'available', published: false }, {})
  await listing('T-PRICE', { status: 'available', price: 1650 }, { price: 1500 })
  await listing('T-BACK', { status: 'available_confirmed' }, { status: 'rented' })
  await listing('T-REVIEW-SILENT', { status: 'pending_check' }, {}, { ownerReply: days(40), confirmed: days(50) })
  await listing('T-REVIEW-REPLIED', { status: 'pending_check' }, {}, { ownerReply: days(3) })
  await listing('T-REVIEW-CONFIRMED', { status: 'pending_check' }, {}, { ownerReply: null, confirmed: days(5) })
  await listing('T-UPCOMING', { status: 'upcoming' }, {})
  await listing('T-MARKET-ONLY', null, {})                                    // no ARGUS listing behind it
  await listing('T-NEVER-ON-SITE', { status: 'available' }, null)             // available in ARGUS, never on the website
  await listing('T-HIDDEN-BY-HAND', { status: 'available' }, { published: false })   // someone took it off
})
test.after(async () => { await pool.end() })

test('report only: nothing is written', async () => {
  const s = await W.reconcile({ apply: false })
  assert.deepEqual([s.refresh, s.markRented, s.hide, s.show], [2, 1, 4, 0], JSON.stringify(s))
  assert.equal(s.keptUnderReview, 2)
  assert.equal(s.applied, false)
  assert.equal((await web('T-RENTED')).status, 'available')
  assert.equal((await pool.query(`SELECT count(*)::int n FROM website_reconcile_log`)).rows[0].n, 0)
})

test('an unattended run that would change too much changes nothing and says so', async () => {
  const s = await W.reconcile({ apply: true, maxChanges: 3 })
  assert.equal(s.held, true); assert.equal(s.applied, false)
  assert.equal((await web('T-RENTED')).status, 'available')
  assert.ok(errors.some(e => /too many changes/.test(e[0])))
})

test('apply: rented shows as rented, gone and unverified are hidden, differences are refreshed', async () => {
  const s = await W.reconcile({ apply: true, maxChanges: null })
  assert.equal(s.applied, true); assert.equal(s.failed, 0)
  assert.deepEqual([(await web('T-RENTED')).status, (await web('T-RENTED')).is_published], ['rented', true], 'rented stays reachable, shown as rented')
  for (const ref of ['T-ARCHIVED', 'T-NOTAVAIL', 'T-UNPUBLISHED', 'T-REVIEW-SILENT']) assert.equal((await web(ref)).is_published, false, ref)
  assert.equal((await web('T-REVIEW-SILENT')).status, 'available', 'a missing confirmation never becomes "rented"')
  for (const ref of ['T-REVIEW-REPLIED', 'T-REVIEW-CONFIRMED']) assert.deepEqual([(await web(ref)).is_published, (await web(ref)).status], [true, 'available'], ref + ' has a recent sign of life')
  assert.equal(Number((await web('T-PRICE')).price), 1650, 'ARGUS price wins')
  assert.equal((await web('T-BACK')).status, 'available')
  assert.equal((await web('T-UPCOMING')).is_published, true)
})

test('it leaves alone what is not its business', async () => {
  assert.deepEqual([(await web('T-MARKET-ONLY')).is_published, (await web('T-MARKET-ONLY')).status], [true, 'available'], 'no ARGUS listing is not a reason to hide')
  assert.equal(await web('T-NEVER-ON-SITE'), undefined, 'available in ARGUS is not a permission to publish')
  assert.equal((await web('T-HIDDEN-BY-HAND')).is_published, false, 'a listing someone else took off stays off')
  assert.equal((await pool.query(`SELECT count(*)::int n FROM properties`)).rows[0].n, 14, 'no listing deleted')
  assert.equal((await pool.query(`SELECT count(*)::int n FROM website_properties`)).rows[0].n, 14, 'no website row deleted')
})

test('the public "updated" time moves only where the content changed', async () => {
  for (const ref of ['T-OK', 'T-RENTED', 'T-RENTED-OK', 'T-ARCHIVED', 'T-REVIEW-SILENT', 'T-REVIEW-REPLIED', 'T-MARKET-ONLY', 'T-UPCOMING']) {
    assert.equal(new Date((await web(ref)).updated_at).getTime(), OLD.getTime(), ref + ' keeps its time')
  }
  assert.ok(new Date((await web('T-PRICE')).updated_at) > OLD, 'a new price is a real update')
})

test('every change is logged with before and after', async () => {
  const rows = (await pool.query(`SELECT property_reference ref, action, reason, argus_status, before_state, after_state FROM website_reconcile_log ORDER BY id`)).rows
  const by = a => rows.filter(r => r.action === a).map(r => r.ref).sort()
  assert.deepEqual(by('rented'), ['T-RENTED'])
  assert.deepEqual(by('hide'), ['T-ARCHIVED', 'T-NOTAVAIL', 'T-REVIEW-SILENT', 'T-UNPUBLISHED'])
  assert.deepEqual(by('refresh'), ['T-BACK', 'T-PRICE'])
  const r = rows.find(x => x.ref === 'T-RENTED')
  assert.deepEqual([r.before_state.status, r.after_state.status, r.argus_status], ['available', 'rented', 'rented'])
})

test('a second run finds nothing to do', async () => {
  const before = (await pool.query(`SELECT count(*)::int n FROM website_reconcile_log`)).rows[0].n
  const s = await W.reconcile({ apply: true })
  assert.deepEqual([s.refresh, s.markRented, s.hide, s.show], [0, 0, 0, 0])
  assert.equal((await pool.query(`SELECT count(*)::int n FROM website_reconcile_log`)).rows[0].n, before)
})

test('a listing this job hid comes back when ARGUS confirms it; one hidden by hand does not', async () => {
  await pool.query(`UPDATE properties SET available_status = 'available_confirmed' WHERE ref IN ('T-REVIEW-SILENT', 'T-ARCHIVED')`)
  const s = await W.reconcile({ apply: true })
  assert.equal(s.show, 2)
  assert.deepEqual([(await web('T-REVIEW-SILENT')).is_published, (await web('T-ARCHIVED')).is_published], [true, true])
  assert.equal((await web('T-HIDDEN-BY-HAND')).is_published, false)
  const again = await W.reconcile({ apply: true })
  assert.equal(again.show + again.hide + again.refresh + again.markRented, 0)
})

test('a listing the website cannot take yet is counted as failed, not forced', async () => {
  await listing('T-NOTREADY', { status: 'available', price: 900 }, { price: 800 })
  const s = await W.reconcile({ apply: true })
  assert.equal(s.failed, 1)
  assert.equal(Number((await web('T-NOTREADY')).price), 800)
})
