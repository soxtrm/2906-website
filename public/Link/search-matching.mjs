import {blankProfile,restoreProfile,activeRequirements,checkRequirement,normalizePlace} from './data.mjs';
import {resolveLocality} from './places-selection.mjs';
import {matchesPropertyType,PROPERTY_TYPE_KEYS} from './property-options.mjs';
import {distanceMetres,validCoordinates} from './activity-intelligence.mjs';
import {normalizeZones,inAnyZone} from './spatial-zones.mjs';

export const defaultSearchFilters=()=>({market:'all',types:[],query:'',maxPrice:0,bedrooms:0,bathrooms:0,alternativeBudget:200,nearbyTowns:true,drawnAreas:[]});
export function restoreSearchFilters(value={}){
 const f=defaultSearchFilters();
 if(['all','longlets','sales','stays','commercials'].includes(value.market))f.market=value.market;
 f.query=String(value.query||'').slice(0,100);
 f.types=Array.isArray(value.types)?value.types.filter(t=>PROPERTY_TYPE_KEYS.has(t)||['office','store','warehouse','other-commercial'].includes(t)):[];
 for(const key of ['maxPrice','bedrooms','bathrooms'])if(Number.isFinite(value[key])&&value[key]>=0)f[key]=Math.min(key==='maxPrice'?10000000:6,value[key]);
 if(Number.isFinite(value.alternativeBudget))f.alternativeBudget=Math.max(0,Math.min(300,Math.round(value.alternativeBudget/50)*50));
 f.nearbyTowns=value.nearbyTowns!==false;f.drawnAreas=normalizeZones(value.drawnAreas);return f;
}
export function hasActiveSearch(profile,filters){const f=restoreSearchFilters(filters);return f.market!=='all'||Boolean(f.drawnAreas.length||f.query||f.types.length||f.maxPrice||f.bedrooms||f.bathrooms||activeRequirements(profile).length||profile.household||Object.values(profile.priorities||{}).some(v=>v!=='any'));}
export function resetSearch(profile,filters,lastSearch=null){
 const saved={profile:restoreProfile(profile),filters:restoreSearchFilters(filters)};
 const changed=JSON.stringify(saved.profile)!==JSON.stringify(blankProfile())||JSON.stringify(saved.filters)!==JSON.stringify(defaultSearchFilters());
 return {profile:blankProfile(),filters:defaultSearchFilters(),lastSearch:changed?saved:lastSearch};
}
// Keep candidate retrieval broad enough for explicit soft budget / nearby alternatives.
// Required criteria remain on the request. The same final matcher is used by map and list.
export function candidateProfile(profile){
 const p=restoreProfile(profile);p.allowOutside=true;
 for(const key of ['budget','locations'])if(p.requirements[key].importance!=='required')p.requirements[key].value=key==='locations'?[]:null;
 return p;
}
const localityKeyCache=new Map();
const localKey=value=>{if(!localityKeyCache.has(value))localityKeyCache.set(value,resolveLocality(value)?.key||normalizePlace(value));return localityKeyCache.get(value);};
const textMatches=(text,query)=>normalizePlace(query).split(' ').filter(Boolean).every(word=>normalizePlace(text).includes(word));
const euro=n=>new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n);

