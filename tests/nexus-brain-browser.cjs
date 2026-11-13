/* Headless production-build verification. Only loopback fixtures; no real login, records or messages. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'tests/screenshots/nexus-brain-v2');
fs.mkdirSync(out, { recursive: true });
const origin = 'http://127.0.0.1:3419';
const results = [], errors = [], writes = [];
const check = (name, details={}) => { results.push({name, status:'PASS', ...details}); console.log(`PASS ${name}`); };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const upstream = http.createServer((req,res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  res.setHeader('content-type', 'application/json');
  if (token === 'fixture-outage') { res.writeHead(503); res.end('{}'); return; }
  if (!['fixture-admin','fixture-agent','fixture-board'].includes(token)) {res.writeHead(401);res.end('{}');return;}
  res.end(JSON.stringify({agent:{role:token.slice(8)}}));
});
let app, browser;
async function run() {
  await new Promise(r=>upstream.listen(3420,'127.0.0.1',r));
  app = spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-p','3419','-H','127.0.0.1'],{cwd:root,env:{...process.env,NEXUS_BRAIN_AUTH_ORIGIN:'http://127.0.0.1:3420'},stdio:['ignore','pipe','pipe']});
  let startup = ''; app.stderr.on('data',d=>startup+=d); app.stdout.on('data',d=>startup+=d);
  for(let i=0;i<80;i++){try{if((await fetch(origin+'/rating')).ok)break;}catch{} if(i===79)throw new Error('Startup failed: '+startup);await sleep(250);}
  for (const token of ['', 'invalid', 'fixture-agent', 'fixture-board', 'fixture-outage']) {
    for(const rsc of [false,true]) {
      const r=await fetch(origin+'/rating'+(rsc?'?_rsc=fixture':''),{headers:{...(token?{cookie:`crm_session=${token}`} : {}),...(rsc?{RSC:'1'}:{})}});
      const html=await r.text();
      assert.ok(!html.includes('Good food.') && !html.includes('reports mention a soggy bun'));
      assert.match(r.headers.get('x-robots-tag'),/noindex/);
      assert.match(r.headers.get('cache-control'),/no-store/);
      check(`authorization ${token||'anonymous'} ${rsc?'RSC':'HTML'} denies presentation`);
    }
  }
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push({method:r.method(),url:r.url()});});
  await page.setViewport({width:1440,height:1000,deviceScaleFactor:1});
  await page.goto(origin+'/rating',{waitUntil:'networkidle0'});
  assert.ok(await page.$('#identity'));
  await page.screenshot({path:path.join(out,'signin-desktop.png')});
  check('anonymous sign-in form visible');
  await page.setCookie({name:'crm_session',value:'fixture-admin',url:origin,httpOnly:true,sameSite:'Lax'});
  await page.goto(origin+'/rating',{waitUntil:'networkidle0'});
  await page.waitForSelector('.brain-scene.in-view');
  await sleep(500);
  assert.match(await page.$eval('h1',el=>el.innerText),/Good food/);
  check('authorized presenter server rendering');
  await page.screenshot({path:path.join(out,'desktop-hero.png')});
  async function clickText(selector,needle){await page.evaluate(({selector,needle})=>{const el=[...document.querySelectorAll(selector)].findLast(el=>el.textContent.trim().includes(needle));if(!el)throw Error('Missing '+needle);el.click()},{selector,needle});await sleep(250);}
  async function section(id,file){await page.$eval(id,el=>el.scrollIntoView({block:'start'}));await sleep(600);await page.screenshot({path:path.join(out,file)});}
  await clickText('.signal-node','Timing');assert.match(await page.$eval('.signal-caption',el=>el.textContent),/10 minutes/);
  await section('#experience','desktop-burgers.png');
  assert.equal(await page.$$eval('.burger-comparison img',els=>new Set(els.map(e=>e.src)).size),2);
  check('two distinct expected and delivered burger images');
  await clickText('.case-tabs button','The wait');await sleep(350);
  assert.match(await page.$eval('.wait-scene',el=>el.textContent),/10min/);assert.match(await page.$eval('.wait-scene',el=>el.textContent),/30min/);
  await section('#experience','desktop-time-delta.png');check('10 versus 30 minute timeline');
  await clickText('.case-tabs button','Arrival condition');assert.ok(await page.$('.condition-scene'));
  await clickText('.case-tabs button','Different expectations');assert.match(await page.$eval('.expectations',el=>el.textContent),/never penalize nationality/);
  check('arrival and contextual expectations scenes');
  async function range(selector,value){await page.$eval(selector,(el,v)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);await sleep(150);}
  await range('#rating-input',9.4);assert.match(await page.$eval('.rating-number',el=>el.textContent),/Excellent/);
  await range('#rating-input',9.5);assert.match(await page.$eval('.rating-number',el=>el.textContent),/World Class/);
  assert.equal(await page.$$eval('.locked-evidence input',els=>els.length),0);
  for(const name of ['Delivery','Takeaway','Dine-in']){await clickText('.mode-tabs button',name);assert.match(await page.$eval('.radar-score',el=>el.textContent),new RegExp(name));assert.equal(await page.$$eval('.radar text',els=>els.length),6);}
  await clickText('.mode-tabs button','Delivery');await section('#rating-lab','desktop-rating-9-5.png');
  check('rating boundary, immutable history and three six-axis modes');
  await clickText('.reactions button',"Didn't like it");assert.equal(await page.$$eval('.question-block .reason-chips:first-of-type button',els=>els.length),11);
  await clickText('.reason-chips button','Too greasy');await clickText('.question-block .reason-chips button','Cheese');
  await clickText('.question-block .reason-chips button','Oily packaging');
  await page.select('#interpretation','Uncertain');await clickText('.interpretation button','Keep');
  assert.match(await page.$eval('.saved',el=>el.textContent),/No profile/);
  await section('#taste','desktop-semantic.png');check('dislike drill-down, effect, corrected interpretation and local save');
  await clickText('.reactions button','Loved it');await clickText('.reason-chips button','Flavor balance');await clickText('.question-block .reason-chips button','Balanced sauce');
  await clickText('.interpretation button','Keep');assert.ok(await page.$('.saved'));check('positive semantic branch');
  await clickText('.skip-question','Skip');assert.ok(await page.$('.saved'));check('optional semantic skip');
  await clickText('.dish-option','Roasted kale');assert.equal(await page.$eval('.fit-value b',el=>el.textContent),'?');await range('#curiosity',100);assert.equal(await page.$eval('.fit-value b',el=>el.textContent),'?');
  await clickText('.dish-option','Spicy sausage');assert.match(await page.$eval('.fit-value',el=>el.textContent),/NEXUS FIT/);check('ingredient FIT and unknown is not dislike');
  await clickText('.social-dishes button','Carbonara');assert.match(await page.$eval('.social-detail',el=>el.textContent),/Explicit demo opt-in/);
  await page.click('.consent input');assert.equal(await page.$$eval('.social-dishes',els=>els.length),0);check('dish-specific endorsements and hide consent');
  for(let i=0;i<6;i++){await page.$$eval('.loop-track button',(els,index)=>els[index].click(),i);assert.equal(await page.$eval('.loop-index',el=>el.textContent),'0'+(i+1));}
  await clickText('.merchant-hypothesis button','Record');assert.match(await page.$eval('.merchant-hypothesis',el=>el.textContent),/Awaiting post-change evidence/);
  await section('#merchant','desktop-merchant-loop.png');check('all six loop steps and no fabricated experiment outcome');
  for(const v of ['Drinks','Services','Experiences','Food']){await clickText('.vertical-tabs button',v);assert.ok(await page.$('.vertical-result h3'));}check('four vertical teasers');
  await page.click('[aria-label="Pause animations"]');assert.ok(await page.$('.motion-paused'));check('global animation pause');
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.reload({waitUntil:'networkidle0'});assert.ok(await page.$('.motion-paused'));check('reduced motion respected');
  await page.emulateMediaFeatures([]);
  for(const width of [390,430]){
    await page.setViewport({width,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await page.reload({waitUntil:'networkidle0'});await sleep(350);
    let overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
    await page.screenshot({path:path.join(out,`mobile-${width}-hero.png`)});
    await section('#experience',`mobile-${width}-burgers.png`);
    await section('#rating-lab',`mobile-${width}-rating.png`);
    await section('#merchant',`mobile-${width}-merchant.png`);
    overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
    check(`mobile ${width}px touch layout without horizontal overflow`);
  }
  await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});
  await page.goto(origin+'/rating',{waitUntil:'networkidle0'});
  const recorder=await page.screencast({path:path.join(out,'mobile-walkthrough.webm'),format:'webm'});
  await sleep(1000);
  for(const id of ['#experience','#rating-lab','#taste','#fit','#merchant']){await page.$eval(id,el=>el.scrollIntoView({behavior:'smooth',block:'start'}));await sleep(1400);if(id==='#experience'){await clickText('.case-tabs button','The wait');await sleep(900);}if(id==='#rating-lab'){await range('#rating-input',9.5);await clickText('.mode-tabs button','Delivery');}if(id==='#taste'){await clickText('.reactions button',"Didn't like it");await clickText('.reason-chips button','Too greasy');}if(id==='#merchant'){await clickText('.loop-controls button','Play');await sleep(3500);}}
  await recorder.stop();check('mobile walkthrough video captured');
  await page.evaluate(()=>scrollTo(0,0));await sleep(300);
  const metrics=await page.evaluate(async()=>{const nav=performance.getEntriesByType('navigation')[0];const frames=[];await new Promise(resolve=>{let last=performance.now();const tick=t=>{frames.push(t-last);last=t;if(frames.length<120)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});return{loadMs:Math.round(nav.loadEventEnd),domContentLoadedMs:Math.round(nav.domContentLoadedEventEnd),medianFrameMs:frames.sort((a,b)=>a-b)[60],jsDecodedBytes:performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script').reduce((sum,r)=>sum+r.decodedBodySize,0),webglCanvases:document.querySelectorAll('canvas').length};});
  check('headless mobile performance sample',metrics);
  const cdp=await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:200000,uploadThroughput:96000});
  await page.setCacheEnabled(false);
  await page.goto(origin+'/rating',{waitUntil:'networkidle0'});
  const cold=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {loadMs:Math.round(n.loadEventEnd),domContentLoadedMs:Math.round(n.domContentLoadedEventEnd),decodedJsBytes:performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script').reduce((sum,r)=>sum+r.decodedBodySize,0)}});
  await page.tap('.case-tabs button:nth-child(2)');await page.waitForSelector('.wait-scene');
  assert.match(await page.$eval('.wait-scene',el=>el.textContent),/30min/);
  await page.tap('.mode-tabs button:last-child');assert.match(await page.$eval('.radar-score',el=>el.textContent),/Delivery/);
  await page.tap('.reactions button:last-child');await page.tap('.question-block .reason-chips button:first-child');
  assert.match(await page.$eval('.interview',el=>el.textContent),/Was it the salami/);
  await page.$eval('#rating-input',el=>el.scrollIntoView({block:'center'}));
  await page.focus('#rating-input');const beforeKey=await page.$eval('#rating-input',el=>Number(el.value));
  await page.keyboard.press('ArrowRight');assert.equal(await page.$eval('#rating-input',el=>Number(el.value)),Math.round((beforeKey+.1)*10)/10);
  await page.$eval('.mode-tabs',el=>el.scrollIntoView({block:'center'}));
  await page.evaluate(()=>{window.brainTapLatency=null;document.querySelector('.mode-tabs button').addEventListener('click',event=>requestAnimationFrame(()=>window.brainTapLatency=performance.now()-event.timeStamp),{once:true})});
  await page.tap('.mode-tabs button');await page.waitForFunction(()=>window.brainTapLatency!==null);
  const tapLatencyMs=Math.round(await page.evaluate(()=>window.brainTapLatency));
  const heap=await page.metrics();
  check('cold mobile simulation and actual touch/keyboard actions',{...cold,cpuSlowdown:4,network:'1.6 Mbps down / 150ms latency',tapToNextFrameMs:tapLatencyMs,jsHeapMiB:Math.round(heap.JSHeapUsedSize/1024/1024*10)/10});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);check('no browser exceptions and zero outgoing mutations');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({at:new Date().toISOString(),browser:await browser.version(),environment:'Local production build, loopback identity fixture; desktop CPU, mobile viewports, not physical-device benchmark',results,errors,writes},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({at:new Date().toISOString(),message:e.message,results,errors},null,2));}).finally(async()=>{if(browser)await browser.close();if(app)app.kill();upstream.close();});
