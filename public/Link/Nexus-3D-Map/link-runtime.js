import {setupValletta} from './valletta.js?v=walls-limestone-47';
import {setupCatalog} from './catalog.js?v=ihg-original-1';
import {ZERO_PART,partCentre,applyPart,transformedPolygons} from './parts.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.mjs';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ORIGINAL, DEFAULT_PLACEMENT, sanitizePlacement, coordinates, offsets, footprint, groundSamples, platformLevels } from './placement.mjs';

document.body.insertAdjacentHTML('beforeend', `
<header class="masthead"><div class="brand">NEXUS</div><div class="eyebrow">Malta · The landmark collection</div></header>
<nav class="top-actions" aria-label="Map views"><button class="action secondary" id="overview">All Malta ↗</button><button class="action secondary" id="home">OneOneO</button><button class="action secondary" id="fort-home">Fort Cambridge</button><button class="action secondary" id="portomaso-home">Portomaso + Hilton</button><button class="action secondary" id="laguna-home">Laguna</button><button class="action secondary" id="mercury-home">Mercury</button><button class="action secondary" id="suites-home">Mercury Suites</button><button class="action secondary" id="ora-home">ORA 8 + 9</button><button class="action secondary" id="hardrock-home">Hard Rock</button><button class="action secondary" id="creek-home">Creekville 10 + 11</button><button class="action secondary" id="tigne-home">Tigne 15–18</button><button class="action secondary" id="toggle-panel" aria-expanded="true">Locations</button></nav>
<div class="status" role="status" id="status">Loading the landmark collection…</div>
<aside class="panel" aria-label="Landmark collection"><div class="panel-head"><div class="eyebrow">Explore the island</div><h1>Extraordinary places.</h1><div class="count">37 locations · 26 landmark models · 11 mapped locations</div><input class="search" id="search" aria-label="Search developments" placeholder="Find a development…"></div><div class="landmark-list" id="list"></div><section class="detail" id="detail"></section></aside>
<section class="model-modal" id="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-title"><div class="model-header"><div><div class="eyebrow" id="model-eyebrow">Landmark study / 01</div><h2 id="model-title">OneOneO, in detail.</h2></div><button class="action secondary" id="close-model">Back to map ×</button></div><div class="viewer" id="viewer"></div><div class="model-footer"><p>Reference-based architectural model. Drag to orbit · Scroll to zoom.<br>Dimensions and alignment are estimates; this is not a surveyed model.</p><div class="actions"><button class="action secondary" id="material">Material: Champagne</button><a class="action" id="download-model" href="oneoneo.glb" download>Download .GLB ↓</a></div></div></section>`);
const $ = id => document.getElementById(id);
const status = message => $('status').textContent = message;
document.querySelector('.top-actions').insertAdjacentHTML('beforeend','<button class="action" id="export-map">Download Map + Modelle ↓</button>');
const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let catalog,cityLayer;
let selected=1, features=[], markers=[], model, layer, viewerRenderer, viewerScene, viewerCamera, orbit, viewerModel, animation, opener;
let placement={...DEFAULT_PLACEMENT}, editMode=true, moveHandle, footprintTimer;
const assets = [
 {key:'oneoneo',name:'OneOneO',ids:[1],origin:ORIGINAL,halfSize:[54,13.5],file:'oneoneo.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.7},
 {key:'fort-cambridge',name:'Fort Cambridge',ids:[2,3],origin:[14.509604,35.908444],halfSize:[46,14],file:'fort-cambridge.glb',defaults:{...DEFAULT_PLACEMENT,heading:130},zoom:17.1},
 {key:'portomaso-hilton',name:'Portomaso + Hilton',ids:[4],origin:[14.49291,35.92205],halfSize:[84,99],file:'portomaso-hilton.glb',defaults:{...DEFAULT_PLACEMENT,heading:0,lift:0},zoom:15.8,openGround:true,fixedAltitude:2},
 {key:'laguna-portomaso',name:'Laguna Portomaso',ids:[5],origin:[14.49455,35.92016],halfSize:[65,60],file:'laguna-portomaso.glb',defaults:{...DEFAULT_PLACEMENT,lift:0},zoom:17.2,viewBearing:180,openGround:true,fixedAltitude:2},
 {key:'mercury-tower',name:'Mercury Tower + House',ids:[6],origin:[14.489162,35.92308],halfSize:[37,34],file:'mercury-tower.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1},
 {key:'mercury-suites',name:'Mercury Suites + Plaza',ids:[7],origin:[14.489296,35.922391],halfSize:[44,58],file:'mercury-suites.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1},
 {key:'ora-west',name:'ORA West Tower',ids:[8],origin:[14.489795,35.928126],halfSize:[12,13],file:'ora-west.glb',defaults:{...DEFAULT_PLACEMENT,heading:27},zoom:17.6},
 {key:'ora-east',name:'ORA East Tower',ids:[9],origin:[14.489483,35.928298],halfSize:[12,13],file:'ora-east.glb',defaults:{...DEFAULT_PLACEMENT,heading:27},zoom:17.6},
 {key:'hard-rock-hotel',name:'Hard Rock Hotel',ids:[37],origin:[14.488753,35.928045],halfSize:[74,42],file:'hard-rock-hotel.glb',defaults:{...DEFAULT_PLACEMENT,heading:27},zoom:16.5},
 {key:'creekville-10',name:'Creekville Sued',ids:[10],origin:[14.481929,35.919422],halfSize:[43,52],file:'creekville-10.glb',defaults:{...DEFAULT_PLACEMENT},zoom:18},
 {key:'creekville-11',name:'Creekville Nord',ids:[11],origin:[14.481795,35.919725],halfSize:[40,65],file:'creekville-11.glb',defaults:{...DEFAULT_PLACEMENT},zoom:18},
 {key:'balluta-terraces',name:'Balluta Terraces',ids:[12],origin:[14.492676,35.91317],halfSize:[28,38],file:'balluta-terraces.glb',defaults:{...DEFAULT_PLACEMENT},zoom:18.2},
 {key:'balluta-buildings',name:'Balluta Buildings',ids:[13],origin:[14.494306,35.913681],halfSize:[42,65],file:'balluta-buildings.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.7},
 {key:'fortina',name:'Fortina',ids:[14],origin:[14.509559,35.906914],halfSize:[100,65],file:'fortina.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.2},
 {key:'tigne-15',name:'Tigne Point 15',ids:[15],origin:[14.511136, 35.906657],halfSize:[85,90],file:'tigne-15.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1},
 {key:'tigne-16',name:'Tigne Point 16',ids:[16],origin:[14.511883, 35.906533],halfSize:[85,90],file:'tigne-16.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1},
 {key:'tigne-17',name:'Tigne Point 17',ids:[17],origin:[14.512354, 35.906802],halfSize:[85,90],file:'tigne-17.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1},
 {key:'tigne-18',name:'Tigne Point 18',ids:[18],origin:[14.512607, 35.90695],halfSize:[85,90],file:'tigne-18.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1},
 {key:'madliena-village',name:'Madliena Village',ids:[22],origin:[14.46205,35.92735],halfSize:[70,85],file:'madliena-village.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1,viewBearing:65},
 {key:'verdala-terraces',name:'Verdala Terraces',ids:[26],origin:[14.4035,35.87812],halfSize:[68,100],file:'verdala-terraces.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.1,viewBearing:250},
 {key:'ivory-suites',name:'Ivory Suites / INNSiDE',ids:[23],origin:[14.41451,35.952005],halfSize:[32,50],file:'ivory-suites.glb',defaults:{...DEFAULT_PLACEMENT},zoom:18,viewBearing:135},
 {key:'shoreline',name:'Shoreline',ids:[27],origin:[14.5415,35.892],halfSize:[60,70],file:'shoreline.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.2,viewBearing:110},
 {key:'scirocco-18',name:'Ta Monita Nord',ids:[28],origin:[14.5653,35.86647],halfSize:[65,40],file:'ta-monita-28.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.6,viewBearing:15},
 {key:'scirocco-19',name:'Ta Monita Suedwest',ids:[29],origin:[14.56483,35.86597],halfSize:[90,55],file:'ta-monita-29.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.8,viewBearing:15},
 {key:'southridge',name:'Southridge',ids:[30],origin:[14.365355,35.95302],halfSize:[90,42],file:'southridge.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.4,viewBearing:10},
 {key:'scirocco',name:'Scirocco Heights',ids:[31],origin:[14.530496,35.833892],halfSize:[80,48],file:'scirocco.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.5,viewBearing:145},
 {key:'st-angelo',name:'St Angelo Mansions',ids:[32],origin:[14.5199,35.89062],halfSize:[70,50],file:'st-angelo.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.6,viewBearing:40},
 {key:'tas-sellum',name:'Tas-Sellum Residences',ids:[33],origin:[14.364383,35.96660],halfSize:[55,60],file:'tas-sellum.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.5,viewBearing:180},
 {key:'pendergardens',name:'Pendergardens',ids:[34,35,36],origin:[14.488635,35.92163],halfSize:[70,65],file:'pendergardens.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.3,viewBearing:20},
 {key:'14east',name:'14 East',ids:[38],origin:[14.493732067295127,35.90449520322797],halfSize:[28,30],file:'14east.glb',defaults:{...DEFAULT_PLACEMENT,heading:-20},zoom:17.5,viewBearing:150},
 {key:'fort-manoel',name:'Fort Manoel',ids:[39],origin:[14.505225194086961,35.9028677061595],halfSize:[140,145],file:'fort-manoel.glb',defaults:{...DEFAULT_PLACEMENT},zoom:16.8,viewBearing:35},
 {key:'valletta-dome',name:'Valletta Karmeliterkuppel',ids:[40],origin:[14.512345610343289,35.90028569680575],halfSize:[33,35],file:'valletta-dome.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.5,viewBearing:155},
 {key:'paola-church',name:'Paola Christ the King',ids:[41],origin:[14.508076011469,35.87163798479244],halfSize:[70,40],file:'paola-church.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.2,viewBearing:100},
 {key:'mosta',name:'Mosta Rotunda',ids:[42],origin:[14.425812961376323,35.910033850204385],halfSize:[55,55],file:'mosta.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.3,viewBearing:335},
 {key:'towns-end',name:'Towns End Mellieha',ids:[43],origin:[14.371495251781056,35.95429192821524],halfSize:[55,65],file:'towns-end.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.3,viewBearing:30},
 {key:'doubletree',name:'DoubleTree by Hilton Malta',ids:[44],origin:[14.418394836142596,35.95436252913633],halfSize:[125,145],file:'doubletree.glb',defaults:{...DEFAULT_PLACEMENT},zoom:16.9,viewBearing:100},
 {key:'phoenicia',name:'The Phoenicia Malta',ids:[45],origin:[14.50693305861003,35.89550242380332],halfSize:[120,130],file:'phoenicia.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.3,viewBearing:140},
 {key:'ihg',name:'InterContinental Malta',ids:[48],origin:[14.48794863297249,35.92378744134112],halfSize:[86,100],file:'ihg.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.2,viewBearing:125,preserveMaterials:true},
 {key:'valletta-gate',name:'Valletta Parlament und City Gate',ids:[46],origin:[14.509527549913798,35.895998947782246],halfSize:[90,55],file:'valletta-gate.glb',defaults:{...DEFAULT_PLACEMENT},zoom:17.5,viewBearing:30}
];
try{assets[2].layout=(await (await fetch('portomaso-layout.json')).json()).polygons;}catch{}
try{assets[3].layout=(await (await fetch('laguna-layout.json')).json()).polygons;}catch{}
try{assets[4].layout=(await (await fetch('mercury-layout.json')).json()).polygons;}catch{}
try{assets[5].layout=(await (await fetch('mercury-suites-layout.json')).json()).polygons;}catch{}
let bundledPlacements={};
try{const response=await fetch('placement-defaults.json');if(response.ok)bundledPlacements=await response.json();}catch{}
for(const [old,key] of [['scirocco-18','ta-monita-28'],['scirocco-19','ta-monita-29']])if(bundledPlacements[key])bundledPlacements[old]=bundledPlacements[key];
for(const asset of assets)if(bundledPlacements[asset.key])asset.defaults=sanitizePlacement({...asset.defaults,...bundledPlacements[asset.key]});
// Recover the user's last exported placement snapshot once, retaining a backup.
try{
 const recovery=await (await fetch('placement-recovery.json')).json();
 for(const asset of assets)if(recovery[asset.key])asset.defaults=sanitizePlacement({...asset.defaults,...recovery[asset.key]});
 const recoveryKey='nexus-recovery-20260919-035133';
 if(!localStorage.getItem(recoveryKey)){
  const backup={};
  for(const asset of assets){const key='nexus-'+asset.key+'-placement-v1';backup[key]=localStorage.getItem(key);}
  localStorage.setItem(recoveryKey+'-backup',JSON.stringify(backup));
  for(const asset of assets)if(recovery[asset.key])localStorage.setItem('nexus-'+asset.key+'-placement-v1',JSON.stringify(recovery[asset.key]));
  localStorage.setItem(recoveryKey,'restored');
 }
}catch{}
for(const asset of assets){asset.placement={...asset.defaults};asset.gold=true;try{const alias=({'scirocco-18':'ta-monita-28','scirocco-19':'ta-monita-29'})[asset.key];const saved=localStorage.getItem('nexus-'+asset.key+'-placement-v1')||(alias&&localStorage.getItem('nexus-'+alias+'-placement-v1'));if(saved){const data=JSON.parse(saved);asset.placement=sanitizePlacement(data);if(data.heightReference!=='platform-v2')asset.placement.lift=Math.max(0,asset.placement.lift);}}catch{}}
let selectedPart=null;
let active=assets[0];placement=active.placement;
const assetFor=id=>assets.find(a=>a.ids.includes(id));
const activeCoordinates=()=>coordinates(active.placement.east,active.placement.north,active.origin);
const handleCoordinates=()=>{const p=selectedPart?partCentre(active,selectedPart):active.placement;return coordinates(p.east,p.north,active.origin);};
function choosePart(id){
 selectedPart=active.parts?.find(p=>p.id===id)||null;
 placement=selectedPart?selectedPart.placement:active.placement;
 renderEditor();moveHandle?.setLngLat(handleCoordinates());
 if(moveHandle)moveHandle.getElement().setAttribute('aria-label','Verschieben: '+(selectedPart?.label||active.name));
}

let cinemaPreload=false;
const warmedViews=new Set();
let cinema=false, cinemaFrame=0, cinemaStart=0, cinemaInitial=null,cinemaTarget=null,cinemaTimeStart=0,cinemaHourStart=21,cinemaLastTime=0;
document.querySelector('.top-actions').insertAdjacentHTML('beforeend','<button class="action secondary" id="cinema" aria-label="Kamerafahrt starten" aria-pressed="false">▶ Play</button>');
function stopCinema(){cinema=false;cancelAnimationFrame(cinemaFrame);$('cinema').textContent='▶ Play';$('cinema').setAttribute('aria-label','Kamerafahrt starten');$('cinema').setAttribute('aria-pressed','false');}
function cinemaFraming(asset){
 const bounds=new THREE.Box3();asset.model.updateMatrixWorld(true);
 asset.model.traverse(o=>{if(!o.isMesh||o.material?.userData.exteriorBeam)return;if(o.isInstancedMesh){if(!o.boundingBox)o.computeBoundingBox();bounds.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));}else{if(!o.geometry.boundingBox)o.geometry.computeBoundingBox();bounds.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));}});
 bounds.min.y=Math.max(0,bounds.min.y);
 const size=bounds.getSize(new THREE.Vector3()),mid=bounds.getCenter(new THREE.Vector3());
 const panel=$('toggle-panel').getAttribute('aria-expanded')==='true'&&innerWidth>700?320:0;
 const width=Math.max(300,innerWidth-panel-70),height=Math.max(280,innerHeight-240),span=Math.max(16,Math.hypot(size.x,size.z));
 const pixelsPerMeter=Math.min(width*.72/span,height*.64/(size.y*.866+span*.5));
 const zoom=Math.max(15.6,Math.min(19.5,Math.log2(pixelsPerMeter*40075016.686*Math.cos(asset.origin[1]*Math.PI/180)/512)));
 // Large, low-rise ensembles get a moving focus inside the site, not a distant orbit.
 let tour=null;
 if(asset.key==='portomaso-hilton'){
  const stops=[[36,58],[32,120],[2,168],[-48,138],[-43,62],[-20,4],[22,-48],[55,-4]];
  tour={curve:new THREE.CatmullRomCurve3(stops.map(([x,z])=>new THREE.Vector3(x,0,z)),true,'centripetal'),duration:32,zoomBoost:1.25};
 }else if(Math.max(size.x,size.z)>230&&size.y<155){
  const stops=[[.2,-.25],[.3,.05],[.16,.3],[-.18,.25],[-.28,-.05],[-.12,-.3]];
  tour={curve:new THREE.CatmullRomCurve3(stops.map(([x,z])=>new THREE.Vector3(mid.x+size.x*x,0,mid.z+size.z*z)),true,'centripetal'),duration:28,zoomBoost:.85};
 }
 return {asset,mid,zoom,tour,pitch:60,padding:{top:tour?180:160+Math.min(300,size.y*pixelsPerMeter*.72),bottom:90,left:30,right:panel+30}};
}
function updateCinemaReadiness(){
 const ready=assets.filter(a=>a.model).length;
 $('cinema').title='Orbit: 7 Sekunden / Grosse Anlagen: Detailflug / Tag-Nacht: 12 Sekunden / Modelle bereit: '+ready+'/'+assets.length;
}
function prewarmCinema(asset){
 if(!asset?.model||!map.getLayer('nexus-buildings-main'))return;
 const key=[asset.key,innerWidth,innerHeight,...Object.values(asset.placement)].join(':');
 if(warmedViews.has(key))return;warmedViews.add(key);
 const framing=cinemaFraming(asset),angle=asset.placement.heading*Math.PI/180;
 const poses=Array.from({length:4},(_,i)=>{
  const p=framing.tour?framing.tour.curve.getPointAt(i/4):framing.mid;
  return {center:coordinates(asset.placement.east+p.x*Math.cos(angle)+p.z*Math.sin(angle),asset.placement.north+p.x*Math.sin(angle)-p.z*Math.cos(angle),asset.origin),zoom:Math.min(19.3,framing.zoom+(framing.tour?framing.tour.zoomBoost+.28:.3)),pitch:67,bearing:i*90,padding:framing.padding};
 });
 // Public Mapbox preload mode requests the future views without moving the live camera.
 for(const pose of poses){try{map.jumpTo({...pose,preloadOnly:true});}catch(error){warmedViews.delete(key);console.warn('View warmup deferred:',error.message);break;}}
}
function beginCinema(){
 if(cinema||!active)return;
 cancelAnimationFrame(cinemaFrame);map.stop();cinema=true;cinemaStart=performance.now();cinemaTimeStart=cinemaStart;cinemaHourStart=Number($('timeSlider').value);cinemaLastTime=0;cinemaTarget=null;cinemaPreload=true;loadNearby();prewarmCinema(active);updateCinemaReadiness();
 cinemaInitial={asset:null,bearing:map.getBearing(),transition:null};
 $('cinema').textContent='Pause';$('cinema').setAttribute('aria-label','Kamerafahrt pausieren');$('cinema').setAttribute('aria-pressed','true');
 const frame=now=>{
  if(!cinema)return;
  if(active?.model){
   if(!cinemaTarget||cinemaTarget.asset!==active)cinemaTarget=cinemaFraming(active);
   const {mid,zoom,padding,tour}=cinemaTarget,angle=active.placement.heading*Math.PI/180;
   const seconds=(now-cinemaStart)/1000;
   if(cinemaInitial.asset!==active){
    cinemaInitial.asset=active;
    const center=map.getCenter(),bearing=map.getBearing();
    // Keep the same angular phase while changing property or following the detail route.
    cinemaInitial.transition={start:now,center:[center.lng,center.lat],bearing,routeBearing:bearing,zoom:map.getZoom(),pitch:map.getPitch(),padding:map.getPadding()};
   }
   const travel=cinemaInitial.transition,elapsed=(now-travel.start)/1000;
   const breathing=(1-Math.cos(seconds*Math.PI*2/5.8))*.5;
   let focus=mid,desiredZoom=zoom-.25+.43*breathing,desiredPitch=58+9*Math.sin(seconds*Math.PI*2/13);
   let bearing=cinemaInitial.bearing+seconds/7*360;
   const progress=Math.min(1,elapsed/(tour?2.2:1.5)),blend=progress*progress*(3-2*progress);
   if(tour){
    // Arc-length sampling keeps the speed even around corners and across the loop seam.
    const phase=(elapsed/tour.duration)%1;
    focus=tour.curve.getPointAt(phase);
    desiredZoom=Math.min(19.3,zoom+tour.zoomBoost+.26*Math.sin(seconds*Math.PI*2/6.2));
    desiredPitch=60+7*Math.sin(phase*Math.PI*2-.4);

   }
   const target=coordinates(active.placement.east+focus.x*Math.cos(angle)+focus.z*Math.sin(angle),active.placement.north+focus.x*Math.sin(angle)-focus.z*Math.cos(angle),active.origin);
   const mix=(a,b)=>a+(b-a)*blend;
   map.jumpTo({center:[mix(travel.center[0],target[0]),mix(travel.center[1],target[1])],
    bearing,pitch:mix(travel.pitch,desiredPitch),zoom:mix(travel.zoom,desiredZoom),
    padding:Object.fromEntries(Object.entries(padding).map(([key,value])=>[key,mix(travel.padding[key],value)]))});
  }
  if(now-cinemaLastTime>=50){
   cinemaLastTime=now;
   $('timeSlider').value=((cinemaHourStart+(now-cinemaTimeStart)/12000*24)%24).toFixed(2);
   $('timeSlider').dispatchEvent(new Event('input',{bubbles:true}));
  }
  cinemaFrame=requestAnimationFrame(frame);
 };
 cinemaFrame=requestAnimationFrame(frame);
}
addEventListener('resize',()=>{cinemaTarget=null;});
$('toggle-panel').addEventListener('click',()=>{cinemaTarget=null;});
document.addEventListener('input',e=>{if(cinema&&e.isTrusted&&e.target.id==='timeSlider'){cinemaHourStart=Number(e.target.value);cinemaTimeStart=performance.now();}});
$('cinema').title='Orbit: 7 Sekunden / Grosse Anlagen: Detailflug / Tag-Nacht: 12 Sekunden';

$('cinema').onclick=()=>cinema?stopCinema():beginCinema();
map.getCanvas().addEventListener('pointerdown',()=>{if(cinema)stopCinema();});
map.getCanvas().addEventListener('wheel',()=>{if(cinema)stopCinema();},{passive:true});
let gold=true;
const prefersReducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
map.addControl(new mapboxgl.NavigationControl(), 'top-left');
map.on('error', event => { console.warn('Map resource:',event.error?.message); status('A map resource could not load. Check your connection or Mapbox access.'); });
map.on('load',()=>status(''));
map.on('sourcedata',event=>{if(event.sourceId==='mapbox-dem'){for(const asset of assets)asset.groundDirty=true;map.triggerRepaint();}});

function select(id, fly=true){
  if(id!==47)cityLayer?.leaveSelection();
  selected=id;
  selectedPart=null;active=assetFor(id);if(active){placement=active.placement;model=active.model;gold=active.gold;if(!active.model)queueMicrotask(()=>loadNearby());if(cinema)prewarmCinema(active);}
  const f=features.find(f=>f.id===id);
  if(!f)return;
  catalog?.ensureVisible(f);
  document.querySelectorAll('.landmark').forEach(el=>el.classList.toggle('active',Number(el.dataset.id)===id));
  markers.forEach(m=>m.getElement().classList.toggle('selected',Number(m.getElement().dataset.id)===id));
  $('detail').innerHTML=`<div class="eyebrow">Location ${String(id).padStart(2,'0')}</div><h2>${escapeHTML(f.properties.name)}</h2>${active?'<div class="actions"><button class="action" id="inspect">Explore 3D model ↗</button><button class="action secondary" id="edit-model">Placement</button></div><div id="placement-editor"></div>':'<p>Saved at your original coordinates. Architectural model pending reference images.</p>'}`;
  if(id===47){
   stopCinema();if(moveHandle)moveHandle.getElement().hidden=true;
   $('detail').innerHTML='<div class="eyebrow">Location 47 / Mauer-Layer</div><h2>'+escapeHTML(f.properties.name)+'</h2><p>Valletta-Stadtmauern und Bastionen sind ausgewaehlt. Ziehe den goldenen Griff, um die gesamte Mauer zu verschieben. Position, Rotation und Hoehe findest du oben.</p><button class="action" id="focus-walls">Gesamte Stadtmauer ansehen</button>';
   $('focus-walls').onclick=()=>cityLayer?.selectWalls(true);cityLayer?.selectWalls(fly);return;
  }
  if(active){$('inspect').onclick=openModel;$('edit-model').onclick=()=>{editMode=!editMode;renderEditor();};renderEditor();}
  if(moveHandle){moveHandle.getElement().hidden=!(active&&editMode);if(active){moveHandle.setLngLat(activeCoordinates());moveHandle.getElement().setAttribute('aria-label','Drag to move '+active.name);}}
  if(active&&active.ids.length>1)$('placement-editor').insertAdjacentHTML('beforebegin','<p class="group-note">Markers '+active.ids.join(' + ')+' · gemeinsame Anlage · Bauteile einzeln anpassbar</p>');
  if(cinema){if(active)beginCinema();else stopCinema();}
  else if(fly)map.flyTo({center:active?activeCoordinates():f.geometry.coordinates,zoom:active?active.zoom:16.6,pitch:64,bearing:active?(active.viewBearing??14)-placement.heading:14,duration:prefersReducedMotion?0:1500,padding:{top:0,bottom:0,left:0,right:innerWidth>700?310:0},retainPadding:false});
}
function renderEditor(){
  $('edit-model').setAttribute('aria-pressed',String(editMode));
  if(moveHandle)moveHandle.getElement().hidden=!editMode;
  $('placement-editor').innerHTML=editMode?`${active.parts?.length?'<label>Bauteil bearbeiten<select id="part-select" aria-label="Bauteil bearbeiten"><option value="">Gesamtes '+active.name+'</option>'+active.parts.map(p=>'<option value="'+p.id+'"'+(selectedPart===p?' selected':'')+'>'+p.label+'</option>').join('')+'</select></label><p>Ein Bauteil auswählen, dann mit dem goldenen Griff verschieben. Drehung erfolgt um seine eigene Mitte.</p>':''}<p>Drag the gold ✥ handle to move the building.</p><div class="placement-fields"><div class="height-control"><label>Gebäudehöhe feinjustieren<span><input id="place-lift" type="text" inputmode="decimal" aria-label="Height above ground" value="${Number(placement.lift.toFixed(2))}"> m</span></label><input type="range" id="lift-building" aria-label="Gebäude anheben oder absenken" min="-20" max="80" step="0.1" value="${placement.lift}"><p class="ground-hint">0 = automatisch über Gelände. Minus = tiefer; die unteren Wände reichen jetzt tiefer ins Gelände.</p><div class="height-buttons"><button class="action secondary" id="lower-building">− 0,5 m</button><button class="action secondary" id="raise-building">+ 0,5 m</button></div></div>${[['heading','Rotation','°',-180,180,1],['east','East / west','m',-500,500,'any'],['north','North / south','m',-500,500,'any']].map(([key,label,unit,min,max,step])=>`<label>${label}<span><input id="place-${key}" type="number" aria-label="${label}" min="${min}" max="${max}" step="${step}" value="${Number(placement[key].toFixed(2))}"> ${unit}</span></label>${key==='heading'?'<input type="range" aria-label="Rotate building" id="rotate-building" min="-180" max="180" value="'+placement.heading+'">':''}`).join('')}</div><div class="actions"><button class="action secondary" id="ground-model">Höhenkorrektur zurücksetzen</button><button class="action secondary" id="reset-model">Reset</button></div><p id="placement-state" role="status">Placement saved on this device.</p>`:'';
  if(!editMode)return;
  if($('part-select'))$('part-select').onchange=e=>choosePart(e.target.value);
  for(const key of Object.keys(DEFAULT_PLACEMENT)){
    const input=$('place-'+key);
    input.oninput=e=>{const raw=e.target.value.trim().replace(',','.');if(raw===''||!Number.isFinite(Number(raw)))return;updatePlacement({[key]:Number(raw)});};
    input.onblur=()=>input.value=Number(placement[key].toFixed(2));
    input.onkeydown=e=>{if(e.key==='Enter')input.blur();};
  }
  $('lift-building').oninput=e=>updatePlacement({lift:Number(e.target.value)});
  $('lower-building').onclick=()=>updatePlacement({lift:Math.round((placement.lift-.5)*100)/100});
  $('raise-building').onclick=()=>updatePlacement({lift:Math.round((placement.lift+.5)*100)/100});
  $('rotate-building').oninput=e=>updatePlacement({heading:Number(e.target.value)});
  $('ground-model').onclick=()=>updatePlacement({lift:0});
  $('reset-model').textContent=selectedPart?'Bauteil zurücksetzen':'Reset';
  $('reset-model').onclick=()=>updatePlacement(selectedPart?ZERO_PART:active.defaults);
}
function updatePlacement(values){
  if(!active)return;cinemaTarget=null;
  placement=sanitizePlacement({...placement,...values});
  if(selectedPart){selectedPart.placement=placement;applyPart(active,selectedPart);}
  else{active.placement=placement;active.groundCache=null;active.groundPoints=null;for(const part of active.parts||[])applyPart(active,part);}
  for(const key of Object.keys(DEFAULT_PLACEMENT)){const el=$('place-'+key);if(el&&el!==document.activeElement)el.value=Number(placement[key].toFixed(2));}
  if($('rotate-building'))$('rotate-building').value=placement.heading;
  if($('lift-building'))$('lift-building').value=placement.lift;
  moveHandle?.setLngLat(handleCoordinates());
  try{if(selectedPart)localStorage.setItem('nexus-'+active.key+'-parts-v1',JSON.stringify(Object.fromEntries(active.parts.map(p=>[p.id,p.placement]))));else localStorage.setItem('nexus-'+active.key+'-placement-v1',JSON.stringify({...placement,heightReference:'platform-v2'}));if($('placement-state'))$('placement-state').textContent='Placement saved on this device.';}catch{if($('placement-state'))$('placement-state').textContent='Placement applied. Browser storage unavailable.';}
  clearTimeout(footprintTimer);footprintTimer=setTimeout(updateFootprint,80);map.triggerRepaint();
}
function updateFootprint(){
  const exclusions=assets.filter(a=>a.model).flatMap(a=>{
    const angle=a.placement.heading*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
    const layout=transformedPolygons(a);
    const rings=layout?layout.map(poly=>poly.map(([x,z])=>coordinates(a.placement.east+x*c+z*s,a.placement.north+x*s-z*c,a.origin))):[footprint(a.placement,a.origin,a.halfSize)];
    return rings.map(ring=>{ring.push(ring[0]);return ['>', ['distance',{type:'Polygon',coordinates:[ring]}],0];});
  });
  cityLayer?.setExclusions(exclusions);

  for(const id of ['nexus-buildings-main','nexus-buildings-warm'])if(map.getLayer(id))map.setFilter(id,['all',['==',['get','extrude'],'true'],...exclusions]);
}

function list(){
 const query=$('search').value.toLocaleLowerCase();
 const shown=features.filter(f=>(!catalog||catalog.visible(f))&&(f.properties.name+' '+f.id).toLocaleLowerCase().includes(query));
 $('list').replaceChildren();
 shown.forEach(f=>{const b=document.createElement('button');b.className='landmark'+(f.id===selected?' active':'');b.dataset.id=f.id;b.innerHTML=`<span class="number">${String(f.id).padStart(2,'0')}</span><span>${escapeHTML(f.properties.name)}${f.id===47?'<small>VALLETTA WALL LAYER</small>':assetFor(f.id)?'<small>3D MODEL AVAILABLE</small>':''}</span>`;b.onclick=()=>select(f.id);b.oncontextmenu=e=>catalog?.context(e,f);$('list').append(b);});
 if(!shown.length)$('list').innerHTML='<p class="empty">No locations match your search.</p>';
}
$('search').oninput=list;
$('home').onclick=()=>select(1);
$('fort-home').onclick=()=>select(2);
$('portomaso-home').onclick=()=>select(4);
$('laguna-home').onclick=()=>select(5);
$('mercury-home').onclick=()=>select(6);
$('suites-home').onclick=()=>select(7);
$('ora-home').onclick=()=>select(8);
$('hardrock-home').onclick=()=>select(37);
$('creek-home').onclick=()=>select(10);
$('tigne-home').onclick=()=>select(16);
$('export-map').onclick=async()=>{
 const button=$('export-map');button.disabled=true;button.textContent='ZIP wird gespeichert…';
 try{
   const response=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({city:cityLayer?.state(),catalog:catalog.collection(),placements:Object.fromEntries(assets.map(a=>[a.key,a.placement])),parts:await exportParts()})});
   if(!response.ok)throw new Error('Export fehlgeschlagen');
   const result=await response.json();if(!result.saved)throw new Error('Speichern fehlgeschlagen');
   status('Gespeichert in Downloads: '+result.filename+' · inklusive deiner Modellpositionen.');button.textContent='✓ In Downloads gespeichert';
 }catch{status('Download fehlgeschlagen. Starte die Map mit Start-Map.cmd und versuche es erneut.');button.textContent='Download erneut versuchen';}
 finally{button.disabled=false;}
};
$('overview').onclick=()=>map.fitBounds([[14.35,35.825],[14.58,35.978]],{padding:{top:100,bottom:180,left:40,right:innerWidth>700?350:40},pitch:35,bearing:0,duration:prefersReducedMotion?0:1600});
$('toggle-panel').onclick=()=>{const hide=document.body.classList.toggle('panel-hidden');$('toggle-panel').setAttribute('aria-expanded',String(!hide));$('panel-style')?.remove();if(hide){const style=document.createElement('style');style.id='panel-style';style.textContent='.panel{display:none}';document.head.append(style);}};

const litScenes=[];
function lighting(scene){
 const sky=new THREE.HemisphereLight(0xc1d1df,0x332c23,1),sun=new THREE.DirectionalLight(0xffe3b5,2),rim=new THREE.DirectionalLight(0x7896ba,.5);
 sun.position.set(-60,100,80);rim.position.set(60,40,-60);scene.add(sky,sun,rim);litScenes.push({sky,sun,rim});updateLighting();
}
// Building-specific night profiles; daytime material treatment remains unchanged.
const NIGHT_PROFILES={
 'ihg':{color:'#ffdfb2',power:.26,density:.57,bay:3.5,floor:3.2},
 'oneoneo':{color:'#ffe1ad',power:.55,density:.34,bay:3.4,floor:3.1},
 'fort-cambridge':{color:'#ffdeb5',power:.44,density:.29,bay:3.6,floor:3.0},
 'portomaso-hilton':{color:'#ffd49a',power:.63,density:.63,bay:3.4,floor:3.2},
 'laguna-portomaso':{color:'#ffe6c4',power:.40,density:.28,bay:4.8,floor:3.1},
 'mercury-tower':{color:'#dfebff',power:.48,density:.42,bay:3.0,floor:3.4},
 'mercury-suites':{color:'#ffe0b1',power:.5,density:.45,bay:3.4,floor:3.1},
 'ora-west':{color:'#e5efff',power:.46,density:.40,bay:3.6,floor:3.2},
 'ora-east':{color:'#ffe5c0',power:.44,density:.34,bay:3.6,floor:3.2},
 'hard-rock-hotel':{color:'#ffd6a0',power:.67,density:.67,bay:3.6,floor:3.2},
 '14east':{color:'#e5f0ff',power:.45,density:.55,bay:3.3,floor:3.2},
 'fortina':{color:'#ffe2b8',power:.59,density:.61,bay:3.5,floor:3.1},
 'pendergardens':{color:'#ffe8c7',power:.43,density:.34,bay:3.7,floor:3.1},
 'towns-end':{color:'#ffe2b7',power:.44,density:.31,bay:5.2,floor:3.1},
 'doubletree':{color:'#ffdfaf',power:.56,density:.64,bay:3.6,floor:3.15},
 'phoenicia':{color:'#ffd28e',power:.57,density:.57,bay:3.8,floor:3.9},
 'valletta-gate':{color:'#ffebcc',power:.34,density:.48,bay:1.5,floor:3.3}
};
function nightProfile(a){return NIGHT_PROFILES[a.key]||{color:a.highlight?'#ffd39a':'#ffe3ba',power:a.highlight?.20:.42,density:a.highlight?.65:.33,bay:3.7,floor:3.1};}
function windowActivity(hour){
 const h=((hour%24)+24)%24,points=[[0,.62],[2,.38],[4,.22],[6,.34],[8,0],[17,0],[19,1.08],[21,1],[23,.76],[24,.62]];
 for(let i=1;i<points.length;i++)if(h<=points[i][0]){const [x,a]=points[i-1],[y,b]=points[i];return a+(b-a)*(h-x)/(y-x);}
 return .62;
}
const FACADE_PROFILES={
 'oneoneo':{stone:'#d8c9ac',trim:'#b99b60',glass:'#354959',power:.26,density:.68,bay:4,floor:3.15,base:6},
 'fort-cambridge':{stone:'#d0c9b9',trim:'#737f86',glass:'#314957',power:.20,density:.54,floor:3.2,base:1},
 'mercury-tower':{stone:'#f0f1ed',trim:'#d6dddf',glass:'#30536b',color:'#ffe3b6',power:.25,density:.72,bay:2.8,floor:3.8},
 'mercury-suites':{stone:'#eef1ed',trim:'#d0dbe1',glass:'#326382',power:.23,density:.65,floor:3.2,base:4},
 'portomaso-hilton':{stone:'#d8c5a5',trim:'#967d55',glass:'#334b56',power:.28,density:.78},
 'laguna-portomaso':{stone:'#dcd5c7',trim:'#756e5e',glass:'#355964',power:.19,density:.62},
 'ora-west':{stone:'#cbd4d9',trim:'#657b89',glass:'#284e66',power:.22,density:.70},
 'ora-east':{stone:'#d3d8d7',trim:'#6e7e87',glass:'#315061',power:.20,density:.65},
 'fortina':{stone:'#efefea',trim:'#1b2229',glass:'#223641',power:.25,density:.73},
 'pendergardens':{stone:'#d1c0a5',trim:'#696862',glass:'#35464b',power:.21,density:.63},
 '14east':{stone:'#d1d7d7',trim:'#607783',glass:'#274f63',power:.19,density:.66},
 'shoreline':{stone:'#ddd8c9',trim:'#847d6a',glass:'#365d68',power:.20,density:.68}
};
function variedWindows(m,profile,asset){
 if(m.userData.nexusWindows)return;
 m.userData.nexusWindows=true;
 // Facade-space bays follow the actual storeys, including Mercury's twist.
 m.onBeforeCompile=shader=>{
  Object.assign(shader.uniforms,{nexusDensity:{value:profile.density},nexusBay:{value:profile.bay},nexusFloor:{value:profile.floor},nexusBase:{value:profile.base||0},nexusMercury:{value:asset.key==='mercury-tower'?1:0},nexusClock:{value:performance.now()/1000},nexusActivity:{value:windowActivity(Number($('timeSlider').value))}});
  m.userData.windowUniforms=shader.uniforms;
  shader.vertexShader='varying vec3 nexusWindowPosition; varying vec3 nexusFacadeNormal;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvec4 nexusLocalPosition=vec4(position,1.0); vec3 nexusLocalNormal=normal;\n#ifdef USE_INSTANCING\nnexusLocalPosition=instanceMatrix*nexusLocalPosition; nexusLocalNormal=mat3(instanceMatrix)*nexusLocalNormal;\n#endif\nnexusWindowPosition=(modelMatrix*nexusLocalPosition).xyz; nexusFacadeNormal=mat3(modelMatrix)*nexusLocalNormal;');
  shader.fragmentShader='varying vec3 nexusWindowPosition; varying vec3 nexusFacadeNormal; uniform float nexusDensity; uniform float nexusBay; uniform float nexusFloor; uniform float nexusBase; uniform float nexusMercury; uniform float nexusClock; uniform float nexusActivity;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>
   vec3 p=nexusWindowPosition;
   vec3 fn=normalize(nexusFacadeNormal);
   vec2 tangent=normalize(vec2(-fn.z,fn.x)+vec2(.00001));
   float u=dot(p.xz,tangent);
   float side=abs(fn.x)>.7?1.0:2.0;
   if(nexusMercury>.5 && p.y>10.8){
    float twist=smoothstep(37.0,53.0,p.y);
    float angle=radians(31.0+12.0*twist);
    vec2 d=vec2(p.x,p.z-5.6);
    vec2 q=vec2(d.x*cos(angle)-d.y*sin(angle),d.x*sin(angle)+d.y*cos(angle));
    float halfLength=(29.0+17.0*twist)*.5;
    bool end=abs(q.y)/halfLength>abs(q.x)/10.0;
    u=end?q.x:q.y;side=end?2.0:1.0;
   }
   vec2 facade=vec2(u/nexusBay,(p.y-nexusBase)/nexusFloor);
   vec2 room=floor(facade),pane=fract(facade);
   float seed=dot(room,vec2(12.9898,78.233))+side*7.31;
   float occupied=fract(sin(seed)*43758.5453);
   float period=mix(45.0,150.0,occupied);
   float phase=nexusClock/period+occupied*13.0;
   float epoch=floor(phase);
   float previous=fract(sin(seed+(epoch-1.0)*41.73)*43758.5453);
   float next=fract(sin(seed+epoch*41.73)*43758.5453);
   float density=clamp(nexusDensity*nexusActivity,.025,.95);
   float transition=smoothstep(0.0,5.0/period,fract(phase));
   float occupancy=mix(1.0-smoothstep(density-.025,density+.025,previous),1.0-smoothstep(density-.025,density+.025,next),transition);
   float frame=smoothstep(.11,.17,pane.x)*(1.0-smoothstep(.83,.89,pane.x));
   frame*=smoothstep(.20,.26,pane.y)*(1.0-smoothstep(.82,.88,pane.y));
   float lit=mix(.025,mix(.65,1.0,occupied),occupancy);
   totalEmissiveRadiance*=frame*lit*(1.0-smoothstep(.55,.85,abs(fn.y)));
   // Mercury's architectural ribbon descends in facade space, following its actual twist.
   float ribbonPhase=fract(p.y/32.0+nexusClock*.075);
   float ribbon=exp(-pow((ribbonPhase-.5)*28.0,2.0));
   float verticalFace=1.0-smoothstep(.45,.8,abs(fn.y));
   totalEmissiveRadiance+=vec3(.24,.52,.78)*ribbon*verticalFace*nexusMercury*clamp(nexusActivity,.12,1.0)*.42;`);
 };
 m.customProgramCacheKey=()=> 'nexus-facade-windows-v3';m.needsUpdate=true;
}
function updateLighting(){
 const hour=Number($('timeSlider')?.value??21),night=hour<6.5||hour>=20.5,dusk=!night&&(hour<8.5||hour>=18.5);
 const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
 const nightMix=1-smooth(5.8,8.2,hour)+smooth(18.8,21.5,hour);
 const warmth=Math.max(0,1-Math.abs(hour-7)/1.5,1-Math.abs(hour-19.3)/1.7),lightMix=Math.min(1,nightMix+.28*warmth);
 for(const l of litScenes){l.sky.intensity=1.3+.2*nightMix;l.sun.intensity=(2.3-1.65*nightMix)*(1-.2*warmth);l.rim.intensity=.3+.8*nightMix;l.sky.color.set('#c1d1df').lerp(new THREE.Color('#b9cee7'),nightMix);l.sun.color.set('#ffe9ce').lerp(new THREE.Color('#bdcfe3'),nightMix).lerp(new THREE.Color('#ffc784'),warmth*.75);l.sun.position.set(Math.cos(hour/24*Math.PI*2)*100,100-65*nightMix,70);}
 for(const a of assets){const housing=!a.highlight&&!a.hotel,facade=FACADE_PROFILES[a.key]||{},profile={...nightProfile(a),...(housing?{power:.20,density:.64}:{}),...facade};const mats=a.materials||[];
  a.windowMaterials=[];
  for(const m of mats){if(m.userData.exteriorBeam||!m.color)continue;if(m.userData.nexusMuted){m.color.set('#344653');m.emissiveIntensity=.008;continue;}const name=m.name||'';
   if(/water|pool|plant|foliage|wood|timber/i.test(name))continue;
   const lamp=/Nexus lamp/i.test(name),glass=/glass|glaz|window/i.test(name),dark=/bronze|metal|charcoal|rail|frame|recess/i.test(name);
   const original=m.userData.catalogOriginal;
   if((housing||a.nexusPrime||a.preserveMaterials)&&original&&!lamp){
    m.color.copy(original.color);m.metalness=original.metalness;m.roughness=original.roughness;
    const stone=/limestone|stone|concrete/i.test(name),trim=/bronze|metal|supports/i.test(name)&&!glass;
    if(stone&&facade.stone)m.color.set(facade.stone);
    if(trim&&facade.trim)m.color.set(facade.trim);
    if(glass&&!m.transparent){if(facade.glass)m.color.set(facade.glass);m.metalness=.28;m.roughness=.3;}
    else if(stone){m.metalness=.12;m.roughness=.58;}
    if(!glass)m.color.lerp(new THREE.Color('#71859d'),.16*nightMix);
   }else{m.color.set(lamp?'#ffdb9d':glass?'#24323b':dark?'#343c43':night?'#ac9d83':'#cfbd9d');m.metalness=glass?.3:dark?.35:.08;m.roughness=glass?.3:.72;}
   // Neutral architectural material: light is applied independently of base colour.
   if(!a.nexusPrime&&!lamp&&!glass){m.color.set(dark?'#293944':'#536473').lerp(new THREE.Color(dark?'#1b2935':'#304354'),nightMix*.7);m.roughness=dark?.42:.7;m.metalness=dark?.3:.1;}
   if(glass&&!m.transparent){variedWindows(m,profile,a);a.windowMaterials.push(m);if(m.userData.windowUniforms)m.userData.windowUniforms.nexusActivity.value=windowActivity(hour);}
   if(m.emissive){m.emissive.set(lamp||glass?profile.color:housing?'#b4c5d9':'#bc9361');m.emissiveIntensity=lamp?.05+2.1*lightMix:glass&&!m.transparent?profile.power*lightMix:(housing?.008:a.highlight?.065:.018)*nightMix;}
  }
 }
 for(const a of assets)for(const beam of a.exteriorBeams||[]){beam.visible=lightMix>.001;beam.material.uniforms.strength.value=.115*lightMix;}
 map.triggerRepaint();
}
// Idle night animation runs at four frames per second, without a permanent 60 fps loop.
setInterval(()=>{const hour=Number($('timeSlider')?.value??13);if(document.visibilityState==='visible'&&(hour>=18.5||hour<6.5))map.triggerRepaint();},250);
function addExteriorBeams(asset){
 if(asset.highlight||asset.hotel)return;
 asset.model.updateMatrixWorld(true);
 const bounds=new THREE.Box3().setFromObject(asset.model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
 const cast=new THREE.Raycaster(),surfaces=[];
 asset.model.traverse(o=>{if(o.isMesh&&!o.material.transparent)surfaces.push(o);});
 asset.exteriorBeams=[];
 for(const fraction of [-.28,.28]){
  const origin=new THREE.Vector3(center.x+size.x*fraction,Math.max(1.2,bounds.min.y+size.y*.035),bounds.max.z+6);
  cast.set(origin,new THREE.Vector3(0,0,-1));
  const hit=cast.intersectObjects(surfaces,false).find(h=>h.face&&Math.abs(h.face.normal.y)<.3);
  if(!hit)continue;
  const normal=hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  let parent=hit.object;while(parent.parent&&parent.parent!==asset.model&&!parent.userData.partId)parent=parent.parent;
  if(!parent.userData.partId)parent=asset.model;
  const base=hit.point.clone().addScaledVector(normal,.3),height=Math.min(9,Math.max(4,size.y*.1));
  const geometry=new THREE.CylinderGeometry(1.8,.06,height,12,1,true);
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
   uniforms:{strength:{value:.065},tint:{value:new THREE.Color('#ffdda7')}},
   vertexShader:'varying vec2 beamUV; void main(){beamUV=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
   fragmentShader:'varying vec2 beamUV; uniform float strength; uniform vec3 tint; void main(){float fade=pow(1.0-beamUV.y,2.0); float soft=pow(sin(beamUV.x*3.14159265),2.0); gl_FragColor=vec4(tint,strength*fade*soft);}'
  });material.userData.exteriorBeam=true;
  const beam=new THREE.Mesh(geometry,material);beam.name='Architectural facade wash';beam.position.copy(parent.worldToLocal(base.add(new THREE.Vector3(0,height/2,0))));parent.add(beam);asset.exteriorBeams.push(beam);
 }
}

function addFacadeLamps(asset){
 const bounds=new THREE.Box3().setFromObject(asset.model),size=bounds.getSize(new THREE.Vector3()),c=bounds.getCenter(new THREE.Vector3());
 const material=new THREE.MeshStandardMaterial({name:'Nexus lamp',color:0xffdcaa,emissive:0xffd298,emissiveIntensity:2});
 const lamps=new THREE.InstancedMesh(new THREE.BoxGeometry(.45,1.5,.45),material,8);const matrix=new THREE.Matrix4();
 for(let i=0;i<8;i++){const side=i<4?-1:1,x=c.x+(i%4-1.5)*size.x/4;matrix.makeTranslation(x,Math.max(1,bounds.min.y+4),c.z+side*(size.z/2+.2));lamps.setMatrixAt(i,matrix);}
 asset.model.add(lamps);
}
document.addEventListener('input',e=>{if(e.target.id==='timeSlider')updateLighting();});
document.addEventListener('click',e=>{if(e.target.closest('.theme-btn'))updateLighting();});

// Identical repeated geometry can share one draw while retaining every editable part root.
function batchRepeatedMeshes(asset){
 asset.model.updateMatrixWorld(true);
 const groups=new Map();
 asset.model.traverse(mesh=>{
  if(!mesh.isMesh||mesh.isInstancedMesh||mesh.children.length||Array.isArray(mesh.material))return;
  let parent=mesh.parent;while(parent!==asset.model&&!parent.userData.partId)parent=parent.parent;
  const key=[parent.uuid,mesh.geometry.uuid,mesh.material.uuid].join(':');
  if(!groups.has(key))groups.set(key,{parent,meshes:[]});groups.get(key).meshes.push(mesh);
 });
 for(const {parent,meshes} of groups.values()){
  if(meshes.length<3)continue;
  const batch=new THREE.InstancedMesh(meshes[0].geometry,meshes[0].material,meshes.length);
  batch.name='Repeated facade elements';const inverse=parent.matrixWorld.clone().invert();
  meshes.forEach((mesh,i)=>batch.setMatrixAt(i,new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld)));
  for(const mesh of meshes)mesh.removeFromParent();parent.add(batch);batch.computeBoundingBox();batch.computeBoundingSphere();
 }
}
let modelRenderer;
function installModels(){
 for(const asset of assets){
  if(!asset.model||map.getLayer('nexus-'+asset.key))continue;
  map.addLayer({id:'nexus-'+asset.key,type:'custom',renderingMode:'3d',onAdd(map,gl){
    this.scene=new THREE.Scene();this.scene.add(asset.model);lighting(this.scene);this.camera=new THREE.Camera();
    if(!modelRenderer){modelRenderer=new THREE.WebGLRenderer({canvas:map.getCanvas(),context:gl,antialias:true});modelRenderer.autoClear=false;}
    this.renderer=modelRenderer;
    // Compile before first visibility; the renderer and programs are shared by the collection.
    asset.compiled=this.renderer.compileAsync(this.scene,this.camera).catch(error=>console.warn('Model warmup:',error.message));
  },render(gl,matrix){
    const p=asset.placement;
    const view=map.getBounds(),radius=asset.renderRadius||Math.hypot(...asset.halfSize);
    const southwest=coordinates(p.east-radius,p.north-radius,asset.origin),northeast=coordinates(p.east+radius,p.north+radius,asset.origin);
    if(asset!==active&&(northeast[0]<view.getWest()||southwest[0]>view.getEast()||northeast[1]<view.getSouth()||southwest[1]>view.getNorth()))return;
    const now=performance.now();asset.lastViewed=now;
    if(!asset.groundCache||((!asset.groundCache.levels?.complete||(!cinema&&asset.groundDirty))&&now-asset.groundCache.time>1000)){
      let levels;
      if(asset.fixedAltitude!==undefined)levels={altitude:asset.fixedAltitude+p.lift,depth:.2,complete:true};
      else{
       asset.groundPoints??=groundSamples(p,asset.origin,asset.halfSize);
       const samples=asset.groundPoints.map(point=>map.getTerrain()?map.queryTerrainElevation(point):0);
       levels=platformLevels(samples,p.lift);
      }
      // Incomplete/recycled terrain tiles must never remove or drop an already placed model.
      if(asset.groundCache?.levels&&(!levels?.complete||(cinema&&asset.groundCache.levels.complete)))levels=asset.groundCache.levels;
      asset.groundCache={time:now,levels};asset.groundDirty=false;
    }
    const levels=asset.groundCache.levels;
    // Wait for ground data instead of briefly drawing a buried model at sea level.
    if(!levels)return;
    const origin=mapboxgl.MercatorCoordinate.fromLngLat(coordinates(p.east,p.north,asset.origin),levels.altitude);
    const scale=origin.meterInMercatorCoordinateUnits();
    const transform=new THREE.Matrix4().makeTranslation(origin.x,origin.y,origin.z).scale(new THREE.Vector3(scale,-scale,scale)).multiply(new THREE.Matrix4().makeRotationX(Math.PI/2)).multiply(new THREE.Matrix4().makeRotationY(p.heading*Math.PI/180));
    for(const m of asset.windowMaterials||[])if(m.userData.windowUniforms)m.userData.windowUniforms.nexusClock.value=prefersReducedMotion?0:now/1000;
    this.camera.projectionMatrix=new THREE.Matrix4().fromArray(matrix).multiply(transform);this.renderer.resetState();this.renderer.render(this.scene,this.camera);
  }});
 }
 clearTimeout(footprintTimer);footprintTimer=setTimeout(updateFootprint,120);
 if(moveHandle){if(active?.model&&model!==active.model){model=active.model;renderEditor();}return;}
 const handle=document.createElement('button');handle.className='move-handle';handle.textContent='✥';handle.title='Drag to move building';
 moveHandle=new mapboxgl.Marker({element:handle,draggable:true,offset:[0,42]}).setLngLat(active?activeCoordinates():ORIGINAL).addTo(map);
 moveHandle.on('drag',()=>{if(!active)return;const p=moveHandle.getLngLat(),pos=offsets([p.lng,p.lat],active.origin);if(selectedPart){const base=partCentre(active,{...selectedPart,placement:ZERO_PART});updatePlacement({east:pos.east-base.east,north:pos.north-base.north});}else updatePlacement(pos);});
 select(selected,false);status('');map.triggerRepaint();
}

function openModel(){
 stopCinema();
 if(!model){status('The 3D model is still loading.');return;}
 $('model-title').textContent=active.name+', in detail.';$('model-eyebrow').textContent='Landmark study / '+active.ids.join(' + ');$('download-model').href=active.file;$('material').disabled=!!(active.highlight||active.hotel);$('material').textContent='Material: '+(active.hotel?'Hotel night':active.highlight?'White light':active.gold?'Champagne':'Limestone');
 opener=document.activeElement;$('model-modal').classList.add('open');$('close-model').focus();
 if(!viewerRenderer){
   viewerRenderer=new THREE.WebGLRenderer({antialias:true});viewerRenderer.setPixelRatio(Math.min(devicePixelRatio,2));$('viewer').append(viewerRenderer.domElement);viewerRenderer.domElement.setAttribute('aria-label','Interactive OneOneO 3D model');
   viewerScene=new THREE.Scene();viewerScene.background=new THREE.Color('#091216');lighting(viewerScene);

   const ground=new THREE.Mesh(new THREE.PlaneGeometry(2000,2000),new THREE.MeshStandardMaterial({color:0x101e25,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.1;viewerScene.add(ground);
   viewerCamera=new THREE.PerspectiveCamera(38,1,.1,3000);viewerCamera.position.set(105,62,130);orbit=new OrbitControls(viewerCamera,viewerRenderer.domElement);orbit.target.set(0,18,0);orbit.maxPolarAngle=Math.PI*.49;orbit.minDistance=40;orbit.maxDistance=350;orbit.enableDamping=true;orbit.update();
 }
 if(viewerModel)viewerScene.remove(viewerModel);
 viewerModel=model.clone(true);viewerScene.add(viewerModel);
 const bounds=new THREE.Box3().setFromObject(viewerModel),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
 const extent=Math.max(size.x,size.y,size.z);orbit.target.copy(center);viewerCamera.position.copy(center).add(new THREE.Vector3(extent*(['laguna-portomaso','tas-sellum'].includes(active.key)?-.65:.85),extent*(['laguna-portomaso','tas-sellum'].includes(active.key)?.95:.45),extent*(['laguna-portomaso','tas-sellum'].includes(active.key)?-1.45:1.65)));orbit.minDistance=extent*.45;orbit.maxDistance=extent*5;orbit.update();
 viewerRenderer.domElement.setAttribute('aria-label','Interactive '+active.name+' 3D model');
 resizeViewer();
 const frame=()=>{animation=requestAnimationFrame(frame);orbit.update();viewerRenderer.render(viewerScene,viewerCamera);};frame();
}
function resizeViewer(){if(!viewerRenderer)return;const r=$('viewer').getBoundingClientRect();if(!r.height)return;viewerRenderer.setSize(r.width,r.height);viewerCamera.aspect=r.width/r.height;viewerCamera.updateProjectionMatrix();}
function closeModel(){cancelAnimationFrame(animation);$('model-modal').classList.remove('open');opener?.focus();}
$('close-model').onclick=closeModel;
document.addEventListener('keydown',e=>{if(!$('model-modal').classList.contains('open'))return;if(e.key==='Escape')closeModel();if(e.key==='Tab'){const items=[...$('model-modal').querySelectorAll('button,a')];const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
addEventListener('resize',resizeViewer);
$('material').onclick=()=>{gold=!gold;active.gold=gold;const mats=new Set();model.traverse(o=>{if(o.isMesh)mats.add(o.material);});mats.forEach(m=>{if(!m.userData.original)m.userData.original=m.color.clone();if(gold)m.color.copy(m.userData.original);else if(m.name==='Champagne limestone')m.color.set('#e5e3d9');else if(m.name==='V supports gold')m.color.set('#d9b327');else if(m.name==='Facade bronze')m.color.set('#5b8d79');});$('material').textContent='Material: '+(gold?'Champagne':'Limestone');map.triggerRepaint();};
const partDefaultsPromise=fetch('parts-defaults.json').then(r=>r.ok?r.json():{}).catch(()=>({}));
let loadingCount=0,arrivalPreload=null;
MeshoptDecoder.useWorkers(2);
try{
 const response=await fetch('landmarks.geojson',{cache:'no-store'});if(!response.ok)throw new Error('Location data unavailable');features=(await response.json()).features;
 catalog=setupCatalog({map,features,assets,markers,select,list,status});document.addEventListener('nexus-materials',updateLighting);catalog.restore();
 features.forEach(catalog.addPin);catalog.refresh();
 list();select(1,false);
 const ready=()=>{installModels();loadNearby();map.on('moveend',loadNearby);let nextStream=0;map.on('move',()=>{if(performance.now()>nextStream){nextStream=performance.now()+750;loadNearby();}});setupValletta(map,()=>queueMicrotask(updateFootprint)).then(city=>{cityLayer=city;updateFootprint();if(selected===47)select(47,false);}).catch(console.error);};
 if(map.getLayer('nexus-buildings-main'))ready();else map.once('load',ready);
}catch(error){console.error(error);status('Could not load the collection. Reload the page or check the local server.');}






function inStreamingView(a,bounds){
 const [lng,lat]=coordinates(a.placement.east,a.placement.north,a.origin),dx=(bounds.getEast()-bounds.getWest())*.22,dy=(bounds.getNorth()-bounds.getSouth())*.22;
 return lng>=bounds.getWest()-dx&&lng<=bounds.getEast()+dx&&lat>=bounds.getSouth()-dy&&lat<=bounds.getNorth()+dy;
}
function loadNearby(){
 // Keep current/selected objects; retire distant chunks after a grace period.
 if(!cinemaPreload){
  const resident=assets.filter(a=>a.model),bounds=map.getBounds();
  const removable=resident.filter(a=>a!==active&&!bounds.contains(coordinates(a.placement.east,a.placement.north,a.origin))&&performance.now()-(a.lastViewed||0)>30000).sort((a,b)=>(a.lastViewed||0)-(b.lastViewed||0));
  while(resident.length>24&&removable.length){
   const a=removable.shift(),layerId='nexus-'+a.key,custom=map.getLayer(layerId);
   if(map.getLayer(layerId))map.removeLayer(layerId);
   const geometries=new Set(),materials=new Set();a.model.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);});
   geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());
   for(let i=litScenes.length-1;i>=0;i--)if(litScenes[i].sky.parent===a.model.parent)litScenes.splice(i,1);
   a.model.removeFromParent();a.model=null;a.parts=[];a.materials=new Set();a.nexusFlares=null;a.exteriorBeams=[];a.windowMaterials=[];a.compiled=null;
   resident.splice(resident.indexOf(a),1);queueMicrotask(updateFootprint);
  }
 }
 if(loadingCount>=2||!catalog||!map.getLayer('nexus-buildings-main'))return;
 const center=map.getCenter(),bounds=map.getBounds();
 const candidates=assets.filter(a=>!a.model&&!a.loading&&(!a.failedAt||Date.now()-a.failedAt>15000)&&(cinemaPreload||arrivalPreload?.has(a)||a===active||(map.getZoom()>=14.5&&inStreamingView(a,bounds)))).sort((a,b)=>a===active?-1:b===active?1:Math.hypot(a.origin[0]-center.lng,a.origin[1]-center.lat)-Math.hypot(b.origin[0]-center.lng,b.origin[1]-center.lat));
 for(const asset of candidates){if(loadingCount>=2)break;asset.loading=true;loadingCount++;
 (async()=>{const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(asset.file+'?v=packed-lossless-1');asset.model=gltf.scene;asset.parts=[];
 let savedParts={};
 try{const defaults=await partDefaultsPromise;savedParts=defaults[asset.key]||defaults[({'scirocco-18':'ta-monita-28','scirocco-19':'ta-monita-29'})[asset.key]]||{};}catch{}
 try{const alias=({'scirocco-18':'ta-monita-28','scirocco-19':'ta-monita-29'})[asset.key];const saved=localStorage.getItem('nexus-'+asset.key+'-parts-v1')||(alias&&localStorage.getItem('nexus-'+alias+'-parts-v1'));if(saved)savedParts=JSON.parse(saved);}catch{}
 asset.model.traverse(node=>{if(node.userData.partId){const data=node.userData;asset.parts.push({id:data.partId,label:data.label,node,pivot:data.pivot,polygons:data.polygons,placement:sanitizePlacement({...ZERO_PART,...savedParts[data.partId]})});}});
 for(const part of asset.parts)applyPart(asset,part);batchRepeatedMeshes(asset);catalog.appearance(asset);if(asset.highlight||asset.hotel)addFacadeLamps(asset);else addExteriorBeams(asset);
 asset.materials=new Set();asset.model.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])asset.materials.add(m);});
 const bounds=new THREE.Box3().setFromObject(asset.model);asset.renderRadius=Math.max(Math.abs(bounds.min.x),Math.abs(bounds.max.x),Math.abs(bounds.min.z),Math.abs(bounds.max.z))+20;
 updateLighting();installModels();document.dispatchEvent(new Event('nexus-model-loaded'));if(cinema&&asset===active)prewarmCinema(asset);
 })().catch(error=>{asset.failedAt=Date.now();console.error('Model load failed:',asset.name,error);status('Modell konnte nicht geladen werden: '+asset.name);}).finally(()=>{asset.loading=false;loadingCount--;updateCinemaReadiness();loadNearby();});
 }
}

async function exportParts(){
 const defaults=await partDefaultsPromise;
 return Object.fromEntries(assets.map(a=>{const alias=({'scirocco-18':'ta-monita-28','scirocco-19':'ta-monita-29'})[a.key];let saved=defaults[a.key]||defaults[alias]||{};
 try{saved=JSON.parse(localStorage.getItem('nexus-'+a.key+'-parts-v1')||(alias&&localStorage.getItem('nexus-'+alias+'-parts-v1'))||JSON.stringify(saved));}catch{}
 return [a.key,a.parts?.length?Object.fromEntries(a.parts.map(p=>[p.id,p.placement])):saved];}));
}
import {modelPresentation} from '../model-presentation.mjs';
let presentationMarket='all',commercialPrimeIds=[];
// Appended only to the embedded map module by the local preview server.
// Model placements remain owned by the supplied map, including saved offsets.
const breathingBases=new WeakMap();
const breatheMotion=matchMedia('(prefers-reduced-motion: reduce)');
let lampFlareTexture;
function installLampFlares(asset){
 if(asset.nexusFlares)return;
 asset.nexusFlares=[];
 if(!lampFlareTexture){const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const c=canvas.getContext('2d'),g=c.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'#fff9e9');g.addColorStop(.08,'#ffe8bdcc');g.addColorStop(.3,'#f5c58444');g.addColorStop(1,'#edc79300');c.fillStyle=g;c.fillRect(0,0,64,64);lampFlareTexture=new THREE.CanvasTexture(canvas);}
 const lamps=[];asset.model.updateMatrixWorld(true);
 asset.model.traverse(mesh=>{if(mesh.isMesh&&/Nexus lamp/i.test(mesh.material?.name||''))lamps.push(mesh);});
 for(const mesh of lamps){
  if(!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();
  const center=mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
  const count=mesh.isInstancedMesh?mesh.count:1;
  for(let i=0;i<count&&asset.nexusFlares.length<16;i++){
   const point=center.clone();if(mesh.isInstancedMesh){const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);point.applyMatrix4(matrix);}point.applyMatrix4(mesh.matrixWorld);asset.model.worldToLocal(point);
   const material=new THREE.SpriteMaterial({map:lampFlareTexture,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthTest:true,depthWrite:false,toneMapped:false});
   const flare=new THREE.Sprite(material);flare.name='Nexus existing lamp halo';flare.position.copy(point);flare.scale.set(1.8,1.8,1);asset.model.add(flare);asset.nexusFlares.push(flare);
  }
 }
}
export const nexusModels = {
  async prewarm(){
    // Warm the arrival chunk, not every parsed model on the island.
    const bounds=map.getBounds(),center=map.getCenter();
    const required=assets.filter(a=>a===active||bounds.contains(coordinates(a.placement.east,a.placement.north,a.origin))).sort((a,b)=>a===active?-1:b===active?1:Math.hypot(a.origin[0]-center.lng,a.origin[1]-center.lat)-Math.hypot(b.origin[0]-center.lng,b.origin[1]-center.lat)).slice(0,6);
    arrivalPreload=new Set(required);
    loadNearby();
    await new Promise(resolve=>{const poll=setInterval(()=>{if(required.every(a=>a.model||a.failedAt)){clearInterval(poll);resolve();}},150);});
    await Promise.all(required.map(a=>a.compiled));
    arrivalPreload=null;
    return {loaded:required.filter(a=>a.model).length,total:required.length};
  },
  setMarket(market,commercialIds=[]){
    presentationMarket=market||'all';commercialPrimeIds=commercialIds;
    for(const asset of assets){
      const policy=modelPresentation(asset,presentationMarket,commercialPrimeIds);
      asset.nexusPrime=policy.prime;
      for(const part of asset.parts||[]){part.node.userData.nexusMuted=policy.mutedParts.includes(part.id);part.node.traverse(o=>{if(o.isMesh&&o.userData.nexusOwnMaterials)for(const m of Array.isArray(o.material)?o.material:[o.material])m.userData.nexusMuted=part.node.userData.nexusMuted;});}
    }
    for(const asset of assets)if(asset.model){asset.materials=new Set();asset.model.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])asset.materials.add(m);});}
    updateLighting();
    for(const asset of assets)for(const part of asset.parts||[])if(part.node.userData.nexusMuted){
      part.node.traverse(mesh=>{if(!mesh.isMesh)return;
        if(!mesh.userData.nexusOwnMaterials){mesh.material=Array.isArray(mesh.material)?mesh.material.map(m=>m.clone()):mesh.material.clone();mesh.userData.nexusOwnMaterials=true;}
        for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material]){if(/water|pool|plant|foliage/i.test(m.name))continue;m.userData.nexusMuted=true;m.color?.set('#344653');if(m.emissiveIntensity!==undefined)m.emissiveIntensity=.008;}
      });
    }
  },
  snapshot() {
    return assets.map(asset => ({
      ids: asset.ids,
      name: asset.name,
      key: asset.key,
      coordinates: coordinates(asset.placement.east, asset.placement.north, asset.origin),
      zoom: asset.zoom,
      bearing: asset.viewBearing ?? 20,
      ready: Boolean(asset.model)
    }));
  },
  prepare(id) { select(id, false); },
  illuminate() {
    for(const asset of assets){
      const model=asset.model;if(!model)continue;
      let base=breathingBases.get(model);
      if(!base){const bounds=new THREE.Box3().setFromObject(model);base={scale:model.scale.y,y:model.position.y,floor:bounds.min.y};breathingBases.set(model,base);}
      installLampFlares(asset);
      const activity=windowActivity(Number($('timeSlider')?.value??13));
      for(const flare of asset.nexusFlares){flare.visible=activity>.01;flare.material.opacity=Math.min(.62,activity*.6);}
      // 0.14% vertical breathing, anchored at the foundation. No change to map placement.
      const wave=breatheMotion.matches?0:(1-Math.cos(performance.now()/1000*Math.PI*2/7.4+asset.ids[0]*.73))*.5;
      const factor=1+wave*.0014;model.scale.y=base.scale*factor;model.position.y=base.y+(base.floor-base.y)*(1-factor);
    }
    // A restrained architectural fill; original facade/window lighting still owns the day cycle.
    for (const asset of assets) for (const material of asset.materials || []) {
      if (!material.emissive || material.userData.exteriorBeam || !/stone|limestone|concrete|facade/i.test(material.name)) continue;
      material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, .018);
    }
  }
};

document.addEventListener('nexus-model-loaded',()=>nexusModels.setMarket(presentationMarket,commercialPrimeIds));
