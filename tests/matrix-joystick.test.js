const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
 try{
 const page=await browser.newPage();await page.setViewport({width:393,height:852});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 await page.setRequestInterception(true);
 page.on('request',r=>r.isNavigationRequest()?r.respond({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/Link/map-islands.css"></head><body><main></main></body></html>'}):r.continue());
 await page.goto('http://127.0.0.1:4174/joystick-test');
 await page.evaluate(async()=>{
 const {createMapInstruments}=await import('/Link/map-instruments.mjs');
 window.moves=[];window.returns=0;
 window.instrument=createMapInstruments(document.querySelector('main'),{id:'test',map:true,getFilters:()=>({}),getHomes:()=>[],getLocations:()=>[],getFavorites:()=>[],getSuperFavorites:()=>[],onMove:a=>moves.push(a),onReturn:()=>returns++});
 instrument.open('view');
 });
 await page.focus('.map-joystick');await page.keyboard.down('ArrowRight');await page.keyboard.down('ArrowDown');
 let axes=await page.evaluate(()=>moves.at(-1));assert.ok(axes.x>0&&axes.y>0&&Math.hypot(axes.x,axes.y)<=1.001);
 await page.keyboard.up('ArrowDown');axes=await page.evaluate(()=>moves.at(-1));assert.deepEqual(axes,{x:1,y:0});
 await page.evaluate(()=>instrument.close());await page.keyboard.up('ArrowRight');
 const count=await page.evaluate(()=>moves.length);await new Promise(r=>setTimeout(r,230));assert.equal(await page.evaluate(()=>moves.length),count);assert.deepEqual(await page.evaluate(()=>moves.at(-1)),{x:0,y:0});
 await page.evaluate(()=>instrument.open('view'));await page.focus('.map-joystick');await page.keyboard.down('ArrowLeft');
 await page.evaluate(()=>instrument.open('filters'));await page.keyboard.up('ArrowLeft');assert.deepEqual(await page.evaluate(()=>moves.at(-1)),{x:0,y:0});
 await page.evaluate(()=>instrument.open('view'));await page.click('.joystick-return');assert.equal(await page.evaluate(()=>returns),1);
 const box=await page.$eval('.map-joystick',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
 await page.mouse.move(box.x,box.y);await page.mouse.down();assert.deepEqual(await page.evaluate(()=>moves.at(-1)),{x:0,y:0});await page.mouse.move(box.x+35,box.y);assert.ok((await page.evaluate(()=>moves.at(-1))).x>0);await page.mouse.up();assert.deepEqual(await page.evaluate(()=>moves.at(-1)),{x:0,y:0});
 await page.screenshot({path:'matrix-joystick-mobile.png'});console.log('Matrix joystick: diagonal keys, release, close, tab switch, return, dead zone and pointer drag passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});

