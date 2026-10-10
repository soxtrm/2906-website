const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')

const makeListing = (i, town) => ({
  id: i, ref: `2906-${9000+i}`, town, localityKey: town.toLowerCase().replace(/\W/g,'-'), localityLabel: town,
  subLocation: null, type: i % 2 ? 'apartment' : 'penthouse', beds: 2 + i % 2, baths: 1, sizeSqm: 90,
  price: 1400 + i * 100, salePrice: null, shortlet: false, availableStatus: 'available', availableDate: null,
  viewingDate: null, viewingStatus: null, hasViewingLocation: false, exclusive: false, createdAt: new Date(Date.now()-i*86400000).toISOString(),
  lastConfirmedAvailableAt: null, statusChangeReason: null, images: [], imageCount: 0,
  listedBy: { id: 1, displayName: i % 2 ? 'Kevin' : 'Olga', colorHex: i % 2 ? '#d7b52d' : '#3b82f6' }, isMine: i % 2 === 1,
  viewing: null, bookingsPossible: i === 1, isHotProperty: i < 4,
  contact: { mode: 'owner', reachesName: 'Owner', canAsk: true, reason: null, questionsUsed: 0, questionsPerDay: 2, canQuestion: true, questionReason: null },
})
const listings = ['Mġarr','San Ġwann','Swieqi','St Julian’s','Żurrieq','Sliema','Mosta','Mellieħa','Qawra'].map((town,i)=>makeListing(i+1,town))

