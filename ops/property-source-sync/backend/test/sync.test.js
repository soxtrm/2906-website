'use strict'
// Property Source Sync — database workflow tests on the isolated test Postgres.
// Ports prototype tests 17–31 and the brief's acceptance tests. Nothing here
// reaches the network or WhatsApp (WAHA stub throws).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const H = require('./helpers/harness')
const Sync = H.load('services/propertySourceSync')
const A = H.load('services/propertySourceAdapters')

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'observed_2026-11-09.json'), 'utf8')).listings
const longLets = () => JSON.parse(JSON.stringify(fixture.filter(x => x.category === 'long_let')))
const sales = () => JSON.parse(JSON.stringify(fixture.filter(x => x.category === 'sale')))
const q = (sql, p) => H.db.query(sql, p).then(r => r.rows)
let admin, L, S

test.before(async () => { await H.migrate(); admin = await H.agent('admin') })
test.beforeEach(async () => {
  await H.reset()
  L = (await Sync.createSource({ adapter: 'mynexthome', category: 'long_let', url: 'https://www.mynexthome.mt/long-let/' }, admin)).id
  S = (await Sync.createSource({ adapter: 'mynexthome', category: 'sale', url: 'https://www.mynexthome.mt/for-sale/' }, admin)).id
})
test.after(async () => { assert.equal(H.wahaCalls.length, 0, 'source sync must never call WhatsApp'); await H.db.end?.() })

const pending = (sourceId, type) => q(`SELECT * FROM property_source_events WHERE source_id=$1 AND status='PENDING' ${type ? 'AND event_type=$2' : ''} ORDER BY id`, type ? [sourceId, type] : [sourceId])

