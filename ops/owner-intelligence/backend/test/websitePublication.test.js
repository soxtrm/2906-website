'use strict'
// Kev, 2026-10-31 — CRM → 2906.estate acceptance tests, REAL trigger +
// services/websitePublication.js + services/websiteSync.js on the test DB.
// Synthetic listings only; nothing is published anywhere real.
//   node --test test/websitePublication.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
const WS = H.load('services/websiteSync')
const P = H.load('services/websitePublication')

const REF = '2906-T101'
const photos = { images: ['https://example.invalid/a.jpg', 'https://example.invalid/b.jpg'], description_public: 'Bright two-bedroom apartment close to the promenade, fully furnished.' }

async function listing(fields = {}) {
  const r = await H.db.query(
    `INSERT INTO properties (ref, town, bedrooms, bathrooms, property_type, longlet_price, available_status, published, public_payload, street)
     VALUES ($1, 'Sliema', 2, 1, 'Apartment', $2, $3, $4, $5, 'Triq it-Torri 12') RETURNING id`,
    [REF, fields.price ?? 1500, fields.status ?? 'available', fields.published ?? true, JSON.stringify(fields.payload ?? photos)])
  return r.rows[0].id
}
const site = async () => (await H.db.query(`SELECT * FROM website_properties WHERE property_reference = $1`, [REF])).rows
const state = async id => (await H.db.query(`SELECT * FROM website_publication_state WHERE property_id = $1`, [id])).rows[0]
const run = () => P.processDue({ limit: 50 })

test.beforeEach(async () => {
  await H.db.query(`DELETE FROM website_properties WHERE property_reference LIKE '2906-T%'`)
  await H.db.query(`DELETE FROM properties WHERE ref LIKE '2906-T%'`)
})

test('approved listing appears once; repeated events and runs never duplicate it', async () => {
  const id = await listing()
  assert.strictEqual((await state(id)).status, 'sync_pending', 'the trigger queued it')
  await run()
  let rows = await site()
  assert.strictEqual(rows.length, 1)
  assert.deepStrictEqual([rows[0].is_published, rows[0].status], [true, 'available'])
  const slug = rows[0].slug
  await H.db.query(`UPDATE properties SET longlet_price = longlet_price WHERE id = $1`, [id]) // a no-op webhook-style re-touch
  await run(); await run()
  rows = await site()
  assert.strictEqual(rows.length, 1, 'still one row')
  assert.strictEqual(rows[0].slug, slug, 'public URL stable')
  const chip = P.chipFor(await state(id))
  assert.deepStrictEqual([chip.status, chip.label], ['published', 'Published'])
})

test('rent and photo edits reach the site; no owner contact or street in the public row', async () => {
  const id = await listing()
  await run()
  await H.db.query(`UPDATE properties SET longlet_price = 1650, public_payload = $2 WHERE id = $1`,
    [id, JSON.stringify({ ...photos, images: ['https://example.invalid/c.jpg', ...photos.images] })])
  await run()
  const [row] = await site()
  assert.strictEqual(Number(row.price), 1650)
  assert.strictEqual(row.images[0], 'https://example.invalid/c.jpg')
  const publicText = JSON.stringify(row)
  assert.doesNotMatch(publicText, /Triq it-Torri 12/, 'full street never public')
  assert.doesNotMatch(publicText, /356\d{8}/, 'no phone numbers')
})

test('owner confirms rented → no longer available on the site; CRM record kept', async () => {
  const id = await listing()
  await run()
  await H.db.query(`UPDATE properties SET available_status = 'rented' WHERE id = $1`, [id])
  await run()
  const [row] = await site()
  assert.strictEqual(row.status, 'rented')
  assert.strictEqual((await state(id)).status, 'marked_unavailable')
  assert.strictEqual((await H.db.query(`SELECT COUNT(*)::int n FROM properties WHERE id = $1`, [id])).rows[0].n, 1)
})

test('withdrawn / archived / unpublished → off the site, never deleted', async () => {
  const id = await listing()
  await run()
  await H.db.query(`UPDATE properties SET published = FALSE WHERE id = $1`, [id])
  await run()
  const [row] = await site()
  assert.strictEqual(row.is_published, false)
  assert.strictEqual((await state(id)).status, 'unpublished')
})

test('not publish-ready but already online and rented → public status still corrected', async () => {
  const id = await listing()
  await run()
  await H.db.query(`UPDATE properties SET public_payload = '{}'::jsonb, available_status = 'rented' WHERE id = $1`, [id])
  await run()
  const [row] = await site()
  assert.strictEqual(row.status, 'rented')
  assert.strictEqual((await state(id)).status, 'not_ready')
})

test('API failure → Sync pending with retries, then Sync failed (never "live"); retry recovers', async () => {
  const id = await listing()
  const real = WS.syncPropertyToWebsite
  WS.syncPropertyToWebsite = async () => { throw new Error('website DB unreachable') }
  try {
    await run()
    let s = await state(id)
    assert.deepStrictEqual([s.status, s.attempts], ['sync_pending', 1])
    assert.strictEqual(P.chipFor(s).status, 'sync_pending')
    for (let i = 0; i < P.MAX_ATTEMPTS; i++) {
      await H.db.query(`UPDATE website_publication_state SET next_attempt_at = NOW() WHERE property_id = $1`, [id])
      await run()
    }
    s = await state(id)
    assert.strictEqual(s.status, 'failed')
    const chip = P.chipFor(s, { admin: true })
    assert.deepStrictEqual([chip.label, chip.error], ['Sync failed', 'website DB unreachable'])
    assert.strictEqual(P.chipFor(s).error, undefined, 'error details only for admins')
    assert.strictEqual((await site()).length, 0, 'nothing claimed as published')
    assert.ok((await P.summary()).failed.some(f => f.property_id === id))
  } finally { WS.syncPropertyToWebsite = real }
  assert.deepStrictEqual(await P.retryFailed(id), { retried: true })
  await run()
  assert.strictEqual((await state(id)).status, 'published')
  assert.strictEqual((await site()).length, 1)
})

test('a change made while a publish is in flight is not lost (no out-of-order revert)', async () => {
  const id = await listing()
  const real = WS.syncPropertyToWebsite
  WS.syncPropertyToWebsite = async pid => {
    // the CRM changes the price while this run is publishing
    await H.db.query(`UPDATE properties SET longlet_price = 1800 WHERE id = $1`, [pid])
    return real(pid)
  }
  try { await run() } finally { WS.syncPropertyToWebsite = real }
  assert.strictEqual((await state(id)).status, 'sync_pending', 'newer revision still queued')
  await H.db.query(`UPDATE website_publication_state SET next_attempt_at = NOW() WHERE property_id = $1`, [id])
  await run()
  assert.strictEqual(Number((await site())[0].price), 1800)
  assert.strictEqual((await state(id)).status, 'published')
})

test('reconcile re-queues drift that bypassed the trigger (e.g. a manual edit of the website row)', async () => {
  const id = await listing()
  await run()
  await H.db.query(`UPDATE properties SET available_status = 'rented' WHERE id = $1`, [id])
  // simulate the old world: the change was never published
  await H.db.query(`UPDATE website_publication_state SET published_revision = desired_revision, status = 'published' WHERE property_id = $1`, [id])
  assert.strictEqual((await P.summary()).falselyAvailableOnSite >= 1, true)
  const r = await P.reconcile()
  assert.ok(r.requeued >= 1)
  await run()
  assert.strictEqual((await site())[0].status, 'rented')
})
