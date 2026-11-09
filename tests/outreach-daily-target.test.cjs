// Claude, 2026-11-09 — Outreach daily target control (recovery spec "Outreach
// Control"). Mocked CRM API only: no backend, no WhatsApp. Run against a local
// dev server: OUTREACH_URL=http://127.0.0.1:4291/crm/outreach node tests/outreach-daily-target.test.cjs
const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const URL = process.env.OUTREACH_URL || 'http://127.0.0.1:4291/crm/outreach'
const OUT = process.env.EVIDENCE_DIR || path.join(__dirname, '..', 'ops', 'owner-intelligence', 'evidence', '2026-11-09')
const accounts = [['default', 'Kev primary'], ['Cedric', 'Cedric'], ['Gabriela', 'Gabriela']].map(([sessionName, label], index) => ({
  id: index + 1, sessionName, label, phone: `3569900000${index}`, connected: true, lastOutreachAt: null, pool: 'top',
  outreachVolumePercent: 30, outreachPaceMin: 30, outreachPaceMax: 30, outreachVolumeUntil: null, outreachAutoBaseCount: null, outreachAutoMessage: '',
  active: true, outreachEnabled: true, outreachEligible: true, dailyTargetMin: 15, dailyTargetMax: 25, persona: index === 0 ? 'kev' : sessionName.toLowerCase(),
  quotaToday: { day: '2026-11-10', target: 20, cap: 40, used: 0, sent: 0, remaining: 40, remainingToTarget: 20 },
}))
const planRows = ['TODAY', 'TOMORROW', 'IN_2_DAYS', 'IN_3_DAYS', 'IN_4_DAYS'].map((label, index) => ({
  id: index + 1, account_id: 1, session_name: 'default', scheduled_date: `2026-11-${10 + index}`, scheduled_at: null, status: 'draft', armed: false,
  message_template: null, label, stats: { total: 0, eligible: 0, hot: 0, cold: 0, skip: 0, sent: 0 }, entries: [],
}))

async function run(width) {
  accounts[0].dailyTargetMin = 15; accounts[0].dailyTargetMax = 25   // each width starts from the same saved state
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROME_PATH || undefined })
  const page = await browser.newPage()
  await page.setViewport({ width, height: 860, deviceScaleFactor: 2, isMobile: width < 768, hasTouch: width < 768 })
  const posts = []
  let accountsServed = 0
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = request.url()
    const json = body => request.respond({ contentType: 'application/json', body: JSON.stringify(body) })
    if (request.method() === 'POST') {
      posts.push({ url, body: JSON.parse(request.postData() || '{}') })
      if (url.endsWith('/daily-target')) {
        const b = JSON.parse(request.postData() || '{}')
        accounts[0].dailyTargetMin = Math.max(1, b.target - b.variation); accounts[0].dailyTargetMax = Math.min(40, b.target + b.variation)
        return json({ ok: true, target: b.target, variation: b.variation, min: accounts[0].dailyTargetMin, max: accounts[0].dailyTargetMax, cap: 40, savedAt: '2026-11-10T13:30:00Z' })
      }
      return json({ ok: true })
    }
    if (url.endsWith('/api/crm/me')) return json({ agent: { id: 1, username: 'kevin', email: '', name: 'Kevin', role: 'admin', daily_reveal_limit: 50 }, reveals: { used: 0, limit: 50 } })
    if (url.endsWith('/api/crm/outreach/accounts')) { accountsServed++; return json({ accounts }) }
    if (url.endsWith('/api/crm/outreach/today-summary')) return json({ unique_owners: 0, total_sends: 0, perAccount: [] })
    if (url.endsWith('/api/crm/outreach/due-reminders')) return json({ rows: [], perAccount: [] })
    if (url.endsWith('/api/crm/outreach/owner-recheck')) return json({ mode: 'REVIEW_ONLY', tasks: [] })
    if (url.endsWith('/api/crm/outreach/templates')) return json({ templates: [] })
    if (url.includes('/api/crm/outreach/plans?')) return json({ plans: planRows })
    if (url.includes('/api/crm/')) return json({ plan: { entries: [] }, templates: [], rows: [] })
    request.continue()
  })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
  await page.waitForSelector('.account-daily-target', { timeout: 60000 })
  await page.waitForFunction(() => !document.querySelector('.argus-intro'), { timeout: 20000 }).catch(() => {})
  const input = '.account-daily-target input[type="text"]'
  const status = '.account-daily-target [role="status"]'

  assert.equal(await page.$eval(input, el => el.value), '20', 'saved 15–25 shows as target 20')
  assert.match(await page.$eval(status, el => el.textContent), /Saved · plans 15–25/)

  // Type 3 then 30 with a background refresh in between: the draft must survive.
  await page.click(input, { clickCount: 3 })
  await page.keyboard.type('3')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await new Promise(r => setTimeout(r, 400))
  assert.equal(await page.$eval(input, el => el.value), '3', 'first digit not reverted')
  await page.keyboard.type('0')
  assert.equal(await page.$eval(input, el => el.value), '30')
  assert.match(await page.$eval(status, el => el.textContent), /Unsaved · plans 25–35/)
  assert.equal(posts.filter(p => p.url.endsWith('/daily-target')).length, 0, 'typing never saves')

  // Out of range is refused client-side, nothing posted.
  await page.click(input, { clickCount: 3 }); await page.keyboard.type('55')
  assert.match(await page.$eval(status, el => el.textContent), /enter 0–40/)
  const saveBtn = await page.$('.account-daily-target button')
  assert.equal(await saveBtn.evaluate(b => b.disabled), true)

  // Save 30 ±5 → exactly one POST, then "Saved".
  await page.click(input, { clickCount: 3 }); await page.keyboard.type('30')
  await saveBtn.evaluate(b => b.scrollIntoView({ block: 'center' }))
  const hit = await saveBtn.evaluate(b => { const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === b || b.contains(el) })
  assert.equal(hit, true, 'Save is not covered by the island or another layer')
  await saveBtn.click()
  await page.waitForFunction(s => /Saved · plans 25–35/.test(document.querySelector(s)?.textContent || ''), {}, status)
  const saved = posts.filter(p => p.url.endsWith('/daily-target'))
  assert.deepEqual(saved.map(p => p.body), [{ target: 30, variation: 5 }])
  assert.ok(posts.every(p => !/\/(arm|start|send|auto)$/.test(p.url)), 'saving never arms, starts or sends')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `no horizontal overflow (${overflow}px)`)
  fs.mkdirSync(OUT, { recursive: true })
  await (await page.$('.account-safety-panel')).screenshot({ path: path.join(OUT, `outreach-daily-target-${width}.png`) })
  await browser.close()
  return { width, accountsServed, posts: saved.length }
}

;(async () => {
  for (const width of [360, 390, 430, 1440]) console.log('ok', JSON.stringify(await run(width)))
})().catch(err => { console.error(err); process.exit(1) })
