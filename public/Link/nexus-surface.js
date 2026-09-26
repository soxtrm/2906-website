/* Nexus surface treatment: neutral architectural mass, natural ground, selective light.
   Runs after the original theme definitions, before map load. Geometry is untouched. */
(() => {
 const palettes={
  sunrise:{land:'#9badab',road:'#737d80',green:'#527654',water:'#244e65',blocks:['#283440','#303e4b','#3c4c59','#465867','#526574']},
  morning:{land:'#adbdb8',road:'#788187',green:'#5e835b',water:'#285e77',blocks:['#303d48','#374752','#40515e','#4c5f6c','#596e7a']},
  day:{land:'#a8bab4',road:'#747f84',green:'#507b54',water:'#23566e',blocks:['#2c3945','#354550','#3e505e','#4a5e6d','#556d7a']},
  sunset:{land:'#8d9694',road:'#697782',green:'#476b51',water:'#183c55',blocks:['#212d3b','#293846','#324454','#3c5060','#495f70']},
  night:{land:'#4b5a61',road:'#667987',green:'#2c5145',water:'#0c253b',blocks:['#172431','#1d2d3c','#26394b','#304456','#3a5266']}
 };
 for(const [name,p]of Object.entries(palettes)){
  const t=THEMES[name];t.land=p.land;t.roadBase=p.road;t.greenBaseRaw=p.green;t.greenBase=p.green;t.greenSoft=p.green;t.parkFill=p.green;
  t.waterBase=p.water;t.waterDepth=p.water;t.waterLife=p.water;t.building=p.blocks;t.buildingWarm=['#bccddd','#bccddd','#bccddd'];t.buildingWarmOpacity=.012;
  t.css.mainOpacity=.15;t.css.warmOpacity=.12;t.css.waterOpacity=.22;
  t.mapFilter={saturation:1,contrast:1.04,brightness:1};
 }
 // The previous blanket landuse recolour made built-up land look like parkland.
 restyleRawBaseLayers=function(t){
  for(const layer of map.getStyle().layers||[]){
   const id=layer.id.toLowerCase();if(id.startsWith('nexus-')||id.startsWith('link-'))continue;
   if(layer.type==='background')map.setPaintProperty(layer.id,'background-color',t.land);
   if(layer.type==='fill'&&id.includes('water'))map.setPaintProperty(layer.id,'fill-color',t.waterBase);
   else if(layer.type==='fill'&&/landuse|landcover/.test(id))map.setPaintProperty(layer.id,'fill-color',['match',['get','class'],['park','grass','wood','scrub','forest','golf_course','pitch','recreation_ground','cemetery'],t.greenBaseRaw,t.land]);
   else if(layer.type==='fill'&&/park|grass|wood|scrub/.test(id))map.setPaintProperty(layer.id,'fill-color',t.greenBaseRaw);
   if(layer.type==='line'&&/road|street|bridge/.test(id)&&!/label|arrow|oneway|shield|exit|lane|marking|turn|junction/.test(id)){
    map.setPaintProperty(layer.id,'line-color',/case|casing/.test(id)?'#46545c':t.roadBase);map.setPaintProperty(layer.id,'line-opacity',.8);
   }
  }
 };
 // Only mapped OSM trees are rendered. The previous procedural scatter could
 // imply trees on streets and private plots where no source data existed.
 let vegetation=[],treeTimer;
 const circle=(lng,lat,r)=>Array.from({length:11},(_,i)=>{const a=i/10*Math.PI*2;return [lng+Math.cos(a)*r/(90000*Math.cos(lat*Math.PI/180)),lat+Math.sin(a)*r/111320];});
 const inBounds=(point,bounds)=>point[0]>=bounds.getWest()&&point[0]<=bounds.getEast()&&point[1]>=bounds.getSouth()&&point[1]<=bounds.getNorth();
 function rowPoints(line){
  const points=[];
  for(let i=1;i<line.length;i++){
   const a=line[i-1],b=line[i],north=(b[1]-a[1])*111320,east=(b[0]-a[0])*90000*Math.cos(a[1]*Math.PI/180),steps=Math.max(1,Math.floor(Math.hypot(east,north)/12));
   for(let step=0;step<steps;step++){const t=step/steps;points.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
  }
  if(line.length)points.push(line.at(-1));return points;
 }
 function treeBody(point,height,id,estimated){
  const [lng,lat]=point,h=Math.max(3,Math.min(18,height||6)),properties={osm_id:id,height:h,height_estimated:estimated};
  return [[.28,0,Math.min(2.7,h*.42),'#665b49'],[1.8,h*.30,h*.72,'#345e48'],[2.35,h*.48,h*.88,'#427556'],[1.55,h*.76,h,'#568364']].map(([radius,base,top,color])=>({type:'Feature',properties:{...properties,base,top,color},geometry:{type:'Polygon',coordinates:[circle(lng,lat,radius)]}}));
 }
 function renderMappedVegetation(){
  if(map.getZoom()<14.5||!map.isStyleLoaded()||!vegetation.length)return;
  const bounds=map.getBounds(),mobile=matchMedia('(max-width: 760px)').matches,limit=mobile?90:220,features=[];let trees=0;
  for(const feature of vegetation){
   if(trees>=limit)break;const kind=feature.properties?.kind,geometry=feature.geometry;
   const points=kind==='tree'?[geometry.coordinates]:kind==='tree_row'?rowPoints(geometry.coordinates):[];
   for(const point of points){if(trees>=limit)break;if(!inBounds(point,bounds))continue;features.push(...treeBody(point,feature.properties.height,feature.properties.osm_id,!feature.properties.height));trees++;}
  }
  const data={type:'FeatureCollection',features};
  if(map.getSource('nexus-green-canopies'))map.getSource('nexus-green-canopies').setData(data);
  else{map.addSource('nexus-green-canopies',{type:'geojson',data});map.addLayer({id:'nexus-green-canopies',type:'fill-extrusion',source:'nexus-green-canopies',minzoom:14.5,paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-base':['get','base'],'fill-extrusion-height':['get','top'],'fill-extrusion-opacity':.92}});}
 }
 async function loadMappedVegetation(){
  try{
   const response=await fetch('../assets/malta-osm-vegetation.geojson',{cache:'force-cache'});if(!response.ok)throw new Error('HTTP '+response.status);
   const data=await response.json();vegetation=data.features||[];
   const woodland={type:'FeatureCollection',features:vegetation.filter(feature=>feature.properties?.kind==='woodland')};
   if(woodland.features.length&&!map.getSource('nexus-osm-woodland')){map.addSource('nexus-osm-woodland',{type:'geojson',data:woodland});map.addLayer({id:'nexus-osm-woodland',type:'fill',source:'nexus-osm-woodland',minzoom:11,paint:{'fill-color':'#315e43','fill-opacity':['interpolate',['linear'],['zoom'],11,.12,16,.32]}});}
   renderMappedVegetation();
  }catch(error){console.warn('Mapped vegetation unavailable:',error.message);}
 }
 map.on('moveend',()=>{clearTimeout(treeTimer);treeTimer=setTimeout(renderMappedVegetation,450);});map.once('idle',loadMappedVegetation);
})();