test('17 first snapshot: 4 Long Let records → 4 NEW proposals, dashboard shows 4 (not fabricated)', async () => {
  const out = await Sync.ingestSnapshot(L, longLets())
  assert.equal(out.counts.new, 4)
  const sum = await Sync.summary()
  assert.equal(sum.sources.find(s => s.id === L).pending.new, 4)
  assert.equal(sum.totals.new, 4); assert.equal(sum.totals.updated, 0); assert.equal(sum.totals.check, 0)
})
test('18 re-running the same snapshot creates no duplicate proposals', async () => {
  await Sync.ingestSnapshot(L, longLets())
  const again = await Sync.ingestSnapshot(L, longLets())
  assert.equal(again.counts.new, 0); assert.equal(again.counts.unchanged, 4)
  assert.equal((await pending(L)).length, 4)
})
test('19/20 a later higher price is a PRICE_UPDATED event with the field diff', async () => {
  await Sync.ingestSnapshot(L, longLets())
  for (const e of await pending(L)) await Sync.decide(e.id, 'accept', admin)
  const next = longLets(); next[0].price.amount = '1600'; next[0].price.candidate_prices = [{ amount: '1600', basis: 'EUR_MONTH', evidence: 'Rent € 1,600 monthly', line_index: 3 }]
  const out = await Sync.ingestSnapshot(L, next)
  assert.equal(out.counts.price_updated, 1)
  const [ev] = await pending(L, 'PRICE_UPDATED')
  assert.equal(ev.field_changes.price_amount.previous, '1300'); assert.equal(ev.field_changes.price_amount.current, '1600')
  assert.equal(ev.current.price.amount, '1600')
})
test('changes to available-from, bathrooms and photos show their own diff', async () => {
  await Sync.ingestSnapshot(L, longLets())
  for (const e of await pending(L)) await Sync.decide(e.id, 'accept', admin)
  const next = longLets()
  next[0].available_from_source = '01/12/2026'; next[1].bathrooms = 1; next[2].media_source_urls = ['https://www.mynexthome.mt/wp-content/uploads/x.jpg']
  const out = await Sync.ingestSnapshot(L, next)
  assert.equal(out.counts.availability_changed, 1); assert.equal(out.counts.details_changed, 1); assert.equal(out.counts.media_changed, 1)
  const evs = await pending(L)
  const by = Object.fromEntries(evs.map(e => [e.event_type, e]))
  assert.deepEqual(by.AVAILABILITY_CHANGED.field_changes.available_from_source, { previous: '01/11/2026', current: '01/12/2026' })
  assert.deepEqual(by.DETAILS_CHANGED.field_changes.bathrooms, { previous: 2, current: 1 })
  assert.ok(by.MEDIA_CHANGED.field_changes.media_source_urls)
})
test('21 missing once never flags; 22 missing in two complete scans → review-only MISSING_FROM_SOURCE', async () => {
  await Sync.ingestSnapshot(L, longLets())
  assert.equal((await Sync.ingestSnapshot(L, longLets().slice(1))).counts.missing, 0)
  assert.equal((await Sync.ingestSnapshot(L, longLets().slice(1))).counts.missing, 1)
  const [ev] = await pending(L, 'MISSING_FROM_SOURCE')
  assert.deepEqual(ev.flags, ['VERIFY_WITH_PROVIDER'])
  await assert.rejects(Sync.decide(ev.id, 'accept', admin), /never marked rented/)
  const third = await Sync.ingestSnapshot(L, longLets().slice(1))
  assert.equal(third.counts.missing, 0, 'one missing check per absence, not one per scan')
})
test('incomplete or failed scans never turn listings into missing ones', async () => {
  await Sync.ingestSnapshot(L, longLets())
  await Sync.ingestSnapshot(L, [], { complete: false })
  await Sync.ingestSnapshot(L, longLets().slice(0, 1), { complete: false })
  assert.equal((await pending(L, 'MISSING_FROM_SOURCE')).length, 0)
  const counts = await q(`SELECT MAX(missing_scan_count) AS m FROM website_source_inventory WHERE source_id=$1`, [L])
  assert.equal(counts[0].m, 0)
})
test('live scan: network failure on one detail page fails the scan and marks nothing missing', async () => {
  await Sync.ingestSnapshot(L, longLets())
  await Sync.updateSource(L, { permission: { read_permission: 'GRANTED', reference: 'Test: written permission email 2026-11-09' } }, admin)
  const category = longLets().map(l => `<a href="${l.source_url}">x</a>`).join('')
  let calls = 0
  const request = async url => { calls++; if (url.endsWith('/long-let/')) return { status: 200, headers: { 'content-type': 'text/html' }, body: category }; if (calls > 2) throw new Error('ECONNRESET'); return { status: 200, headers: { 'content-type': 'text/html' }, body: '<h1>Hamrun 1-bedroom</h1><p>€ 1,300 monthly</p>' } }
  for (let i = 0; i < 2; i++) await assert.rejects(Sync.runScan(L, { request, robotsRequest: async () => ({ status: 404, body: '' }), delayMs: 0 }), /ECONNRESET/)
  const [src] = await q(`SELECT * FROM property_sources WHERE id=$1`, [L])
  assert.match(src.last_error, /ECONNRESET/); assert.equal(src.consecutive_failures, 2)
  assert.equal((await pending(L, 'MISSING_FROM_SOURCE')).length, 0)
  const failed = await q(`SELECT status, complete FROM property_source_scans WHERE source_id=$1 AND status='FAILED'`, [L])
  assert.equal(failed.length, 2); assert.ok(failed.every(f => f.complete === false))
})
test('live scan: an empty collection page is a failure, never an empty successful snapshot', async () => {
  await Sync.updateSource(L, { permission: { read_permission: 'GRANTED', reference: 'Test permission' } }, admin)
  await assert.rejects(Sync.runScan(L, { request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<p>maintenance</p>' }), robotsRequest: async () => ({ status: 404 }), delayMs: 0 }), /Zero listing links/)
})
test('live scan with permission parses detail pages and ingests them as one complete run', async () => {
  await Sync.updateSource(L, { permission: { read_permission: 'GRANTED', reference: 'Test permission' } }, admin)
  const pages = {
    'https://www.mynexthome.mt/long-let/': '<a href="/directory-apartments/listing/a/">a</a><a href="/directory-apartments/listing/b/">b</a>',
    'https://www.mynexthome.mt/directory-apartments/listing/a/': '<h1>Sliema 2-bedroom Apartment</h1><button>Short Let</button><p>€ 1,500 monthly</p><p>Rent: € 1,400 monthly</p><p>WiFi €45 monthly</p>',
    'https://www.mynexthome.mt/directory-apartments/listing/b/': '<h1>Gzira Studio</h1><p>Price on request</p>',
  }
  const out = await Sync.runScan(L, { request: async u => ({ status: 200, headers: { 'content-type': 'text/html', etag: '"v1"' }, body: pages[u] }), robotsRequest: async () => ({ status: 200, body: 'User-agent: *\nDisallow: /wp-admin/' }), delayMs: 0 })
  assert.equal(out.counts.new, 2)
  const evs = await pending(L, 'NEW')
  const sliema = evs.find(e => e.current.title.startsWith('Sliema'))
  assert.equal(sliema.current.price.amount, '1400'); assert.ok(sliema.flags.includes('PRICE_CONFLICT'))
  const gzira = evs.find(e => e.current.title.startsWith('Gzira'))
  assert.equal(gzira.current.price.amount, null); assert.ok(gzira.flags.includes('NEEDS_PRICE_REVIEW'))
  const [src] = await q(`SELECT etag, complete_scan_count FROM property_sources WHERE id=$1`, [L])
  assert.equal(src.etag, '"v1"'); assert.equal(src.complete_scan_count, 1)
})
test('23 a Sale snapshot cannot be ingested into the Long Let source', async () => {
  await assert.rejects(Sync.ingestSnapshot(L, sales()), /source collection/)
})
test('24 detection never writes canonical properties by itself', async () => {
  await Sync.ingestSnapshot(L, longLets())
  assert.equal((await q(`SELECT COUNT(*)::int n FROM properties WHERE ref LIKE 'WSI-MYNEXTHOME-%'`))[0].n, 0)
})
test('25 accepting a NEW proposal creates a STAGED canonical draft linked to the source record', async () => {
  await Sync.ingestSnapshot(L, longLets())
  const [ev] = await pending(L, 'NEW')
  const { result } = await Sync.decide(ev.id, 'accept', admin)
  const [p] = await q(`SELECT * FROM properties WHERE id=$1`, [result.propertyId])
  assert.equal(p.is_staging, true); assert.equal(p.published, false); assert.equal(p.system_online, false); assert.equal(p.available_status, 'pending_check')
  assert.equal(Number(p.longlet_price), Number(ev.current.price.amount)); assert.equal(p.lease_type, 'long_let'); assert.deepEqual(p.images, [])
  assert.equal(p.field_provenance.price[0].source_type, 'website_scrape')
  assert.match(p.internal_notes, /LINK_ONLY/)
  const [w] = await q(`SELECT canonical_property_id, import_status FROM website_source_inventory WHERE id=$1`, [ev.wsi_id])
  assert.equal(w.canonical_property_id, p.id); assert.equal(w.import_status, 'SOURCE_DRAFT')
  const audit = await q(`SELECT * FROM agent_activity_log WHERE action_type='PROPERTY_SOURCE_REVIEW' AND target_property_id=$1`, [p.id])
  assert.equal(audit.length, 1); assert.equal(String(audit[0].actor_agent_id), String(admin.id))
})
test('26 reject keeps the CRM unchanged and the item in source history', async () => {
  await Sync.ingestSnapshot(L, longLets())
  const before = (await q(`SELECT COUNT(*)::int n FROM properties`))[0].n
  const [ev] = await pending(L, 'NEW')
  await assert.rejects(Sync.decide(ev.id, 'reject', admin), /reason/)
  await Sync.decide(ev.id, 'reject', admin, { note: 'not our segment' })
  const [rej] = await q(`SELECT decision_note FROM property_source_events WHERE id=$1`, [ev.id])
  assert.equal(rej.decision_note, 'not our segment')
  assert.equal((await Sync.summary()).totals.rejected, 1)
  assert.equal((await q(`SELECT COUNT(*)::int n FROM properties`))[0].n, before)
  const [w] = await q(`SELECT import_status FROM website_source_inventory WHERE id=$1`, [ev.wsi_id])
  assert.equal(w.import_status, 'REJECTED')
  const [again] = await q(`SELECT status, decided_by FROM property_source_events WHERE id=$1`, [ev.id])
  assert.equal(again.status, 'REJECTED'); assert.equal(again.decided_by, admin.id)
})
test('27 the same listing twice inside one scan counts once', async () => {
  const r = longLets(); const out = await Sync.ingestSnapshot(L, [...r, r[0]])
  assert.equal(out.itemsSeen, 4)
})
test('28 Sales are a separate source; the Libya listing is flagged and cannot be accepted as Malta stock', async () => {
  const s = sales(); s[0].title = 'Tripoli Commercial Building'; s[0].market_country = 'OUTSIDE_MALTA'
  assert.equal((await Sync.ingestSnapshot(S, s)).counts.new, 4)
  const tripoli = (await pending(S, 'NEW')).find(e => e.flags.includes('OUTSIDE_MALTA'))
  assert.ok(tripoli)
  await assert.rejects(Sync.decide(tripoli.id, 'accept', admin), /International listing/)
})
test('29 a stale proposal cannot be approved; the newest snapshot supersedes it', async () => {
  await Sync.ingestSnapshot(L, longLets())
  const first = (await pending(L, 'NEW'))[0]
  const next = longLets(); const idx = next.findIndex(x => A.externalRef(A.canonicalUrl(x.source_url, 'mynexthome')) === first.current.external_id)
  next[idx].price.amount = '1999'
  await Sync.ingestSnapshot(L, next)
  await assert.rejects(Sync.decide(first.id, 'accept', admin), /already superseded/)
  const latest = (await pending(L, 'NEW')).find(e => e.wsi_id === first.wsi_id)
  await assert.rejects(Sync.decide(latest.id, 'accept', admin, { fingerprint: first.fingerprint }), /older revision/)
  const ok = await Sync.decide(latest.id, 'accept', admin, { fingerprint: latest.fingerprint })
  assert.ok(ok.result.propertyId)
})
test('30 Short Let collection cannot be registered', async () => {
  await assert.rejects(Sync.createSource({ adapter: 'mynexthome', category: 'short_let', url: 'https://www.mynexthome.mt/short-let/' }, admin), /Short Let/)
  await assert.rejects(Sync.createSource({ adapter: 'mynexthome', category: 'long_let', url: 'https://www.mynexthome.mt/long-let/' }, admin), /already registered/)
})
test('31 private address never appears in the list preview', async () => {
  const r = longLets(); r[0].private_address_candidate = 'Sensitive address 12'
  await Sync.ingestSnapshot(L, r)
  assert.ok(!JSON.stringify(await Sync.listEvents({ sourceId: L })).includes('Sensitive address'))
  const [w] = await q(`SELECT parsed_address FROM website_source_inventory WHERE source_id=$1 AND parsed_address IS NOT NULL`, [L])
  assert.equal(w, undefined, 'private address is not copied into the agent-visible Base Inventory column')
})
test('accepted price change writes through; a newer owner confirmation is not overwritten', async () => {
  await Sync.ingestSnapshot(L, longLets())
  const [ev] = await pending(L, 'NEW')
  const { result } = await Sync.decide(ev.id, 'accept', admin)
  // Owner confirms price + availability directly, later than the website observation.
  const future = new Date(Date.now() + 3600e3).toISOString()
  await H.db.query(`UPDATE properties SET longlet_price=1250, field_provenance = jsonb_set(field_provenance, '{price}', $2::jsonb), last_confirmed_available_at=$3 WHERE id=$1`,
    [result.propertyId, JSON.stringify([{ value: 1250, source_type: 'owner_whatsapp', observed_at: future }]), future])
  const next = longLets(); const i = next.findIndex(x => x.external_id === ev.current.external_id)
  next[i].price.amount = '1450'; next[i].bedrooms = 3
  await Sync.ingestSnapshot(L, next)
  const chg = (await pending(L)).find(e => e.wsi_id === ev.wsi_id)
  assert.equal(chg.event_type, 'PRICE_UPDATED')
  const out = await Sync.decide(chg.id, 'accept', admin)
  assert.deepEqual(out.result.applied, ['bedrooms'])
  assert.ok(out.result.skipped.some(s => s.field === 'price' && /owner_whatsapp/.test(s.reason)))
  const [p] = await q(`SELECT longlet_price, bedrooms, published, is_staging FROM properties WHERE id=$1`, [result.propertyId])
  assert.equal(Number(p.longlet_price), 1250); assert.equal(p.bedrooms, 3); assert.equal(p.published, false)
  const [wt] = await q(`SELECT details FROM agent_activity_log WHERE action_type='PROPERTY_SOURCE_WRITE_THROUGH' AND target_property_id=$1`, [result.propertyId])
  assert.equal(wt.details.save_mode, 'SAVE_ONLY_NO_REPOST')
})
test('same building, different flats stay separate; same unit from another agency is only a candidate', async () => {
  await H.property({ ref: 'SST-FLAT2', town: 'Hamrun', apt: '2', bedrooms: 2, longlet_price: 1600, is_staging: false })
  const flat5 = await H.property({ ref: 'SST-FLAT5', town: 'Hamrun', apt: '5', bedrooms: 2, longlet_price: 1600, is_staging: false })
  const r = longLets(); const i = r.findIndex(x => /2-bedroom/.test(x.title)); r[i].title = 'Hamrun 2-bedroom Flat 5 Apartment'
  await Sync.ingestSnapshot(L, [r[i]])
  const [ev] = await pending(L, 'NEW')
  const props = ev.match_candidates.filter(c => c.kind === 'property')
  assert.deepEqual(props.map(c => c.ref), ['SST-FLAT5'])
  assert.ok(ev.flags.includes('POSSIBLE_DUPLICATE'))
  // Not merged: accept creates its own record; linking is explicit.
  const before = (await q(`SELECT COUNT(*)::int n FROM properties`))[0].n
  const { result } = await Sync.decide(ev.id, 'link', admin, { propertyId: flat5.id })
  assert.equal(result.propertyId, flat5.id)
  assert.equal((await q(`SELECT COUNT(*)::int n FROM properties`))[0].n, before)
})
test('idempotent retries: repeating the same decision returns the original result', async () => {
  await Sync.ingestSnapshot(L, longLets())
  const [ev] = await pending(L, 'NEW')
  const a = await Sync.decide(ev.id, 'accept', admin)
  const b = await Sync.decide(ev.id, 'accept', admin)
  assert.equal(b.idempotentReplay, true); assert.equal(b.event.canonical_property_id, a.result.propertyId)
  assert.equal((await q(`SELECT COUNT(*)::int n FROM properties WHERE ref LIKE 'WSI-MYNEXTHOME-%'`))[0].n, 1)
})
test('batch acceptance takes only safe new drafts; conflicts and duplicates need individual review', async () => {
  const r = longLets(); r[0].price = { amount: '1400', basis: 'EUR_MONTH', candidate_prices: [{ amount: '1400' }, { amount: '1500' }], review_required: true }
  await Sync.ingestSnapshot(L, r)
  const ids = (await pending(L, 'NEW')).map(e => e.id)
  const out = await Sync.acceptSafeNew(L, admin, ids)
  assert.equal(out.accepted, 3); assert.equal(out.skipped, 1)
  const [left] = await pending(L, 'NEW'); assert.ok(left.flags.includes('PRICE_CONFLICT'))
})
test('notifications: one digest per scan with genuine counts, none when nothing changed', async () => {
  await Sync.ingestSnapshot(L, longLets())
  await Sync.ingestSnapshot(L, longLets())
  const d = await q(`SELECT details FROM agent_activity_log WHERE action_type='SOURCE_SYNC_DIGEST' ORDER BY id`)
  assert.equal(d.length, 1); assert.equal(d[0].details.counts.new, 4)
  const sum = await Sync.summary(); assert.equal(sum.digests[0].counts.new, 4)
})
test('polling needs recorded permission: no permission → no request, tick ignores the source', async () => {
  let requested = false
  await assert.rejects(Sync.runScan(L, { request: async () => { requested = true } }), /permission/)
  await assert.rejects(Sync.updateSource(L, { sync_enabled: true }, admin), /permission/)
  await assert.rejects(Sync.updateSource(L, { permission: { read_permission: 'GRANTED', reference: '' } }, admin), /Record where/)
  await assert.rejects(H.db.query(`UPDATE property_sources SET sync_enabled=true WHERE id=$1`, [L]), /property_sources_polling_needs_permission/)
  assert.deepEqual(await Sync.tick({ request: async () => { requested = true } }), [])
  assert.equal(requested, false)
  const s = (await Sync.listSources()).find(x => x.id === L)
  assert.equal(s.polling_allowed, false); assert.ok(s.polling_blockers.length)
})
test('revoking permission pauses automatic checking; media stays link-only without a licence', async () => {
  await Sync.updateSource(L, { permission: { read_permission: 'GRANTED', reference: 'Agreement 2026-11-09', media_use: 'LICENSED' } }, admin)
  await Sync.updateSource(L, { sync_enabled: true, interval_hours: 24 }, admin)
  let s = (await Sync.listSources()).find(x => x.id === L); assert.equal(s.sync_enabled, true); assert.equal(s.media_use, 'LICENSED')
  await Sync.updateSource(L, { permission: { read_permission: 'REVOKED', reference: 'Provider asked to stop' } }, admin)
  s = (await Sync.listSources()).find(x => x.id === L); assert.equal(s.sync_enabled, false); assert.equal(s.media_use, 'LINK_ONLY')
  await assert.rejects(Sync.updateSource(L, { interval_hours: 1 }, admin), /Interval/)
})
test('optimistic version check on source edits', async () => {
  const s = (await Sync.listSources()).find(x => x.id === L)
  await Sync.updateSource(L, { label: 'A', version: s.version }, admin)
  await assert.rejects(Sync.updateSource(L, { label: 'B', version: s.version }, admin), /changed elsewhere/)
})
