const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')

const makeListing = (i, town) => ({
  id: i, ref: `2906-${9000+i}`, town, localityKey: town.toLowerCase().replace(/\W/g,'-'), localityLabel: town,
  subLocation: null, type: i % 2 ? 'apartment' : 'penthouse', beds: 2 + i % 2, baths: 1, sizeSqm: 90,
  price: 1400 + i * 100, salePrice: null, shortlet: false, availableStatus: 'available', availableDate: null,
  viewingDate: null, viewingStatus: null, hasViewingLocation: false, exclusive: false, createdAt: new Date(Date.now()-i*86400000).toISOString(),
  lastConfirmedAvailableAt: null, statusChangeReason: null,
  images: ['#e7a25b','#6aa7d8','#82b987','#a67bc4'].map((colour,index)=>`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${colour}"/><text x="400" y="320" text-anchor="middle" font-size="110" fill="white">${index+1}</text></svg>`)}`), imageCount: 4,
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
  await page.goto('http://localhost:4174/crm/schedule-board',{waitUntil:'domcontentloaded'})
  await page.waitForSelector('.crm-listing-card')
  await page.waitForFunction(()=>document.querySelectorAll('.crm-listing-card').length>=6)
  await page.evaluate(()=>document.fonts.ready)
  await page.waitForFunction(()=>{
    const header=document.querySelector('.crm-header')?.getBoundingClientRect()
    const filter=document.querySelector('.crm-filterbar')?.getBoundingClientRect()
    return header && filter && Math.abs(header.y-filter.y)<5
  })
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
  assert.ok(layout.content.w<=1581 && layout.content.w>=1450,'wider centered board canvas')
  assert.ok(Math.abs(layout.header.y-layout.filter.y)<5,'header actions share top rail')
  assert.ok(layout.filter.h<=60,'compact top rail')
  assert.equal(layout.theme,'light','desktop board defaults to reference light theme')
  assert.ok(layout.brand.x<=40 && layout.brand.y===0,'ARGUS wordmark anchors the global top bar')
  assert.ok(layout.brandImage.w>=100 && layout.brandImage.h>0,'the supplied ARGUS logo asset is visible')
  assert.ok(layout.headerActions.x>layout.viewport-layout.headerActions.w-24,'global utility buttons align right')
  assert.ok(Math.abs(layout.mapButton.x+layout.mapButton.w/2-layout.viewport/2)<=1,'Map is centered over the viewport')
  assert.ok(layout.mapButton.x-(layout.filter.x+layout.filter.w)<70,'filter icons finish beside the centred Map control')
  assert.ok(layout.topRail.x-(layout.mapButton.x+layout.mapButton.w)<70,'board actions start beside the centred Map control')
  assert.ok(layout.sidebar.x>50 && layout.sidebar.w<=165,'Facebook-like navigation rail sits beside the wider centered board')
  assert.ok(layout.topRail.y===0 && layout.topRail.h<=60,'board controls stay inside the global top rail')
  assert.ok(layout.scope.y>=58 && layout.scope.x>=layout.content.x,'village filters begin directly below the top rail')
  assert.equal(layout.visibleFilterIcons,8,'all property filter icons remain available on desktop')
  assert.equal(layout.argusDisplay,'none','mobile ARGUS island is not duplicated on desktop')
  assert.equal(layout.smartDisplay,'none','mobile smart island is not duplicated on desktop')
  assert.equal(new Set(layout.cards.map(c=>Math.round(c.y))).size,1,'three cards share first row')
  assert.equal(new Set(layout.cards.map(c=>Math.round(c.x))).size,3,'three columns visible')
  assert.ok(layout.cards.every(card=>card.w>=490),'wider cards give property photography more room')
  const firstPhoto=await page.$('.crm-listing-photo')
  await firstPhoto.hover()
  await page.waitForFunction(()=>document.querySelector('.crm-listing-photo')?.dataset.photoIndex!=='0',{timeout:3000})
  const hoverGallery=await page.evaluate(()=>({
    index:Number(document.querySelector('.crm-listing-photo')?.dataset.photoIndex),
    arrows:[...document.querySelectorAll('.crm-listing-card:first-child .crm-photo-arrow')].map(node=>getComputedStyle(node).opacity),
    segments:document.querySelectorAll('.crm-listing-card:first-child .crm-photo-progress i').length,
  }))
  assert.ok(hoverGallery.index>0,'hover advances through listing photos')
  assert.deepEqual(hoverGallery.arrows,['1','1'],'photo navigation appears on hover')
  assert.equal(hoverGallery.segments,4,'photo progress exposes the available images')
  await page.screenshot({path:path.join(os.tmpdir(),'board-clean-desktop.png'),fullPage:false})

  await page.setViewport({width:1024,height:900,deviceScaleFactor:1})
  const compactDesktop=await page.evaluate(()=>{
    const cards=[...document.querySelectorAll('.crm-listing-card')].slice(0,3).map(node=>node.getBoundingClientRect())
    return {overflow:document.documentElement.scrollWidth-innerWidth,rows:cards.map(card=>Math.round(card.y))}
  })
  assert.ok(compactDesktop.overflow<=0,'compact desktop has no horizontal overflow')
  assert.ok(Math.abs(compactDesktop.rows[0]-compactDesktop.rows[1])<=5,'compact desktop keeps two cards in its first row')
  assert.ok(compactDesktop.rows[2]-compactDesktop.rows[1]>40,'compact desktop wraps the third card cleanly')

  // Guard the phone shell explicitly: sidebar hidden, the three mobile
  // islands present, and no desktop rail.
  await page.setViewport({width:390,height:844,deviceScaleFactor:1})
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.crm-sidebar')).display==='none')
  const mobile=await page.evaluate(()=>({
    desktopRail:document.querySelector('.crm-board-desktop-rail'),
    islands:getComputedStyle(document.querySelector('.crm-board-islands')).display,
    sidebar:getComputedStyle(document.querySelector('.crm-sidebar')).display,
    bottomNav:getComputedStyle(document.querySelector('.crm-bottom-nav')).display,
    workspaceLabels:[...document.querySelectorAll('.crm-smart-island [data-label]')].map(node=>node.dataset.label),
  }))
  assert.equal(mobile.desktopRail,null,'desktop controls are not rendered on mobile')
  assert.notEqual(mobile.islands,'none','mobile islands remain visible')
  assert.equal(mobile.sidebar,'none','desktop sidebar remains hidden on mobile')
  assert.notEqual(mobile.bottomNav,'none','mobile bottom navigation remains available')
  assert.deepEqual(mobile.workspaceLabels,['Map','Favourites','More'],'mobile workspace island has exactly three distinct actions')
  assert.equal(await page.$$('.crm-smart-island [data-label="Profile"]') .then(nodes=>nodes.length),0,'profile is not duplicated in the floating island')

  await page.$eval('.crm-smart-island [data-label="Favourites"]',button=>button.click())
  await page.waitForFunction(()=>document.querySelector('.crm-smart-island [data-label="Favourites"]')?.getAttribute('aria-pressed')==='true')
  await page.$eval('.crm-smart-island [data-label="Map"]',button=>button.click())
  await page.waitForFunction(()=>document.querySelector('.crm-smart-island [data-label="Map"]')?.getAttribute('aria-pressed')==='true' && document.querySelector('.crm-smart-island [data-label="Favourites"]')?.getAttribute('aria-pressed')==='false')
  await page.$eval('.crm-smart-island [data-label="More"]',button=>button.click())
  await page.waitForSelector('[role="dialog"] .crm-mobile-menu-actions')
  assert.equal(await page.$$eval('[role="dialog"] .crm-nav-item',nodes=>nodes.filter(node=>node.textContent.includes('Profile')).length),1,'profile appears once in shared navigation')
  await page.$eval('#crm-smart-tags',button=>button.click())
  await page.waitForSelector('.crm-selection-help')
  await page.waitForSelector('[role="dialog"]',{hidden:true})
  assert.match(await page.$eval('.crm-selection-help',node=>node.textContent),/Nothing is picked automatically/)
  await page.screenshot({path:path.join(os.tmpdir(),'board-clean-mobile.png'),fullPage:false})
  const motionRecorder=process.env.RECORD_MOTION
    ? await page.screencast({path:path.join(__dirname,'..','artifacts','ui-audit','pass2-island-motion.webm'),fps:30,speed:.25})
    : null
  if(motionRecorder) await new Promise(resolve=>setTimeout(resolve,500))

  const moveContent = async (positions, delay = 70) => {
    for (const top of positions) {
      await page.$eval('.crm-content',(node,nextTop)=>{
        node.scrollTop=nextTop
        node.dispatchEvent(new Event('scroll'))
      },top)
      await new Promise(resolve=>setTimeout(resolve,delay))
    }
  }
  await moveContent([6,2,9],55)
  assert.equal(await page.$eval('.crm-workspace',node=>node.classList.contains('crm-navigation-compact')),false,'tiny scroll jitter keeps the island expanded')
  await moveContent([28,52,78,104,132],150)
  await page.waitForFunction(()=>document.querySelector('.crm-workspace')?.classList.contains('crm-navigation-compact'))
  assert.deepEqual(await page.$$eval('.crm-bottom-nav :is(a,button)',nodes=>nodes.filter(node=>node.tabIndex>=0).map(node=>node.getAttribute('aria-label')||node.textContent.trim())),['Show mobile navigation'],'only the visible compact handle remains in the keyboard order')
  await moveContent([128,133,129],55)
  assert.equal(await page.$eval('.crm-workspace',node=>node.classList.contains('crm-navigation-compact')),true,'tiny direction changes do not flicker the compact island')
  await moveContent([111,88,62],45)
  await page.waitForFunction(()=>!document.querySelector('.crm-workspace')?.classList.contains('crm-navigation-compact'))
  await new Promise(resolve=>setTimeout(resolve,560))
  if(motionRecorder) await motionRecorder.stop()

  const openIsland=await page.evaluate(()=>{
    const workspace=document.querySelector('.crm-workspace')
    const island=document.querySelector('.crm-bottom-nav')
    const handle=document.querySelector('.crm-bottom-nav-handle')
    const openRect=island.getBoundingClientRect()
    const openHandleOpacity=getComputedStyle(handle).opacity
    workspace.classList.add('crm-navigation-compact')
    return {w:openRect.width,h:openRect.height,openHandleOpacity}
  })
  await new Promise(resolve=>setTimeout(resolve,620))
  const compactIsland=await page.evaluate(()=>{
    const island=document.querySelector('.crm-bottom-nav')
    const handle=document.querySelector('.crm-bottom-nav-handle')
    const compactRect=island.getBoundingClientRect()
    const compactStyle=getComputedStyle(island)
    const handleStyle=getComputedStyle(handle)
    const handleMarkStyle=getComputedStyle(handle.querySelector('span'))
    return {w:compactRect.width,h:compactRect.height,compactOpacity:compactStyle.opacity,handleOpacity:handleStyle.opacity,animation:handleMarkStyle.animationName}
  })
  assert.equal(openIsland.openHandleOpacity,'0','the handle stays inside the expanded island')
  assert.ok(compactIsland.w<openIsland.w/3 && compactIsland.h<openIsland.h/2,'the same island shell morphs into a small bar')
  assert.ok(Number(compactIsland.compactOpacity)>=.7 && Number(compactIsland.handleOpacity)>=.9,'the compact shell and its handle remain usable')
  assert.match(compactIsland.animation,/crm-nav-handle-breathe/,'the compact handle has subtle movement')
  await page.screenshot({path:path.join(os.tmpdir(),'board-clean-mobile-compact.png'),fullPage:false})
  assert.equal(await page.$$('.crm-bottom-nav').then(nodes=>nodes.length),1,'expanded and compact states share one island shell')
  assert.equal(await page.$$('.crm-bottom-nav-edge').then(nodes=>nodes.length),0,'there is no replacement edge control')
  await page.evaluate(()=>document.querySelector('.crm-workspace').classList.remove('crm-navigation-compact'))
  await page.$eval('.crm-bottom-nav > button:last-child',button=>button.click())
  await page.waitForFunction(()=>document.querySelector('.crm-workspace')?.classList.contains('crm-menu-cloud-open'))
  await new Promise(resolve=>setTimeout(resolve,260))
  const cloudIslandOpacity=await page.$eval('.crm-bottom-nav',node=>getComputedStyle(node).opacity)
  assert.equal(cloudIslandOpacity,'0','the complete mini island disappears while the menu cloud is open')
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}])
  await page.waitForFunction(()=>parseFloat(getComputedStyle(document.querySelector('.crm-bottom-nav')).transitionDuration)<=.001)
  assert.equal(await page.$eval('.crm-bottom-nav-handle span',node=>getComputedStyle(node).animationName),'none','reduced motion removes idle handle movement')
  await browser.close();console.log('clean desktop board layout passed')
})().catch(error=>{console.error(error);process.exitCode=1})