;(async()=>{
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']})
  const page=await browser.newPage();await page.setViewport({width:1920,height:1080,deviceScaleFactor:1})
  await page.setRequestInterception(true)
  page.on('request',req=>{
    const url=req.url(); if(!url.includes('/api/crm/'))return req.continue()
    const json=body=>req.respond({contentType:'application/json',body:JSON.stringify(body)})
    if(url.endsWith('/api/crm/me'))return json({agent:{id:1,username:'kevin',name:'Kevin',role:'admin',daily_reveal_limit:50},reveals:{used:0,limit:50},nav:['dashboard','inventory','board','bookings','access','owners','clientgroups','ownergroups','outreach','agentchats','profile','baseinventory']})
    if(url.includes('schedule-board/listings?status=rented'))return json({listings:[]})
    if(url.includes('schedule-board/listings?'))return json({listings})
    if(url.includes('schedule-board/towns'))return json({towns:listings.map(x=>({key:x.localityKey,label:x.town,n:1}))})
    if(url.includes('schedule-board/notifications'))return json({notifications:[]})
    if(url.includes('property-changes/pending'))return json([])
    if(url.includes('schedule-board/config'))return json({})
    if(url.includes('reachout-settings'))return json({mode:'off'})
    return json({})
  })
  await page.goto('http://127.0.0.1:4174/crm/schedule-board',{waitUntil:'domcontentloaded'})
  await page.waitForSelector('.crm-listing-card')
  await page.waitForFunction(()=>document.querySelectorAll('.crm-listing-card').length>=6)
  const layout=await page.evaluate(()=>{
    const content=document.querySelector('.crm-board-content').getBoundingClientRect()
    const header=document.querySelector('.crm-header').getBoundingClientRect()
    const filter=document.querySelector('.crm-filterbar').getBoundingClientRect()
    const brand=document.querySelector('.crm-brand').getBoundingClientRect()
    const brandImage=document.querySelector('.crm-brand img').getBoundingClientRect()
    const sidebar=document.querySelector('.crm-sidebar').getBoundingClientRect()
    const topRail=document.querySelector('.crm-board-desktop-rail').getBoundingClientRect()
    const headerActions=document.querySelector('.crm-header-actions').getBoundingClientRect()
    const mapButton=document.querySelector('.crm-board-map-link').getBoundingClientRect()
    const scope=document.querySelector('.crm-board-scope-rail').getBoundingClientRect()
    const visibleFilterIcons=[...document.querySelectorAll('.crm-filter-island .crm-island-feature')].filter(node=>getComputedStyle(node).display!=='none').length
    const argusDisplay=getComputedStyle(document.querySelector('.crm-argus-orbit')).display
    const smartDisplay=getComputedStyle(document.querySelector('.crm-smart-island')).display
    const cards=[...document.querySelectorAll('.crm-listing-card')].slice(0,3).map(n=>n.getBoundingClientRect()).map(r=>({x:r.x,y:r.y,w:r.width}))
    return {viewport:innerWidth,content:{x:content.x,w:content.width},header:{x:header.x,y:header.y,w:header.width,h:header.height},filter:{x:filter.x,y:filter.y,w:filter.width,h:filter.height},brand:{x:brand.x,y:brand.y,w:brand.width,h:brand.height},brandImage:{x:brandImage.x,w:brandImage.width,h:brandImage.height},sidebar:{x:sidebar.x,w:sidebar.width},topRail:{x:topRail.x,y:topRail.y,h:topRail.height},headerActions:{x:headerActions.x,w:headerActions.width},mapButton:{x:mapButton.x,w:mapButton.width},scope:{x:scope.x,y:scope.y},visibleFilterIcons,argusDisplay,smartDisplay,theme:document.documentElement.dataset.crmTheme,cards}
  })
  assert.ok(layout.content.w<=1341 && layout.content.w>=1200,'centered compact board width')
  assert.ok(Math.abs(layout.header.y-layout.filter.y)<5,'header actions share top rail')
  assert.ok(layout.filter.h<=60,'compact top rail')
  assert.equal(layout.theme,'light','desktop board defaults to reference light theme')
  assert.ok(layout.brand.x<=40 && layout.brand.y===0,'ARGUS wordmark anchors the global top bar')
  assert.ok(layout.brandImage.w>=100 && layout.brandImage.h>0,'the supplied ARGUS logo asset is visible')
  assert.ok(layout.headerActions.x>layout.viewport-layout.headerActions.w-24,'global utility buttons align right')
  assert.ok(Math.abs(layout.mapButton.x+layout.mapButton.w/2-layout.viewport/2)<=1,'Map is centered over the viewport')
  assert.ok(layout.sidebar.x>180 && layout.sidebar.w<=165,'Facebook-like navigation rail sits beside the centered board')
  assert.ok(layout.topRail.y===0 && layout.topRail.h<=60,'board controls stay inside the global top rail')
  assert.ok(layout.scope.y>=58 && layout.scope.x>=layout.content.x,'village filters begin directly below the top rail')
  assert.equal(layout.visibleFilterIcons,8,'all property filter icons remain available on desktop')
  assert.equal(layout.argusDisplay,'none','mobile ARGUS island is not duplicated on desktop')
  assert.equal(layout.smartDisplay,'none','mobile smart island is not duplicated on desktop')
  assert.equal(new Set(layout.cards.map(c=>Math.round(c.y))).size,1,'three cards share first row')
  assert.equal(new Set(layout.cards.map(c=>Math.round(c.x))).size,3,'three columns visible')
  await page.screenshot({path:path.join(os.tmpdir(),'board-clean-desktop.png'),fullPage:false})

  // This change is desktop-only. Guard the existing phone shell explicitly:
  // sidebar hidden, the three mobile islands present, and no desktop rail.
  await page.setViewport({width:390,height:844,deviceScaleFactor:1})
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.crm-sidebar')).display==='none')
  const mobile=await page.evaluate(()=>({
    desktopRail:document.querySelector('.crm-board-desktop-rail'),
    islands:getComputedStyle(document.querySelector('.crm-board-islands')).display,
    sidebar:getComputedStyle(document.querySelector('.crm-sidebar')).display,
    bottomNav:getComputedStyle(document.querySelector('.crm-bottom-nav')).display,
  }))
  assert.equal(mobile.desktopRail,null,'desktop controls are not rendered on mobile')
  assert.notEqual(mobile.islands,'none','mobile islands remain visible')
  assert.equal(mobile.sidebar,'none','desktop sidebar remains hidden on mobile')
  assert.notEqual(mobile.bottomNav,'none','mobile bottom navigation remains unchanged')
  await browser.close();console.log('clean desktop board layout passed')
})().catch(error=>{console.error(error);process.exitCode=1})
