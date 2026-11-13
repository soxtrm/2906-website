'use strict'
// Incoming Properties — integration test against a THROW-AWAY copy of the ARGUS
// schema (never production). Synthetic agents, owners, properties and upload
// packages only; everything created here is removed afterwards.
//
//   ARGUS_BASE_DIR=<production backend, read-only> NODE_PATH=<base>/node_modules \
//   TEST_DB_HOST=… TEST_DB_NAME=… TEST_DB_USER=… TEST_DB_PASSWORD=… \
//   node --test --test-concurrency=1 test/intake.integration.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const BASE = process.env.ARGUS_BASE_DIR
if (!BASE || !fs.existsSync(path.join(BASE, 'db.js'))) throw new Error('ARGUS_BASE_DIR must point to a production backend copy')
if (/^(2906_postgres|postgres)$/i.test(process.env.TEST_DB_HOST || '')) throw new Error('refusing to run against the production database host')

const stubs = {
  config: {
    db: { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT || 5432), database: process.env.TEST_DB_NAME, user: process.env.TEST_DB_USER, password: process.env.TEST_DB_PASSWORD },
    redis: {}, waha: { url: 'http://waha.invalid', apiKey: 'x' }, telegram: {},
  },
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return stubs.logger } },
}
globalThis.fetch = async url => { throw new Error('network is not available in this test: ' + String(url).slice(0, 60)) }
const exists = p => fs.existsSync(p) || fs.existsSync(p + '.js')
const original = Module._load
Module._load = function (request, parent) {
  if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../'))) {
    const resolved = path.resolve(path.dirname(parent.filename), request)
    for (const root of [ROOT, BASE]) {
      const rel = path.relative(root, resolved).replace(/\\/g, '/').replace(/\.js$/, '')
      if (rel.startsWith('..')) continue
      if (Object.prototype.hasOwnProperty.call(stubs, rel)) return stubs[rel]
      if (root === BASE && exists(path.join(ROOT, rel))) return original.call(this, path.join(ROOT, rel), parent)
      if (root === ROOT && !exists(resolved) && exists(path.join(BASE, rel))) return original.call(this, path.join(BASE, rel), parent)
    }
  }
  return original.apply(this, arguments)
}

const db = require(path.join(BASE, 'db'))
const intake = require(path.join(ROOT, 'services', 'propertyIntake.js'))
const TAG = `IN${process.pid}${Date.now() % 100000}`
let seq = 0
const q = (sql, p) => db.query(sql, p)
const img = n => Array.from({ length: n }, (_, i) => ({ url: `https://example.invalid/${TAG}/${seq}-${i}.jpg` }))

let admin, olga, other
async function agent(role, name) {
  return (await q(`INSERT INTO agents (username, name, role, active, email) VALUES ($1,$2,$3,TRUE,$4) RETURNING id, username, name, role`,
    [`${TAG.toLowerCase()}_${name}`, `${name} ${TAG}`, role, `${TAG.toLowerCase()}_${name}@example.invalid`])).rows[0]
}
async function pkg(agentId, state = 'REVIEW_REQUIRED', { reason = null, media = 6, minutesAgo = 5 } = {}) {
  seq++
  const ts = Math.floor(Date.now() / 1000) - minutesAgo * 60
  return (await q(
    `INSERT INTO upload_packages (chat_id, session, divider_message_id, divider_stanza_id, divider_ts, sender_jid, agent_id, state, media_expected, first_message_ts, summary, failure_reason)
     VALUES ($1,'testsess',$2,$2,$3,'1@lid',$4,$5,$6,$7,$8,$9) RETURNING *`,
    [`${TAG}@g.us`, `${TAG}-D${seq}`, ts, agentId, state, media, ts - 60, `Synthetic ${TAG} package ${seq}`, reason])).rows[0]
}
async function draft(by, { town = 'Sliema', beds = 2, rent = 1500, photos = 6, pk = null, published = false, intake = true } = {}) {
  seq++
  const p = (await q(
    `INSERT INTO properties (ref, town, property_type, bedrooms, bathrooms, longlet_price, available_status, published, system_online, listed_by_agent_id, images, description,
                             verification_status, intake_source, intake_package_id, intake_received_at)
     VALUES ($1,$2,'apartment',$3,1,$4,'available',$5,$6,$7,$8::jsonb,'Synthetic listing',$9,$10,$11,NOW() - INTERVAL '5 minutes') RETURNING *`,
    [`${TAG}-${seq}`, town, beds, rent, published, !intake, by.id, JSON.stringify(img(photos)),
     intake ? 'unverified' : null, intake ? 'whatsapp_divider' : null, pk ? pk.id : null])).rows[0]
  if (pk) await q(`UPDATE upload_packages SET property_ids = ARRAY[$1]::int[], property_refs = ARRAY[$2]::text[] WHERE id = $3`, [p.id, p.ref, pk.id])
  return p
}
const reload = async id => (await q(`SELECT * FROM properties WHERE id = $1`, [id])).rows[0]
const events = async id => (await q(`SELECT action_type, actor_agent_id, details FROM agent_activity_log WHERE target_property_id = $1 ORDER BY id`, [id])).rows

