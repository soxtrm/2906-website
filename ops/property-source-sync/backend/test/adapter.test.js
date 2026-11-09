'use strict'
// Property Source Sync — pure adapter tests. Ports every prototype adapter test
// (reference/tests/test_source_sync.py 01–16) plus all price-policy examples,
// URL/SSRF policy, robots and redirect handling. No network, no database.
const test = require('node:test')
const assert = require('node:assert/strict')
const A = require('../services/propertySourceAdapters')
const F = require('../services/propertySourceFetch')

const L = 'long_let', S = 'sale', M = 'mynexthome'
const sel = (lines, c) => A.selectPrice(lines, c)

// ── prototype 01–10 + docs/PRICE_POLICY_AND_EXAMPLES.md ─────────────────────
test('01 single monthly rent', () => { const p = sel(['€ 1,500 monthly'], L); assert.equal(p.amount, '1500'); assert.equal(p.review_required, false) })
test('02 founder rule: two current monthly rents → lower €1,400 + PRICE_CONFLICT', () => {
  const p = sel(['€ 1,500 monthly', 'Rent: € 1,400 monthly'], L)
  assert.equal(p.amount, '1400'); assert.equal(p.basis, 'EUR_MONTH'); assert.equal(p.conflict, true); assert.equal(p.review_required, true)
  assert.deepEqual(p.candidate_prices.map(c => c.amount).sort(), ['1400', '1500'])
})
test('03 Wi-Fi, security and utilities deposits ignored', () => {
  const p = sel(['Rent: € 1,300 monthly', 'WiFi € 45 monthly', 'Wi-Fi €45 monthly', 'Security deposit € 1,300', 'Utilities deposit 100€'], L)
  assert.equal(p.amount, '1300'); assert.equal(p.candidate_prices.length, 1)
})
test('04 price on request stays unknown — never €0 or a fee', () => { const p = sel(['Price on request', 'Utilities deposit: €100', 'Utilities €100'], L); assert.equal(p.amount, null); assert.equal(p.review_required, true) })
test('05 weekly rate is a different basis', () => { const p = sel(['€ 900 weekly', 'Rent € 1,500 monthly'], L); assert.equal(p.amount, '1500'); assert.equal(p.candidate_prices.length, 1) })
test('05b €1,500 per week + €1,400 monthly → €1,400/month', () => assert.equal(sel(['€1,500 per week', '€1,400 monthly'], L).amount, '1400'))
test('06 repeated identical sale price is not a conflict', () => { const p = sel(['€ 255,000', 'Sale Price: €255,000 (Freehold)'], S); assert.equal(p.amount, '255000'); assert.equal(p.review_required, false) })
test('07 founder rule: €255,000 headline + €245,000 asking → €245,000 + conflict', () => { const p = sel(['€ 255,000', 'Sale Price: €245,000'], S); assert.equal(p.amount, '245000'); assert.equal(p.conflict, true) })
test('08 agency fee and deposit never become a sale price', () => assert.equal(sel(['€255,000', 'Agency fee €3,000', 'Deposit €1000'], S).amount, '255000'))
test('09 euro sign after the number', () => assert.equal(sel(['For rent at 1,200€ monthly'], L).amount, '1200'))
test('10 Malta number locales', () => { assert.equal(A.amount('1,300'), 1300); assert.equal(A.amount('1.300'), 1300); assert.equal(A.amount('1,300.50'), 1300.5); assert.equal(A.amount('abc'), null) })
test('monthly rent never compared with a sale price or a nightly stay', () => {
  assert.equal(sel(['€250,000', '€1,200 monthly'], S).amount, '250000')
  assert.equal(sel(['€120 per night', '€1,100 monthly'], L).amount, '1100')
})

