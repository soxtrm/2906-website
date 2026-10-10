const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')

const accounts = [
  ['Argus1','Argus1 · Bridge',true,false],['Jasmine','Jasmine (Singapore)',false,false],['Olga','Olga',false,false],
  ['Cedric','Cedric (Germany)',true,true],['Argus2','Argus2 · Outreach default',true,true],['default','Kev primary',true,true],
  ['Kevsecond','Kev second',true,true],['kevthirdd','Kev third',true,true],['Gabriela','Gabriela',true,true],['Argus3','Argus 3',false,true],['Argus4','Argus 4',false,true],
].map(([sessionName,label,connected,outreachEligible],index)=>({id:index+1,sessionName,label,phone:`3569900000${index}`,connected,lastOutreachAt:index>2?'2026-09-27T08:15:00Z':null,pool:'top',outreachVolumePercent:100,outreachVolumeUntil:null,active:connected,outreachEnabled:outreachEligible,outreachEligible}))

;(async()=>{
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']})
  const page=await browser.newPage();await page.setViewport({width:1440,height:1000,deviceScaleFactor:1})
  const mutations=[]
  await page.setRequestInterception(true)
  page.on('request',request=>{
    const url=request.url()
    if(request.method()==='POST'){mutations.push({url,body:request.postData()});return request.respond({contentType:'application/json',body:JSON.stringify({ok:true,added:3})})}
    if(url.endsWith('/api/crm/me'))return request.respond({contentType:'application/json',body:JSON.stringify({agent:{id:1,username:'kevin',email:'',name:'Kevin',role:'admin',daily_reveal_limit:50},reveals:{used:0,limit:50}})})
    if(url.endsWith('/api/crm/outreach/accounts'))return request.respond({contentType:'application/json',body:JSON.stringify({accounts})})
    if(url.endsWith('/api/crm/outreach/today-summary'))return request.respond({contentType:'application/json',body:JSON.stringify({unique_owners:4,total_sends:4,perAccount:[]})})
    if(url.endsWith('/api/crm/outreach/due-reminders'))return request.respond({contentType:'application/json',body:JSON.stringify({rows:[],perAccount:[]})})
    if(url.endsWith('/api/crm/outreach/owner-recheck'))return request.respond({contentType:'application/json',body:JSON.stringify({mode:'REVIEW_ONLY',tasks:[]})})
    if(url.endsWith('/api/crm/outreach/templates'))return request.respond({contentType:'application/json',body:JSON.stringify({templates:[]})})
    if(url.includes('/api/crm/outreach/plans?'))return request.respond({contentType:'application/json',body:JSON.stringify({plans:['TODAY','TOMORROW','IN_2_DAYS'].map((label,index)=>({id:index+1,account_id:6,session_name:'default',scheduled_date:`2026-09-${27+index}`,scheduled_at:null,status:'draft',armed:false,message_template:null,label,stats:{total:0,eligible:0,hot:0,cold:0,skip:0,sent:0},entries:[]}))})})
    if(url.includes('/api/crm/'))return request.respond({contentType:'application/json',body:JSON.stringify({plan:{entries:[]}})})
    request.continue()
  })
  await page.goto(process.env.MARKET_BASE?.replace('/link-marketplace/','/crm/outreach')||'http://127.0.0.1:4174/crm/outreach',{waitUntil:'domcontentloaded'})
  await page.waitForSelector('.outreach-account-grid')
  assert.equal(await page.$$eval('.outreach-account-tile',nodes=>nodes.length),9)
  assert.match(await page.$eval('.outreach-account-tile.is-manager',node=>node.textContent),/SYSTEM MANAGER · NOT IN ROTATION/)
  assert.equal(await page.$eval('.outreach-account-tile.is-manager',node=>node.disabled),true)
  assert.match(await page.$eval('.outreach-account-grid',node=>node.textContent),/Kev Default/)
  assert.equal(await page.$$eval('.outreach-account-tile:not(:disabled)',nodes=>nodes.length),6)
  assert.match(await page.$eval('.outreach-account-tile.is-selected',node=>node.textContent),/Kev Default/)
  assert.match(await page.$eval('.outreach-account-grid',node=>node.textContent),/24h 14m|Protected until/)
  await page.waitForSelector('.queue-autosetup')
  assert.match(await page.$eval('.queue-console', n=>n.innerText), /Prepare. Review. Connect./)
  await page.click('.queue-autosetup'); await page.waitForFunction(()=>document.body.innerText.includes('Auto:'))
  assert.ok(mutations.some(r=>r.url.endsWith('/generate')&&JSON.parse(r.body).topUp===false&&JSON.parse(r.body).count===10))
  assert.ok(mutations.some(r=>r.url.endsWith('/save')))
  assert.ok(!mutations.some(r=>/arm|send|run-now/.test(r.url)))
  await page.click('.account-add'); await page.waitForSelector('.account-register'); assert.equal(await page.$$('.account-register input').then(x=>x.length),3); await page.click('.account-register button[type="button"]')
  await page.screenshot({path:'outreach-control-deck.png',fullPage:false})
  await page.setViewport({width:390,height:844}); await new Promise(r=>setTimeout(r,300)); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false); await page.screenshot({path:'outreach-control-deck-mobile.png',fullPage:false})
  await page.$eval('.outreach-main-tabs button:nth-child(2)',node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})))
  await page.waitForFunction(()=>document.querySelector('.outreach-main-tabs button:nth-child(2)')?.getAttribute('aria-pressed')==='true')
  assert.match(await page.$eval('body',node=>node.innerText),/Owner Recheck/i)
  assert.match(await page.$eval('.outreach-main-tabs',node=>node.textContent),/Outreach reminders/)
  await browser.close();console.log('outreach control deck passed')
})().catch(error=>{console.error(error);process.exitCode=1})