test.before(async () => {
  admin = await agent('admin', 'Admin'); olga = await agent('admin', 'Olga'); other = await agent('agent', 'Other')
  olga.role = 'agent'   // review rights must come from being the uploader, not from an admin role
  await q(`UPDATE agents SET role = 'agent' WHERE id = $1`, [olga.id])
})
test.after(async () => {
  const like = `${TAG}-%`
  await q(`DELETE FROM agent_activity_log WHERE target_property_id IN (SELECT id FROM properties WHERE ref LIKE $1) OR actor_agent_id IN (SELECT id FROM agents WHERE username LIKE $2)`, [like, `${TAG.toLowerCase()}_%`])
  await q(`DELETE FROM property_activities WHERE property_id IN (SELECT id FROM properties WHERE ref LIKE $1)`, [like])
  await q(`DELETE FROM properties WHERE ref LIKE $1`, [like])
  await q(`DELETE FROM upload_packages WHERE chat_id = $1`, [`${TAG}@g.us`])
  await q(`DELETE FROM agents WHERE username LIKE $1`, [`${TAG.toLowerCase()}_%`])
  await db.end?.()
})

test('one complete upload appears at once as an UNVERIFIED internal draft, with its WhatsApp time and uploader', async () => {
  const pk = await pkg(olga.id)
  const p = await draft(olga, { pk })
  const items = await intake.listItems(admin, { filter: 'needs_verification' })
  const it = items.find(i => i.id === p.id)
  assert.ok(it, 'listed for the administrator')
  assert.equal(it.verification.status, 'unverified'); assert.equal(it.published, false); assert.equal(it.ready, true)
  assert.equal(it.uploader.name, olga.name); assert.equal(it.package.id, Number(pk.id)); assert.equal(it.imageCount, 6)
  assert.ok((await intake.listItems(olga, { filter: 'new_today' })).some(i => i.id === p.id), 'the uploader sees her own upload under New Today')
  assert.ok(!(await intake.listItems(other, { filter: 'needs_verification' })).some(i => i.id === p.id), 'another agent does not')
  const pending = await q(`SELECT id FROM properties p WHERE p.archived_at IS NULL AND p.verification_status IN ('unverified','needs_correction') AND p.id = $1`, [p.id])
  assert.equal(pending.rows.length, 1, 'the Inventory "Pending verification" filter matches it')
})

test('three successive uploads are three separate drafts and all are counted', async () => {
  const before = (await intake.summary(admin)).counts.new_today
  const ps = []
  for (const town of ['Gzira', 'Msida', 'Swieqi']) ps.push(await draft(olga, { town, pk: await pkg(olga.id) }))
  assert.equal(new Set(ps.map(p => p.id)).size, 3)
  const s = await intake.summary(admin)
  assert.equal(s.counts.new_today, before + 3)
  assert.ok(s.uploadsToday.some(u => u.agent === olga.name && u.n >= 4))
})

test('a failed package stays visible with its reason and can be dismissed only by an administrator', async () => {
  const pk = await pkg(olga.id, 'FAILED', { reason: 'listing 1: extractor unavailable', media: 12 })
  const failed = await intake.listItems(olga, { filter: 'failed' })
  const it = failed.find(i => i.packageId === Number(pk.id))
  assert.ok(it); assert.equal(it.reason, 'listing 1: extractor unavailable'); assert.equal(it.mediaExpected, 12)
  assert.ok((await intake.summary(admin)).counts.failed >= 1)
  await assert.rejects(intake.dismissPackage(olga, pk.id), /administrator/)
  await intake.dismissPackage(admin, pk.id, { note: 'test' })
  assert.ok(!(await intake.listItems(admin, { filter: 'failed' })).some(i => i.packageId === Number(pk.id)))
})

test('missing price blocks verification and says what is missing; Edit & Verify then succeeds without publishing', async () => {
  const p = await draft(olga, { rent: null, pk: await pkg(olga.id) })
  assert.ok((await intake.listItems(admin, { filter: 'missing_info' })).some(i => i.id === p.id))
  await assert.rejects(intake.verify(admin, p.id), e => e.status === 422 && e.missing.some(m => m.field === 'price'))
  const r = await intake.verify(admin, p.id, { edits: { longlet_price: '1,750', available_date: '2027-01-15' }, note: 'checked with Olga' })
  assert.deepEqual(r.changed.longlet_price, { before: null, after: 1750 })
  const row = await reload(p.id)
  assert.equal(row.verification_status, 'verified'); assert.equal(Number(row.verified_by_agent_id), admin.id); assert.ok(row.verified_at)
  assert.equal(Number(row.longlet_price), 1750); assert.equal(row.system_online, true, 'usable inside ARGUS')
  assert.equal(row.published, false, 'verification never publishes')
  const ev = await events(p.id)
  assert.equal(ev.at(-1).action_type, 'intake:verified'); assert.equal(Number(ev.at(-1).actor_agent_id), admin.id)
  assert.deepEqual((await intake.verify(admin, p.id)).already, true, 'a retried click does not verify twice')
  assert.equal((await events(p.id)).filter(e => e.action_type === 'intake:verified').length, 1)
})

