const puppeteer = require('puppeteer')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')

const accounts = [
  ['Argus1','Argus1 · Bridge',true,false],['Jasmine','Jasmine (Singapore)',false,false],['Olga','Olga',false,false],
  ['Cedric','Cedric (Germany)',true,true],['Argus2','Argus2 · Outreach default',true,true],['default','Kev primary',true,true],
  ['Kevsecond','Kev second',true,true],['kevthirdd','Kev third',true,true],['Gabriela','Gabriela',true,true],['Argus3','Argus 3',false,true],['Argus4','Argus 4',false,true],
].map(([sessionName,label,connected,outreachEligible],index)=>({id:index+1,sessionName,label,phone:`3569900000${index}`,connected,lastOutreachAt:index>2?'2026-09-27T08:15:00Z':null,pool:'top',outreachVolumePercent:100,outreachVolumeUntil:null,outreachAutoBaseCount:index===5?40:null,outreachAutoMessage:'',active:connected,outreachEnabled:outreachEligible,outreachEligible}))

const scheduledTimes=['2026-09-27T08:15:00.000Z','2026-09-28T08:31:00.000Z','2026-09-29T08:47:00.000Z','2026-09-30T09:03:00.000Z','2026-10-01T09:19:00.000Z']
const planRows=['TODAY','TOMORROW','IN_2_DAYS','IN_3_DAYS','IN_4_DAYS'].map((label,index)=>({id:index+1,account_id:6,session_name:'default',scheduled_date:`2026-09-${27+index}`,scheduled_at:null,status:'draft',armed:false,message_template:null,label,stats:{total:0,eligible:0,hot:0,cold:0,skip:0,sent:0},entries:[]}))
const scheduledPlanRows=planRows.map((plan,index)=>({...plan,scheduled_at:scheduledTimes[index]}))

