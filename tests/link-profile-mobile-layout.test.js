const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')

;(async () => {
  const base = process.env.LINK_BASE || 'http://127.0.0.1:4174/Link/'
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.evaluateOnNewDocument(() => sessionStorage.setItem('nexus-link-intent-market', 'longlets'))
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (/\/Link\/config\.js/.test(request.url())) return request.respond({ contentType: 'text/javascript', body: "window.NEXUS_CONFIG={mode:'demo',designInventory:false};" })
    request.continue()
  })
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.scroll-profile .map-dock-wrap')
  await new Promise(resolve => setTimeout(resolve, 500))

  const before = await page.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector)
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height, position: getComputedStyle(node).position }
    }
    return {
      reel: rect('.property-reel'),
      dock: rect('.map-dock-wrap'),
      market: rect('.map-market-entry'),
      overflow: document.documentElement.scrollWidth - innerWidth
    }
  })

  assert.equal(before.dock.position, 'relative')
  assert.ok(before.dock.top >= before.reel.bottom, `map card overlaps property reel by ${Math.round(before.reel.bottom - before.dock.top)}px`)
  assert.ok(before.market.top - before.dock.bottom < 40, `map card leaves a ${Math.round(before.market.top - before.dock.bottom)}px blank gap`)
  assert.ok(before.overflow <= 1, `mobile body overflowed by ${before.overflow}px`)

  await page.evaluate(() => scrollTo(0, 300))
  await new Promise(resolve => setTimeout(resolve, 150))
  const afterTop = await page.$eval('.map-dock-wrap', node => node.getBoundingClientRect().top)
  assert.ok(Math.abs((before.dock.top - afterTop) - 300) < 3, 'map card did not move naturally with the page scroll')

  await browser.close()
  console.log('link profile mobile layout passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
