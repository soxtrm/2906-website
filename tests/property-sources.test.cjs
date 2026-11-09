'use strict'
// Property Sources dashboard — real Chromium against the real Next.js page,
// /api/crm/* intercepted with backend-shaped responses (no production data,
// no production requests). Requires `next dev` on http://localhost:3000.
//   CRM_BASE=http://localhost:3000 node --test tests/property-sources.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer')

const BASE = process.env.CRM_BASE || 'http://localhost:3000'
const OUT = path.join(__dirname, 'screenshots', 'property-sources')
fs.mkdirSync(OUT, { recursive: true })

const now = '2026-11-09T21:30:00.000Z'
const src = (id, category, extra = {}) => ({
  id, adapter: 'mynexthome', label: `My Next Home · ${category === 'sale' ? 'For Sale' : 'Long Let'}`, provider_name: 'My Next Home', category,
  url: `https://www.mynexthome.mt/${category === 'sale' ? 'for-sale' : 'long-let'}/`, read_permission: 'NOT_RECORDED', permission_reference: null, permission_recorded_at: null,
  media_use: 'LINK_ONLY', text_use: 'METADATA_ONLY', import_mode: 'REVIEW_REQUIRED', sync_enabled: false, interval_hours: 24, next_check_at: null,
  last_check_at: now, last_success_at: now, last_error: null, consecutive_failures: 0, complete_scan_count: 1, version: 3,
  polling_allowed: false, polling_blockers: ['Provider read/sync permission is not recorded', 'No permission evidence reference'], pending: { new: 0, updated: 0, check: 0 }, ...extra,
})
const snap = (title, amount, extra = {}) => ({ external_id: title.replace(/\W/g, '').slice(0, 20), source_url: `https://www.mynexthome.mt/directory-apartments/listing/${title.toLowerCase().replace(/\W+/g, '-')}/`,
  title, category: 'long_let', locality: title.split(' ')[0], bedrooms: 2, bathrooms: 1, available_from_source: '01/12/2026', total_area_sqm: 70,
  price: { amount, basis: 'EUR_MONTH', conflict: false, quote_count: 1 }, market_country: 'MALTA', ...extra })
function state() {
  const events = [
    { id: 11, source_id: 1, source_label: 'My Next Home · Long Let', category: 'long_let', event_type: 'NEW', fingerprint: 'f11', status: 'PENDING', flags: ['PRICE_CONFLICT'],
      current: snap('Sliema 2-bedroom Apartment', '1400', { price: { amount: '1400', basis: 'EUR_MONTH', conflict: true, quote_count: 2 } }), previous: null, field_changes: {},
      match_candidates: [{ kind: 'property', id: 501, ref: 'P-501', town: 'Sliema', bedrooms: 2, price: 1450, reasons: ['same locality', 'same bedrooms', 'price within 15%'] }], created_at: now, stale: false },
    { id: 12, source_id: 1, source_label: 'My Next Home · Long Let', category: 'long_let', event_type: 'NEW', fingerprint: 'f12', status: 'PENDING', flags: [],
      current: snap('Gzira 1-bedroom Apartment', '1100'), previous: null, field_changes: {}, match_candidates: [], created_at: now, stale: false },
    { id: 13, source_id: 1, source_label: 'My Next Home · Long Let', category: 'long_let', event_type: 'PRICE_UPDATED', fingerprint: 'f13', status: 'PENDING', flags: [],
      current: snap('Hamrun 2-bedroom 3rd Floor Apartment', '1400'), previous: snap('Hamrun 2-bedroom 3rd Floor Apartment', '1500'),
      field_changes: { price_amount: { previous: '1500', current: '1400' } }, match_candidates: [], created_at: now, stale: false },
    { id: 14, source_id: 1, source_label: 'My Next Home · Long Let', category: 'long_let', event_type: 'MISSING_FROM_SOURCE', fingerprint: 'f14:missing', status: 'PENDING', flags: ['VERIFY_WITH_PROVIDER'],
      current: snap('Hamrun 1-bedroom 1st Floor Maisonette', '1300'), previous: null, field_changes: {}, match_candidates: [], created_at: now, stale: false },
  ]
  return { events, posts: [], sources: [src(1, 'long_let', { pending: { new: 2, updated: 1, check: 1 } }), src(2, 'sale')] }
}

