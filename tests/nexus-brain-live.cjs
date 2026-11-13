// Scoped live smoke: no valid credentials, messages, ratings or database writes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const origin='https://nexuslink.fit';
const out=path.resolve(__dirname,'screenshots/nexus-brain-v2');
const results=[];
const pass=(name,info={})=>{results.push({name,status:'PASS',...info});console.log('PASS '+name);};
let browser;
(async()=>{
  for(const token of ['', 'invalid-live-smoke'])for(const rsc of [false,true]){
    const res=await fetch(origin+'/rating'+(rsc?'?_rsc=smoke':''),{headers:{...(token?{cookie:`crm_session=${token}`} : {}),...(rsc?{RSC:'1'} : {})}});
    const body=await res.text();
    assert.equal(res.status,200);assert.ok(body.includes(rsc?'"state":"signin"':'Email or username'));assert.ok(!body.includes('Good food.'));
    assert.ok(!body.includes('temporarily unavailable'),'Canonical identity upstream must be reachable, not just fail closed');
    assert.match(res.headers.get('cache-control'),/no-store/);assert.match(res.headers.get('x-robots-tag'),/noindex/);
    pass(`live ${token?'invalid session':'anonymous'} ${rsc?'RSC':'HTML'} protected`,{http:res.status});
  }
  const malicious=await fetch(origin+'/rating?x-vercel-set-bypass-cookie=true');assert.equal(malicious.status,400);pass('client cannot request platform bypass cookie');
  const login=await fetch(origin+'/rating/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.ok([400,401,422].includes(login.status));assert.ok(!login.headers.get('set-cookie'));pass('canonical login reachable and rejects missing credentials',{http:login.status});
  for(const p of ['/','/anima','/robots.txt','/sitemap.xml']){const r=await fetch(origin+p);assert.equal(r.status,200);const body=await r.text();assert.ok(!body.includes('/rating'));pass('existing route preserved '+p,{http:r.status});}
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
  for(const width of [1440,390]){
    const page=await browser.newPage();const failures=[];
    page.on('pageerror',e=>failures.push(e.message));page.on('requestfailed',r=>failures.push(r.url().split('?')[0]));
    await page.setViewport({width,height:width===390?844:1000,deviceScaleFactor:1,isMobile:width===390,hasTouch:width===390});
    await page.goto(origin+'/rating',{waitUntil:'networkidle0'});assert.ok(await page.$('#identity'));assert.equal(await page.$eval('h1',el=>getComputedStyle(el).fontSize),width===390?'39px':'44px');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(out,`live-signin-${width}.png`)});assert.deepEqual(failures,[]);pass(`live HTTPS sign-in ${width}px with styles and scripts`);
    await page.close();
  }
  fs.writeFileSync(path.join(out,'live-results.json'),JSON.stringify({at:new Date().toISOString(),origin,results,limitation:'Live admin login not exercised: no founder password or session was requested or captured. Authorized interaction evidence uses actual local production build with loopback identity fixture.'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close()});
