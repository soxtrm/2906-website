'use strict'
// ARGUS Outreach P0 browser acceptance (Claude, 2026-11-10). Real Chromium on
// the real /crm/outreach page; /api/crm/* answered by a stateful in-memory
// backend shaped like the production routes (no WhatsApp, no production data).
// Covers PACING-01/02/03/05/06/07/08/13, TRAFFIC-01/04/05/07/11/12, the
// Auto/Pause separation and template drafts.
//   CRM_BASE=http://localhost:3000 node --test tests/outreach-p0.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const puppeteer = require('puppeteer')

const BASE = process.env.CRM_BASE || 'http://localhost:3000'
const OUT = path.join(__dirname, 'screenshots', 'outreach-p0'); fs.mkdirSync(OUT, { recursive: true })
const NOW = new Date().toISOString()
const day = (i, state, label, extra = {}) => ({ date: `2026-11-${String(10 + i).padStart(2, '0')}`, relative: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : null, weekday: ((i + 1) % 7) + 1, state, label, ...extra })
const days = [day(0, 'completed', 'Completed — 28 accepted', { scheduledAt: '2026-11-10T07:00:00Z', target: 30, accepted: 28 }), day(1, 'scheduled', 'Scheduled', { scheduledAt: '2026-11-11T07:16:00Z', target: '25–35' }),
  day(2, 'skipped', 'Skipped', { reason: 'account_disconnected:SCAN_QR_CODE' }), ...Array.from({ length: 7 }, (_, k) => day(k + 3, 'planned', 'Planned'))]
const H = {
  green: { color: 'green', code: 'ready', label: 'Ready', reason: 'Next run passed its preflight checks', action: null, telemetryAt: NOW, nextAt: null },
  yellow: { color: 'yellow', code: 'scheduled', label: 'Scheduled', reason: 'Next run is planned', action: null, telemetryAt: NOW, nextAt: null },
  red: { color: 'red', code: 'offline', label: 'Offline', reason: 'WhatsApp session scan qr code', action: 'Scan the QR code to reconnect this number', telemetryAt: NOW, nextAt: null },
  gray: { color: 'gray', code: 'auto_off', label: 'Auto off', reason: 'No automatic outreach for this account', action: 'Turn Auto on or plan a manual run', telemetryAt: NOW, nextAt: null },
  unknown: { color: 'unknown', code: 'unknown', label: 'Unknown', reason: 'WhatsApp session status could not be read just now', action: 'Refresh', telemetryAt: null, nextAt: null },
}
function store() {
  return {
    pace: { 1: { target: 30, variation: 5, version: 4 }, 2: { target: 20, variation: 0, version: 2 }, 3: { target: 30, variation: 5, version: 1 }, 4: { target: 10, variation: 0, version: 1 } },
    paused: {}, legacyAuto: { 1: true, 2: false, 3: false, 4: true }, puts: [], posts: [], failNextPut: false,
    templates: [
      { id: 51, persona: 'kev', period: 'morning', slot: 1, status: 'approved', active: true, title: null, approved_by: null, body: 'Good morning! Kevin here. I\'m currently assisting several clients…' },
      { id: 61, persona: 'kev', period: 'morning', slot: 6, status: 'draft', active: true, title: 'Kevin — Availability update', body: 'Good morning,\n\nMy name is Kevin. I\'m a real estate consultant with the 2906 independent-agent collective, focusing on residential rentals and sales in Malta.\n\nWould you have any apartments available now or becoming available soon?\n\nKind regards,\nKevin' },
    ],
  }
}
const accountsLegacy = [1, 2, 3, 4].map(id => ({ id, sessionName: ['default', 'Cedric', 'Gabriela', 'kevthirdd'][id - 1], label: ['Kev primary', 'Cedric', 'Gabriela', 'Kev third'][id - 1], phone: `3569900000${id}`, connected: id !== 2, active: true, outreachEnabled: true, outreachEligible: id !== 2, outreachPaceMin: 30, outreachPaceMax: 30, persona: ['kev', 'cedric', 'gabriela', 'kev'][id - 1], pool: 'top', planningDays: [], recentRuns: [] }))
const lastOutreachAt = '2026-11-09T15:08:54Z'
accountsLegacy[0].lastOutreachAt = lastOutreachAt
accountsLegacy[0].recentRuns = [
  { id: 2, sent_count: 0, total_contacts: 32, completed_at: '2026-11-11T09:06:06Z', last_sent_at: null },
  { id: 1, sent_count: 19, total_contacts: 38, completed_at: '2026-11-09T16:05:05Z', last_sent_at: lastOutreachAt },
]
function overview(s) {
  const health = { 1: H.green, 2: H.red, 3: H.gray, 4: H.unknown }
  return {
    generatedAt: NOW, today: '2026-11-10', timezone: 'Europe/Malta',
    kpi: { sentToday: 28, scheduled: 30, remaining: 0, nextRun: null, activeAccounts: 2, accounts: 4, attention: [], health: { green: 1, yellow: 0, red: 1, gray: 1, unknown: 1 } },
    accounts: accountsLegacy.map(a => ({
      id: a.id, label: a.label, sessionName: a.sessionName, persona: a.persona, sessionStatus: a.id === 2 ? 'SCAN_QR_CODE' : 'WORKING', connected: a.id !== 2, restricted: false, restrictionUntil: null, restrictionReason: null,
      sentToday: a.id === 1 ? 28 : 0, targetToday: a.id === 1 ? 30 : null, lastAcceptedAt: a.id === 1 ? lastOutreachAt : null,
      nextRun: a.id === 1 ? { at: '2026-11-11T07:16:00Z', mode: 'manual', status: 'ready' } : null,
      automation: { enabled: false, suspendedReason: null, suspendedRecoverable: null }, legacyAuto: s.legacyAuto[a.id], days, attention: a.id === 2 ? ['Disconnected (SCAN_QR_CODE)'] : [],
      health: s.paused[a.id] ? { color: 'gray', code: 'paused', label: 'Manually paused', reason: 'Paused by kevin', action: 'Resume when ready', telemetryAt: NOW, nextAt: null } : health[a.id],
      pace: { ...s.pace[a.id], min: 0, max: 0, savedAt: NOW }, manualPaused: s.paused[a.id] ? { at: NOW, by: 'kevin', reason: null } : null,
    })),
  }
}
const paceView = (s, id) => { const p = s.pace[id]; const v = p.target ? Math.min(p.variation, p.target - 1) : 0; return { accountId: id, target: p.target, variation: v, min: p.target ? Math.max(1, p.target - v) : 0, max: p.target ? Math.min(40, p.target + v) : 0, cap: 40, version: p.version, savedAt: NOW, savedBy: 'kevin', worker: { min: p.target ? Math.max(1, p.target - v) : 0, max: p.target ? Math.min(40, p.target + v) : 0, source: 'whatsapp_accounts' } } }