// ── URL policy / SSRF ──────────────────────────────────────────────────────
test('11 cross-domain, metadata, IP-literal, localhost, http, userinfo and ports are refused', () => {
  for (const u of ['http://169.254.169.254/latest/meta-data', 'https://169.254.169.254/', 'https://127.0.0.1/long-let/', 'https://localhost/long-let/',
    'http://www.mynexthome.mt/long-let/', 'https://user:pw@www.mynexthome.mt/long-let/', 'https://www.mynexthome.mt:8443/long-let/',
    'https://www.mynexthome.mt.evil.com/long-let/', 'https://evil.com/?u=https://www.mynexthome.mt/', 'https://[::1]/', 'javascript:alert(1)'])
    assert.throws(() => A.canonicalUrl(u, M), u)
})
test('12 trackers and query tricks are dropped from canonical URLs', () => {
  assert.equal(A.canonicalUrl('https://www.mynexthome.mt/long-let/?ref=spam#x', M), 'https://www.mynexthome.mt/long-let/')
  assert.equal(A.canonicalUrl('https://MyNextHome.mt//long-let', M), 'https://www.mynexthome.mt/long-let/')
  // Dot segments (even percent-encoded) are resolved, never left to escape the path.
  assert.equal(A.canonicalUrl('https://www.mynexthome.mt/a/%2e%2e/b/', M), 'https://www.mynexthome.mt/b/')
})
test('registration accepts exactly the Long Let and Sale collections; Short Let is refused', () => {
  assert.equal(A.validateRegistration({ adapter: M, category: L, url: 'https://www.mynexthome.mt/long-let/' }), 'https://www.mynexthome.mt/long-let/')
  assert.equal(A.validateRegistration({ adapter: M, category: S, url: 'https://mynexthome.mt/for-sale' }), 'https://www.mynexthome.mt/for-sale/')
  assert.throws(() => A.validateRegistration({ adapter: M, category: 'short_let', url: 'https://www.mynexthome.mt/short-let/' }), /Short Let/)
  assert.throws(() => A.validateRegistration({ adapter: M, category: L, url: 'https://www.mynexthome.mt/short-let/' }), /approved/)
  assert.throws(() => A.validateRegistration({ adapter: M, category: S, url: 'https://www.mynexthome.mt/long-let/' }), /approved/)
  assert.throws(() => A.validateRegistration({ adapter: 'anything', category: L, url: 'https://example.com/' }), /adapter/)
})
test('public-address check rejects private, loopback, link-local, CGNAT and ULA ranges', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.equal(F.isPublicAddress(ip), false, ip)
  for (const ip of ['178.104.162.193', '8.8.8.8', '2a00:1450:4001::1']) assert.equal(F.isPublicAddress(ip), true, ip)
})
test('vetted lookup refuses IP literals and hosts that resolve to private space', async () => {
  await assert.rejects(new Promise((res, rej) => F.vettedLookup('127.0.0.1', {}, e => (e ? rej(e) : res()))), /IP-literal/)
  await assert.rejects(new Promise((res, rej) => F.vettedLookup('localhost', {}, e => (e ? rej(e) : res()))), /non-public|ENOTFOUND|EAI_AGAIN/)
})
test('redirects are re-validated on every hop; off-list hops fail', async () => {
  const hops = { 'https://www.mynexthome.mt/long-let/': { status: 301, headers: { location: 'https://mynexthome.mt/long-let' } },
                 'https://www.mynexthome.mt/long-let/#2': null }
  let n = 0
  const ok = await F.fetchAllowed('https://www.mynexthome.mt/long-let/', M, { request: async url => (n++ === 0 ? hops[url] : { status: 200, headers: { 'content-type': 'text/html' }, body: '<a>ok</a>' }) })
  assert.equal(ok.status, 200); assert.equal(ok.finalUrl, 'https://www.mynexthome.mt/long-let/')
  for (const loc of ['http://www.mynexthome.mt/long-let/', 'https://evil.com/', 'https://127.0.0.1/', 'https://169.254.169.254/latest'])
    await assert.rejects(F.fetchAllowed('https://www.mynexthome.mt/long-let/', M, { request: async () => ({ status: 302, headers: { location: loc } }) }))
  let loops = 0
  await assert.rejects(F.fetchAllowed('https://www.mynexthome.mt/long-let/', M, { request: async () => { loops++; return { status: 302, headers: { location: '/long-let/' } } } }), /Redirect limit/)
  assert.equal(loops, 4)
  await assert.rejects(F.fetchAllowed('https://www.mynexthome.mt/long-let/', M, { request: async () => ({ status: 403, headers: {} }) }), /refused/)
  await assert.rejects(F.fetchAllowed('https://www.mynexthome.mt/long-let/', M, { request: async () => ({ status: 200, headers: { 'content-type': 'application/zip' }, body: 'PK' }) }), /content type/)
})
test('conditional requests send ETag / If-Modified-Since and honour 304', async () => {
  let seen
  const r = await F.fetchAllowed('https://www.mynexthome.mt/long-let/', M, { conditional: { etag: '"abc"', lastModified: 'Mon, 09 Nov 2026 08:00:00 GMT' }, request: async (u, o) => { seen = o.headers; return { status: 304, headers: {} } } })
  assert.equal(r.status, 304); assert.equal(seen['If-None-Match'], '"abc"'); assert.ok(seen['If-Modified-Since'])
})
test('robots.txt is respected', async () => {
  assert.equal(F.robotsAllows('User-agent: *\nDisallow: /wp-admin/', '/long-let/'), true)
  assert.equal(F.robotsAllows('User-agent: *\nDisallow: /', '/long-let/'), false)
  assert.equal(F.robotsAllows('User-agent: *\nDisallow: /\nAllow: /long-let/', '/long-let/'), true)
  assert.equal(F.robotsAllows('User-agent: ARGUS-SourceSync\nDisallow: /directory-apartments/\n\nUser-agent: *\nAllow: /', '/directory-apartments/listing/x/'), false)
  await assert.rejects(F.checkRobots(M, ['/long-let/'], { request: async () => ({ status: 200, body: 'User-agent: *\nDisallow: /long-let/' }) }), /Disallowed/)
  await assert.rejects(F.checkRobots(M, ['/long-let/'], { request: async () => ({ status: 503, body: '' }) }), /5xx/)
  assert.equal(await F.checkRobots(M, ['/long-let/'], { request: async () => ({ status: 404, body: '' }) }), true)
})