export function matchSearch(properties,rawFilters,profile=blankProfile(),developments=[],localities=[]){
 const f=restoreSearchFilters(rawFilters),requirements=activeRequirements(profile),queryPlace=resolveLocality(f.query);
 const locations=profile.requirements.locations.importance==='any'?[]:profile.requirements.locations.value;
 const groups=[locations,...(queryPlace?[[queryPlace.label]]:[])].filter(g=>g.length);
 const budgetRequirement=requirements.find(([key])=>key==='budget')?.[1];
 const monthlyBudget=f.market!=='sales'?budgetRequirement?.value:0;
 const ceilings=[f.maxPrice,monthlyBudget].filter(n=>Number.isFinite(n)&&n>0),ceiling=ceilings.length?Math.min(...ceilings):0;
 const allowance=budgetRequirement?.importance==='required'&&monthlyBudget&&ceiling===monthlyBudget?0:f.alternativeBudget;
 // Use mapped coordinates, then known listing / landmark coordinates as a conservative fallback.
 const placePoints=new Map();
 for(const source of [localities,developments,properties])for(const point of source){const name=point.area||point.label;if(!name||!validCoordinates(point.coordinates))continue;const key=localKey(name);if(!placePoints.has(key))placePoints.set(key,point.coordinates);}
 const result=[],seen=new Set();
 for(const p of properties){
  if(!p.id||seen.has(p.id)||p.status!=='available'||f.market!=='all'&&(p.market||'longlets')!==f.market)continue;
  const inDrawnZone=validCoordinates(p.coordinates)&&inAnyZone(p.coordinates,f.drawnAreas);
  if(f.drawnAreas.length&&!locations.length&&!inDrawnZone)continue;
  if(f.types.length&&!matchesPropertyType(p,f.types))continue;
  if(f.bedrooms&&!(p.bedrooms>=f.bedrooms)||f.bathrooms&&!(p.bathrooms>=f.bathrooms))continue;
  const reasons=[],checks=[],unknown=[];let rejected=false;
  for(const [key,r] of requirements){
   if(key==='budget'||key==='locations')continue;
   const met=checkRequirement(p,key,r.value);checks.push({key,label:p.match?.checks?.find(c=>c.key===key)?.label||key.replace(/([A-Z])/g,' $1'),value:r.value,importance:r.importance,met});
   if(met===false||met!==true&&(r.importance==='required'||key!=='pets')){rejected=true;break;}
   if(met===null)unknown.push(key);
  }
  if(rejected||profile.household==='sharing'&&p.sharing!==true)continue;
  if(Object.entries(profile.priorities||{}).some(([key,value])=>value==='required'&&p.lifestyle?.[key]!==true))continue;
  if(f.query&&!queryPlace&&!textMatches([p.title,p.area,p.id,developments.find(d=>d.id===p.developmentId)?.name].join(' '),f.query))continue;
  let extra=0;
  if(ceiling){
   if(!Number.isFinite(p.rent)||p.currency&&p.currency!=='EUR')continue;
   // A monthly profile budget cannot be compared with a nightly / weekly quote.
   if(monthlyBudget&&p.rentPeriod&&p.rentPeriod!=='month')continue;
   extra=Math.max(0,p.rent-ceiling);if(extra>allowance)continue;
   if(extra)reasons.push(`${euro(extra)} above budget`);
  }
  let nearbyDistance=0;
  for(const group of groups){
   if(group===locations&&inDrawnZone&&profile.requirements.locations.importance!=='required')continue;
   if(group.some(label=>localKey(label)===localKey(p.area)))continue;
   if(!f.nearbyTowns||group===locations&&profile.requirements.locations.importance==='required'){rejected=true;break;}
   const target=resolveLocality(p.area),point=placePoints.get(localKey(p.area));
   const neighbours=group.map(label=>({label,place:resolveLocality(label),distance:distanceMetres(point,placePoints.get(localKey(label)))})).filter(n=>n.place&&target&&n.place.island===target.island&&n.distance!==null&&n.distance<=3000).sort((a,b)=>a.distance-b.distance);
   if(!neighbours.length){rejected=true;break;}
   const near=neighbours[0];nearbyDistance=Math.max(nearbyDistance,near.distance);reasons.push(`Near ${near.label} · ${(near.distance/1000).toFixed(1)} km straight line`);
  }
  if(rejected)continue;
  const kind=reasons.length?'alternative':'direct';
  seen.add(p.id);result.push({...p,searchMatch:{kind,reasons,extraBudget:extra,nearbyDistance,unknown},match:{...p.match,category:kind==='direct'?'best':'alternative',checks:[...(p.match?.checks||[]).filter(c=>!['budget','locations',...checks.map(x=>x.key)].includes(c.key)),...checks],unknown:unknown.length,reason:reasons.length?reasons.join(' · '):'Matches your selected search criteria.',fit:kind==='direct'?'Direct match':'Alternative match'}});
 }
 return result.sort((a,b)=>(a.searchMatch.kind==='alternative')-(b.searchMatch.kind==='alternative')||a.searchMatch.extraBudget-b.searchMatch.extraBudget||a.searchMatch.nearbyDistance-b.searchMatch.nearbyDistance||a.rent-b.rent);
}

// Invalidating a search also invalidates in-flight requests, so Back cannot revive old filters.
export function createSearchCache(load,{maxAgeMs=60000,now=Date.now}={}){let revision=0,value=null,pending=null,loadedAt=0;return {
 invalidate(){revision++;value=null;pending=null;},
 async get(){if(value&&now()-loadedAt<maxAgeMs)return value;if(pending)return pending;const version=revision;const request=Promise.resolve().then(load).then(result=>{if(version!==revision)return this.get();value=result;loadedAt=now();return result;}).finally(()=>{if(version===revision)pending=null;});pending=request;return request;}
};}