async function mount(page, s) {
  await page.setRequestInterception(true)
  page.on('request', req => {
    const u = new URL(req.url()); if (!u.pathname.startsWith('/api/crm/')) return req.continue()
    const p = u.pathname.replace('/api/crm/', ''), m = req.method()
    const json = (body, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
    let mm
    if (p === 'me') return json({ agent: { id: 1, username: 'kevin', name: 'Kevin', role: 'admin' }, reveals: { used: 0, limit: 50 } })
    if (p === 'outreach/accounts') return json({ accounts: accountsLegacy })
    if (p === 'outreach/control/overview') return json(overview(s))
    if ((mm = /^outreach\/pace\/(\d+)$/.exec(p))) {
      const id = Number(mm[1])
      if (m === 'GET') return json(paceView(s, id))
      const body = JSON.parse(req.postData() || '{}'); s.puts.push({ id, ...body })
      if (s.failNextPut) { s.failNextPut = false; return json({ error: 'Daily target must be a whole number from 0 to 40', code: 'invalid_config' }, 400) }
      if (body.version !== s.pace[id].version) return json({ error: 'This target was changed elsewhere (another tab or user). Reload to see the latest value.', code: 'version_conflict', current: paceView(s, id) }, 409)
      s.pace[id] = { target: body.target, variation: body.variation, version: s.pace[id].version + 1 }
      return json({ ok: true, ...paceView(s, id), note: null })
    }
    if ((mm = /^outreach\/automation\/(\d+)\/pause$/.exec(p))) { const b = JSON.parse(req.postData() || '{}'); s.posts.push({ p, b }); s.paused[mm[1]] = b.paused; return json({ ok: true }) }
    if ((mm = /^outreach\/accounts\/(\d+)\/auto$/.exec(p))) { const b = JSON.parse(req.postData() || '{}'); s.posts.push({ p, b }); s.legacyAuto[mm[1]] = b.enabled; return json({ ok: true }) }
    if ((mm = /^outreach\/persona-preview\/(\w+)$/.exec(p))) return json({ persona: mm[1], period: 'morning', variants: s.templates.filter(t => t.persona === mm[1] && t.status === 'approved') })
    if (p === 'outreach/persona-templates' && m === 'PUT') { const b = JSON.parse(req.postData() || '{}'); s.posts.push({ p, b }); const t = s.templates.find(x => x.persona === b.persona && x.slot === b.slot && x.period === b.period); t.body = b.body; return json({ ok: true, template: t }) }
    if (p === 'outreach/persona-templates') { const per = u.searchParams.get('persona'); return json({ templates: s.templates.filter(t => !per || t.persona === per) }) }
    if (p.startsWith('outreach/automation/')) return json({ config: null, timeline: days })
    if (p.includes('outreach/plans')) return json({ plans: [] })
    return json({ rows: [], tasks: [], templates: [], perAccount: [] })
  })
}
async function sliderDrag(page, toValue) {
  // Real pointer drag on the range thumb (mouse on desktop, touch-like path on mobile).
  await page.$eval('[data-testid="pace-slider"]', e => e.scrollIntoView({ block: 'center' }))
  const box = await (await page.$('[data-testid="pace-slider"]')).boundingBox()
  const cur = Number(await page.$eval('[data-testid="pace-slider"]', e => e.value))
  const x = v => box.x + 8 + (box.width - 16) * (v / 40)
  await page.mouse.move(x(cur), box.y + box.height / 2); await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x(cur + (toValue - cur) * i / 8), box.y + box.height / 2)
  await page.mouse.up()
}