// ── extraction (13–16) ─────────────────────────────────────────────────────
test('13 category links: approved section only, deduplicated, foreign hosts dropped', () => {
  const html = '<a href="/directory-apartments/listing/unit-a/">A</a><a href="/directory-apartments/listing/unit-a?x=1">A</a><a href="https://evil.com/directory-apartments/listing/unit-z/">X</a><a href="/short-let/">S</a><a href=\'/directory-apartments/listing/unit-b\'>B</a>'
  assert.deepEqual(A.linksFromCategory(html, 'https://www.mynexthome.mt/long-let/', M), ['https://www.mynexthome.mt/directory-apartments/listing/unit-a/', 'https://www.mynexthome.mt/directory-apartments/listing/unit-b/'])
})
const DETAIL = `<html><head><script>var p="€ 999 monthly"</script><style>.x{}</style></head><body><header><nav>For Sale Long Let Short Let</nav></header>
<h1>Hamrun 2-bedroom 3rd Floor Apartment</h1><button>Short Let</button><button>For Sale</button><button>Long Let</button>
<div class="price">&euro; 1,600 monthly</div><p>Property Address:</p><p>49 Blue Hues Apartment 3</p>
<section>Available 01/11/2026<br>Bedrooms<br>2<br>Bathrooms<br>2<br>Total area<br>69.2 sqm</section>
<p>Rent: € 1,600 monthly</p><p>WiFi 50€ monthly</p><img src="/wp-content/uploads/2026/10/a.jpg"><img src="https://cdn.other.com/b.jpg">
<footer>© My Next Home · Rent from € 400 monthly</footer></body></html>`
test('14 category comes from the source collection despite Short Let / For Sale buttons', () => {
  const item = A.parseDetail(DETAIL, 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  assert.equal(item.category, 'long_let'); assert.equal(item.price.amount, '1600'); assert.equal(item.price.conflict, false)
  assert.equal(item.bedrooms, 2); assert.equal(item.bathrooms, 2); assert.equal(item.total_area_sqm, 69.2)
  assert.equal(item.available_date, '2026-11-01'); assert.equal(item.locality, 'Hamrun'); assert.equal(item.property_type, 'apartment')
  assert.equal(item.private_address_candidate, '49 Blue Hues Apartment 3')
  assert.deepEqual(item.media_source_urls, ['https://www.mynexthome.mt/wp-content/uploads/2026/10/a.jpg'])
  assert.equal(item.market_country, 'MALTA')
})
test('15 sale collection stays sale even with a Long Let button', () => {
  const item = A.parseDetail('<h1>Bugibba First Floor Apartment</h1><button>Long Let</button><p>€ 255,000</p>', 'https://www.mynexthome.mt/directory-apartments/listing/sale-a/', S, M)
  assert.equal(item.category, 'sale'); assert.equal(item.price.amount, '255000'); assert.equal(item.price.basis, 'EUR_SALE'); assert.equal(item.locality, 'Bugibba')
})
test('16 prose about “rented” never sets a rented state', () => {
  const item = A.parseDetail('<h1>Some Flat</h1><p>Rented three years ago.</p><p>€ 1,200 monthly</p>', 'https://www.mynexthome.mt/directory-apartments/listing/flat/', L, M)
  assert.equal(item.availability_state, 'SOURCE_LISTED_UNVERIFIED')
})
test('international listing on the Sales page is flagged OUTSIDE_MALTA', () => {
  const item = A.parseDetail('<h1>Tripoli Commercial Building</h1><p>Located in Tripoli, Libya</p><p>€ 1,200,000</p>', 'https://www.mynexthome.mt/directory-apartments/listing/tripoli/', S, M)
  assert.equal(item.market_country, 'OUTSIDE_MALTA'); assert.equal(item.locality, 'Tripoli')
})
test('detail pages outside the listing section and unsupported categories are refused', () => {
  assert.throws(() => A.parseDetail('<h1>x</h1>', 'https://www.mynexthome.mt/about/', L, M), /section/)
  assert.throws(() => A.parseDetail('<h1>x</h1>', 'https://www.mynexthome.mt/directory-apartments/listing/a/', 'short_let', M), /category/)
})
test('fingerprint ignores page chrome; watched fields drive change classes', () => {
  const a = A.parseDetail(DETAIL, 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  const b = A.parseDetail(DETAIL.replace('© My Next Home', '© 2027 My Next Home Ltd'), 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  assert.equal(A.fingerprint(a), A.fingerprint(b))
  const price = A.parseDetail(DETAIL.replace(/1,600/g, '1,550'), 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  assert.equal(A.classifyChange(A.fieldChanges(a, price)), 'PRICE_UPDATED')
  const avail = A.parseDetail(DETAIL.replace('01/11/2026', '01/12/2026'), 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  assert.equal(A.classifyChange(A.fieldChanges(a, avail)), 'AVAILABILITY_CHANGED')
  const photos = A.parseDetail(DETAIL.replace('a.jpg">', 'a.jpg"><img src="/wp-content/uploads/2026/10/c.jpg">'), 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  assert.equal(A.classifyChange(A.fieldChanges(a, photos)), 'MEDIA_CHANGED')
  const baths = A.parseDetail(DETAIL.replace('Bathrooms<br>2', 'Bathrooms<br>1'), 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  assert.equal(A.classifyChange(A.fieldChanges(a, baths)), 'DETAILS_CHANGED')
})
test('sanitized preview hides private address, media URLs and evidence prose', () => {
  const item = A.parseDetail(DETAIL, 'https://www.mynexthome.mt/directory-apartments/listing/unit-a/', L, M)
  const s = JSON.stringify(A.sanitizedPreview(item))
  assert.ok(!s.includes('Blue Hues')); assert.ok(!s.includes('wp-content')); assert.ok(!s.includes('Rent: €'))
})