async function mount(page, s) {
  await page.setRequestInterception(true)
  page.on('request', req => {
    const u = new URL(req.url())
    if (!u.pathname.startsWith('/api/crm/')) return req.continue()
    const p = u.pathname.replace('/api/crm/', ''), m = req.method()
    const json = (body, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === 'me') return json({ agent: { id: 1, username: 'admin', name: 'Kevin', role: 'admin', email: 'a@b' }, reveals: { used: 0, limit: 50 } })
    if (p === 'property-sources/summary') {
      const pending = s.events.filter(e => e.status === 'PENDING')
      const totals = { new: pending.filter(e => e.event_type === 'NEW').length, updated: pending.filter(e => /UPDATED|CHANGED/.test(e.event_type)).length, check: pending.filter(e => e.event_type === 'MISSING_FROM_SOURCE').length }
      s.sources[0].pending = totals
      return json({ sources: s.sources, totals, digests: [{ id: 99, createdAt: now, source_id: 1, scan_id: 5, label: 'My Next Home · Long Let', counts: { new: 2, price_updated: 1, availability_changed: 0, details_changed: 0, media_changed: 0, missing: 1 } }] })
    }
    if (p === 'property-sources/events') {
      const st = u.searchParams.get('status'), ty = u.searchParams.get('type')
      return json(s.events.filter(e => (st === 'ALL' || (st === 'OPEN' ? ['PENDING', 'CLARIFICATION'].includes(e.status) : e.status === st)) && (!ty || e.event_type === ty)))
    }
    let mm
    if ((mm = /^property-sources\/events\/(\d+)$/.exec(p))) {
      const e = s.events.find(x => x.id === Number(mm[1]))
      return json({ ...e, current: { ...e.current, private_address_candidate: e.id === 11 ? '12 Tower Road, Flat 4' : null, price: e.id === 11 ? { amount: '1400', basis: 'EUR_MONTH', candidate_prices: [{ amount: '1500', basis: 'EUR_MONTH', evidence: '€ 1,500 monthly' }, { amount: '1400', basis: 'EUR_MONTH', evidence: 'Rent: € 1,400 monthly' }] } : e.current.price },
        provider_name: 'My Next Home', first_seen_at: now, last_seen_at: now, missing_scan_count: 0, property: null,
        privacy: { address: e.id === 11 ? 'PRIVATE — admin only, never shared or published' : null }, media: { use: 'LINK_ONLY', count: 9, urls: [], note: 'Link only' } })
    }
    if ((mm = /^property-sources\/events\/(\d+)\/(accept|reject|link|clarify|acknowledge)$/.exec(p)) && m === 'POST') {
      const body = JSON.parse(req.postData() || '{}'); s.posts.push({ id: Number(mm[1]), action: mm[2], body })
      const e = s.events.find(x => x.id === Number(mm[1])); e.status = { accept: 'ACCEPTED', reject: 'REJECTED', link: 'LINKED', clarify: 'CLARIFICATION', acknowledge: 'ACKNOWLEDGED' }[mm[2]]
      return json({ event: e, result: { action: mm[2], propertyId: 900, staged: true } })
    }
    if ((mm = /^property-sources\/sources\/(\d+)\/scans$/.exec(p))) return json([{ id: 5, trigger: 'SNAPSHOT', started_at: now, finished_at: now, status: 'SUCCEEDED', complete: true, items_seen: 4, counts: { new: 2, price_updated: 1, missing: 1 }, error: null },
      { id: 4, trigger: 'MANUAL', started_at: now, finished_at: now, status: 'FAILED', complete: false, items_seen: null, counts: {}, error: 'Provider refused access (HTTP 403); backing off' }])
    if ((mm = /^property-sources\/sources\/(\d+)$/.exec(p)) && m === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}'); s.posts.push({ id: Number(mm[1]), action: 'patch', body })
      const so = s.sources.find(x => x.id === Number(mm[1]))
      if (body.sync_enabled && !so.polling_allowed) return json({ error: 'Automatic checking needs the provider’s recorded read/sync permission', code: 'PERMISSION_REQUIRED' }, 403)
      if (body.interval_hours) so.interval_hours = body.interval_hours
      so.version++
      return json(so)
    }
    return json({ error: 'not mocked ' + p }, 404)
  })
}

