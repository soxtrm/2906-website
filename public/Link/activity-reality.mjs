import {activityHighlights,distanceMetres,validCoordinates} from './activity-intelligence.mjs';

const fold=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const aliases=new Map(Object.entries({
  "st julian s":'san giljan',"saint julian s":'san giljan',"st julians":'san giljan',
  "st paul s bay":'san pawl il bahar',"saint paul s bay":'san pawl il bahar',
  "gozo victoria":'rabat victoria',"gozo rabat victoria":'rabat victoria',victoria:'rabat victoria',"rabat gozo":'rabat victoria',"gozo zebbug":'zebbug gozo',
  cospicua:'bormla',senglea:'isla',vittoriosa:'birgu',"ta xbiex":'ta xbiex',
  paceville:'san giljan',tigne:'sliema',qawra:'san pawl il bahar',bugibba:'san pawl il bahar',salina:'naxxar',
  "ta ibragg":'swieqi',swatar:'birkirkara',kappara:'san gwann',gwardamanga:'pieta'
}));
const placeKey=value=>{const raw=fold(value),short=raw.replace(/^gozo /,'');return aliases.get(raw)||aliases.get(short)||short;};
const set=values=>new Set(values.map(placeKey));

const overall={
  five:set(['Mdina']),
  twoToFive:set(["St Julian's",'Valletta','Floriana','Marsa']),
  oneToTwo:set(['Bormla','Luqa','Gudja','Paola','Ghajnsielem','Hamrun','Birgu',"St Paul's Bay",'Gzira','Gozo - Victoria','Mellieha','Qormi'])
};
const residential={
  twoToFive:set(['Mdina','Munxar','Bormla',"St Julian's",'Santa Lucija']),
  oneToTwo:set(['San Gwann','Gharghur','Gzira','Ghaxaq','Iklin','Qormi','Sliema','Pieta','Ta Xbiex','Swieqi','Birzebbuga','Kirkop','Siggiewi','Luqa','Mqabba','Attard','Valletta','Hamrun']),
  zero:set(['Safi','Sannat','Ghasri','Gharb'])
};
const commercial={
  five:set(["St Julian's"]),
  twoToFive:set(['Gudja','San Lawrenz','Bormla']),
  zero:set(['Mtarfa','Santa Lucija','Sannat','Gharghur','Mqabba','Xaghra','Munxar','Qrendi','Nadur','Xghajra','Kercem','Qala','Ghasri','Gharb'])
};
const councils=set(['Attard','Balzan','Birgu','Birkirkara','Birzebbuga','Bormla','Dingli','Fgura','Floriana','Fontana','Ghajnsielem','Gharb','Gharghur','Ghasri','Ghaxaq','Gzira','Gudja','Hamrun','Iklin','Isla','Kalkara','Kercem','Kirkop','Lija','Luqa','Marsa','Marsaskala','Marsaxlokk','Mdina','Mellieha','Mgarr','Mosta','Mqabba','Msida','Mtarfa','Munxar','Nadur','Naxxar','Paola','Pembroke','Pieta','Qala','Qormi','Qrendi','Rabat','Gozo - Victoria','Safi','San Gwann','San Lawrenz','Sannat','Santa Lucija','Santa Venera','Siggiewi','Sliema',"St Julian's","St Paul's Bay",'Swieqi','Ta Xbiex','Tarxien','Valletta','Xaghra','Xewkija','Xghajra','Zabbar','Zebbug','Gozo - Zebbug','Zejtun','Zurrieq']);
export const SAFETY_SOURCE={label:'CrimeMalta Observatory · Annual Crime Review 2025',year:2025,url:'https://www.gov.mt/en/Government/DOI/Press%20Releases/PublishingImages/Pages/2026/03/16/PR260434/PR260434b.pdf',spatialLevel:'LOCALITY'};
function bandFor(key,groups,{complete=false}={}){
  if(groups.five?.has(key))return {key:'five_plus',label:'5× or more than national rate',position:92};
  if(groups.twoToFive?.has(key))return {key:'two_to_five',label:'2–5× national rate',position:74};
  if(groups.oneToTwo?.has(key))return {key:'one_to_two',label:'Above national rate, up to 2×',position:55};
  if(groups.zero?.has(key))return {key:'zero_reported',label:'Zero reported offences in this category',position:5};
  if(complete)return {key:'below',label:'Below national rate',position:24};
  return {key:'unknown',label:'UNKNOWN',position:null};
}
export function localitySafety(locality,{market='longlets'}={}){
  const key=placeKey(locality);if(!key)return {locality,source:SAFETY_SOURCE,overall:bandFor('',overall),lens:bandFor('',residential),lensLabel:'Residential theft'};
  const commercialLens=market==='commercials';
  const recognised=councils.has(key);
  return {locality,key,source:SAFETY_SOURCE,overall:bandFor(key,overall,{complete:recognised}),lens:bandFor(key,commercialLens?commercial:residential,{complete:recognised&&!commercialLens}),lensLabel:commercialLens?'Commercial activity-related offences':'Theft from residences'};
}

