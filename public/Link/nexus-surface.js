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
 // Decorative canopies only within mapped green land; never seed streets or building footprints.
 function growCanopies(){
  if(map.getZoom()<14.5||!map.isStyleLoaded())return;
  const layers=map.getStyle().layers||[],green=layers.filter(l=>l.type==='fill'&&/landuse|park|grass|wood/.test(l.id)&&!l.id.startsWith('nexus-')).map(l=>l.id);
  if(!green.length)return;
  const blocked=layers.filter(l=>/building|road|street/.test(l.id)&&['fill','fill-extrusion','line'].includes(l.type)).map(l=>l.id);
  const bounds=map.getBounds(),features=[],step=Math.max(.00022,Math.sqrt((bounds.getEast()-bounds.getWest())*(bounds.getNorth()-bounds.getSouth())/500));
  const circle=(lng,lat,r)=>Array.from({length:13},(_,i)=>{const a=i/12*Math.PI*2;return [lng+Math.cos(a)*r/90000,lat+Math.sin(a)*r/111320];});
  let count=0,attempts=0;
  for(let lat=Math.ceil(bounds.getSouth()/step)*step;lat<bounds.getNorth()&&count<180&&attempts<600;lat+=step){
   for(let lng=Math.ceil(bounds.getWest()/step)*step;lng<bounds.getEast()&&count<180&&attempts<600;lng+=step){
    attempts++;const point=map.project([lng,lat]);if(point.x<0||point.y<0||point.x>map.getCanvas().clientWidth||point.y>map.getCanvas().clientHeight)continue;
    const land=map.queryRenderedFeatures(point,{layers:green});if(!land.some(f=>['park','grass','wood','forest','recreation_ground'].includes(f.properties.class)))continue;
    if(blocked.length&&map.queryRenderedFeatures([[point.x-3,point.y-3],[point.x+3,point.y+3]],{layers:blocked}).length)continue;
    const seed=Math.abs(Math.sin(lng*14321+lat*43212)),height=5+seed*3;
    for(const [radius,base,top,color]of [[.35,0,3,'#665b49'],[2.1,2.5,height*.7,'#345e48'],[2.8,height*.45,height*.86,'#427556'],[1.8,height*.78,height,'#568364']])features.push({type:'Feature',properties:{base,top,color},geometry:{type:'Polygon',coordinates:[circle(lng,lat,radius)]}});
    count++;
   }
  }
  const data={type:'FeatureCollection',features};
  if(map.getSource('nexus-green-canopies'))map.getSource('nexus-green-canopies').setData(data);
  else{map.addSource('nexus-green-canopies',{type:'geojson',data});map.addLayer({id:'nexus-green-canopies',type:'fill-extrusion',source:'nexus-green-canopies',minzoom:14.5,paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-base':['get','base'],'fill-extrusion-height':['get','top'],'fill-extrusion-opacity':.95}});}
 }
 let treeTimer;map.on('moveend',()=>{clearTimeout(treeTimer);treeTimer=setTimeout(growCanopies,500);});map.once('idle',growCanopies);
})();
