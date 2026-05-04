'use strict'
const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'

async function run() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  const pass = []
  const fail = []
  const jsErrors = []

  page.on('pageerror', err => jsErrors.push(err.message))
  page.on('console', msg => {
    if (msg.type() === 'error') jsErrors.push('[console.error] ' + msg.text())
  })

  const MOCK_AGENTS = [
    { id: 1, username: 'kev',    display_name: 'Kev',    color_hex: '#D4AF37', whatsapp_phone: '35699811819', display_order: 1 },
    { id: 2, username: 'olga',   display_name: 'Olga',   color_hex: '#3B82F6', whatsapp_phone: '35679010070', display_order: 2 },
    { id: 3, username: 'tatyana',display_name: 'Tatyana',color_hex: '#EC4899', whatsapp_phone: '35677535977', display_order: 3 },
  ]

  const MOCK_EVENTS = [
    {
      id: 1, agent_id: 1, client_id: null, client_name: 'Maria Borg', client_nationality: 'MT',
      client_phone: '99001122', event_type: 'viewing', title: 'Viewing - Maria Borg',
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      duration_minutes: 30, address: '5 Triq il-Qaliet, Sliema', maps_link: null, comment: 'Bring keys',
      agent_color: '#D4AF37'
    }
  ]

  const MOCK_CLIENTS = [
    { id: 'uuid-1', name: 'Maria Borg',   nationalities: ['MT'], phone: '99001122' },
    { id: 'uuid-2', name: 'James Smith',  nationalities: ['GB'], phone: '99002233' },
    { id: 'uuid-3', name: 'Anna Müller',  nationalities: ['DE'], phone: '99003344' },
  ]

  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = req.url()
    if (url.includes('/api/agents')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_AGENTS) })
    } else if (url.includes('/api/calendar')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_EVENTS) })
    } else if (url.includes('/api/clients')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_CLIENTS) })
    } else {
      req.continue()
    }
  })

  const waitMs = ms => page.evaluate(n => new Promise(r => setTimeout(r, n)), ms)

  async function check(name, fn) {
    try {
      await fn(page)
      pass.push(name)
    } catch (e) {
      fail.push(`${name}: ${e.message}`)
      await page.screenshot({ path: `tests/screenshots/${name.replace(/\W/g, '_')}.png` }).catch(() => {})
    }
  }

  // ── Tests ───────────────────────────────────────────────────────────────

  await check('calendar_interna page loads', async p => {
    await p.goto(`${BASE}/en/calendar_interna`, { waitUntil: 'networkidle2', timeout: 20000 })
    await p.waitForSelector('main, .rbc-calendar, [class*="Calendar"]', { timeout: 10000 })
  })

  await check('no JS errors on load', async p => {
    await waitMs(500)
    const errs = jsErrors.filter(e =>
      !e.includes('net::ERR') &&
      !e.includes('favicon') &&
      !e.includes('_next') &&
      !e.includes('ChunkLoad')
    )
    if (errs.length > 0) throw new Error('JS errors: ' + errs.slice(0, 3).join('; '))
  })

  await check('page shows agent name Kev', async p => {
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Kev')) throw new Error('"Kev" not found on calendar page')
  })

  await check('all 3 mock agents shown in tab bar', async p => {
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Kev')) throw new Error('"Kev" tab missing')
    if (!text.includes('Olga')) throw new Error('"Olga" tab missing')
    if (!text.includes('Tatyana')) throw new Error('"Tatyana" tab missing')
  })

  await check('week switcher shows This Week / Next Week / Week +2', async p => {
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('This Week')) throw new Error('"This Week" button not found')
    if (!text.includes('Next Week')) throw new Error('"Next Week" button not found')
    if (!text.includes('Week +2')) throw new Error('"Week +2" button not found')
  })

  await check('react-big-calendar renders (.rbc-calendar)', async p => {
    await p.waitForSelector('.rbc-calendar', { timeout: 8000 })
  })

  await check('calendar shows event from mock data', async p => {
    await waitMs(300)
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Maria Borg') && !text.includes('Viewing')) {
      throw new Error('Mock event "Maria Borg / Viewing" not visible in calendar')
    }
  })

  await check('client list renders with search box', async p => {
    const hasSearch = await p.$('input[placeholder*="Search"]')
    if (!hasSearch) throw new Error('Search input not found in client list')
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('Maria Borg')) throw new Error('"Maria Borg" not in client list')
    if (!text.includes('James Smith')) throw new Error('"James Smith" not in client list')
  })

  await check('client list shows nationality flags', async p => {
    const text = await p.evaluate(() => document.body.innerText)
    // Malta flag 🇲🇹 or GB flag 🇬🇧 — at least one should be present
    if (!text.includes('🇲🇹') && !text.includes('🇬🇧') && !text.includes('🇩🇪')) {
      throw new Error('No nationality flags found in client list')
    }
  })

  await check('click Olga tab switches agent', async p => {
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => b.textContent?.trim() === 'Olga')
      if (btn) btn.click()
      else throw new Error('Olga tab button not found')
    })
    await waitMs(400)
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes("Olga")) throw new Error('"Olga" not visible after tab click')
  })

  await check('click Next Week changes week offset', async p => {
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('Next Week'))
      if (btn) btn.click()
      else throw new Error('Next Week button not found')
    })
    await waitMs(400)
    // Calendar should still be visible after switching weeks
    await p.waitForSelector('.rbc-calendar', { timeout: 5000 })
  })

  await check('New Event button opens edit modal', async p => {
    // Switch back to This Week first
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => (b.textContent || '').includes('This Week'))
      if (btn) btn.click()
    })
    await waitMs(300)
    // Click the New Event button
    const btn = await p.$('[data-testid="new-event-btn"]')
    if (!btn) throw new Error('"New Event" button not found')
    await btn.click()
    await waitMs(500)
    // Check for modal with datetime-local input
    const modal = await p.$('input[type="datetime-local"]')
    if (!modal) throw new Error('Edit modal with datetime input not opened')
  })

  await check('edit modal has address, duration, comment fields', async p => {
    // Modal should already be open from previous test
    const modal = await p.$('input[type="datetime-local"]')
    if (!modal) throw new Error('Modal not open')
    const text = await p.evaluate(() => document.body.innerText.toLowerCase())
    if (!text.includes('address')) throw new Error('Address field missing in modal')
    if (!text.includes('duration') && !text.includes('min')) throw new Error('Duration field missing in modal')
    if (!text.includes('comment')) throw new Error('Comment field missing in modal')
    // Cancel modal
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const btn = btns.find(b => b.textContent?.trim() === 'Cancel')
      if (btn) btn.click()
    })
    await waitMs(300)
  })

  await check('internal page not linked in nav', async p => {
    await p.goto(`${BASE}/en`, { waitUntil: 'networkidle2', timeout: 15000 })
    const hrefs = await p.$$eval('a', els => els.map(a => a.getAttribute('href') || ''))
    const calLink = hrefs.find(h => h.includes('calendar_interna'))
    if (calLink) throw new Error('calendar_interna link found in navigation — should be hidden')
  })

  await check('robots.txt disallows calendar_interna', async p => {
    await p.goto(`${BASE}/robots.txt`, { waitUntil: 'networkidle2', timeout: 10000 })
    const text = await p.evaluate(() => document.body.innerText)
    if (!text.includes('calendar_interna')) throw new Error('calendar_interna not in robots.txt Disallow')
  })

  await browser.close()

  console.log(`\nPASS: ${pass.length}  FAIL: ${fail.length}`)
  pass.forEach(p => console.log('  ✓', p))
  if (fail.length) {
    fail.forEach(f => console.error('  ✗', f))
    process.exit(1)
  }
}

run()
