'use strict';
const {seconds}=require('./google-traffic.cjs');
// No route geometry, private origin or raw response is returned or persisted.
function normalizeTransit(payload,requestedAt=new Date().toISOString()){
 const route=payload?.routes?.[0];
 if(!route)return {status:'UNKNOWN',reason:'NO_TRANSIT_ROUTE',source:'Google Maps',requestedAt};
 const steps=(route.legs||[]).flatMap(leg=>leg.steps||[]),rides=steps.filter(s=>s.travelMode==='TRANSIT');
 if(!rides.length)return {status:'UNKNOWN',reason:'NO_TRANSIT_LEG',source:'Google Maps',requestedAt};
 const walking=steps.filter(s=>s.travelMode==='WALK').map(s=>seconds(s.staticDuration));
 const firstRide=steps.findIndex(s=>s.travelMode==='TRANSIT'),lastRide=steps.map(s=>s.travelMode).lastIndexOf('TRANSIT');
 const sumMinutes=list=>{const values=list.map(s=>seconds(s.staticDuration));return values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0)/60:null;};
 const accessWalkMinutes=sumMinutes(steps.slice(0,firstRide).filter(s=>s.travelMode==='WALK')),egressWalkMinutes=sumMinutes(steps.slice(lastRide+1).filter(s=>s.travelMode==='WALK')),rideMinutes=sumMinutes(rides),totalSeconds=seconds(route.duration),walkSeconds=walking.every(Number.isFinite)?walking.reduce((a,b)=>a+b,0):null;
 const residual=totalSeconds!==null&&walkSeconds!==null&&rideMinutes!==null?(totalSeconds-walkSeconds-rideMinutes*60)/60:null;
 const scheduledWaitMinutes=residual!==null&&residual>=0?residual:null;
 const fare=route.travelAdvisory?.transitFare;
 const units=Number(fare?.units??0),nanos=Number(fare?.nanos??0);
 const cost=fare?.currencyCode==='EUR'&&Number.isFinite(units)&&Number.isFinite(nanos)?units+nanos/1e9:null;
 return {status:'CONNECTED',mode:'bus',accessWalkMinutes,egressWalkMinutes,rideMinutes,scheduledWaitMinutes,waitConfidence:scheduledWaitMinutes!==null?'MODELLED':'UNKNOWN',durationMinutes:seconds(route.duration)===null?null:seconds(route.duration)/60,distanceMetres:route.distanceMeters??null,walkingMinutes:walking.every(Number.isFinite)?walking.reduce((a,b)=>a+b,0)/60:null,transfers:Math.max(0,rides.length-1),cost,currency:fare?.currencyCode||null,frequencyMinutes:null,reliability:'UNKNOWN',confidence:'MODELLED',source:'Google Maps',requestedAt,meaning:'Scheduled journey estimate; crowding, pickup and on-time reliability are not verified.',services:rides.map(s=>({line:s.transitDetails?.transitLine?.nameShort||s.transitDetails?.transitLine?.name||null,vehicle:s.transitDetails?.transitLine?.vehicle?.type||null,departure:s.transitDetails?.stopDetails?.departureTime||null,arrival:s.transitDetails?.stopDetails?.arrivalTime||null}))};
}
async function transitRoute(origin,destination,{key,fetcher=fetch}={}){
 if(!key)return {status:'UNKNOWN',reason:'KEY_NOT_CONNECTED'};
 const requestedAt=new Date().toISOString();
 try{
 const response=await fetcher('https://routes.googleapis.com/directions/v2:computeRoutes',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':'routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails,routes.travelAdvisory.transitFare'},signal:AbortSignal.timeout(12000),body:JSON.stringify({origin:{location:{latLng:{latitude:origin[1],longitude:origin[0]}}},destination:{location:{latLng:{latitude:destination[1],longitude:destination[0]}}},travelMode:'TRANSIT',transitPreferences:{allowedTravelModes:['BUS']},departureTime:requestedAt})});
 const payload=await response.json();
 if(!response.ok)return {status:'UNKNOWN',reason:'GOOGLE_TRANSIT_UNAVAILABLE',httpStatus:response.status};
 return normalizeTransit(payload,requestedAt);
 }catch{return {status:'UNKNOWN',reason:'GOOGLE_TRANSIT_UNAVAILABLE'};}
}
module.exports={normalizeTransit,transitRoute};
