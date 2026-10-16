const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')

const listing = {
  id: 1, ref: '2906-TEST', town: 'Sliema', subLocation: null, type: 'apartment', beds: 2, baths: 1,
  sizeSqm: 90, price: 1600, salePrice: null, shortlet: false, availableStatus: 'available', availableDate: null,
  viewingDate: null, viewingStatus: null, hasViewingLocation: false, exclusive: false, createdAt: new Date().toISOString(),
  lastConfirmedAvailableAt: null, statusChangeReason: null, images: [], imageCount: 0,
  listedBy: { id: 1, displayName: 'Kevin', colorHex: '#4056e8' }, isMine: true, viewing: null,
  contact: { mode: 'owner', reachesName: 'Owner', canAsk: true, reason: null, questionsUsed: 0, questionsPerDay: 2, canQuestion: true, questionReason: null },
}
const relay = {
  open: true,
  ownerLabel: 'Owner 1234',
  persona: 'Argus',
  messages: [
    { id: 1, direction: 'owner_to_agent', text: 'Yes, the apartment is still available for a viewing.', at: new Date(Date.now() - 60000).toISOString() },
    { id: 2, direction: 'agent_to_owner', text: 'Thank you. I will send the booking details now.', at: new Date().toISOString() },
  ],
  events: [], otherActivity: [], privateDeviceChat: false, preferenceRules: [], presence: { state: 'idle', agentName: null },
}

