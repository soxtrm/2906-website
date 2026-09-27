'use strict';
const fs=require('node:fs');
let blocked=null;
const seconds=value=>typeof value==='string'&&/^\d+(\.\d+)?s$/.test(value)?Number(value.slice(0,-1)):null;
async function currentTraffic(origin,anchors,ref){
 let key;try{key=fs.readFileSync('/opt/nexus-routing/google-routes.key','utf8').trim();}catch{return {status:'UNKNOWN',reason:'KEY_NOT_CONNECTED'};}
 if(blocked&&blocked.key===key&&Date.now()-blocked.at<60000)return {status:'UNKNOWN',reason:blocked.reason};
 const routes=[];
 for(const anchor of anchors){
  try{
   const response=await fetch('https://routes.googleapis.com/directions/v2:computeRoutes',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':'routes.duration,routes.staticDuration,routes.distanceMeters'},signal:AbortSignal.timeout(12000),body:JSON.stringify({origin:{location:{latLng:{latitude:origin[1],longitude:origin[0]}}},destination:{location:{latLng:{latitude:anchor.coordinates[1],longitude:anchor.coordinates[0]}}},travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE_OPTIMAL'})});
   const payload=await response.json();
   if(!response.ok){const reason=payload.error?.details?.find(x=>x.reason)?.reason||'GOOGLE_ROUTES_UNAVAILABLE';blocked={key,reason,at:Date.now()};return {status:'UNKNOWN',reason};}
   const route=payload.routes?.[0];routes.push({id:anchor.id,distanceMetres:route?.distanceMeters??null,trafficSeconds:seconds(route?.duration),noTrafficSeconds:seconds(route?.staticDuration),observedAt:new Date().toISOString(),confidence:'LIVE',source:'Google Maps',meaning:'Traffic-informed predicted duration, not an observed completed journey'});
  }catch{return {status:'UNKNOWN',reason:'GOOGLE_ROUTES_UNAVAILABLE'};}
 }
 return {status:'CONNECTED',routes};
}
module.exports={currentTraffic,seconds};