for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['small', 360, 780]]) {
  test(`Outreach P0 overview at ${label} ${width}px`, async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); const errors = []
    try {
      const page = await browser.newPage()
      await page.setViewport({ width, height, isMobile: width < 768, hasTouch: false })
      page.on('pageerror', e => errors.push(e.message))
      await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('argus_intro_seen', '1'); localStorage.setItem('crm_theme_pref', 'dark') } catch {} })
      const s = store(); await mount(page, s)
      await page.goto(`${BASE}/crm/outreach`, { waitUntil: 'networkidle2', timeout: 120000 })
      await page.waitForSelector('[data-testid="pace-card"]', { timeout: 60000 })
      assert.equal(await page.$eval(`[data-testid="auto-row"] time[datetime="${lastOutreachAt}"]`, e => e.textContent), '09 Nov 2026, 16:08:54')
      await page.evaluate(() => [...document.querySelectorAll('.cc-tabs button')].find(b => b.textContent.trim() === 'Activity').click())
      await page.waitForSelector('.cc-activity-head time')
      assert.equal(await page.$eval('.cc-activity-head time', e => e.textContent), '09 Nov 2026, 16:08:54')
      await page.evaluate(() => [...document.querySelectorAll('.cc-tabs button')].find(b => b.textContent.trim() === 'Manual planner').click())
      await page.waitForSelector('.account-recent-runs time')
      const recent = await page.$$eval('.account-recent-runs > div', rows => rows.map(row => row.textContent))
      assert.match(recent[0], /0\/32 · No sends.*Run ended · 11 Nov 2026, 10:06:06/)
      assert.match(recent[1], /19\/38.*Last sent · 09 Nov 2026, 16:08:54/)
      await page.evaluate(() => [...document.querySelectorAll('.cc-tabs button')].find(b => b.textContent.trim() === 'Overview').click())
      await page.waitForSelector('[data-testid="pace-card"]')
      // PACING-01 + TRAFFIC: real slider, all four lights with labels (unknown is never green).
      assert.equal(await page.$eval('[data-testid="pace-slider"]', e => e.type), 'range')
      const lights = await page.$$eval('[data-testid^="account-card-"] [data-light]', ns => ns.map(n => [n.dataset.light, n.textContent.trim()]))
      assert.deepEqual(lights.map(l => l[0]), ['green', 'red', 'gray', 'unknown'])
      assert.deepEqual(lights.map(l => l[1]), ['Ready', 'Offline', 'Auto off', 'Unknown'])
      assert.match(await page.$eval('[data-testid="account-card-2"]', n => n.textContent), /Scan the QR code/)
      assert.equal(await page.$eval('[data-testid="pace-number"]', e => e.value), '30')
      assert.match(await page.$eval('[data-testid="pace-envelope"]', e => e.textContent), /Planned 25–35/)
      await page.screenshot({ path: path.join(OUT, `overview-${width}.png`), fullPage: true })
      // PACING-02: drag 30 → 12, no request sent while dragging.
      await sliderDrag(page, 12)
      const dragged = Number(await page.$eval('[data-testid="pace-number"]', e => e.value))
      assert.ok(Math.abs(dragged - 12) <= 1, `dragged to ${dragged}`)
      assert.equal(s.puts.length, 0)
      assert.match(await page.$eval('[data-testid="pace-state"]', e => e.textContent), /Unsaved/)
      // PACING-05/06: type 1 → 18 (intermediate "1" kept), survive an overview poll.
      await page.click('[data-testid="pace-number"]', { clickCount: 3 }); await page.keyboard.type('1')
      assert.equal(await page.$eval('[data-testid="pace-number"]', e => e.value), '1')
      await page.evaluate(() => fetch('/api/crm/outreach/control/overview'))
      await page.keyboard.type('8')
      assert.equal(await page.$eval('[data-testid="pace-number"]', e => e.value), '18')
      // PACING-13: a rejected save shows an error and is not marked saved.
      s.failNextPut = true
      await page.$eval('[data-testid="pace-save"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="pace-save"]')
      await page.waitForSelector('[data-testid="pace-error"]')
      assert.match(await page.$eval('[data-testid="pace-state"]', e => e.textContent), /Unsaved/)
      // PACING-03: save 18 → persisted version, then full reload shows 18.
      await page.$eval('[data-testid="pace-save"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="pace-save"]')
      await page.waitForFunction(() => /Saved .* v5/.test(document.querySelector('[data-testid="pace-state"]')?.textContent || ''))
      assert.deepEqual(s.puts.at(-1), { id: 1, target: 18, variation: 5, version: 4 })
      await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('[data-testid="pace-card"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="pace-number"]')?.value === '18')
      // PACING-07: switch to Cedric (20), edit without saving, back to Kev keeps 18, back to Cedric keeps the draft.
      await page.$eval('[data-testid="account-card-1"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="account-card-2"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="pace-number"]')?.value === '20')
      await page.click('[data-testid="pace-number"]', { clickCount: 3 }); await page.keyboard.type('22')
      await page.$eval('[data-testid="account-card-1"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="account-card-1"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="pace-number"]')?.value === '18')
      await page.$eval('[data-testid="account-card-1"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="account-card-2"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="pace-number"]')?.value === '22')
      assert.equal(s.pace[2].target, 20, 'unsaved Cedric draft never reached the server')
      // PACING-08: another tab saved Cedric meanwhile → conflict surfaced, Load latest.
      s.pace[2] = { target: 25, variation: 0, version: 3 }
      await page.$eval('[data-testid="pace-save"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="pace-save"]')
      await page.waitForFunction(() => /changed elsewhere/.test(document.querySelector('[data-testid="pace-error"]')?.textContent || ''))
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="pace-error"] button')].find(b => /Load latest/.test(b.textContent)).click())
      await page.waitForFunction(() => document.querySelector('[data-testid="pace-number"]')?.value === '25')
      // Auto and Pause are separate: pausing Kev does not touch Auto.
      await page.$eval('[data-testid="account-card-1"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="account-card-1"]')
      await page.waitForSelector('[data-testid="pause-button"]')
      await page.$eval('[data-testid="pause-button"]', e => e.scrollIntoView({ block: 'center' })); await page.click('[data-testid="pause-button"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="account-card-1"] [data-light]')?.textContent.includes('Manually paused'))
      assert.equal(s.legacyAuto[1], true)
      assert.deepEqual(s.posts.at(-1), { p: 'outreach/automation/1/pause', b: { paused: true, reason: 'Paused from Outreach overview' } })
      assert.equal(await page.$eval('[data-testid="auto-switch"]', e => e.getAttribute('aria-checked')), 'true')
      // Filters.
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="health-filter"] button')].find(b => b.textContent.startsWith('Blocked')).click())
      assert.deepEqual(await page.$$eval('[data-testid^="account-card-"]', ns => ns.map(n => n.dataset.testid)), ['account-card-2', 'account-card-4'])
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="health-filter"] button')].find(b => b.textContent.startsWith('All')).click())
      // 7 days + persona preview with paragraphs; drafts are labelled, never live.
      assert.equal(await page.$$eval('[data-testid="seven-days"] li', ns => ns.length), 7)
      assert.match(await page.$eval('[data-testid="persona-drafts"]', e => e.textContent), /1 draft introduction.*never sent/)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow')
      await page.screenshot({ path: path.join(OUT, `after-${width}.png`), fullPage: true })
      // Templates: edit a draft — stays draft, nothing approved.
      await page.evaluate(() => [...document.querySelectorAll('.cc-tabs button')].find(b => b.textContent.startsWith('Templates')).click())
      await page.waitForSelector('.cc-template-edit')
      await page.evaluate(() => document.querySelector('.cc-template-edit').open = true)
      await page.waitForSelector('[data-testid="draft-editor-61"] textarea')
      await page.$eval('[data-testid="draft-editor-61"] textarea', e => { e.focus(); e.setSelectionRange(e.value.length, e.value.length) })
      await page.keyboard.type(' Thank you.')
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="draft-editor-61"] button')].find(b => /Save draft/.test(b.textContent)).click())
      await page.waitForFunction(() => /still draft/.test(document.querySelector('[data-testid="draft-editor-61"]')?.textContent || ''))
      assert.equal(s.templates.find(t => t.id === 61).status, 'draft')
      assert.match(s.templates.find(t => t.id === 61).body, /\n\nKind regards,\nKevin Thank you\.$/)
      await page.screenshot({ path: path.join(OUT, `templates-${width}.png`), fullPage: false })
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  })
}
