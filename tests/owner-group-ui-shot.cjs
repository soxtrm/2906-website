const puppeteer = require('puppeteer')
const path = require('node:path')

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#30456b"/><circle cx="700" cy="170" r="190" fill="#B8953F" opacity=".45"/><text x="70" y="330" font-size="90" fill="white">#9340</text></svg>')}`
const listing = {
  id: 9340, ref: '9340', town: 'Sliema', localityKey: 'sliema', localityLabel: 'Sliema',
  type: 'penthouse', beds: 2, baths: 2, sizeSqm: 125, price: 2200, shortlet: false,
  availableStatus: 'available', createdAt: new Date().toISOString(), images: [image], imageCount: 1,
  listedBy: { id: 1, displayName: 'Kevin', colorHex: '#B8953F' }, isMine: true, viewing: null,
  bookingsPossible: true, canCreateOwnerGroup: true, ownerGroupRequest: null,
  contact: { mode: 'owner', reachesName: 'Owner', canAsk: true, reason: null, questionsUsed: 0, questionsPerDay: 2, canQuestion: true, questionReason: null },
}

;(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', req => {
    const u = req.url()
    if (!u.includes('/api/crm/')) return req.continue()
    const json = x => req.respond({ contentType: 'application/json', body: JSON.stringify(x) })
    if (u.endsWith('/api/crm/me')) return json({ agent: { id: 1, username: 'kev', name: 'Kevin', role: 'admin', daily_reveal_limit: 50, can_create_owner_group: true }, reveals: { used: 0, limit: 50 } })
    if (u.includes('/group-request-context')) return json({ property: { id: 9340, ref: '9340', town: 'Sliema' }, owner: { label: 'Anna B.', contact: 'masked' }, agent: { id: 1, name: 'Kevin' }, approvalPolicy: 'EXPLICIT_APPROVAL_REQUIRED', latest: null, clients: [{ id: 'c1', name: 'Maya & Luca', moveInDate: '2026-11-01', relationship: 'Couple' }] })
    if (u.includes('schedule-board/listings?status=rented')) return json({ listings: [] })
    if (u.includes('schedule-board/listings?')) return json({ listings: [listing] })
    if (u.includes('schedule-board/towns')) return json({ towns: [{ key: 'sliema', label: 'Sliema', n: 1 }] })
    if (u.includes('notifications')) return json({ notifications: [] })
    if (u.includes('property-changes')) return json([])
    if (u.includes('config')) return json({})
    if (u.includes('reachout-settings')) return json({ mode: 'off' })
    return json({})
  })

  for (const [name, w, h] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
    await page.goto(`http://localhost:${process.env.PORT || 4174}/crm/schedule-board`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.crm-listing-card')
    await page.waitForFunction(() => !document.querySelector('.argus-intro'), { timeout: 10000 }).catch(() => {})
    await page.$eval('.crm-listing-card button[title="More actions"]', button => button.click())
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(x => x.textContent.includes('Create Group ★')))
    await page.evaluate(() => [...document.querySelectorAll('button')].find(x => x.textContent.includes('Create Group ★'))?.click())
    await page.waitForFunction(() => document.body.innerText.includes('CREATE OWNER GROUP') || document.body.innerText.includes('Create Owner Group'))
    await page.screenshot({ path: path.join(__dirname, `../artifacts/owner-group-${name}.png`), fullPage: false })
    await page.keyboard.press('Escape')
  }
  await browser.close()
  console.log('owner group screenshots created')
})().catch(error => { console.error(error); process.exit(1) })