;(async()=>{
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']})
  const page=await browser.newPage();await page.setViewport({width:1440,height:1000,deviceScaleFactor:1})
  const mutations=[]
  await page.setRequestInterception(true)
  page.on('request',request=>{
    const url=request.url()
    if(request.method()==='POST'){
      mutations.push({url,body:request.postData()})
      if(url.endsWith('/auto-prepare'))return request.respond({contentType:'application/json',body:JSON.stringify({ok:true,baseCount:40,intervalMinutes:{min:16,max:16},plans:scheduledPlanRows.map((plan,index)=>({planId:plan.id,label:plan.label,status:index===0?'blocked':'prepared',preparedCount:index===0?0:40,scheduledAt:plan.scheduled_at,targetCount:40})),rollingPlans:scheduledPlanRows})})
      if(url.endsWith('/volume')){
        const body=JSON.parse(request.postData()||'{}')
        const account=accounts.find(item=>item.id===6)
        account.outreachVolumePercent=body.percent
        return request.respond({contentType:'application/json',body:JSON.stringify({ok:true,account:{outreach_volume_percent:body.percent}})})
      }
      return request.respond({contentType:'application/json',body:JSON.stringify({ok:true,added:3})})
    }
    if(url.endsWith('/api/crm/me'))return request.respond({contentType:'application/json',body:JSON.stringify({agent:{id:1,username:'kevin',email:'',name:'Kevin',role:'admin',daily_reveal_limit:50},reveals:{used:0,limit:50}})})
    if(url.endsWith('/api/crm/outreach/accounts'))return request.respond({contentType:'application/json',body:JSON.stringify({accounts})})
    if(url.endsWith('/api/crm/outreach/today-summary'))return request.respond({contentType:'application/json',body:JSON.stringify({unique_owners:4,total_sends:4,perAccount:[]})})
    if(url.endsWith('/api/crm/outreach/due-reminders'))return request.respond({contentType:'application/json',body:JSON.stringify({rows:[],perAccount:[]})})
    if(url.endsWith('/api/crm/outreach/owner-recheck'))return request.respond({contentType:'application/json',body:JSON.stringify({mode:'REVIEW_ONLY',tasks:[]})})
    if(url.endsWith('/api/crm/outreach/templates'))return request.respond({contentType:'application/json',body:JSON.stringify({templates:[]})})
    if(url.includes('/api/crm/outreach/plans?'))return request.respond({contentType:'application/json',body:JSON.stringify({plans:planRows})})
    if(url.includes('/api/crm/'))return request.respond({contentType:'application/json',body:JSON.stringify({plan:{entries:[]}})})
    request.continue()
  })
  await page.goto(process.env.MARKET_BASE?.replace('/link-marketplace/','/crm/outreach')||'http://127.0.0.1:4174/crm/outreach',{waitUntil:'networkidle0'})
  await page.waitForSelector('.outreach-account-grid')
  await page.waitForFunction(()=>!document.querySelector('.argus-intro'))
  assert.equal(await page.$$eval('.outreach-account-tile',nodes=>nodes.length),9)
  assert.match(await page.$eval('.outreach-account-tile.is-manager',node=>node.textContent),/SYSTEM MANAGER · NOT IN ROTATION/)
  assert.equal(await page.$eval('.outreach-account-tile.is-manager',node=>node.disabled),true)
  assert.match(await page.$eval('.outreach-account-grid',node=>node.textContent),/Kev Default/)
  assert.equal(await page.$$eval('.outreach-account-tile:not(:disabled)',nodes=>nodes.length),6)
  assert.match(await page.$eval('.outreach-account-tile.is-selected',node=>node.textContent),/Kev Default/)
  assert.match(await page.$eval('.outreach-account-grid',node=>node.textContent),/24h 15m|Protected until/)
  await page.waitForSelector('.queue-autosetup')
  assert.match(await page.$eval('.queue-console', n=>n.innerText), /Prepare. Review. Connect./)
  assert.equal(await page.$eval('.queue-autosetup',node=>node.disabled),false)
  const paceInput='.account-volume-compact input[type="number"]'
  await page.$eval(paceInput,input=>{
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(input,'72')
    input.dispatchEvent(new Event('input',{bubbles:true}))
    input.dispatchEvent(new Event('change',{bubbles:true}))
  })
  await page.waitForFunction(()=>document.querySelector('.account-pace-status')?.textContent?.includes('Unsaved · 72%'))
  await page.click('.account-volume-compact button')
  await page.waitForFunction(()=>document.querySelector('.account-pace-status')?.textContent?.includes('Saved · 72%'))
  const volumeMutation=mutations.find(r=>r.url.endsWith('/volume'))
  assert.ok(volumeMutation)
  assert.deepEqual(JSON.parse(volumeMutation.body),{percent:72,days:null})
  assert.equal(await page.$eval(paceInput,node=>node.value),'72')
  await page.click('.queue-autosetup')
  await page.waitForFunction(()=>document.querySelector('.queue-autosetup')?.getAttribute('aria-expanded')==='true')
  await page.waitForSelector('.queue-day-picker')
  assert.equal(mutations.some(r=>r.url.endsWith('/auto-prepare')),false)
  assert.equal(await page.$$eval('.queue-day-checks input:checked',nodes=>nodes.length),0)
  await page.click('.queue-day-picker-head button')
  assert.equal(await page.$$eval('.queue-day-checks input:checked',nodes=>nodes.length),5)
  await page.click('.queue-prepare-selected')
  await page.waitForFunction(()=>document.body.innerText.includes('Auto prepared'))
  assert.match(await page.$eval('.queue-auto-confirm',node=>node.textContent),/AUTO SAVED/)
  assert.match(await page.$eval('.queue-auto-confirm',node=>node.textContent),/\+16 min daily/)
  assert.match(await page.$eval('.queue-auto-confirm',node=>node.textContent),/Morning · 10:31 → Morning · 10:47 → Morning · 11:03 → Morning · 11:19/)
  assert.match(await page.$eval('.queue-time-readout',node=>node.textContent),/Morning10:31Auto next day: \+16 min/)
  const prepareMutation=mutations.find(r=>r.url.endsWith('/auto-prepare'))
  assert.ok(prepareMutation)
  assert.deepEqual(JSON.parse(prepareMutation.body),{baseCount:40,message:'',labels:['TODAY','TOMORROW','IN_2_DAYS','IN_3_DAYS','IN_4_DAYS']})
  assert.ok(!mutations.some(r=>r.url.endsWith('/generate')||r.url.endsWith('/save')))
  assert.ok(!mutations.some(r=>/arm|send|run-now/.test(r.url)))
  await page.click('.account-add'); await page.waitForSelector('.account-register'); assert.equal(await page.$$('.account-register input').then(x=>x.length),3); await page.click('.account-register button[type="button"]')
  await page.screenshot({path:path.join(os.tmpdir(),'outreach-control-deck.png'),fullPage:false})
  await page.setViewport({width:390,height:844}); await new Promise(r=>setTimeout(r,300)); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false); await page.screenshot({path:path.join(os.tmpdir(),'outreach-control-deck-mobile.png'),fullPage:false})
  await page.$eval('.outreach-main-tabs button:nth-child(2)',node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})))
  await page.waitForFunction(()=>document.querySelector('.outreach-main-tabs button:nth-child(2)')?.getAttribute('aria-pressed')==='true')
  assert.match(await page.$eval('body',node=>node.innerText),/Owner Recheck/i)
  assert.match(await page.$eval('.outreach-main-tabs',node=>node.textContent),/Outreach reminders/)
  await browser.close();console.log('outreach control deck passed')
})().catch(error=>{console.error(error);process.exitCode=1})