const weights={nightlife:2,restaurants:1.4,shopping:1.25,transport:1.2,events:1.15,gyms:.85,sports:.8,marinas:.75,promenades:.7,swimming:.65,parks:.45,family:.45,wellness:.55,other:.3};
export function activityPulse(origin,records,{radius=1000,market='longlets'}={}){
  if(!validCoordinates(origin))return {score:null,label:'UNKNOWN',confidence:'UNKNOWN',radius,count:0,residential:'Activity context unavailable',commercial:'Commercial interest unavailable'};
  const nearby=activityHighlights(origin,records,{radius});let weighted=0;
  for(const place of nearby){const distanceFactor=Math.max(.18,1-(place.distance/radius)*.78);weighted+=(weights[place.category]||.3)*distanceFactor;}
  const score=Math.round((1-Math.exp(-weighted/11))*100),confidence=nearby.length>=20?'MODELLED':nearby.length>=6?'PARTIAL':'LOW COVERAGE';
  const level=score>=70?'high':score>=42?'medium':'low';
  return {score,label:level,confidence,radius,count:nearby.length,residential:score>=70?'Lively mapped context · quiet may be limited':score>=42?'Balanced mapped activity context':'Lower mapped activity · real noise remains unverified',commercial:score>=70?'Strong mapped venue-density signal':score>=42?'Moderate mapped venue-density signal':'Limited mapped venue-density signal',market};
}

export function radiusSafety(origin,incidents,{radius=1000}={}){
  if(!validCoordinates(origin)||!Array.isArray(incidents)||!incidents.length)return {status:'UNKNOWN',radius,count:null,confidence:'UNKNOWN'};
  const verified=incidents.filter(item=>validCoordinates(item.coordinates)&&item.source&&Number.isInteger(item.year));
  if(!verified.length)return {status:'UNKNOWN',radius,count:null,confidence:'UNKNOWN'};
  return {status:'KNOWN',radius,count:verified.filter(item=>distanceMetres(origin,item.coordinates)<=radius).length,confidence:'OBSERVED'};
}

export function takeawaySitePotential(origin,records,{traffic=[],demand=[],courier=[],radius=1500}={}){
  const pulse=activityPulse(origin,records,{radius,market:'commercials'}),missing=[];
  if(!Array.isArray(traffic)||!traffic.length)missing.push('time-banded traffic');
  if(!Array.isArray(demand)||!demand.length)missing.push('delivery demand');
  if(!Array.isArray(courier)||!courier.length)missing.push('courier pickup and completion');
  const restaurantCount=activityHighlights(origin,records,{radius}).filter(place=>place.category==='restaurants').length;
  if(missing.length)return {status:'UNKNOWN',score:null,missing,restaurantCount,placeSignal:pulse.score,confidence:'UNKNOWN'};
  return {status:'MODEL_READY',score:null,missing:[],restaurantCount,placeSignal:pulse.score,confidence:'MODELLED'};
}
