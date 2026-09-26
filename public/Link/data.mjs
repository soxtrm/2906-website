import {LOCALITIES,resolveLocality} from './places-selection.mjs';
import {MAPPED_LANDMARKS} from './mapped-landmarks.mjs';
import {asTypes,PROPERTY_TYPE_KEYS,matchesPropertyType} from './property-options.mjs';
// Demo content only. Production matches come from the 2906 / ARGUS adapter.
export const PLACES = LOCALITIES.map(p=>p.label);
export const IMPORTANCE = [['required','Required'],['important','Important'],['nice','Nice to have'],['any','Don’t care']];
export const GROUPS = [['single','Just me','A space of your own','person'],['couple','Couple','Two lives, one home','couple'],['family','Family','Room for everyone','family'],['sharing','Sharing','A place to share','group']];
export const PRIORITIES = [['quiet','Quiet surroundings','leaf'],['beach','Beach & swimming','waves'],['restaurants','Cafés & restaurants','coffee'],['walkable','Walkable essentials','walk'],['sport','Sport & outdoors','sun'],['luxuryArea','Premium neighbourhood','sparkle']];
export const REQUIREMENTS = ['budget','bedrooms','bathrooms','balcony','pets','sharing','propertyType','locations','duration','moveIn','outdoor','luxuryProperty','subletting'];
export function blankProfile(){return {household:null,people:null,nationality:'',jobTitle:'',requirements:Object.fromEntries(REQUIREMENTS.map(key=>[key,{value:['locations','propertyType'].includes(key)?[]:null,importance:'important'}])),anchors:[],transport:null,homeOffice:null,nightlife:null,priorities:{},favoriteTowns:[],allowOutside:false};}
export function normalizePlace(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[’'`.-]/g,'').toLowerCase().replace(/\s+/g,' ').trim().replace(/^saint /,'st ').replace(/^st julian$/,'st julians');}
export function restoreProfile(value){
 const p=blankProfile();if(!value||typeof value!=='object')return p;
 if(GROUPS.some(g=>g[0]===value.household))p.household=value.household;
 if(Number.isInteger(value.people)&&value.people>=1&&value.people<=8)p.people=value.people;
 p.nationality=String(value.nationality||'').trim().slice(0,80);
 p.jobTitle=String(value.jobTitle||'').trim().slice(0,100);
 for(const key of REQUIREMENTS){const v=value.requirements?.[key];if(!v)continue;const imp=IMPORTANCE.some(i=>i[0]===v.importance)?v.importance:'important';let safe=null;
 if(['budget','bedrooms','bathrooms','duration'].includes(key)&&Number.isFinite(v.value)&&v.value>0&&v.value<=10000000)safe=v.value;
 if(['balcony','pets','sharing','outdoor','luxuryProperty'].includes(key)&&typeof v.value==='boolean')safe=v.value;
 if(key==='propertyType')safe=asTypes(v.value).filter(t=>PROPERTY_TYPE_KEYS.has(t));
 if(key==='subletting'&&v.value===true){safe=true;p.requirements[key]={value:true,importance:'required'};continue;}
 if(key==='moveIn'&&/^\d{4}-\d{2}-\d{2}$/.test(v.value)&&!Number.isNaN(Date.parse(v.value)))safe=v.value;
 if(key==='locations')safe=Array.isArray(v.value)?[...new Set(v.value.map(x=>PLACES.includes(x)?x:resolveLocality(x)?.label).filter(Boolean))]:[];
 p.requirements[key]={value:safe,importance:imp};if(key==='budget'&&safe===10000&&v.openEnded===true)p.requirements[key].openEnded=true;}
 p.anchors=Array.isArray(value.anchors)?value.anchors.slice(0,6).filter(a=>a&&['work','school'].includes(a.type)).map(a=>({type:a.type,person:String(a.person||'You').slice(0,40),location:String(a.location||'').slice(0,120),address:String(a.address||'').slice(0,180),placeId:String(a.placeId||'').slice(0,180),days:Number.isInteger(a.days)&&a.days>=1&&a.days<=7?a.days:null,time:/^\d\d:\d\d$/.test(a.time)?a.time:'',coordinates:Array.isArray(a.coordinates)&&a.coordinates.length===2&&a.coordinates.every(Number.isFinite)?a.coordinates:null})):[];
 if(['car','bus','bolt','walk','mixed'].includes(value.transport))p.transport=value.transport;
 if(['remote','hybrid','onsite'].includes(value.homeOffice))p.homeOffice=value.homeOffice;
 if(['often','weekly','rarely'].includes(value.nightlife))p.nightlife=value.nightlife;
 for(const [key] of PRIORITIES)if(IMPORTANCE.some(i=>i[0]===value.priorities?.[key]))p.priorities[key]=value.priorities[key];
 p.favoriteTowns=Array.isArray(value.favoriteTowns)?[...new Set(value.favoriteTowns.map(x=>PLACES.includes(x)?x:resolveLocality(x)?.label).filter(Boolean))].slice(0,12):[];
 p.allowOutside=value.allowOutside===true;return p;
}
export const DEVELOPMENTS = [
 {id:'ora',name:'ORA / Hard Rock',area:'St Julian’s',coordinates:[14.489795,35.928126],markerIds:[8,9,37],image:null,description:'One destination with multiple architectural parts. Offers are grouped at development level.'},
 {id:'ta-monita',name:'Ta Monita',area:'Marsaskala',coordinates:[14.5653,35.86647],markerIds:[28,29],image:null,description:'The mapped building parts share one development marker and offer collection.'},
 {id:'creekville',name:'Creekville',area:'Swieqi',coordinates:[14.481929,35.919422],markerIds:[10,11],image:null,description:'Creekville residences. Both mapped building parts open the shared development inventory; apartment locations are approximate.'},
 {id:'fort-cambridge',name:'Fort Cambridge',area:'Sliema',coordinates:[14.509604,35.908444],markerIds:[2,3],image:'./Nexus-3D-Map/references/fort-cambridge/01.jpg',description:'A residential development in the heart of Sliema. Both building markers connect to this single development.'},
 {id:'portomaso',name:'Portomaso',area:'St Julian’s',coordinates:[14.49291,35.92205],markerIds:[4,5],image:'./Nexus-3D-Map/references/portomaso/aerial.jpg',description:'Marina-side living in St Julian’s. Explore the development and its linked homes.'},
 {id:'mercury',name:'Mercury',area:'St Julian’s',coordinates:[14.489162,35.92308],markerIds:[6,7],image:'./Nexus-3D-Map/references/mercury/868383867.jpg',description:'The tower and suites are grouped in one development view.'},
 {id:'pendergardens',name:'Pendergardens',area:'St Julian’s',coordinates:[14.488635,35.92163],markerIds:[34,35,36],image:null,description:'A single development with several building parts. Property records will come from 2906.'},
 {id:'oneoneo',name:'OneOneO',area:'Sliema',coordinates:[14.499647,35.908036],markerIds:[1],image:null,description:'Development inventory will be connected through 2906.'},
 {id:'tigne-point',name:'Tigné Point',area:'Sliema',coordinates:[14.5118,35.9066],markerIds:[15,16,17,18],image:null,description:'The buildings share one development identity.'},
 {id:'shoreline',name:'Shoreline',area:'Kalkara',coordinates:[14.5415,35.892],markerIds:[27],image:null,description:'Current and upcoming properties will be supplied by 2906.'},
 {id:'verdala',name:'Verdala',area:'Rabat',coordinates:[14.4035,35.87812],markerIds:[26],image:null,description:'Current and upcoming properties will be supplied by 2906.'}
];
// Keep established development IDs; add every other supplied 3D landmark.
for(const landmark of MAPPED_LANDMARKS)if(!DEVELOPMENTS.some(d=>d.markerIds.some(id=>landmark.markerIds.includes(id))))DEVELOPMENTS.push(landmark);
const day=offset=>{const d=new Date();d.setDate(d.getDate()+offset);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const base={market:'longlets',status:'available',currency:'EUR',rentPeriod:'month',minMonths:12,maxMonths:36,availableFrom:day(0),availableUntil:null,propertyType:'apartment',subletting:null,pets:true,sharing:true,balcony:true,outdoor:true,luxuryProperty:false,listingUrl:null,agent:null,demo:true};
export const DEMO_PROPERTIES = [
 {...base,id:'demo-sliema-01',title:'A little closer to the sea.',area:'Sliema',developmentId:'fort-cambridge',rent:1900,bedrooms:2,bathrooms:2,size:112,coordinates:[14.5096,35.9084],images:['coastal','urban','terrace'],features:['Balcony','Furnished','Lift','Air conditioning'],description:'A bright two-bedroom home with an open living space and a balcony to make the most of the Mediterranean light.',lifestyle:{quiet:null,beach:null,restaurants:true,walkable:true,sport:null,luxuryArea:true},mobility:{monthly:40,minutes:12,transport:'walk',assumption:'Illustrative: 20 return journeys per month, occasional paid transport. Not based on your addresses.'},editorial:'More room for your everyday. A balcony, two separate bedrooms and a central Sliema setting.'},
 {...base,id:'demo-gzira-02',subletting:true,title:'More space. More possibilities.',area:'Gżira',developmentId:null,rent:1700,bedrooms:3,bathrooms:2,size:132,coordinates:[14.4957,35.9055],images:['urban','coastal'],balcony:false,outdoor:false,features:['Furnished','Lift','Air conditioning'],description:'Three separate bedrooms and a generous shared living area in a central neighbourhood.',lifestyle:{quiet:null,beach:null,restaurants:true,walkable:true,sport:null,luxuryArea:false},mobility:{monthly:360,minutes:28,transport:'bolt',assumption:'Illustrative: 40 paid trips at €9 each per month. Not a live quote or a route calculation.'},editorial:'An extra bedroom and €200 less rent than the Sliema example. The trade-off: no balcony.'},
 {...base,id:'demo-portomaso-03',title:'Come home to the waterfront.',area:'St Julian’s',developmentId:'portomaso',rent:2650,bedrooms:2,bathrooms:2,size:124,coordinates:[14.4929,35.92205],images:['terrace','coastal'],luxuryProperty:true,sharing:false,features:['Terrace','Furnished','Lift','Parking'],description:'A refined two-bedroom home in a marina-side development, with a terrace and room to unwind.',lifestyle:{quiet:null,beach:null,restaurants:true,walkable:true,sport:null,luxuryArea:true},mobility:null,editorial:'A larger terrace and a premium finish, with a higher monthly rent. Sharing is not permitted.'},
 {...base,id:'demo-msida-04',subletting:false,title:'A practical place to begin.',area:'Msida',developmentId:null,rent:1250,bedrooms:2,bathrooms:1,size:86,coordinates:[14.488,35.8975],images:['urban','terrace'],balcony:false,outdoor:false,pets:false,features:['Furnished','Air conditioning'],description:'A compact two-bedroom apartment for a straightforward, connected everyday.',lifestyle:{quiet:null,beach:null,restaurants:null,walkable:true,sport:null,luxuryArea:false},mobility:null,editorial:'A lower rent and two separate bedrooms. One bathroom, no balcony and no pets.'},
 {...base,id:'demo-ta-xbiex-05',title:'A slower kind of morning.',area:'Ta’ Xbiex',developmentId:null,rent:1850,bedrooms:1,bathrooms:1,size:94,study:true,coordinates:[14.499,35.8985],images:['terrace','urban'],features:['Balcony','Study','Furnished','Lift'],description:'One bedroom and a separate study in a harbour-side setting. The study is not listed as a second bedroom.',lifestyle:{quiet:null,beach:null,restaurants:null,walkable:true,sport:null,luxuryArea:false},mobility:null,editorial:'A separate study gives you space to work. This is a one-bedroom home, not a two-bedroom apartment.'},
 {...base,id:'demo-mercury-06',title:'The city, from a new perspective.',area:'St Julian’s',developmentId:'mercury',rent:2400,bedrooms:2,bathrooms:2,size:105,coordinates:[14.48916,35.92308],images:['coastal','terrace'],availableFrom:day(10),luxuryProperty:true,features:['Balcony','Furnished','Lift','Concierge'],description:'An upcoming two-bedroom apartment with a contemporary interior and an elevated city outlook.',lifestyle:{quiet:null,beach:null,restaurants:true,walkable:true,sport:null,luxuryArea:true},mobility:null,editorial:'A premium development and a later move-in. Available from the date shown, subject to current status.'},
 {...base,id:'demo-winter-07',market:'stays',title:'A home for the quieter season.',area:'Sliema',developmentId:null,rent:1300,bedrooms:2,bathrooms:1,size:95,coordinates:[14.506,35.911],images:['urban','coastal'],minMonths:3,maxMonths:6,availableUntil:day(190),features:['Balcony','Furnished','Winterlet'],description:'An illustrative winterlet with a maximum six-month term. It is not suitable for a twelve-month requirement.',lifestyle:{quiet:null,beach:null,restaurants:true,walkable:true,sport:null,luxuryArea:false},mobility:null,editorial:'Lower rent for a shorter stay. Maximum six months; this is not a longlet.'}
];
export function activeRequirements(profile){return Object.entries(profile.requirements).filter(([key,r])=>!(key==='budget'&&r.openEnded===true)&&((key==='subletting'&&r.value===true)||r.importance!=='any'&&r.value!==null&&r.value!==''&&(!Array.isArray(r.value)||r.value.length)));}
const labels={budget:'Monthly rent',bedrooms:'Separate bedrooms',bathrooms:'Bathrooms',balcony:'Balcony',pets:'Pets allowed',sharing:'Sharing permitted',propertyType:'Property type',locations:'Preferred area',duration:'Rental term',moveIn:'Move-in date',outdoor:'Outdoor space',luxuryProperty:'Premium property',subletting:'Subletting permitted'};
export function checkRequirement(p,key,value){if(key==='propertyType')return matchesPropertyType(p,value);if(key==='budget')return p.rent<=value;if(key==='bedrooms'||key==='bathrooms')return Number.isFinite(p[key])?p[key]>=value:null;if(key==='locations')return value.some(v=>normalizePlace(v)===normalizePlace(p.area));if(key==='duration')return Number.isFinite(p.minMonths)&&Number.isFinite(p.maxMonths)?value>=p.minMonths&&value<=p.maxMonths:null;if(key==='moveIn')return p.availableFrom?p.availableFrom<=value&&(!p.availableUntil||p.availableUntil>=value):null;return p[key]===undefined||p[key]===null?null:p[key]===value;}
export function evaluateDemo(profile,properties=DEMO_PROPERTIES){
 const results=[],excluded=[];
 for(const property of properties){if(property.status!=='available')continue;
 const checks=activeRequirements(profile).map(([key,r])=>({key,label:labels[key],importance:key==='subletting'&&r.value===true?'required':r.importance,value:r.value,met:checkRequirement(property,key,r.value)}));
 if(profile.household==='sharing'&&!checks.some(c=>c.key==='sharing'))checks.push({key:'sharing',label:'Sharing permitted',importance:'required',value:true,met:property.sharing});
 for(const [key,importance] of Object.entries(profile.priorities)){if(importance==='any')continue;checks.push({key,label:PRIORITIES.find(p=>p[0]===key)?.[1]||key,importance,value:true,met:property.lifestyle[key]??null});}
 const hard=checks.filter(c=>c.importance==='required'&&c.met!==true);if(hard.length){excluded.push({id:property.id,reasons:hard});continue;}
 const misses=checks.filter(c=>c.met===false),unknown=checks.filter(c=>c.met===null),known=checks.filter(c=>c.met!==null);let category='best';
 if(misses.length){const areaMiss=misses.some(c=>c.key==='locations');category=areaMiss&&misses.length>1?'outside':misses.filter(c=>c.importance==='important').length>1?'compromise':'alternative';}
 if(category==='outside'&&!profile.allowOutside){excluded.push({id:property.id,reasons:misses});continue;}
 results.push({...property,match:{category,checks,fit:known.length?`${known.filter(c=>c.met).length} of ${known.length} checked preferences`:null,unknown:unknown.length,reason:property.editorial,source:'Illustrative rules applied to demo records. No production matching engine.'}});
 }
 const order={best:0,alternative:1,compromise:2,outside:3};results.sort((a,b)=>order[a.match.category]-order[b.match.category]||a.rent-b.rent);return {properties:results,excluded,total:properties.length,mode:'demo',generatedAt:new Date().toISOString()};
}
export function weekEnd(week,now=new Date()){const d=new Date(now.getFullYear(),now.getMonth(),now.getDate());d.setDate(d.getDate()+(7-d.getDay())%7+(week==='next'?7:0));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
export function availableInWeek(p,week,now=new Date()){
 if(p.status!=='available')return false;const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
 if(p.availableUntil&&p.availableUntil<today)return false;if(!p.availableFrom)return p.availabilityStatus==='upcoming'?week==='later':week!=='later';if(week==='later')return p.availableFrom>weekEnd('next',now);
 const end=weekEnd(week,now);const start=week==='next'?(()=>{const d=new Date(weekEnd('this',now)+'T12:00:00');d.setDate(d.getDate()+1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})():today;
 return p.availableFrom<=end&&(!p.availableUntil||p.availableUntil>=start);
}