test('the uploading agent can correct and verify her own draft; another agent cannot touch it', async () => {
  const p = await draft(olga, { pk: await pkg(olga.id) })
  await assert.rejects(intake.verify(other, p.id), e => e.status === 403)
  await assert.rejects(intake.saveEdits(other, p.id, { longlet_price: 1 }), e => e.status === 403)
  await intake.saveEdits(olga, p.id, { longlet_price: 1600, description: 'Corrected by the agent' })
  assert.equal((await reload(p.id)).verification_status, 'unverified', 'saving is not verifying')
  await intake.verify(olga, p.id)
  const row = await reload(p.id)
  assert.equal(row.verification_status, 'verified'); assert.equal(Number(row.verified_by_agent_id), olga.id); assert.equal(Number(row.longlet_price), 1600)
})

test('Needs Correction keeps the draft pending with the note the uploader sees', async () => {
  const p = await draft(olga, { pk: await pkg(olga.id) })
  await assert.rejects(intake.requestCorrection(admin, p.id, { note: '' }), e => e.status === 422)
  await intake.requestCorrection(admin, p.id, { note: 'Price looks like the sale price' })
  const it = (await intake.listItems(olga, { filter: 'needs_verification' })).find(i => i.id === p.id)
  assert.equal(it.verification.status, 'needs_correction'); assert.equal(it.verification.note, 'Price looks like the sale price')
})

test('Link Existing archives the draft, links it, and adds photos only to an unpublished existing record', async () => {
  const existing = await draft(admin, { town: 'Rabat', beds: 3, rent: 2200, photos: 2, intake: false })
  const live = await draft(admin, { town: 'Rabat', beds: 3, rent: 2200, photos: 2, intake: false, published: true })
  const dup = await draft(olga, { town: 'Rabat', beds: 3, rent: 2200, photos: 5, pk: await pkg(olga.id) })
  const item = await intake.getItem(admin, dup.id)
  assert.ok(item.suggestions.some(s => s.id === existing.id), 'the existing flat is suggested')
  const r = await intake.linkExisting(admin, dup.id, { target: existing.ref })
  assert.equal(r.photosAdded, 5)
  const d = await reload(dup.id), e = await reload(existing.id)
  assert.ok(d.archived_at); assert.equal(d.intake_linked_property_id, existing.id); assert.equal(d.published, false)
  assert.equal(e.images.length, 7)
  assert.ok((await intake.listItems(admin, { filter: 'duplicates' })).some(i => i.id === dup.id))
  assert.ok(!(await intake.listItems(admin, { filter: 'needs_verification' })).some(i => i.id === dup.id))

  const dup2 = await draft(olga, { town: 'Rabat', beds: 3, rent: 2200, photos: 4, pk: await pkg(olga.id) })
  const r2 = await intake.linkExisting(admin, dup2.id, { target: String(live.id) })
  assert.equal(r2.photosAdded, 0); assert.match(r2.photoNote, /published/)
  assert.equal((await reload(live.id)).images.length, 2, 'a published listing is not changed')
  await assert.rejects(intake.linkExisting(admin, dup2.id, { target: existing.ref }), e => e.status === 409, 'cannot link twice')
})

test('Reject Duplicate archives without touching the other record', async () => {
  const p = await draft(olga, { pk: await pkg(olga.id) })
  await intake.rejectDuplicate(olga, p.id, { note: 'sent twice' })
  const row = await reload(p.id)
  assert.ok(row.archived_at); assert.equal(row.available_status, 'archived'); assert.equal(row.published, false)
  assert.equal((await events(p.id)).at(-1).action_type, 'intake:rejected_duplicate')
})

test('the dashboard feed and counts come from persisted events', async () => {
  const p = await draft(olga, { pk: await pkg(olga.id) })
  await intake.verify(admin, p.id)
  const feed = await intake.feed(admin, { limit: 50 })
  assert.ok(feed.some(e => e.propertyId === p.id && e.action === 'verified' && e.actor === admin.name))
  const mine = await intake.feed(olga, { limit: 50 })
  assert.ok(mine.some(e => e.propertyId === p.id), 'the uploader sees decisions on her properties')
  assert.ok((await intake.summary(admin)).counts.approved_today >= 1)
})

test('a property that did not come through intake is untouched and never shows as unverified', async () => {
  const legacy = await draft(admin, { intake: false })
  assert.equal(await intake.getItem(admin, legacy.id), null)
  assert.equal((await reload(legacy.id)).verification_status, null)
})
