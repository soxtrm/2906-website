export const MOBILITY_CONFIDENCE=Object.freeze(['LIVE','OBSERVED','HISTORICAL','MODELLED','LOCAL PRIOR','UNKNOWN']);
export const MOBILITY_MODES=Object.freeze(['walk','bus','bolt','car']);
export const MALTA_OVERVIEW_ANCHORS=Object.freeze([
 {type:'everyday',person:'Malta overview',label:'Landmark',location:'Valletta Gate',placeId:'malta-overview-valletta-gate',coordinates:[14.5107,35.8968],overview:true},
 {type:'everyday',person:'Malta overview',label:'Landmark',location:'Mdina',placeId:'malta-overview-mdina',coordinates:[14.4033,35.8868],overview:true},
 {type:'everyday',person:'Malta overview',label:'Landmark',location:'Portomaso · St Julian’s',placeId:'malta-overview-portomaso',coordinates:[14.4928,35.9221],overview:true},
 {type:'everyday',person:'Malta overview',label:'Landmark',location:'Tigné Point · Sliema',placeId:'malta-overview-tigne-point',coordinates:[14.5148,35.9074],overview:true},
 {type:'everyday',person:'Malta overview',label:'Landmark',location:'Golden Bay',placeId:'malta-overview-golden-bay',coordinates:[14.3447,35.9344],overview:true},
 {type:'everyday',person:'Malta overview',label:'Landmark',location:'Ċirkewwa',placeId:'malta-overview-cirkewwa',coordinates:[14.3290,35.9874],overview:true}
]);

const clean=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[ħĦ]/g,'h').replace(/[żŻ]/g,'z').replace(/[ġĠ]/g,'g').replace(/[ċĊ]/g,'c').replace(/[’'`.-]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const finite=value=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;
const confidence=value=>MOBILITY_CONFIDENCE.includes(String(value||'').toUpperCase())?String(value).toUpperCase():'UNKNOWN';
const percentile=(values,p=.5)=>{const sorted=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return null;const index=(sorted.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);};
const minutes=value=>Number.isFinite(value)?`${Math.max(1,Math.round(value))} min`:'UNKNOWN';
const euros=value=>Number.isFinite(value)?new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:value<10?1:0}).format(value):'UNKNOWN';
const range=(low,high,format)=>Number.isFinite(low)&&Number.isFinite(high)?`${format(low)}–${format(high)}`:'UNKNOWN';

export const MOBILITY_OBSERVATION_FIELDS=Object.freeze([
 'originArea','destinationArea','direction','weekday','hour','season','distanceMetres','durationMinutes',
 'quotedPrice','actualPrice','additionalCharges','totalPaid','pickupMinutes','outcome','observedAt','sourceType','sourceReference'
]);

export function normalizeMobilityObservation(value){
 if(!value||typeof value!=='object')return null;
 const outcome=['accepted','cancelled','failed','unknown'].includes(value.outcome)?value.outcome:'unknown';
 return {
  originArea:String(value.originArea||'').slice(0,120),destinationArea:String(value.destinationArea||'').slice(0,120),
  direction:['outbound','return'].includes(value.direction)?value.direction:'outbound',
  weekday:Number.isInteger(value.weekday)&&value.weekday>=0&&value.weekday<=6?value.weekday:null,
  hour:Number.isInteger(value.hour)&&value.hour>=0&&value.hour<=23?value.hour:null,season:String(value.season||'').slice(0,40),
  distanceMetres:finite(value.distanceMetres),durationMinutes:finite(value.durationMinutes),quotedPrice:finite(value.quotedPrice),
  actualPrice:finite(value.actualPrice),additionalCharges:finite(value.additionalCharges),totalPaid:finite(value.totalPaid),pickupMinutes:finite(value.pickupMinutes),outcome,observedAt:String(value.observedAt||''),
  sourceType:String(value.sourceType||'').slice(0,40),sourceReference:String(value.sourceReference||'').slice(0,120)
 };
}