for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['small', 360, 780]]) {
  test(`Property Sources dashboard works at ${label} ${width}px`, async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    const errors = []
    try {
      const page = await browser.newPage()
      await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 768, hasTouch: width < 768 })
      page.on('pageerror', e => errors.push(e.message))
      await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('argus_intro_seen', '1'); localStorage.setItem('crm_theme_pref', 'dark') } catch {} })
      const s = state(); await mount(page, s)
      await page.goto(`${BASE}/crm/property-sources`, { waitUntil: 'networkidle2', timeout: 120000 })
      await page.waitForSelector('[data-testid="property-sources"]', { timeout: 60000 })
      // Real counts from the (mocked) backend, the notification and the blocker.
      const kpi = await page.$eval('[data-testid="kpi-new"]', n => n.textContent)
      assert.match(kpi, /New\s*2/)
      assert.match(await page.$eval('[data-testid="sync-notice"]', n => n.textContent), /2 new listings detected/)
      assert.match(await page.$eval('[data-testid="source-1"] [data-testid="polling-blocker"]', n => n.textContent), /Connector disabled/)
      const runDisabled = await page.$eval('[data-testid="source-1"]', n => [...n.querySelectorAll('button')].find(b => /Run scan/.test(b.textContent)).disabled)
      assert.equal(runDisabled, true)
      assert.equal(await page.$$eval('[data-testid^="event-"]', n => n.length), 4)
      assert.ok(!(await page.content()).includes('12 Tower Road'), 'private address not in the list')
      await page.screenshot({ path: path.join(OUT, `queue-${width}.png`), fullPage: true })

      // Interval persists through the API (version-checked PATCH).
      await page.select('[data-testid="source-1"] select', '12')
      await page.waitForFunction(() => document.querySelector('[data-testid="toast"]')?.textContent.includes('Interval saved'))
      assert.deepEqual(s.posts.find(p => p.action === 'patch').body, { interval_hours: 12, version: 3 })

      // Scan history shows the honest failed run.
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="source-1"] button')].find(b => /Scan history/.test(b.textContent)).click())
      await page.waitForSelector('[data-testid="history-1"]')
      assert.match(await page.$eval('[data-testid="history-1"]', n => n.textContent), /incomplete — nothing marked missing/)

      // Preview → price conflict evidence → accept as staged draft.
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="event-11"] button')].find(b => /Preview/.test(b.textContent)).click())
      await page.waitForSelector('[data-testid="detail"]')
      const detailText = await page.$eval('[data-testid="detail"]', n => n.textContent)
      assert.match(detailText, /€1,400\/month/); assert.match(detailText, /PRICE CONFLICT/); assert.match(detailText, /€1,500 per month/)
      assert.match(detailText, /private, admin only/); assert.match(detailText, /link only/); assert.match(detailText, /P-501/)
      await page.screenshot({ path: path.join(OUT, `detail-${width}.png`) })
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="detail"] button')].find(b => /Accept as staged draft/.test(b.textContent)).click())
      await page.waitForFunction(() => document.querySelector('[data-testid="toast"]')?.textContent.includes('staged ARGUS draft'))
      assert.deepEqual(s.posts.find(p => p.action === 'accept'), { id: 11, action: 'accept', body: { fingerprint: 'f11' } })

      // Missing listing: acknowledge only, never "rented".
      const missing = await page.$eval('[data-testid="event-14"]', n => n.textContent)
      assert.match(missing, /never marked rented/); assert.ok(!/Accept/.test(missing.replace('Noted', '')))
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="event-14"] button')].find(b => /Noted/.test(b.textContent)).click())
      await page.waitForFunction(() => !document.querySelector('[data-testid="event-14"]'))

      // Price change row shows old → new.
      assert.match(await page.$eval('[data-testid="event-13"]', n => n.textContent), /€1,500 → €1,400/)
      // No horizontal overflow at this width.
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow')
      await page.screenshot({ path: path.join(OUT, `after-${width}.png`), fullPage: true })
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  })
}
