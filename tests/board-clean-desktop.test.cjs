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
    const cards=[...document.querySelectorAll('.crm-listing-card')].slice(0,3).map(n=>n.getBoundingClientRect()).map(r=>({x:r.x,y:r.y,w:r.width}))
    return {content:{x:content.x,w:content.width},header:{x:header.x,y:header.y,w:header.width,h:header.height},filter:{x:filter.x,y:filter.y,w:filter.width,h:filter.height},cards}
  })
  assert.ok(layout.content.w<=1341 && layout.content.w>=1200,'centered compact board width')
  assert.ok(Math.abs(layout.header.y-layout.filter.y)<5,'header actions share top rail')
  assert.ok(layout.filter.h<=60,'compact top rail')
  assert.equal(new Set(layout.cards.map(c=>Math.round(c.y))).size,1,'three cards share first row')
  assert.equal(new Set(layout.cards.map(c=>Math.round(c.x))).size,3,'three columns visible')
  await page.screenshot({path:path.join(os.tmpdir(),'board-clean-desktop.png'),fullPage:false})
  await browser.close();console.log('clean desktop board layout passed')
})().catch(error=>{console.error(error);process.exitCode=1})
