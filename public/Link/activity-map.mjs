import {categoryForPoi,activityHighlights,validCoordinates} from './activity-intelligence.mjs';
import {createActivityPin} from './neon-pin.mjs';
const empty=()=>({type:'FeatureCollection',features:[]});
const feature=(coordinates,properties)=>({type:'Feature',geometry:{type:'Point',coordinates},properties});
export function createActivityMap(map,{send,reduced}){
 let active=false,origin=null,pois=[],selected=null,lastScan=0,signature='',sprites=[];
 function install(){
  if(map.getSource('nexus-activities'))return;
  map.addSource('nexus-activities',{type:'geojson',data:empty()});map.addSource('nexus-activity-link',{type:'geojson',data:empty()});
  for(const category of ['family','promenades','swimming','sports','gyms','parks','restaurants','nightlife','shopping','wellness','events','transport','marinas','culture','other']){const sprite=createActivityPin(category),id='nexus-activity-'+category;map.addImage(id,sprite.draw(0),{pixelRatio:2});sprites.push({id,sprite});}
  map.addLayer({id:'nexus-activity-glow',type:'line',source:'nexus-activity-link',paint:{'line-color':'#68c8ff','line-width':9,'line-opacity':.12,'line-blur':4}});
  map.addLayer({id:'nexus-activity-line',type:'line',source:'nexus-activity-link',paint:{'line-color':'#92d9ff','line-width':2,'line-opacity':.85,'line-dasharray':[1,2]}});
  map.addLayer({id:'nexus-activity-halo',type:'circle',source:'nexus-activities',paint:{'circle-radius':['case',['get','origin'],18,['get','selected'],15,8],'circle-color':['case',['get','origin'],'#45dcff',['get','selected'],'#fff1be','#82d7ff'],'circle-opacity':['case',['get','selected'],.16,.08],'circle-blur':.55,'circle-pitch-alignment':'map'}});
  map.addLayer({id:'nexus-activity-points',type:'circle',source:'nexus-activities',paint:{'circle-radius':3,'circle-color':['case',['get','origin'],'#6ee8ff','#d8ffff'],'circle-opacity':.72,'circle-stroke-width':1,'circle-stroke-color':'#fff'}});
  map.addLayer({id:'nexus-activity-icons',type:'symbol',source:'nexus-activities',layout:{'icon-image':['concat','nexus-activity-',['get','category']],'icon-size':['case',['get','selected'],.72,.58],'icon-anchor':'bottom','icon-allow-overlap':true,'icon-ignore-placement':true,'symbol-sort-key':['case',['get','selected'],0,1]}});
  map.addLayer({id:'nexus-activity-labels',type:'symbol',source:'nexus-activities',layout:{'text-field':['get','name'],'text-font':['DIN Offc Pro Medium'],'text-size':11,'text-anchor':'bottom','text-offset':[0,-7.2],'text-padding':10},paint:{'text-color':'#e8f6ff','text-halo-color':'#10233c','text-halo-width':2}});
 }
 function paint(){
  if(!map.getSource('nexus-activities'))return;
  map.getSource('nexus-activities').setData(active?{type:'FeatureCollection',features:[feature(origin,{id:'origin',origin:true,selected:false,name:'Your place',category:'family'}),...pois.map(p=>feature(p.coordinates,{id:p.id,name:p.name,origin:false,selected:p.id===selected,category:p.category||'events'}))]}:empty());
  const poi=pois.find(p=>p.id===selected);
  map.getSource('nexus-activity-link').setData(active&&poi?{type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:[origin,poi.coordinates]},properties:{}}]}:empty());
 }
 function scan(){
  if(!active||performance.now()-lastScan<1200||!map.getSource('composite')||!map.isSourceLoaded('composite'))return;lastScan=performance.now();
  const records=map.querySourceFeatures('composite',{sourceLayer:'poi_label'}).flatMap(f=>{const name=f.properties?.name_en||f.properties?.name,category=categoryForPoi(f.properties||{}),coordinates=f.geometry?.coordinates;if(!name||!category||f.geometry.type!=='Point'||!validCoordinates(coordinates))return [];return [{id:'map-poi:'+String(f.id||`${name}:${coordinates.map(n=>n.toFixed(5)).join(',')}`),name,category,coordinates,source:'Mapbox map POI',tags:['Mapped place','Access unverified']}];});
  const nearby=activityHighlights(origin,records),next=nearby.map(p=>p.id).sort().join('|');if(next===signature)return;signature=next;send('activity-map-pois',{records:nearby});
 }
 map.on('idle',scan);
 setInterval(()=>{if(!active||document.hidden||reduced.matches||!map.getLayer('nexus-activity-line'))return;const now=performance.now()/1000,phase=Math.floor(performance.now()/140)%4;map.setPaintProperty('nexus-activity-line','line-dasharray',[[0,2,1,0],[.3,2,.7,0],[.6,2,.4,0],[1,2]][phase]);for(const {id,sprite} of sprites)map.updateImage(id,sprite.draw(now));},140);
 function focus(id){selected=id;paint();const poi=pois.find(p=>p.id===id);if(!poi)return;const padding={top:95,left:45,right:45,bottom:Math.min(innerHeight*.58,innerHeight-160)},bounds=[[Math.min(origin[0],poi.coordinates[0]),Math.min(origin[1],poi.coordinates[1])],[Math.max(origin[0],poi.coordinates[0]),Math.max(origin[1],poi.coordinates[1])]];
  const camera=map.cameraForBounds(bounds,{padding,maxZoom:17});if(camera)map.easeTo({...camera,padding,pitch:40,duration:reduced.matches?0:1500});
 }
 return {get active(){return active;},handle(data){
  if(data.type==='activity-close'){active=false;for(const id of ['link-place-points','link-place-halos','link-place-labels'])if(map.getLayer(id))map.setLayoutProperty(id,'visibility','visible');paint();return;}
  if(data.type==='activity-open'&&validCoordinates(data.origin)){active=true;origin=data.origin;selected=null;signature='';lastScan=0;install();for(const id of ['link-place-points','link-place-halos','link-place-labels'])if(map.getLayer(id))map.setLayoutProperty(id,'visibility','none');map.easeTo({center:origin,zoom:15.8,pitch:46,padding:{top:80,bottom:innerHeight*.52,left:0,right:0},duration:reduced.matches?0:1500});scan();}
  if((data.type==='activity-open'||data.type==='activity-update')&&active){pois=activityHighlights(origin,data.pois||[]);if(!pois.some(p=>p.id===selected))selected=pois[0]?.id||null;paint();}
  if(data.type==='activity-focus'&&active)focus(data.id);
 },click(event){if(!active)return false;const hit=map.queryRenderedFeatures(event.point,{layers:['nexus-activity-icons','nexus-activity-points','nexus-activity-labels','nexus-activity-halo']}).find(f=>f.properties.id!=='origin');if(hit){focus(hit.properties.id);send('activity-select',{id:hit.properties.id});}return true;}};
}
