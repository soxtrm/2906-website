import {DEVELOPMENTS} from './data.mjs';
import {developmentBinding} from './development-bindings.mjs';
import {LOCALITIES} from './places-registry.mjs';
import {PROPERTY_TYPE_KEYS} from './property-options.mjs';
import {validCoordinates} from './activity-intelligence.mjs';
import {propertyPillars} from './nexus-semantics.mjs';

let nexusTaxonomy=null;
export function setNexusTaxonomy(taxonomy){nexusTaxonomy=taxonomy;}

const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:null;
function approximateCoordinates(center,identity){
 let hash=2166136261;for(const char of String(identity)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619)}hash>>>=0;
 const angle=(hash%3600)/3600*Math.PI*2,radius=70+((hash>>>12)%350),latitudeOffset=Math.sin(angle)*radius/111320,longitudeOffset=Math.cos(angle)*radius/(111320*Math.cos(center[1]*Math.PI/180));
 return [Number((center[0]+longitudeOffset).toFixed(6)),Number((center[1]+latitudeOffset).toFixed(6))];
}
const labels={air_conditioning:'Air conditioning',balcony:'Balcony',terrace:'Terrace',study:'Study',parking:'Parking',sea_view:'Sea view',seafront:'Seafront',lift:'Lift',garden:'Garden',pool:'Pool',fireplace:'Fireplace',furnished:'Furnished',unfurnished:'Unfurnished',washing_machine:'Washing machine',dishwasher:'Dishwasher',storage_room:'Storage room',built_in_wardrobes:'Built-in wardrobes',double_glazing:'Double glazing',solar_water_heater:'Solar water heater',alarm_system:'Alarm system',gym:'Gym',jacuzzi:'Jacuzzi',bathtub:'Bathtub',concierge:'Concierge',rooftop_access:'Rooftop access',garage:'Garage',garage_or_parking:'Garage or parking',internet:'Internet',step_free:'Step-free access'};
const reviewedTitles=new Map([['2906-9208','Luxury Apartment in Mercury Studios']]);
const capitalise=value=>value?value.charAt(0).toUpperCase()+value.slice(1):'Property';
function listingTitle(raw,typeLabel,locality,binding){
 const reviewed=reviewedTitles.get(String(raw.id));
 if(reviewed)return reviewed;
 const supplied=typeof raw.title==='string'?raw.title.trim():'';
 const generic=/^(?:\d+-bed\s+)?(?:apartment|penthouse|maisonette|house|villa|townhouse|studio|property)\s+in\s+/i.test(supplied);
 const development=binding&&DEVELOPMENTS.find(item=>item.id===binding.id);
 if(supplied&&!generic)return supplied;
 if(development)return `Luxury ${capitalise(typeLabel)} in ${development.name}`;
 return `${number(raw.bedrooms)!==null?raw.bedrooms+'-bed ':''}${typeLabel} in ${locality.label}`;
}
export const confirmed=fact=>fact?.status==='KNOWN'&&(
 /^(A:|B:|DERIVED:)/.test(fact.source||'')||
 ([1,2,3].includes(fact.tier)&&/^(db_field|manual|owner_chat|listing_text|derived:)/.test(fact.source||''))
)?fact.value:null;
export function normalizeArgusInventory(payload){
 if(!payload?.meta||!Array.isArray(payload.meta.firewall_leaks)||payload.meta.firewall_leaks.length||!Array.isArray(payload.properties))throw new Error('The public inventory has not passed its data firewall.');
 const properties=[],seen=new Set(),unresolved=[];
 for(const raw of payload.properties){
  if(!raw.id||seen.has(String(raw.id))||raw.listable!==true)continue;seen.add(String(raw.id));
  if(!['available','available_confirmed','upcoming'].includes(raw.status))continue;
  const locality=LOCALITIES.find(p=>p.key===raw.area);
  if(!locality){unresolved.push({ref:String(raw.id),issue:'Public locality mapping required'});continue;}
  const modes=Array.isArray(raw.rentalModes)?raw.rentalModes:[];
  const market=modes.length===1&&modes[0]==='SHORT_LET'?'stays':'longlets';
  const coordinates=raw.locationDisclosure==='locality'&&validCoordinates(raw.coordinates)?approximateCoordinates(raw.coordinates,raw.id):null;
  const images=(raw.images||[]).filter(url=>typeof url==='string'&&/^https:\/\//i.test(url)).slice(0,25);if(!images.length)continue;
  const facts=raw.featureFacts||{},get=key=>confirmed(facts[key]),pet=get('pets');
  const propertyType=PROPERTY_TYPE_KEYS.has(raw.propertyType)?raw.propertyType:null;
  const ref=String(raw.id),typeLabel=propertyType?.replaceAll('-',' ')||'Property';
  const binding=developmentBinding(raw);
  // Explicit allow-list: never spread a raw record, owner details or private pins.
  properties.push({id:ref,ref,market,title:listingTitle(raw,typeLabel,locality,binding),area:locality.label,localityKey:locality.key,regionKeys:Array.isArray(raw.regions)?raw.regions.filter(x=>typeof x==='string'):[],coordinates,coordinateLevel:coordinates?'locality_approximate':null,developmentId:binding?.id||null,developmentSource:binding?.source||null,developmentTags:binding?.tags||[],developmentEvidence:binding?.evidence||null,rent:number(raw.rent),rentPeriod:'month',currency:'EUR',propertyType,bedrooms:number(raw.bedrooms),bathrooms:number(raw.bathrooms),size:number(raw.size),images,features:Object.entries(labels).filter(([key])=>(get(key)===true||(key==='furnished'&&typeof get(key)==='string'&&get(key)!=='UNFURNISHED'))).map(([,label])=>label),pets:pet==='ALLOWED'?true:pet==='PROHIBITED'?false:null,sharing:get('sharing'),subletting:get('subletting'),balcony:get('balcony'),study:get('study'),outdoor:get('garden')===true||get('terrace')===true?true:null,luxuryProperty:Boolean(binding),minMonths:null,maxMonths:null,rentalModes:modes,availableFrom:date(raw.availableFrom),availableUntil:date(raw.availableUntil),status:'available',availabilityStatus:raw.status,listable:true,description:typeof raw.description==='string'?raw.description:'',lifestyle:{},mobility:null,demo:false,source:'2906 / ARGUS snapshot',updatedAt:raw.updatedAt||null,softTags:[]});
 }

 for(const property of properties){
  const raw=payload.properties.find(r=>String(r.id)===property.id);
  property.featureFacts=Object.fromEntries(Object.entries(raw?.featureFacts||{}).filter(([key])=>Object.hasOwn(labels,key)||['pets','sharing','subletting','bedrooms','bathrooms','size','rent','property_type','available_from','available_until'].includes(key)).map(([key,f])=>[key,{status:f?.status,value:f?.value??null,tier:f?.tier??null,source:f?.source??null}]));
  property.nexusPillars=nexusTaxonomy?propertyPillars(nexusTaxonomy,property.featureFacts):[];
  property.source=payload.meta.mode==='live'?'2906 / ARGUS live':'2906 / ARGUS snapshot';
 }
 return {properties,unresolved,mode:payload.meta.mode==='live'?'live':'argus',generatedAt:payload.meta.generated_at||null,total:properties.length};
}

export function createArgusInventoryAdapter({inventoryUrl,placesUrl,designProperties=[],getActivities}){
 let cached=null,pending=null;
 let placesCached=null,placesPending=null;
 async function inventory(){if(cached&&Date.now()-cached.loadedAt<60000)return cached;if(!pending)pending=Promise.all([fetch(inventoryUrl,{headers:{Accept:'application/json'},credentials:'same-origin',signal:AbortSignal.timeout(15000)}),fetch('./nexus-taxonomy.json').then(r=>r.ok?r.json():null).catch(()=>null)]).then(async([response,taxonomy])=>{if(!response.ok)throw new Error('The public 2906 inventory is not connected yet.');if(taxonomy)setNexusTaxonomy(taxonomy);const result=normalizeArgusInventory(await response.json());cached={...result,properties:[...result.properties,...designProperties],total:result.properties.length+designProperties.length,loadedAt:Date.now()};return cached;}).finally(()=>pending=null);return pending;}
 function saved(){try{return JSON.parse(localStorage.getItem('nexus-link-argus-favorites')||'[]').filter(id=>typeof id==='string');}catch{return [];}}
 async function activities(anchor){
  if(!placesUrl)return getActivities(anchor);
  try{
   if(!placesCached||Date.now()-placesCached.loadedAt>300000){if(!placesPending)placesPending=fetch(placesUrl,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)}).then(async response=>{if(!response.ok)throw new Error('Places intelligence unavailable');return {records:(await response.json()).records||[],loadedAt:Date.now()};}).finally(()=>placesPending=null);placesCached=await placesPending;}
   return {records:placesCached.records,coverage:'nexus-places'};
  }catch{return getActivities(anchor);}
 }
 return {mode:'argus',getActivities:activities,getMatches:inventory,async getProperty(id){const p=(await inventory()).properties.find(p=>p.id===id);if(!p)throw new Error('This property is not in the public inventory.');return p;},async getFavorites(){return saved();},async setFavorite(id,active){const items=new Set(saved());active?items.add(id):items.delete(id);localStorage.setItem('nexus-link-argus-favorites',JSON.stringify([...items]));return {saved:active,scope:'device'};},async getDevelopment(id){const d=DEVELOPMENTS.find(p=>p.id===id);if(!d)throw new Error('Development not found.');return {...d,properties:(await inventory()).properties.filter(p=>p.developmentId===id)};},async getViewingSlots(){return {slots:[],connected:false};},async requestViewing(){throw new Error('Viewings use the existing 2906 booking flow. This read-only connection cannot send requests.');},async createSelectionLink(){throw new Error('Selection sharing is not connected.');}};
}
