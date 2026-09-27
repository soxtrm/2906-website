'use strict';
// Standalone service. Private property locations never leave this process.
const http=require('node:http');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const run=promisify(execFile);
const cache=new Map();let snapshot=null,loading=null;
const valid=c=>Array.isArray(c)&&c.length===2&&c.every(Number.isFinite)&&c[0]>=14.1&&c[0]<=14.7&&c[1]>=35.7&&c[1]<=36.2;
const distance=(a,b)=>{const r=Math.PI/180;return 6371000*2*Math.asin(Math.min(1,Math.sqrt(Math.sin((b[1]-a[1])*r/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin((b[0]-a[0])*r/2)**2)));};
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('UPSTREAM_UNAVAILABLE');return r.json();}
async function sources(){
 if(snapshot&&Date.now()-snapshot.at<60000)return snapshot;
 if(loading)return loading;
 loading=(async()=>{
  const [inventory,places,privateResult]=await Promise.all([json('http://127.0.0.1:3001/api/nexus/inventory'),json('http://127.0.0.1:3001/api/nexus/places'),run('docker',['exec','2906_backend','node','/app/scripts/nexus-routing-locations.cjs'],{maxBuffer:1024*1024,timeout:12000})]);
  snapshot={at:Date.now(),properties:inventory.properties.filter(p=>p.listable===true),places:places.records.filter(p=>valid(p.coordinates)),private:JSON.parse(privateResult.stdout)};return snapshot;
 })().finally(()=>loading=null);return loading;
}
const category=p=>({beach:'swimming',swimming_spot:'swimming',gym:'wellbeing',outdoor_gym:'wellbeing',sport:'wellbeing',park:'wellbeing',medical:'daily',pharmacy:'daily',healthcare:'daily',grocery:'daily',shopping:'daily',atm:'daily',transit:'mobility',restaurant:'social',cafe:'social',nightlife:'social',education:'wellbeing'})[p.kind]||null;
async function publicPin(origin,ref,precise){
 if(!precise)return origin;
 const hash=[...ref].reduce((n,c)=>(Math.imul(n,31)+c.charCodeAt(0))>>>0,7),angle=hash%360*Math.PI/180;
 for(const step of [65,95,135]){
  const candidate=[origin[0]+Math.cos(angle)*step/(111320*Math.cos(origin[1]*Math.PI/180)),origin[1]+Math.sin(angle)*step/110540];
  const result=await json(`http://127.0.0.1:5011/nearest/v1/driving/${candidate.join(',')}?number=5`);
  const point=result.waypoints?.map(p=>p.location).find(p=>distance(origin,p)>=45&&distance(origin,p)<=200);
  if(point)return point;
 }
 // No defensible nearby road found: keep public locality anchor instead.
 return null;
}
async function matrix(origin,places,port){
 if(!places.length)return null;
 const points=[origin,...places.map(p=>p.coordinates)].map(p=>p.join(',')).join(';');
 const result=await json(`http://127.0.0.1:${port}/table/v1/driving/${points}?sources=0&annotations=duration,distance`);
 if(result.code!=='Ok')return null;return result;
}
async function compute(ref){
 const data=await sources(),property=data.properties.find(p=>p.id===ref);
 if(!property)throw Object.assign(Error('PROPERTY_NOT_AVAILABLE'),{status:404});
 const internal=data.private.find(p=>p.ref===ref&&p.precision==='exact'&&valid(p.coordinates));
 const origin=internal?.coordinates||property.coordinates;
 if(!valid(origin))return {status:'UNKNOWN',reason:'LOCATION_UNRESOLVED',places:[]};
 const key=createHash('sha256').update(JSON.stringify([ref,origin,property.updatedAt,data.places.map(p=>[p.id,p.coordinates])])).digest('hex');
 const hit=cache.get(ref);if(hit?.key===key&&Date.now()-hit.at<3600000)return hit.value;
 const nearest=data.places.map(p=>({...p,d:distance(origin,p.coordinates),group:category(p)})).filter(p=>p.group&&p.d<=5000).sort((a,b)=>a.d-b.d);
 const selected=[...new Map(['swimming','daily','social','wellbeing','mobility'].flatMap(group=>nearest.filter(p=>p.group===group).slice(0,18)).map(p=>[p.id,p])).values()];
 const [walk,drive,pin]=await Promise.all([matrix(origin,selected,5012),matrix(origin,selected,5011),publicPin(origin,ref,Boolean(internal))]);
 const precision=internal&&pin?'APPROXIMATE':'AREA_ONLY',observedAt=new Date().toISOString();
 const values=selected.map((place,i)=>{
  const w=walk?.durations?.[0]?.[i+1],d=drive?.durations?.[0]?.[i+1],walkSnap=walk?.destinations?.[i+1]?.distance,driveSnap=drive?.destinations?.[i+1]?.distance;
  const walkingOk=Number.isFinite(w)&&walkSnap<=200&&(walk?.sources?.[0]?.distance??Infinity)<=200;
  const drivingOk=Number.isFinite(d)&&driveSnap<=300&&(drive?.sources?.[0]?.distance??Infinity)<=300;
  return {id:place.id,routeVerified:walkingOk||drivingOk,walkingSeconds:walkingOk?w:null,walkingDistanceMetres:walkingOk?walk.distances[0][i+1]:null,drivingSeconds:drivingOk?d:null,drivingDistanceMetres:drivingOk?drive.distances[0][i+1]:null,walkingAccessGapMetres:walkingOk?Math.round(walkSnap):null,drivingAccessGapMetres:drivingOk?Math.round(driveSnap):null,routeSource:'OSRM / OpenStreetMap',routeConfidence:'MODELLED',routeObservedAt:observedAt,originPrecision:precision};
 });
 const value={status:'CONNECTED',propertyRef:ref,publicCoordinates:pin||property.coordinates,precision,originBasis:internal?'PRIVATE_VERIFIED_LOCATION':'APPROXIMATE_AREA',source:'OpenStreetMap / self-hosted OSRM',confidence:'MODELLED',traffic:'NOT_CONNECTED',observedAt,places:values};
 cache.set(ref,{at:Date.now(),key,value});if(cache.size>1000)cache.delete(cache.keys().next().value);return value;
}
async function geometry(value,placeId,mode){
 const data=await sources(),place=data.places.find(p=>p.id===placeId);
 if(!place||!value.places.some(p=>p.id===placeId)||!valid(value.publicCoordinates))throw Object.assign(Error('PLACE_NOT_CONNECTED'),{status:404});
 const port=mode==='walk'?5012:5011;
 const result=await json(`http://127.0.0.1:${port}/route/v1/driving/${value.publicCoordinates.join(',')};${place.coordinates.join(',')}?overview=full&geometries=geojson&steps=false`);
 return {status:result.code==='Ok'?'CONNECTED':'UNKNOWN',geometry:result.routes?.[0]?.geometry||null,source:'OpenStreetMap / OSRM',confidence:'MODELLED',originBasis:'PUBLIC_APPROXIMATE_PIN',mode};
}
let active=0;const inflight=new Map();
const server=http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','public, max-age=60');
 try{
  const url=new URL(req.url,'http://localhost');if(req.method!=='GET')throw Object.assign(Error('METHOD_NOT_ALLOWED'),{status:405});
  if(url.pathname==='/health'){res.end(JSON.stringify({ok:true,engine:'OSRM',traffic:false}));return;}
  const ref=url.searchParams.get('ref');if(!/^2906-[\w-]{1,60}$/.test(ref||''))throw Object.assign(Error('INVALID_REF'),{status:400});
  if(active>=12)throw Object.assign(Error('BUSY'),{status:429});active++;
  try{
   if(!inflight.has(ref))inflight.set(ref,compute(ref).finally(()=>inflight.delete(ref)));
   const value=await inflight.get(ref),place=url.searchParams.get('place');
   res.end(JSON.stringify(place?await geometry(value,place,url.searchParams.get('mode')==='car'?'car':'walk'):value));
  }finally{active--;}
 }catch(e){res.statusCode=e.status||503;res.end(JSON.stringify({status:'UNKNOWN',reason:e.status?e.message:'ROUTING_UNAVAILABLE'}));}
});
if(require.main===module)server.listen(3012,'127.0.0.1',()=>console.log('Nexus routing listening on loopback:3012'));
module.exports={distance,valid,category};