function sameCorridor(observation,origin,destination){return clean(observation.originArea)===clean(origin)&&clean(observation.destinationArea)===clean(destination);}
function routeFor(property,anchor,mode){
 const routes=Array.isArray(property.mobilityRoutes)?property.mobilityRoutes:[];
 if(anchor.overview)return routes.find(route=>route&&route.mode===mode&&route.anchorPlaceId===anchor.placeId)||null;
 return routes.find(route=>route&&route.mode===mode&&(!route.anchorPlaceId||route.anchorPlaceId===anchor.placeId))||null;
}
function observationSummary(records,origin,destination,direction='outbound'){
 const matching=(Array.isArray(records)?records:[]).map(normalizeMobilityObservation).filter(Boolean).filter(item=>sameCorridor(item,origin,destination)&&item.direction===direction);
 if(!matching.length)return null;
 const prices=matching.map(item=>item.totalPaid??item.actualPrice??item.quotedPrice).filter(Number.isFinite),durations=matching.map(item=>item.durationMinutes).filter(Number.isFinite),pickups=matching.map(item=>item.pickupMinutes).filter(Number.isFinite);
 const outcomes=matching.filter(item=>item.outcome!=='unknown'),accepted=outcomes.filter(item=>item.outcome==='accepted').length;
 return {count:matching.length,priceLow:prices.length>=2?percentile(prices,.2):null,priceExpected:percentile(prices,.5),priceHigh:prices.length>=2?percentile(prices,.8):null,durationLow:percentile(durations,.2),durationHigh:percentile(durations,.8),pickup:percentile(pickups,.5),acceptance:outcomes.length?accepted/outcomes.length:null};
}
function busPrior(origin,destination,time){
 const north=/mellieha|cirkewwa|marfa|ferry|armier|mgarr/.test(clean(origin));
 const central=/sliema|st julians|gzira|msida|valletta|swieqi|ta xbiex|san gwann|central/.test(clean(destination));
 const hour=/^\d\d:\d\d$/.test(time||'')?Number(time.slice(0,2)):null;
 return north&&central&&hour!==null&&hour>=17&&hour<19?'High crowding risk at peak tourist times — allow extra time.':null;
}
function unknownMode(mode){return {mode,time:'UNKNOWN',cost:'UNKNOWN',costDetail:null,reliability:'UNKNOWN',comfort:'UNKNOWN',confidence:'UNKNOWN',warning:null,minutes:null,costExpected:null};}
function buildMode(mode,{property,anchor,origin,destination,observations}){
 const result=unknownMode(mode),route=routeFor(property,anchor,mode);
 if(route){
  const low=finite(route.durationLowMinutes??route.durationMinutes),high=finite(route.durationHighMinutes??route.durationMinutes);
  result.time=range(low,high,minutes);result.minutes=Number.isFinite(low)&&Number.isFinite(high)?(low+high)/2:null;
  result.confidence=confidence(route.confidence);
  if(mode==='walk')result.comfort=route.friction||'Weather, night, urgency and luggage can change the practical fit.';
  if(mode==='bus'){
   const transfers=finite(route.transfers),walking=finite(route.walkingMinutes),frequency=finite(route.frequencyMinutes);
   result.cost=Number.isFinite(finite(route.cost))?euros(finite(route.cost)):'UNKNOWN';result.costExpected=finite(route.cost);
   result.reliability=route.reliability||'UNKNOWN';
   result.comfort=[Number.isFinite(transfers)?`${transfers} ${transfers===1?'transfer':'transfers'}`:null,Number.isFinite(walking)?`${minutes(walking)} walking`:null,Number.isFinite(frequency)?`every ${minutes(frequency)}`:null,route.crowding].filter(Boolean).join(' · ')||'UNKNOWN';
  }
  if(mode==='car'){
   const fuel=finite(route.fuelCost),parking=finite(route.parkingCost);result.cost=Number.isFinite(fuel)||Number.isFinite(parking)?[Number.isFinite(fuel)?`${euros(fuel)} fuel`:null,Number.isFinite(parking)?`${euros(parking)} parking`:null].filter(Boolean).join(' + '):'UNKNOWN';
   result.costExpected=Number.isFinite(fuel)||Number.isFinite(parking)?(fuel||0)+(parking||0):null;result.reliability=route.reliability||'Traffic sensitive';result.comfort=route.friction||'Parking availability UNKNOWN';
  }
  if(mode==='bolt'){
   const lowPrice=finite(route.priceLow),expected=finite(route.priceExpected),highPrice=finite(route.priceHigh);
   result.cost=Number.isFinite(expected)?`${euros(expected)} expected`:'UNKNOWN';result.costExpected=expected;result.costDetail=Number.isFinite(expected)?{expected,low:lowPrice,high:highPrice,busyHigh:finite(route.priceBusyHigh)}:null;
   result.reliability=route.pickupReliability||'UNKNOWN';result.comfort=route.friction||'UNKNOWN';result.warning=route.warning||null;
  }
 }
 if(mode==='bolt'){
  const observed=observationSummary(observations,origin,destination);
  if(observed){
   result.cost=Number.isFinite(observed.priceExpected)?`${euros(observed.priceExpected)} expected`:'UNKNOWN';result.costExpected=observed.priceExpected;result.costDetail=Number.isFinite(observed.priceExpected)?{expected:observed.priceExpected,low:observed.priceLow,high:observed.priceHigh,busyHigh:null}:null;
   if(Number.isFinite(observed.durationLow)&&Number.isFinite(observed.durationHigh)){result.time=range(observed.durationLow,observed.durationHigh,minutes);result.minutes=(observed.durationLow+observed.durationHigh)/2;}
   result.reliability=Number.isFinite(observed.pickup)?`About ${minutes(observed.pickup)} pickup${Number.isFinite(observed.acceptance)?` · ${Math.round(observed.acceptance*100)}% completed acceptance evidence`:''}`:Number.isFinite(observed.acceptance)?`${Math.round(observed.acceptance*100)}% completed acceptance evidence`:'UNKNOWN';
   result.comfort='Door-to-door; pickup conditions vary by time and area.';result.confidence='OBSERVED';
   if(observed.count<5)result.warning='Limited observations — pickup availability can be less predictable here, especially late.';
  }
 }
 if(mode==='bus'){
  const prior=busPrior(origin,destination,anchor.time);if(prior&&!route?.crowding){result.warning=prior;if(result.confidence==='UNKNOWN')result.confidence='LOCAL PRIOR';}
 }
 if(property.demo&&property.mobility?.transport===mode&&Number.isFinite(property.mobility.minutes)&&result.time==='UNKNOWN'){
  result.time=`≈ ${minutes(property.mobility.minutes)}`;result.minutes=property.mobility.minutes;result.confidence='MODELLED';
 }
 return result;
}