;(async () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../components/crm/board-dialogs.tsx'), 'utf8')
  assert.match(source, /for \(const file of selectedFiles\)/)
  assert.match(source, /form\.append\('files', file\)/)
  assert.match(source, /Message owner…/)
  assert.match(source, /Photos/)
  assert.match(source, /Files/)
  assert.match(source, /window\.visualViewport/)
  assert.match(source, /data-keyboard-open/)

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => localStorage.setItem('crm_theme_pref', 'light'))
  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = req.url()
    if (!url.includes('/api/crm/')) return req.continue()
    const json = body => req.respond({ contentType: 'application/json', body: JSON.stringify(body) })
    if (url.endsWith('/api/crm/me')) return json({ agent: { id: 1, username: 'kevin', name: 'Kevin', role: 'admin', daily_reveal_limit: 50 }, reveals: { used: 0, limit: 50 }, nav: ['dashboard','inventory','board','bookings','access','owners','clientgroups','ownergroups','outreach','agentchats','profile','baseinventory'] })
    if (url.includes('/relay')) return json(relay)
    if (/schedule-board\/listings\/2906-TEST(?:\?|$)/.test(url)) return json(listing)
    if (url.includes('schedule-board/listings?')) return json({ listings: [] })
    if (url.includes('schedule-board/towns')) return json({ towns: [] })
    if (url.includes('schedule-board/notifications')) return json({ notifications: [] })
    if (url.includes('property-changes/pending')) return json([])
    if (url.includes('schedule-board/config')) return json({})
    if (url.includes('reachout-settings')) return json({ mode: 'off' })
    return json({})
  })

  await page.setViewport({ width: 430, height: 860 })
  await page.goto('http://localhost:4174/crm/schedule-board?ref=2906-TEST&action=chat', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.crm-chat-dialog textarea[placeholder="Message owner…"]')
  await page.waitForFunction(() => {
    const nav = document.querySelector('.crm-bottom-nav')
    return nav && Number.parseFloat(getComputedStyle(nav).opacity) < 0.01 && getComputedStyle(nav).pointerEvents === 'none'
  })
  await page.waitForSelector('.argus-intro', { hidden: true, timeout: 5000 })

  const readability = await page.evaluate(() => {
    const incoming = document.querySelector('.crm-chat-bubble-incoming')
    const outgoing = document.querySelector('.crm-chat-bubble-outgoing')
    const input = document.querySelector('.crm-chat-dialog textarea')
    return {
      incomingText: incoming?.textContent || '',
      outgoingText: outgoing?.textContent || '',
      incomingFontSize: Number.parseFloat(getComputedStyle(incoming).fontSize),
      incomingLineHeight: Number.parseFloat(getComputedStyle(incoming).lineHeight),
      inputLabel: input?.labels?.[0]?.textContent || '',
      dialogRole: document.querySelector('.crm-chat-dialog')?.getAttribute('role'),
      bottomNavOpacity: getComputedStyle(document.querySelector('.crm-bottom-nav')).opacity,
      bottomNavPointerEvents: getComputedStyle(document.querySelector('.crm-bottom-nav')).pointerEvents,
    }
  })
  assert.match(readability.incomingText, /Owner 1234/)
  assert.match(readability.outgoingText, /You/)
  assert.ok(readability.incomingFontSize >= 15, 'chat message text remains readable')
  assert.ok(readability.incomingLineHeight >= 22, 'chat message line-height remains readable')
  assert.match(readability.inputLabel, /Message owner about listing 2906-TEST/)
  assert.equal(readability.dialogRole, 'dialog')
  assert.equal(readability.bottomNavOpacity, '0')
  assert.equal(readability.bottomNavPointerEvents, 'none')

  for (const width of [320, 360, 390, 430]) {
    await page.setViewport({ width, height: 820 })
    await page.waitForFunction(() => {
      const send = document.querySelector('button[aria-label="Send"]')?.getBoundingClientRect()
      return !!send && send.bottom <= innerHeight + 2
    }, { timeout: 3000 })
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector('.crm-chat-dialog').getBoundingClientRect()
      const send = document.querySelector('button[aria-label="Send"]').getBoundingClientRect()
      const textarea = document.querySelector('.crm-chat-dialog textarea').getBoundingClientRect()
      return { dialogLeft: dialog.left, dialogRight: dialog.right, sendLeft: send.left, sendRight: send.right, sendBottom: send.bottom, textareaRight: textarea.right, viewport: innerWidth, height: innerHeight }
    })
    assert.ok(geometry.dialogLeft >= -0.5 && geometry.dialogRight <= width + 0.5, `dialog fits ${width}px`)
    assert.ok(geometry.sendLeft >= 0 && geometry.sendRight <= width, `send visible ${width}px`)
    assert.ok(geometry.textareaRight <= width, `textarea fits ${width}px`)
    assert.ok(geometry.sendBottom <= geometry.height + 2, `composer above viewport bottom ${width}px`)
  }
  await page.setViewport({ width: 390, height: 844 })
  await new Promise(resolve => setTimeout(resolve, 280))
  await page.screenshot({ path: path.join(os.tmpdir(), 'chat-composer-mobile.png'), fullPage: false })

  // Next's development overlay owns the very last screen pixels in headless
  // mode, so invoke the button's native click rather than hitting that overlay.
  await page.$eval('button[aria-label="Add attachment"]', n => n.click())
  await page.waitForFunction(() => document.body.innerText.includes('Photos') && document.body.innerText.includes('Files'))
  assert.equal(await page.$eval('button[aria-label="Add attachment"]', n => n.getAttribute('aria-expanded')), 'true')
  await page.mouse.click(250, 250)
  await page.waitForFunction(() => document.querySelector('button[aria-label="Add attachment"]')?.getAttribute('aria-expanded') === 'false')
  assert.equal(await page.$eval('input[accept="image/*"]', n => n.multiple), true)
  assert.equal(await page.$$eval('.crm-chat-dialog input[type="file"]', ns => ns.every(n => n.multiple)), true)

  // A short viewport approximates the visual area left above a software
  // keyboard. Focusing the textarea must keep the whole composer reachable.
  await page.focus('.crm-chat-dialog textarea')
  await page.setViewport({ width: 390, height: 430 })
  await new Promise(resolve => setTimeout(resolve, 220))
  const keyboardGeometry = await page.evaluate(() => {
    const composer = document.querySelector('.crm-chat-composer').getBoundingClientRect()
    const send = document.querySelector('button[aria-label="Send"]').getBoundingClientRect()
    return { composerBottom: composer.bottom, sendBottom: send.bottom, height: innerHeight }
  })
  assert.ok(keyboardGeometry.composerBottom <= keyboardGeometry.height + 2, 'composer remains above keyboard viewport')
  assert.ok(keyboardGeometry.sendBottom <= keyboardGeometry.height + 2, 'send remains above keyboard viewport')

  await browser.close()
  console.log('mobile chat composer passed at 320/360/390/430')
})().catch(error => { console.error(error); process.exitCode = 1 })
