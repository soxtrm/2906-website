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
  await page.goto(`${process.env.CRM_MOCK_BASE||'http://localhost:4174'}/crm/schedule-board`,{waitUntil:'domcontentloaded'})
  await page.waitForSelector('.crm-listing-card')
  await page.waitForFunction(()=>document.querySelectorAll('.crm-listing-card').length>=6)
  await page.evaluate(()=>document.fonts.ready)
  await page.waitForFunction(()=>{
    const header=document.querySelector('.crm-header')?.getBoundingClientRect()
    const filter=document.querySelector('.crm-filterbar')?.getBoundingClientRect()
    return header && filter && Math.abs(header.y-filter.y)<5
  })
  // 2026-10-19 founder layout: 2906 · ARGUS group over the results · quiet
  // text navigation · theme. Filter column on the left, a wide four-column
  // working canvas, and the page scroller at the far browser edge.
  await page.waitForSelector('[data-testid=board-filter-rail]')
  const layout=await page.evaluate(()=>{
    const r=sel=>{const n=document.querySelector(sel);if(!n)return null;const b=n.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),r:Math.round(b.right)}}
    const cards=[...document.querySelectorAll('.crm-listing-card')].slice(0,4).map(n=>n.getBoundingClientRect()).map(b=>({x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),r:Math.round(b.right)}))
    const photo=document.querySelector('.crm-listing-photo')?.getBoundingClientRect()
    return {viewport:innerWidth,brand:r('.crm-agency-brand'),argus:r('.crm-argus-orbit'),tools:r('[data-testid=board-tools-button]'),nav:r('.crm-header-nav'),actions:r('.crm-header-actions'),rail:r('[data-testid=board-filter-rail]'),filter:r('.crm-filterbar'),header:r('.crm-header'),
      navLabels:[...document.querySelectorAll('.crm-header-nav > .crm-nav-item')].map(n=>n.textContent.trim()),
      railKeys:[...document.querySelectorAll('[data-testid=board-filter-rail] section')].map(n=>n.dataset.rail),
      railOpen:document.querySelectorAll('[data-testid=board-filter-rail] .crm-rail-toggle[aria-expanded=true]').length,
      filterIsland:getComputedStyle(document.querySelector('.crm-filter-island')).display,
      oldRail:getComputedStyle(document.querySelector('.crm-board-desktop-rail')||document.body).display,
      theme:document.documentElement.dataset.crmTheme,cards,content:r('.crm-content'),body:r('.crm-listing-card-body'),overlay:document.querySelector('.crm-card-overlay-meta')?.textContent?.trim(),photo:photo&&{w:Math.round(photo.width),h:Math.round(photo.height)}}
  })
  assert.equal(layout.theme,'light','desktop board defaults to the light theme')
  assert.ok(Math.abs(layout.header.y-layout.filter.y)<5 && layout.filter.h<=60,'ARGUS group lives in the top bar')
  assert.ok(layout.brand.x<=40,'2906 mark anchors the left of the top bar')
  assert.ok(layout.brand.r<layout.argus.x && layout.tools.r<layout.nav.x && layout.nav.r<=layout.actions.x,'order: 2906 · ARGUS group · nav · utilities')
  assert.ok(Math.abs(layout.argus.x-layout.cards[0].x)<=2,'ARGUS starts over the results column')
  assert.deepEqual(layout.navLabels,['Dashboard','Inventory','Board','Bookings','Outreach','Profile'],'labelled primary navigation')
  assert.deepEqual(layout.railKeys,['location','price','booking','beds','baths','types','specials','season'],'filter column sections')
  assert.equal(layout.railOpen,0,'filter sections start collapsed')
  assert.ok(layout.rail.r<=layout.cards[0].x,'filters left of the results')
  assert.equal(layout.filterIsland,'none','the phone filter island is not duplicated on desktop')
  assert.equal(layout.oldRail,'none','the old top board rail is gone')
  assert.ok(layout.actions.r>layout.viewport-24,'utility buttons align right')
  assert.equal(new Set(layout.cards.map(c=>c.y)).size,1,'four cards share the first row')
  assert.equal(new Set(layout.cards.map(c=>c.h)).size,1,'listing cards keep one stable height')
  assert.ok(layout.photo.w/layout.photo.h>1.55,'listing photos use a landscape frame')
  assert.ok(Math.abs(layout.rail.x-(layout.viewport-layout.cards[3].r))<=20,'filter rail and listing edge form one centred canvas')
  assert.ok(layout.rail.y>=layout.cards[0].y+50,'the desktop filter rail starts clearly below the listing header')
  assert.ok(layout.cards[0].h<460 && layout.body.h<210,`listing cards stay dense (${layout.cards[0].h}px card, ${layout.body.h}px body)`)
  assert.equal(layout.content.r,layout.viewport,'the page scrollbar lives at the far browser edge')
  assert.equal(await page.$eval('.crm-board-legacy-filter-row',node=>getComputedStyle(node).display),'none','legacy text filters never create a second desktop row')
  const firstPhoto=await page.$('.crm-listing-photo')
  await page.waitForFunction(()=>{
    const layers=[...document.querySelectorAll('.crm-listing-card:first-child .crm-photo-layer')]
    return layers.length===4 && layers.every(layer=>layer.complete&&layer.naturalWidth>0)
  })
  assert.equal(await page.$$eval('.crm-listing-card:first-child .crm-photo-layer[data-active=true]',nodes=>nodes.length),1,'one decoded photo layer remains visible while the gallery changes')
  await firstPhoto.hover()
  await new Promise(resolve=>setTimeout(resolve,100))
  const hoveredIndex=Number(await page.$eval('.crm-listing-photo',node=>node.dataset.photoIndex))
  await new Promise(resolve=>setTimeout(resolve,1100))
  assert.equal(Number(await page.$eval('.crm-listing-photo',node=>node.dataset.photoIndex)),hoveredIndex,'hover never auto-advances listing photos')
  await page.click('.crm-listing-card:first-child .crm-photo-arrow-next')
  await page.waitForFunction(expected=>Number(document.querySelector('.crm-listing-photo')?.dataset.photoIndex)===expected,{timeout:3000},(hoveredIndex+1)%4)
  await page.waitForFunction(()=>{
    const photo=document.querySelector('.crm-listing-photo')
    return photo?.dataset.displayPhotoIndex===photo?.dataset.photoIndex
  },{timeout:3000})
  const hoverGallery=await page.evaluate(()=>({
    index:Number(document.querySelector('.crm-listing-photo')?.dataset.photoIndex),
    arrows:[...document.querySelectorAll('.crm-listing-card:first-child .crm-photo-arrow')].map(node=>getComputedStyle(node).opacity),
    segments:document.querySelectorAll('.crm-listing-card:first-child .crm-photo-progress i').length,
  }))
  assert.equal(hoverGallery.index,(hoveredIndex+1)%4,'manual next arrow advances exactly one photo')
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

  // Guard the phone shell explicitly: sidebar hidden; ARGUS · ⌂ · map · ☰ ·
  // filter island present; no desktop rail.
  await page.setViewport({width:390,height:844,deviceScaleFactor:1})
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.crm-sidebar')).display==='none')
  const mobile=await page.evaluate(()=>({
    desktopRail:document.querySelector('.crm-board-desktop-rail') ? getComputedStyle(document.querySelector('.crm-board-desktop-rail')).display : 'missing',
    islands:getComputedStyle(document.querySelector('.crm-board-islands')).display,
    sidebar:getComputedStyle(document.querySelector('.crm-sidebar')).display,
    bottomNav:getComputedStyle(document.querySelector('.crm-bottom-nav')).display,
    orbs:[...document.querySelectorAll('.crm-board-orb')].map(node=>node.dataset.testid),
    filterIcons:document.querySelectorAll('.crm-filter-island .crm-island-feature').length,
    filterPreviewIcons:document.querySelectorAll('.crm-filter-cloud-preview>i').length,
    filterTrigger:!!document.querySelector('[data-testid=island-filter-trigger]'),
    firstCard:(()=>{const node=document.querySelector('.crm-listing-card');const rect=node?.getBoundingClientRect();return rect&&{height:Math.round(rect.height)}})(),
    firstPhoto:(()=>{const node=document.querySelector('.crm-listing-photo');const rect=node?.getBoundingClientRect();return rect&&{height:Math.round(rect.height)}})(),
    photoLayers:[...document.querySelectorAll('.crm-listing-card:first-child .crm-photo-layer')].map(node=>({position:getComputedStyle(node).position,opacity:getComputedStyle(node).opacity})),
  }))
  assert.ok(['none','missing'].includes(mobile.desktopRail),'desktop controls are hidden on mobile')
  assert.notEqual(mobile.islands,'none','mobile islands remain visible')
  assert.equal(mobile.sidebar,'none','desktop sidebar remains hidden on mobile')
  assert.notEqual(mobile.bottomNav,'none','mobile bottom navigation remains available')
  assert.deepEqual(mobile.orbs,['board-market-button','board-map-button','board-tools-button'],'Market · Map · Tools')
  assert.equal(mobile.filterIcons,0,'the phone filter cloud starts calm and collapsed')
  assert.equal(mobile.filterPreviewIcons,4,'the closed filter cloud previews the frequent filters')
  assert.equal(mobile.filterTrigger,true,'the whole collapsed phone filter cloud is one clear trigger')
  assert.ok(mobile.firstPhoto.height>=140&&mobile.firstPhoto.height<260,`mobile photo stays inside its compact frame (${mobile.firstPhoto.height}px)`)
  assert.ok(mobile.firstCard.height<620,`preloaded images do not stretch the mobile card (${mobile.firstCard.height}px)`)
  assert.ok(mobile.photoLayers.length>1,'mobile preloads the listing gallery near the viewport')
  assert.ok(mobile.photoLayers.every(layer=>layer.position==='absolute'),'every preloaded mobile photo is overlaid in one frame')
  assert.equal(mobile.photoLayers.filter(layer=>layer.opacity==='1').length,1,'only one preloaded mobile photo is visible')

  const filterWidthBefore=await page.$eval('.crm-filter-island',node=>node.getBoundingClientRect().width)
  await page.$eval('[data-testid=filter-preview-price]',icon=>icon.click())
  await page.waitForSelector('[data-testid=island-price]')
  await new Promise(resolve=>setTimeout(resolve,600))
  assert.equal(await page.$('#crm-mobile-filter-panel'),null,'expanding the cloud does not pick a filter')
  const filterWidthAfter=await page.$eval('.crm-filter-island',node=>node.getBoundingClientRect().width)
  assert.ok(filterWidthAfter>filterWidthBefore+25,`filter cloud grows before selection (${filterWidthBefore} → ${filterWidthAfter})`)
  assert.deepEqual(await page.$$eval('.crm-filter-icons .crm-island-feature',nodes=>nodes.map(node=>node.dataset.testid)),['island-location','island-price','island-availability','island-rooms','island-types','island-tenancy','island-updated','island-rental'],'the expanded cloud exposes every filter group')
  await page.$eval('.crm-filter-island [aria-label="Open price filters"]',button=>button.click())
  await page.waitForSelector('#crm-mobile-filter-panel')
  assert.equal(await page.$eval('#crm-mobile-filter-panel',node=>getComputedStyle(node).display!=='none'),true,'a shortcut opens its section after the cloud expands')
  await page.$eval('#crm-mobile-filter-panel [aria-label="Close filters"]',button=>button.click())
  await page.waitForSelector('#crm-mobile-filter-panel',{hidden:true})

  await page.$eval('[data-testid=board-tools-button]',button=>button.click())
  await page.waitForSelector('[data-testid=board-tools-panel]')
  await page.$eval('#crm-smart-tags',button=>button.click())
  await page.waitForSelector('.crm-selection-help')
  await page.waitForSelector('[data-testid=board-tools-panel]',{hidden:true})
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
