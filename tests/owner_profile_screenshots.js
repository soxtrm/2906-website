// Owner Profile V2 (Teil A) — real-browser screenshot proof, desktop + mobile,
// for a multi-property owner (3721) and a single-property owner (11801),
// across the required tabs. Auth: mints a JWT with the same shape/secret the
// real login flow signs (routes/crm.js), sets it as the crm_session cookie
// Next.js's proxy already reads — same legitimate access path, no password
// guessing, just skipping the manual login form for an automated run.
const puppeteer = require('puppeteer')
const BASE = 'http://localhost:3000'
// Minted on the VPS backend container (has the real JWT_SECRET; this script
// never touches the secret itself, only the resulting bearer token) via:
//   docker exec 2906_backend node -e "... jwt.sign({id:1,username:'kev',role:'admin',name:'Kev'}, JWT_SECRET, {expiresIn:'2h'}) ..."
const TEST_TOKEN = process.env.CRM_TEST_TOKEN || ''

const OWNERS = [
  { id: 3721, label: 'multi' },
  { id: 11801, label: 'single' },
]
const TABS = ['overview', 'properties', 'insights', 'documents']

// CrmShell (lib/crm/ui.tsx) is an app-shell layout: the OUTER wrapper is
// pinned to height:100vh and the actual page content scrolls inside an
// inner div (overflow-y:auto), not the document body. Puppeteer's naive
// fullPage:true measures document.body/documentElement, which never grows
// past 100vh in this layout — every "full page" shot below the fold was
// silently cropped at the first viewport. Fix: find that inner scrollable
// node, read its real scrollHeight, and grow the viewport to fit it before
// shooting, so 100vh becomes tall enough that nothing needs to scroll.
async function fullContentHeight(page) {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('body *'))
    let tallest = 0
    for (const el of all) {
      const cs = getComputedStyle(el)
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        tallest = Math.max(tallest, el.scrollHeight)
      }
    }
    return Math.max(tallest, document.documentElement.scrollHeight)
  })
}
async function shotFull(page, outfile, baseViewport) {
  const h = await fullContentHeight(page)
  await page.setViewport({ ...baseViewport, height: Math.max(h + 40, baseViewport.height) })
  await new Promise(r => setTimeout(r, 200))
  await page.screenshot({ path: outfile, fullPage: false })
  await page.setViewport(baseViewport)
}

async function run() {
  if (!TEST_TOKEN) throw new Error('Set CRM_TEST_TOKEN env var to a valid backend-signed JWT')
  const token = TEST_TOKEN
  const browser = await puppeteer.launch({ headless: 'new' })

  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844, isMobile: true }]) {
    const page = await browser.newPage()
    await page.setViewport(viewport)
    await page.setCookie({ name: 'crm_session', value: token, domain: 'localhost', path: '/', httpOnly: false })
    for (const owner of OWNERS) {
      await page.goto(`${BASE}/crm/owner/${owner.id}`, { waitUntil: 'networkidle2', timeout: 20000 })
      await new Promise(r => setTimeout(r, 900))
      await page.screenshot({ path: `tests/screenshots/owner_${owner.label}_${viewport.name}_header.png`, fullPage: false })
      for (const tab of TABS) {
        const clicked = await page.evaluate((tabLabel) => {
          const map = { overview: 'Overview', properties: 'Properties', insights: 'Contact & Insights', documents: 'Documents' }
          const btns = Array.from(document.querySelectorAll('button'))
          const btn = btns.find(b => b.textContent?.trim() === map[tabLabel])
          if (btn) { btn.click(); return true }
          return false
        }, tab)
        if (!clicked) { console.log(`WARN: tab button not found for ${tab} on owner ${owner.id}`); continue }
        await new Promise(r => setTimeout(r, 500))
        await shotFull(page, `tests/screenshots/owner_${owner.label}_${viewport.name}_${tab}.png`, viewport)
      }
      console.log(`done: owner ${owner.id} (${owner.label}) @ ${viewport.name}`)
    }
    await page.close()
  }
  await browser.close()
}
run().catch(e => { console.error(e); process.exit(1) })