export function modeOrder(preferred){
 if(preferred==='bus')return ['bus','bolt','walk','car'];
 if(preferred==='bolt')return ['bolt','bus','car','walk'];
 if(preferred==='car')return ['car','bolt','bus','walk'];
 if(preferred==='walk')return ['walk','bolt','bus','car'];
 return ['walk','bus','bolt','car'];
}
export function mobilityFallback(preferred){
 return ({bus:'Need to be somewhere on time? Compare Bolt.',bolt:'Bus remains visible, including known service friction.',car:'Compare Bolt, bus and walking when they are practical.',walk:'Bolt stays available for weather, night, urgency or luggage.',mixed:'Every realistic option stays visible.'})[preferred]||'Every realistic option stays visible.';
}
export function buildMobilityReality(property,profile,{observations=property.mobilityObservations||[]}={}){
 const selected=(Array.isArray(profile?.anchors)?profile.anchors:[]).filter(anchor=>anchor?.location||anchor?.address).slice(0,6);
 const island=clean(property?.island),area=clean(property?.area),latitude=Array.isArray(property?.coordinates)?finite(property.coordinates[1]):null;
 const gozo=island==='gozo'||Number.isFinite(latitude)&&latitude>=36.025||/victoria|rabats gozo|xaghra|nadur|ghajnsielem|xewkija|zebbug gozo|qala|sannat|kerċem|kercem|munxar|fontana|g[aħh]arb|g[aħh]asri/.test(area);
 const anchors=selected.length?selected:gozo?[]:MALTA_OVERVIEW_ANCHORS;
 const origin=property.area||'';
 return anchors.map(anchor=>{
  const destination=anchor.location||anchor.address;const modes=modeOrder(profile.transport).map(mode=>buildMode(mode,{property,anchor,origin,destination,observations}));
  const days=finite(anchor.days),journeysPerMonth=Number.isFinite(days)&&days>0?days*2*52/12:null;
  return {anchor,modes,journeysPerMonth,monthly:{money:modes.filter(mode=>Number.isFinite(mode.costExpected)&&Number.isFinite(journeysPerMonth)).map(mode=>({mode:mode.mode,value:mode.costExpected*journeysPerMonth})),time:modes.filter(mode=>Number.isFinite(mode.minutes)&&Number.isFinite(journeysPerMonth)).map(mode=>({mode:mode.mode,value:mode.minutes*journeysPerMonth}))}};
 });
}
