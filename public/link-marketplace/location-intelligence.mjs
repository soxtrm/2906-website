import {categoryForPoi,distanceMetres,validCoordinates} from '../Link/activity-intelligence.mjs';

export const CONNECTORS=[
 {key:'swimming',label:'Swimming',icon:'≈',radius:12000,categories:['swimming','promenades'],limit:5},
 {key:'daily',label:'Mini-markets',icon:'▢',radius:2000,categories:[],kinds:['grocery','supermarket','convenience','shopping'],limit:2},
 {key:'health',label:'Health',icon:'✚',radius:3000,categories:[],kinds:['pharmacy','medical','healthcare','hospital','doctor'],limit:2},
 {key:'atm',label:'ATM',icon:'€',radius:2000,categories:[],kinds:['atm'],limit:2},
 {key:'social',label:'Food & cafés',icon:'◇',radius:2000,categories:['restaurants'],limit:6},
 {key:'nightlife',label:'Bars',icon:'✧',radius:2000,categories:['nightlife'],limit:4},
 {key:'gym',label:'Gyms',icon:'◉',radius:5000,categories:['gyms'],limit:3},
 {key:'sport',label:'Sport',icon:'◎',radius:5000,categories:['sports'],limit:3},
 {key:'wellbeing',label:'Parks & wellness',icon:'♧',radius:5000,categories:['parks','wellness','family'],limit:3},
 {key:'mobility',label:'Bus & ferry',icon:'↗',radius:2000,categories:['transport'],limit:2}
];
export const SEARCH_RADII=Object.freeze([250,500,1000,2000,5000]);

const precisionValue=value=>{
  const normalized=String(value||'').trim().toLowerCase();
  if(['exact','precise','verified_exact'].includes(normalized))return 'EXACT';
  if(['approximate','approx','nearby','blurred'].includes(normalized))return 'APPROXIMATE';
  return 'AREA_ONLY';
};

const KIND_CATEGORY={beach:'swimming',swimming:'swimming',promenade:'promenades',gym:'gyms',outdoor_gym:'gyms',sport:'sports',restaurant:'restaurants',cafe:'restaurants',bar:'nightlife',nightclub:'nightlife',grocery:'shopping',supermarket:'shopping',convenience:'shopping',pharmacy:'shopping',medical:'shopping',healthcare:'shopping',atm:'shopping',shopping:'shopping',bus_stop:'transport',ferry:'transport',park:'parks',wellness:'wellness'};

const connectorFor=place=>CONNECTORS.find(c=>c.kinds?.includes(place.kind))?.key||CONNECTORS.find(c=>c.categories.includes(place.category))?.key||null;

export function propertyLocationPrecision(property){
  if(!validCoordinates(property?.coordinates))return 'AREA_ONLY';
  return precisionValue(property.locationDisclosure||property.locationPrecision||property.coordinatePrecision||'approximate');
}

export function buildLocationIntelligence(property,records,{radius=5000}={}){
  const precision=propertyLocationPrecision(property),origin=validCoordinates(property?.coordinates)?property.coordinates:null;
  if(!origin)return {origin:null,precision,radius,tiers:Object.fromEntries(SEARCH_RADII.map(value=>[value,0])),places:[],connectors:CONNECTORS.map(connector=>({...connector,places:[]})),routeEvidence:0};
  const places=(records||[]).flatMap((record,index)=>{
    if(!validCoordinates(record.coordinates)||!record.name)return [];
    const distance=distanceMetres(origin,record.coordinates),category=record.category||KIND_CATEGORY[record.kind]||categoryForPoi(record);
    if(distance===null||distance>radius||!category)return [];
    const id=String(record.id||`${record.kind||category}-${index}`),routeMode=record.routeMode||(Number.isFinite(record.walkingSeconds)?'walk':Number.isFinite(record.drivingSeconds)?'car':null),travelSeconds=routeMode==='walk'?record.walkingSeconds:record.drivingSeconds,place={...record,id,category,distance,connector:null,connection:{origin_id:String(property.id||''),destination_id:id,coordinate_precision:precision,entrance_access_point:record.entranceAccessPoint||null,straight_line_m:Math.round(distance),walking_m:record.routeVerified&&Number.isFinite(record.walkingDistanceMetres)?record.walkingDistanceMetres:null,driving_km:record.routeVerified&&Number.isFinite(record.drivingDistanceMetres)?record.drivingDistanceMetres/1000:null,travel_minutes:record.routeVerified&&Number.isFinite(travelSeconds)?travelSeconds/60:null,transport_mode:record.routeVerified?routeMode:null,source:record.routeVerified?record.routeSource||'ROUTE_DATA':'GEOMETRIC',observed_at:record.routeObservedAt||'',confidence:record.routeVerified?record.routeConfidence||'LIVE':'MODELLED'}};
    place.connector=connectorFor(place);
    return place.connector?[place]:[];
  }).sort((a,b)=>a.distance-b.distance||String(a.name).localeCompare(String(b.name)));
  const seen=new Set(),deduped=places.filter(place=>{
    const key=`${place.connector}:${String(place.name).trim().toLowerCase()}`;
    if(seen.has(key))return false;seen.add(key);return true;
  });
  const connectors=CONNECTORS.map(connector=>{let selected=deduped.filter(place=>place.connector===connector.key&&place.distance<=connector.radius).sort((a,b)=>{const aTime=a.routeVerified&&Number.isFinite(a.walkingSeconds)?a.walkingSeconds:Infinity,bTime=b.routeVerified&&Number.isFinite(b.walkingSeconds)?b.walkingSeconds:Infinity;return aTime-bTime||a.distance-b.distance;});if(connector.key==='swimming'){const bathing=selected.filter(place=>place.kind==='beach'||place.kind==='swimming'||place.publicBeach===true),promenades=selected.filter(place=>!bathing.includes(place));selected=[...bathing.slice(0,4),...promenades.slice(0,1)];}return {...connector,places:selected.slice(0,connector.limit||3)};});
  const tiers=Object.fromEntries(SEARCH_RADII.map(value=>[value,deduped.filter(place=>place.distance<=value).length]));
  return {origin,precision,radius,tiers,places:connectors.flatMap(connector=>connector.places),connectors,routeEvidence:deduped.filter(place=>place.routeVerified&&(Number.isFinite(place.walkingSeconds)||Number.isFinite(place.drivingSeconds))).length};
}

export function placeTravelEvidence(place){
  if(!place?.routeVerified){if(place?.walkableRoute===true&&Number.isFinite(place.walkingDistanceMetres)&&place.walkingDistanceMetres>=0)return {walk:`${Math.max(1,Math.round(place.walkingDistanceMetres/75))} min`,drive:'UNKNOWN',confidence:'MODELLED · 4.5 KM/H'};return {walk:'UNKNOWN',drive:'UNKNOWN',confidence:'UNKNOWN'};}
  const minutes=seconds=>Number.isFinite(seconds)?`${Math.max(1,Math.round(seconds/60))} min`:'UNKNOWN';
  return {walk:minutes(place.walkingSeconds),drive:minutes(place.drivingSeconds),confidence:place.routeConfidence||'MODELLED / ROUTED'};
}

export function mapPosition(origin,coordinates,radius=2500){
  if(!validCoordinates(origin)||!validCoordinates(coordinates))return {x:50,y:50};
  const latitude=origin[1]*Math.PI/180,dx=(coordinates[0]-origin[0])*111320*Math.cos(latitude),dy=(coordinates[1]-origin[1])*110540;
  return {x:Math.max(7,Math.min(93,50+dx/radius*43)),y:Math.max(7,Math.min(93,50-dy/radius*43))};
}
