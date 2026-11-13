// Browser test of ARGUS Incoming Properties against a local dev server.
// /api/crm/* is answered from a fixture captured from the production intake API
// (real records, admin view), so no login and no write reaches production.
// Writes are simulated and asserted on the request the UI sends.
const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')
const FX = JSON.parse(fs.readFileSync(process.env.INTAKE_FIXTURE || path.join(__dirname, 'intake-fixture.json'), 'utf8'))
const OUT = process.env.INTAKE_EVIDENCE || path.join(__dirname, 'evidence-inbox'); fs.mkdirSync(OUT, { recursive: true })
const BASE = 'http://crm.localhost:3123'
const me = { agent: { id: 1, username: 'kev', name: 'Kevin', role: 'admin', email: 'x', daily_reveal_limit: 0 }, reveals: { used: 0, limit: 0 } }
const state = { verified: new Set(), posts: [] }
const items = filter => {
  const list = (FX[`items_${filter}`] || { items: [] }).items
  return list.filter(i => !(i.kind === 'property' && state.verified.has(i.id)))
}
function answer(url, method, body) {
  const u = new URL(url); const p = u.pathname.replace(/^\/api\/crm\//, '')
  if (method === 'POST') {
    state.posts.push({ p, body })
    const m = p.match(/^intake\/items\/(\d+)\/verify$/)
    if (m) {
      const d = FX.detail[m[1]].item
      const edits = (body && body.edits) || {}
      if ((d.rent == null && d.sale == null) && !edits.longlet_price && !edits.sale_price) return [422, { error: 'Add price before verifying', missing: [{ field: 'price', label: 'Price', critical: true }] }]
      state.verified.add(Number(m[1])); return [200, { ok: true }]
    }
    return [200, { ok: true }]
  }
  if (p === 'me') return [200, me]
  if (p === 'stats') return [200, { totalListings: 1768, myListings: 12, hotOwners: 41, recent: [] }]
  if (p === 'intake/summary') { const s = JSON.parse(JSON.stringify(FX.summary)); s.counts.needs_verification -= state.verified.size; s.counts.approved_today += state.verified.size; return [200, s] }
  if (p === 'intake/feed') return [200, FX.feed]
  if (p === 'intake/items') return [200, { items: items(u.searchParams.get('filter') || 'needs_verification') }]
  const d = p.match(/^intake\/items\/(\d+)$/)
  if (d) { const it = FX.detail[d[1]] || { item: (FX.items_needs_verification.items.find(i => i.id === Number(d[1]))) }; return it.item ? [200, { item: { ...it.item, canReview: true, suggestions: it.item.suggestions || [] } }] : [404, { error: 'nf' }] }
  if (p.startsWith('properties')) return [200, { properties: FX.inv.properties, total: FX.inv.total }]
  if (p === 'agents') return [200, { agents: [] }]
  if (p === 'locations') return [200, { locations: [] }]
  return [200, {}]
}

;(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const results = []
  const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }
  async function page(vp) {
    const pg = await browser.newPage()
    await pg.setViewport(vp)
    await pg.setRequestInterception(true)
    pg.on('request', r => {
      if (r.url().includes('/api/crm/')) {
        let body = null; try { body = r.postData() ? JSON.parse(r.postData()) : null } catch {}
        const [status, json] = answer(r.url(), r.method(), body)
        return r.respond({ status, contentType: 'application/json', body: JSON.stringify(json) })
      }
      r.continue()
    })
    pg.on('pageerror', e => console.log('PAGE ERROR', e.message))
    await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('crm_theme_pref', 'dark'); sessionStorage.setItem('argus_intro_seen', '1') } catch {} })
    return pg
  }
  const settle = pg => pg.waitForNetworkIdle({ idleTime: 600, timeout: 60000 }).catch(() => {})

  // 1. Dashboard — Your Properties of the Day (desktop)
  let pg = await page({ width: 1440, height: 1000 })
  await pg.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await pg.waitForSelector('.ib-potd-card', { timeout: 120000 })
  await settle(pg)
  const potd = await pg.$$eval('.ib-potd-card', els => els.map(e => e.getAttribute('href')))
  check('dashboard shows Properties of the Day cards', potd.length === 5, potd.join(' '))
  const lines = await pg.$$eval('.ib-potd-lines a', els => els.map(e => e.textContent))
  check('dashboard summary lines from real counts', lines.some(l => /Olga uploaded 1 property today/.test(l)) && lines.some(l => /5 need verification/.test(l)) && lines.some(l => /missing a price/.test(l)), lines.join(' | '))
  const badge = await pg.$eval('.crm-nav-count', e => e.textContent).catch(() => null)
  check('Incoming nav entry shows the pending count', badge === '5', String(badge))
  await pg.screenshot({ path: path.join(OUT, '01-dashboard-desktop.png'), fullPage: false })
  await pg.evaluate(() => document.querySelector('.ib-potd')?.scrollIntoView())
  await pg.screenshot({ path: path.join(OUT, '02-dashboard-potd-desktop.png') })

  // 2. Inbox desktop: queue + card
  await pg.goto(`${BASE}/incoming`, { waitUntil: 'domcontentloaded' })
  await pg.waitForSelector('.ib-card .ib-verify-badge', { timeout: 60000 }); await settle(pg)
  const rows = await pg.$$eval('.ib-row', els => els.length)
  check('inbox lists every pending property', rows === 5, String(rows))
  const warn = await pg.$eval('.ib-card .ib-verify-badge', e => [e.textContent, getComputedStyle(e).backgroundColor])
  check('unverified card shows an orange "Verification required" badge (not green)', /Verification required/.test(warn[0]) && /232, 89, 12/.test(warn[1]), warn.join(' '))
  await pg.screenshot({ path: path.join(OUT, '03-inbox-desktop.png') })

  // 3. Missing price: Approve is refused, the edit form opens with the reason
  await pg.goto(`${BASE}/incoming?id=29750`, { waitUntil: 'domcontentloaded' })
  await pg.waitForFunction(() => document.querySelector('.ib-card .ib-ref')?.textContent?.includes('2906-9708'), { timeout: 60000 })
  await settle(pg); await new Promise(r => setTimeout(r, 800))
  await pg.click('.ib-main-actions .ib-btn.primary')
  await pg.waitForSelector('.ib-form-error', { timeout: 10000 })
  const err = await pg.$eval('.ib-form-error', e => e.textContent)
  check('Approve without a price opens Edit with the missing field', /price/i.test(err), err)
  await pg.screenshot({ path: path.join(OUT, '04-missing-price-edit.png') })
  const rentInput = (await pg.$$('.ib-form .ib-grid input'))[1]
  await rentInput.click({ clickCount: 3 }); await rentInput.type('1950')
  await pg.click('.ib-form button[type=submit]')
  await pg.waitForSelector('.ib-toast.ok', { timeout: 10000 })
  const sent = state.posts.at(-1)
  check('Edit & approve sends the corrected price to the verify endpoint', sent.p === 'intake/items/29750/verify' && sent.body.edits.longlet_price === '1950', JSON.stringify(sent))
  await new Promise(r => setTimeout(r, 1200))
  const rowsAfter = await pg.$$eval('.ib-row', els => els.length)
  check('approved property leaves the queue and the next one is shown', rowsAfter === 4, String(rowsAfter))

  // 4. Mobile 390: dashboard rail + deck with prev/next and one-tap approve
  pg = await page({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await pg.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await pg.waitForSelector('.ib-potd-card', { timeout: 60000 }); await settle(pg); await new Promise(r => setTimeout(r, 3500))
  await pg.evaluate(() => document.querySelector('.ib-potd')?.scrollIntoView())
  await pg.screenshot({ path: path.join(OUT, '05-dashboard-mobile.png') })
  await pg.goto(`${BASE}/incoming?id=29749`, { waitUntil: 'domcontentloaded' })
  await pg.waitForFunction(() => document.querySelector('.ib-card .ib-ref')?.textContent?.includes('2906-9707'), { timeout: 60000 }); await settle(pg)
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('mobile inbox has no horizontal page scroll', overflow <= 1, String(overflow))
  const photoCount = await pg.$eval('.ib-photo-count', e => e.textContent)
  check('Rabat card shows all 38 photos', /\/ 38/.test(photoCount), photoCount)
  const tap = await pg.$eval('.ib-main-actions .ib-btn.primary', e => { const r = e.getBoundingClientRect(); return [r.width, r.height] })
  check('primary action is a full-width, thumb-sized button', tap[0] > 300 && tap[1] >= 44, tap.join('x'))
  await pg.screenshot({ path: path.join(OUT, '06-inbox-mobile-card.png') })
  await pg.evaluate(() => document.querySelector('.ib-main-actions')?.scrollIntoView({ block: 'center' }))
  await pg.screenshot({ path: path.join(OUT, '07-inbox-mobile-actions.png') })
  const before = await pg.$eval('.ib-card .ib-ref', e => e.textContent)
  await pg.click('.ib-deck-head button[aria-label="Next property"]')
  await pg.waitForFunction(b => document.querySelector('.ib-card .ib-ref')?.textContent !== b, { timeout: 15000 }, before)
  check('Next moves to the following property', true, before + ' → ' + await pg.$eval('.ib-card .ib-ref', e => e.textContent))
  await pg.click('.ib-main-actions .ib-btn:nth-child(4)')   // Link existing
  await pg.waitForSelector('.ib-form', { timeout: 5000 })
  await pg.screenshot({ path: path.join(OUT, '08-mobile-link-existing.png') })

  // 5. Inventory pending verification tab + badge
  pg = await page({ width: 1440, height: 900 })
  await pg.goto(`${BASE}/inventory`, { waitUntil: 'domcontentloaded' })
  await pg.waitForFunction(() => [...document.querySelectorAll('button')].some(b => /Pending verification/.test(b.textContent || '')), { timeout: 60000 })
  await pg.evaluate(() => [...document.querySelectorAll('button')].find(b => /Pending verification/.test(b.textContent || ''))?.click())
  await pg.waitForSelector('.inv-verify-badge', { timeout: 30000 }); await settle(pg)
  const invBadges = await pg.$$eval('.inv-verify-badge', els => els.map(e => e.textContent))
  check('Inventory "Pending verification" shows the drafts with the warning badge', invBadges.length >= 4 && invBadges.every(t => /VERIFY/.test(t)), String(invBadges.length))
  await pg.screenshot({ path: path.join(OUT, '09-inventory-pending.png') })

  // 6. light mode check of the card
  pg = await page({ width: 1280, height: 900 })
  await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('crm_theme_pref', 'light') } catch {} })
  await pg.goto(`${BASE}/incoming?id=29752`, { waitUntil: 'domcontentloaded' })
  await pg.waitForSelector('.ib-card .ib-verify-badge', { timeout: 60000 }); await settle(pg)
  await pg.screenshot({ path: path.join(OUT, '10-inbox-light.png') })

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  await browser.close()
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
