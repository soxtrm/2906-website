/* Integration surface around the supplied map. No screen-positioned property pins. */
(() => {
  const send=(type,payload={})=>parent.postMessage({source:'nexus-map',type,...payload},location.origin);
  if(typeof map==='undefined'){send('unavailable');return;}
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let primeQuotes=null;import('./prime-estimates.mjs').then(m=>{primeQuotes=m;if(mapReady)updatePlaces();});
  let landmarkView=null;import('./landmark-presentation.mjs').then(m=>{landmarkView=m;if(mapReady)updatePlaces();});
  let touchOrbit=null;import('./map-touch.mjs').then(m=>{touchOrbit=m.installTouchOrbit(map,{active:()=>step===5,onStart:()=>{endArrival();endTour();stopAmbient();send('map-interaction');scheduleAmbientResume();},reduced});});
  let activityMap=null;import('./activity-map.mjs').then(m=>{activityMap=m.createActivityMap(map,{send,reduced});});
  let cameraFlow=null;import('./camera-flow.mjs').then(module=>{cameraFlow=module;});
  const framePadding=(height=0,focused=true)=>cameraFlow?.framingPadding(innerWidth,innerHeight,height,focused)||{top:Math.min(72,innerHeight*.1),bottom:Math.min(Math.max(height,focused?innerHeight*.47:0),innerHeight*.7),left:0,right:0};
  const overview={center:[14.498,35.907],zoom:14.7,pitch:58,bearing:20,padding:0};
  const sourceId='link-places',pointId='link-place-points',haloId='link-place-halos',labelId='link-place-labels';
  const streetAnchors=new Map();let lastStreetAttempt=0,markerMath=null;import('./marker-locations.mjs').then(module=>{markerMath=module;if(mapReady)updatePlaces();});
  let step=1,pending,mapReady=false,models=null,items=[],lastState={},selectedKey=null;
  const priceMarkers=new Map();let joystickFrame=0,joystickVector={x:0,y:0},lastJoystick=0;
  function stopJoystick(){cancelAnimationFrame(joystickFrame);joystickFrame=0;joystickVector={x:0,y:0};}
  function joystick(data){joystickVector={x:Math.max(-1,Math.min(1,Number(data.x)||0)),y:Math.max(-1,Math.min(1,Number(data.y)||0))};lastJoystick=performance.now();if(!joystickVector.x&&!joystickVector.y){stopJoystick();return;}endArrival();endTour();map.stop();if(joystickFrame)return;let previous=performance.now();const tick=now=>{if(step!==5||document.hidden||now-lastJoystick>450){stopJoystick();return;}const dt=Math.min(40,now-previous)/1000;previous=now;map.panBy([joystickVector.x*220*dt,joystickVector.y*220*dt],{duration:0});joystickFrame=requestAnimationFrame(tick);};joystickFrame=requestAnimationFrame(tick);}
  const priceStyle=document.createElement('style');priceStyle.textContent='.link-price-pill{border:1px solid #d8e3e9;border-radius:19px;padding:8px 13px;background:#fcffffed;color:#172d3e;font:600 12px system-ui;box-shadow:0 5px 20px #05162835;cursor:pointer;backdrop-filter:blur(12px);text-align:left;transition:background .2s,box-shadow .3s;min-width:105px}.link-price-pill:hover,.link-price-pill:focus-visible{background:#e1f4ff;box-shadow:0 0 0 3px #69c5ff88}.link-price-pill b{font-size:15px;display:block}.link-price-pill small{font-size:9px;font-weight:400;display:block;margin-top:3px;color:#4b6575}.link-price-pill:after{content:"";width:7px;height:7px;background:#fcffff;position:absolute;bottom:-4px;left:calc(50% - 4px);transform:rotate(45deg)}';document.head.append(priceStyle);
  function updatePriceAreas(){const groups=step===5?lastState.priceAreas||[]:[],keys=new Set(groups.map(g=>g.key));for(const [key,value]of priceMarkers)if(!keys.has(key)){value.marker.remove();priceMarkers.delete(key);}for(const group of groups){let value=priceMarkers.get(group.key);if(!value){const element=document.createElement('button');element.type='button';element.className='link-price-pill';element.addEventListener('pointerdown',e=>e.stopPropagation());element.addEventListener('click',event=>{event.stopPropagation();send('area-inspect',{key:group.key});});value={element,marker:new mapboxgl.Marker({element,anchor:'bottom',offset:[0,-5]}).setLngLat(group.coordinates).addTo(map)};priceMarkers.set(group.key,value);}value.marker.setLngLat(localityPoints.get(group.key.split('|')[0])?.coordinates||group.coordinates);value.element.replaceChildren();const price=document.createElement('b'),place=document.createElement('span'),meta=document.createElement('small');price.textContent=group.label;place.textContent=group.area;meta.textContent=`from ${group.period} · ${group.count} ${group.demo?'demo ':''}${group.count===1?'offer':'offers'}`;value.element.append(place,price,meta);value.element.setAttribute('aria-label',`${group.area}, from ${group.label} ${group.period}, ${group.count} offers`);}syncPriceVisibility();}
  function syncPriceVisibility(){for(const {element}of priceMarkers.values())element.hidden=map.getZoom()>15.5;}
  map.on('zoom',syncPriceVisibility);
  let placesContract=null,lastPlaceScan=0,lastLocalitySignature='',lastLocalityVisibility=null;const localityPoints=new Map();
  import('./places-selection.mjs').then(value=>{placesContract=value;if(mapReady)updateLocalities();});
  function updateLocalities(){
    if(!placesContract||!mapReady)return;
    if(!map.getSource('link-localities')){
      map.addSource('link-localities',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      map.addLayer({id:'link-locality-points',type:'circle',source:'link-localities',paint:{'circle-radius':['case',['get','selected'],10,6],'circle-color':['case',['get','selected'],'#44abf0','#d4eaff'],'circle-stroke-color':'#18415a','circle-stroke-width':2}});
      map.addLayer({id:'link-locality-labels',type:'symbol',source:'link-localities',layout:{'text-field':['get','label'],'text-size':12,'text-font':['DIN Offc Pro Medium'],'text-offset':[0,1.6],'text-allow-overlap':false},paint:{'text-color':'#eef8ff','text-halo-color':'#132c40','text-halo-width':2}});
    }
    if(lastState.placeMode&&performance.now()-lastPlaceScan>1200&&map.isSourceLoaded('composite')){
      lastPlaceScan=performance.now();
      for(const feature of map.querySourceFeatures('composite',{sourceLayer:'place_label'})){
        if(feature.geometry?.type!=='Point')continue;
        const coordinates=feature.geometry.coordinates,island=coordinates[1]>36.01?'gozo':'malta';
        const place=placesContract.resolveLocality(feature.properties.name_en||feature.properties.name,island);
        if(place&&!localityPoints.has(place.key))localityPoints.set(place.key,{...place,coordinates});
      }
    }
    const selected=new Set(lastState.selectedPlaces||[]);
    const signature=[localityPoints.size,[...selected].sort().join(',')].join('|');
    if(signature!==lastLocalitySignature){lastLocalitySignature=signature;map.getSource('link-localities').setData({type:'FeatureCollection',features:[...localityPoints.values()].map(p=>({type:'Feature',properties:{key:p.key,label:p.label,selected:selected.has(p.key)},geometry:{type:'Point',coordinates:p.coordinates}}))});}
    if(lastLocalityVisibility!==Boolean(lastState.placeMode)){lastLocalityVisibility=Boolean(lastState.placeMode);
    for(const id of ['link-locality-points','link-locality-labels'])map.setLayoutProperty(id,'visibility',lastState.placeMode?'visible':'none');
    for(const id of [pointId,haloId,labelId])if(map.getLayer(id))map.setLayoutProperty(id,'visibility',lastState.placeMode?'none':'visible');
    }
    if(lastState.placeMode)send('locality-bindings',{count:localityPoints.size});
  }
  let introEnd=null,pinSprites=[],pinFactory=null;
  import('./neon-pin.mjs').then(module=>{pinFactory=module.createNeonPin;if(mapReady)installPinSprites();});
  function installPinSprites(){if(!pinFactory||pinSprites.length)return;for(const [key,housing,accent] of [['nexus-housing',true],['nexus-alternative',true,'#e7bd79'],['nexus-muted',false,'#8f9b9f'],['nexus-landmark',false,'#e7bd79'],['nexus-super',true,'#ffda8a']]){const sprite=pinFactory(housing,accent);map.addImage(key,sprite.draw(0),{pixelRatio:2});pinSprites.push({key,sprite});}}
  setInterval(()=>{if(!mapReady||step!==5||document.hidden)return;const now=reduced.matches?0:performance.now()/1000;for(const {key,sprite} of pinSprites)map.updateImage(key,sprite.draw(now));if(map.getLayer(labelId))map.setLayoutProperty(labelId,'icon-size',['case',['==',['get','kind'],'development'],.34+(reduced.matches?0:Math.sin(now*1.15)*.018),1]);models?.illuminate();},100);
  let orbitFrame=0,ambientFrame=0,ambientResume=0,flightEnd=null,tourSelection=null,focusedCoordinates=null,focusZoom=null,orbitCamera=null,paddingBlend=null;
  map.jumpTo({center:[14.4942,35.9208],zoom:16.4,pitch:64,bearing:-23,padding:0});
  map.scrollZoom.disable();
  import('./Nexus-3D-Map/link-runtime.js').then(module=>{models=module.nexusModels;if(mapReady)updatePlaces();}).catch(()=>send('model-unavailable'));
  let dayMath=null,dayTimer=null,dayStarted=0,dayElapsed=0,dayRunning=false;
  const dayModule=import('./day-cycle.mjs').then(module=>dayMath=module);
  function paintDay(){
    if(!dayMath)return;
    const elapsed=dayElapsed+(dayRunning?performance.now()-dayStarted:0),snapshot=dayMath.dayAtElapsed(elapsed);
    const slider=document.getElementById('timeSlider');
    if(slider){slider.step='0.001';slider.value=String(snapshot.hour);slider.dispatchEvent(new Event('input',{bubbles:true}));}
    send('day-time',{...snapshot,running:dayRunning});
  }
  async function startDay(){await dayModule;if(step!==5)return;clearInterval(dayTimer);dayElapsed=0;dayStarted=performance.now();dayRunning=!reduced.matches;paintDay();if(dayRunning)dayTimer=setInterval(paintDay,250);}
  function pauseDay(){if(dayRunning){dayElapsed+=performance.now()-dayStarted;dayRunning=false;clearInterval(dayTimer);paintDay();}}
  function toggleDay(){if(!dayMath)return;if(dayRunning)pauseDay();else{dayStarted=performance.now();dayRunning=true;dayTimer=setInterval(paintDay,250);paintDay();}}
  function resolveModel(item){
    const development=item.kind==='development'?item:(lastState.developments||[]).find(d=>d.id===item.developmentId);
    return models?.snapshot().find(m=>item.markerId?m.ids.includes(Number(item.markerId)):development?.markerIds?.some(id=>m.ids.includes(id)));
  }
  function installLayers(){
    if(map.getSource(sourceId))return;
    map.addSource(sourceId,{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    installPinSprites();
    const color='#64c6ff';
    map.addLayer({id:haloId,type:'circle',source:sourceId,paint:{'circle-radius':['case',['==',['get','kind'],'development'],['case',['boolean',['feature-state','selected'],false],7,4],['case',['boolean',['feature-state','selected'],false],24,15]],'circle-color':['case',['==',['get','kind'],'development'],'#aeb7b8',color],'circle-opacity':['case',['==',['get','kind'],'development'],.06,.2],'circle-pitch-alignment':'map','circle-pitch-scale':'map','circle-stroke-width':['case',['==',['get','kind'],'development'],.35,1],'circle-stroke-color':['case',['==',['get','kind'],'development'],'#cad0d0',color]}});
    map.addLayer({id:pointId,type:'circle',source:sourceId,paint:{'circle-radius':['case',['==',['get','kind'],'development'],['case',['boolean',['feature-state','selected'],false],3,1.7],['case',['boolean',['feature-state','selected'],false],8,5]],'circle-color':['case',['==',['get','kind'],'development'],'#aeb7b8',color],'circle-opacity':['case',['==',['get','kind'],'development'],.24,1],'circle-stroke-width':['case',['==',['get','kind'],'development'],.5,2],'circle-stroke-color':['case',['==',['get','kind'],'development'],'#e5e8e7','#18303b'],'circle-pitch-alignment':'map','circle-pitch-scale':'map'}});
    map.addLayer({id:labelId,type:'symbol',source:sourceId,layout:{'text-field':['get','label'],'text-font':['DIN Offc Pro Medium','Arial Unicode MS Regular'],'text-size':['case',['==',['get','kind'],'development'],10,12],'text-anchor':'bottom','text-offset':['case',['==',['get','kind'],'development'],['literal',[0,-2.5]],['literal',[0,-6.7]]],'text-letter-spacing':.07,'icon-image':['get','icon'],'icon-anchor':'bottom','icon-size':['case',['==',['get','kind'],'development'],.34,1],'icon-allow-overlap':true,'icon-pitch-alignment':'viewport','icon-rotation-alignment':'viewport','text-padding':9,'text-allow-overlap':false,'symbol-sort-key':['get','sort'],'text-pitch-alignment':'viewport','text-rotation-alignment':'viewport'},paint:{'icon-opacity':['case',['==',['get','kind'],'development'],.24,1],'text-opacity':['case',['==',['get','kind'],'development'],.42,1],'text-color':['case',['get','muted'],'#9da7ae',['==',['get','kind'],'development'],'#b6c0c1',color],'text-halo-color':'#11212c','text-halo-width':['case',['==',['get','kind'],'development'],1,2],'text-halo-blur':.4}});
  }
  function updatePlaces(){
    installLayers();
    const developments=landmarkView?landmarkView.landmarkPresentations(lastState.developments||[],models?.snapshot()||[]):(lastState.developments||[]).map(d=>({...d,kind:'development'}));
    const grouped=new Map();
    for(const p of (lastState.properties||[]).filter(p=>!developments.some(d=>d.id===p.developmentId))){if(!Array.isArray(p.coordinates))continue;const key=p.coordinates.map(n=>n.toFixed(6)).join(',');if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(p);}
    const standalone=[...grouped.values()].map(homes=>{
      if(homes.length===1)return {...homes[0],kind:'property'};
      const first=homes[0],amounts=homes.map(p=>p.priceAmount).filter(Number.isFinite),sameUnits=homes.every(p=>p.currency===first.currency&&p.period===first.period),money=n=>new Intl.NumberFormat('en-IE',{style:'currency',currency:first.currency||'EUR',maximumFractionDigits:0}).format(n);
      const price=amounts.length&&sameUnits?money(Math.min(...amounts))+(Math.max(...amounts)>Math.min(...amounts)?'–'+money(Math.max(...amounts)):''):'Mixed prices';
      return {...first,id:first.name,kind:'area',price:price+' · '+homes.length+' homes',superFavorite:homes.some(p=>p.superFavorite),matchKind:homes.every(p=>p.matchKind==='alternative')?'alternative':'direct'};
    });
    items=step===5?[...developments,...standalone]:[];
    const roads=markerMath&&map.isSourceLoaded('composite')?map.querySourceFeatures('composite',{sourceLayer:'road',filter:['match',['get','class'],['street','street_limited','service','secondary','tertiary','primary'],true,false]}):[];
    const features=items.map(item=>{const model=resolveModel(item);item.mapCoordinates=model?.coordinates||item.mapCoordinates||item.coordinates;item.featureId=item.kind+':'+item.id+(item.markerId?':'+item.markerId:'');if(!streetAnchors.has(item.featureId)&&roads.length){const anchor=markerMath.nearestStreetAnchor(item.mapCoordinates,roads);if(anchor)streetAnchors.set(item.featureId,anchor);}const offers=(lastState.properties||[]).filter(p=>p.developmentId===item.id),amounts=offers.map(p=>p.priceAmount).filter(Number.isFinite),money=n=>new Intl.NumberFormat('en-IE',{style:'currency',currency:offers[0]?.currency||'EUR',maximumFractionDigits:0}).format(n),sameUnits=offers.every(p=>p.currency===offers[0]?.currency&&p.period===offers[0]?.period);const estimate=primeQuotes?.primeEstimate(item.markerId||item.markerIds?.[0]);const quote=amounts.length&&sameUnits?`${money(Math.min(...amounts))}${Math.max(...amounts)>Math.min(...amounts)?' – '+money(Math.max(...amounts)):''} · ${offers.length} ${offers.length===1?'home':'homes'}`:null;return {type:'Feature',id:item.featureId,properties:{id:item.id,kind:item.kind,markerId:item.markerId||0,icon:item.muted?'nexus-muted':item.superFavorite||offers.some(p=>p.superFavorite)?'nexus-super':(item.matchKind==='alternative'||offers.length&&offers.every(p=>p.matchKind==='alternative'))?'nexus-alternative':item.kind!=='development'?'nexus-housing':'nexus-landmark',muted:Boolean(item.muted),sort:item.id==='tigne-point'||item.id==='fortina'?0:1,label:item.kind==='development'?(quote||(estimate?'~'+primeQuotes.estimateLabel(estimate):'✦'))+(offers.length&&offers.every(p=>p.matchKind==='alternative')?' · Alternative':''):item.price+' · '+item.name+(item.matchKind==='alternative'?' · Alternative':'')},geometry:{type:'Point',coordinates:streetAnchors.get(item.featureId)||item.mapCoordinates}};});
    map.getSource(sourceId).setData({type:'FeatureCollection',features});
    // Native symbol projection follows the map; billboard faces the viewer above custom 3D layers.
    if(map.getLayer(labelId))map.moveLayer(labelId);
    if(selectedKey)map.setFeatureState({source:sourceId,id:selectedKey},{selected:true});
  }
  function endTour(notify=true){
    cancelAnimationFrame(orbitFrame);orbitFrame=0;
    if(flightEnd){map.off('moveend',flightEnd);flightEnd=null;}
    const selected=tourSelection;tourSelection=null;
    if(selected&&notify){send('selection-ready',selected);send('camera-paused');}
  }
  function stopAmbient(){cancelAnimationFrame(ambientFrame);ambientFrame=0;clearTimeout(ambientResume);ambientResume=0;}
  function startAmbient(center,camera={}){
    stopAmbient();if(reduced.matches||step!==5)return;
    const point=Array.isArray(center)?center:[center.lng,center.lat],base={zoom:camera.zoom??map.getZoom(),pitch:camera.pitch??map.getPitch(),bearing:camera.bearing??map.getBearing(),padding:camera.padding??map.getPadding()},started=performance.now();let previous=started,elapsed=0;
    const tick=now=>{if(step!==5){stopAmbient();return;}if(document.hidden){previous=now;ambientFrame=requestAnimationFrame(tick);return;}elapsed+=Math.min(80,Math.max(0,now-previous));previous=now;const seconds=elapsed/1000,envelope=Math.min(1,seconds/2.4),latitudeScale=Math.max(.35,Math.cos(point[1]*Math.PI/180));map.jumpTo({center:[point[0]+Math.sin(seconds/15)*.00016*envelope/latitudeScale,point[1]+Math.cos(seconds/18)*.0001*envelope],zoom:base.zoom+Math.sin(seconds/12)*.045*envelope,pitch:base.pitch+Math.sin(seconds/16)*.8*envelope,bearing:base.bearing+seconds*.42*envelope,padding:base.padding});ambientFrame=requestAnimationFrame(tick);};
    ambientFrame=requestAnimationFrame(tick);
  }
  function easeIntoAmbient(camera,duration=1200){
    stopAmbient();map.stop();const center=Array.isArray(camera.center)?camera.center:[camera.center.lng,camera.center.lat];
    if(reduced.matches){map.jumpTo(camera);return;}
    const done=()=>{map.off('moveend',done);startAmbient(center,{zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing(),padding:map.getPadding()});};map.once('moveend',done);map.easeTo({...camera,duration,easing:t=>1-Math.pow(1-t,3)});
  }
  function scheduleAmbientResume(){clearTimeout(ambientResume);ambientResume=setTimeout(()=>{if(step===5&&!tourSelection){const center=map.getCenter();startAmbient([center.lng,center.lat]);}},1800);}
  function selectPlace(value){
    endTour(false);stopAmbient();map.stop();
    const item=items.find(i=>i.id===value.id&&(!value.kind||value.kind===i.kind)&&(!Number(value.markerId)||i.markerId===Number(value.markerId)))||{...value,kind:value.kind||'property'};
    const model=resolveModel(item),center=model?.coordinates||item.mapCoordinates||item.coordinates;
    if(!center)return;focusedCoordinates=center;
    if(selectedKey)map.setFeatureState({source:sourceId,id:selectedKey},{selected:false});
    selectedKey=item.kind==='area'?null:item.featureId||item.kind+':'+item.id;if(selectedKey)map.setFeatureState({source:sourceId,id:selectedKey},{selected:true});
    tourSelection={kind:item.kind,id:item.id,markerId:item.markerId,name:primeQuotes?.primeEstimate(item.markerId)?.name||item.name||'Your place',includeUpcoming:value.includeUpcoming};
    send('selection-start',tourSelection);
    if(model)models.prepare(model.ids[0]);
    focusZoom=item.kind==='area'?15.3:Math.min(model?.zoom||16.7,17.5);
    const padding=framePadding(innerHeight*(innerWidth<760?.52:.54)),usableHeight=Math.max(180,innerHeight-padding.top-padding.bottom);
    const camera={center,zoom:focusZoom-.25+Math.min(0,Math.log2(usableHeight/400)*.5),pitch:52,padding,bearing:map.getBearing()};orbitCamera=camera;paddingBlend=null;
    if(reduced.matches){map.jumpTo(camera);endTour();return;}
    // One camera trajectory: approach, close pass and ongoing orbit overlap from frame one.
    const origin=map.getCenter(),initial={center:[origin.lng,origin.lat],zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing(),padding:map.getPadding()},start=performance.now();
    const delta=[center[0]-initial.center[0],center[1]-initial.center[1]],distance=Math.hypot(...delta)||1;
    const side=[-delta[1]/distance,delta[0]/distance],curve=Math.min(.0015,distance*.16);
    let motionElapsed=0,previousFrame=start;
    const tick=now=>{
      if(document.hidden){previousFrame=now;orbitFrame=requestAnimationFrame(tick);return;}
      motionElapsed+=Math.min(80,Math.max(0,now-previousFrame));previousFrame=now;
      const seconds=motionElapsed/1000,t=Math.min(1,seconds/3.8),ease=1-Math.pow(1-t,3),arc=Math.sin(t*Math.PI)*curve*(1-t);
      const position=[initial.center[0]+delta[0]*ease+side[0]*arc,initial.center[1]+delta[1]*ease+side[1]*arc];
      const pass=cameraFlow?.ambientPass(seconds,center[1])||{longitude:0,latitude:0,zoom:0,pitch:0};
      position[0]+=pass.longitude;position[1]+=pass.latitude;
      let padding=Object.fromEntries(Object.keys(camera.padding).map(k=>[k,initial.padding[k]+(camera.padding[k]-initial.padding[k])*Math.min(1,seconds/1.05)]));
      if(paddingBlend){const q=Math.min(1,(now-paddingBlend.start)/1050),u=1-Math.pow(1-q,3);padding=Object.fromEntries(Object.keys(paddingBlend.to).map(k=>[k,paddingBlend.from[k]+(paddingBlend.to[k]-paddingBlend.from[k])*u]));if(q===1){orbitCamera.padding=paddingBlend.to;paddingBlend=null;}}
      else if(t===1)padding=orbitCamera.padding;
      map.jumpTo({center:position,zoom:initial.zoom+(camera.zoom-initial.zoom)*(1-Math.pow(1-t,4))+.15*Math.sin(t*Math.PI)+pass.zoom,pitch:initial.pitch+(camera.pitch-initial.pitch)*ease+pass.pitch,bearing:initial.bearing+32*(1-Math.exp(-seconds/1.5))+seconds*2.2,padding});
      orbitFrame=requestAnimationFrame(tick);
    };
    orbitFrame=requestAnimationFrame(tick);
  }

  function endArrival(){if(!introEnd)return;map.off('moveend',introEnd);introEnd=null;send('arrival-ready');}
  function arrive(data){
    endArrival();endTour(false);stopAmbient();map.stop();startDay();
    const target=data.target,item=target&&(items.find(i=>i.id===target.id&&i.kind===target.kind)||target);
    let destination={...overview};if(data.fitMatches){const points=(lastState.properties||[]).map(p=>p.coordinates).filter(c=>Array.isArray(c)&&c.every(Number.isFinite));if(points.length){const bounds=points.reduce((b,p)=>b.extend(p),new mapboxgl.LngLatBounds(points[0],points[0]));destination={...overview,...map.cameraForBounds(bounds,{padding:70,maxZoom:14.7}),pitch:30};}}
    const destinationCenter=Array.isArray(destination.center)?destination.center:[destination.center.lng,destination.center.lat];
    const center=item?(resolveModel(item)?.coordinates||item.mapCoordinates||item.coordinates):destinationCenter;
    send('arrival-start',{name:item?.name?`${item.name}. In view.`:'Malta. Your next chapter.'});
    if(reduced.matches){map.jumpTo({...destination,center});send('arrival-ready');if(data.selectTarget&&target)selectPlace(target);return;}
    if(data.selectTarget&&target){map.jumpTo({center:[center[0]-.0018,center[1]-.0012],zoom:15.9,pitch:52,bearing:-25,padding:0});send('arrival-ready');selectPlace(target);return;}
    map.jumpTo({center:[center[0]-.018,center[1]-.009],zoom:10.7,pitch:18,bearing:-22,padding:0});
    introEnd=()=>{introEnd=null;send('arrival-ready');if(data.selectTarget&&target)selectPlace(target);else startAmbient(center,{zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing(),padding:map.getPadding()});};
    map.once('moveend',introEnd);map.flyTo({...destination,center,duration:5600,essential:false,curve:1.05,easing:t=>1-Math.pow(1-t,2.4)});
  }
  function apply(data){
    lastState=data;step=data.step;models?.setMarket(data.market,data.commercialMarkerIds||[]);
    if(step!==5){endArrival();endTour(false);stopAmbient();pauseDay();}
    for(const handler of ['dragPan','dragRotate','touchZoomRotate','doubleClickZoom','keyboard','scrollZoom'])map[handler][step===5?'enable':'disable']();
    updatePlaces();updateLocalities();updatePriceAreas();map.resize();
  }
  addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==parent||event.data?.source!=='nexus-link')return;
    const data=event.data;
    if(data.type.startsWith('activity-')&&mapReady){if(data.type==='activity-open'){endArrival();endTour(false);map.stop();}activityMap?.handle(data);}
    if(data.type==='state'){if(mapReady)apply(data);else pending=data;}
    if(data.type==='reveal')arrive(data);
    if(data.type==='select'){endArrival();selectPlace(data);}
    if(data.type==='park'){touchOrbit?.stop();activityMap?.handle({type:'activity-close'});endArrival();endTour(false);stopAmbient();pauseDay();map.stop();map.easeTo({padding:0,duration:reduced.matches?0:520});}
    if(data.type==='preview'&&mapReady){const item=items.find(i=>i.id===data.target.id)||data.target,model=resolveModel(item);endTour(false);pauseDay();map.stop();map.jumpTo({center:model?.coordinates||item.mapCoordinates||item.coordinates,zoom:Math.min(model?.zoom||16.7,17),pitch:52,padding:0});}
    if(data.type==='resume-view'){map.resize();if(!dayRunning&&!reduced.matches)toggleDay();if(!tourSelection){const center=map.getCenter();startAmbient([center.lng,center.lat]);}}
    if(data.type==='day-toggle')toggleDay();
    if(data.type==='joystick'&&step===5)joystick(data);
    if(data.type==='view'&&step===5){endArrival();endTour();map.stop();map.jumpTo({...Number.isFinite(data.zoom)&&{zoom:Math.max(10,Math.min(19,data.zoom))},...Number.isFinite(data.pitch)&&{pitch:Math.max(0,Math.min(70,data.pitch))}});}
    if(data.type==='focus-area'&&Array.isArray(data.coordinates)){endArrival();endTour();map.flyTo({center:data.coordinates,zoom:14.8,pitch:42,padding:0,duration:reduced.matches?0:1700});}
    if(data.type==='day-restart')startDay();
    if(data.type==='zoom'){endTour();map.zoomTo(map.getZoom()+(data.delta>0?1:-1),{duration:reduced.matches?0:300});}
    if(data.type==='overview'){endArrival();endTour();const points=(lastState.properties||[]).map(p=>p.coordinates).filter(c=>Array.isArray(c)&&c.every(Number.isFinite));const bounds=points.length?points.reduce((b,p)=>b.extend(p),new mapboxgl.LngLatBounds(points[0],points[0])):[[14.17,35.79],[14.59,36.09]],camera=map.cameraForBounds(bounds,{padding:70,maxZoom:14.7})||overview;focusedCoordinates=null;easeIntoAmbient({...camera,pitch:30,bearing:map.getBearing(),padding:{top:70,bottom:70,left:70,right:70}},1500);}
    if(data.type==='reset'){endTour(false);focusedCoordinates=null;easeIntoAmbient(overview,1100);}
    if(data.type==='tour-skip'||data.type==='camera-pause'){endArrival();endTour();map.stop();}
    if(data.type==='sheet-height'&&tourSelection&&orbitCamera){paddingBlend={from:map.getPadding(),to:framePadding(data.height),start:performance.now()};}
    if(data.type==='sheet-height'&&!tourSelection){map.easeTo({center:focusedCoordinates||map.getCenter(),...(focusedCoordinates&&focusZoom?{zoom:focusZoom-(data.height>150?Math.min(1.3,Math.log2(innerHeight/Math.max(170,innerHeight-data.height-90)))*.65:0)}:{}),padding:framePadding(data.height,Boolean(focusedCoordinates)),duration:reduced.matches?0:650});}
  });
  // User gestures always take priority over the automated orbit.
  for(const event of ['mousedown','touchstart','wheel'])map.on(event,()=>{send('map-interaction');stopAmbient();if(introEnd){endArrival();map.stop();}if(tourSelection){endTour();map.stop();}scheduleAmbientResume();});
  map.getCanvas().addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','+','-','='].includes(event.key)){endArrival();endTour();map.stop();}});
  let lastViewSent=0;const publishView=()=>{if(step!==5||performance.now()-lastViewSent<80)return;lastViewSent=performance.now();const center=map.getCenter(),canvas=map.getCanvas();send('view-state',{zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing(),center:[center.lng,center.lat],corners:[[0,0],[canvas.clientWidth,0],[canvas.clientWidth,canvas.clientHeight],[0,canvas.clientHeight]].map(p=>{const c=map.unproject(p);return [c.lng,c.lat];})});};map.on('move',publishView);map.on('moveend',publishView);
  map.on('mousemove',event=>{if(step===5&&map.getLayer(pointId)){const direct=map.queryRenderedFeatures(event.point,{layers:[pointId]})[0],label=map.queryRenderedFeatures(event.point,{layers:[labelId],filter:['!=',['get','kind'],'development']})[0];map.getCanvas().style.cursor=direct||label?'pointer':'';}});
  map.on('click',event=>{
    if(step!==5||touchOrbit?.isClickSuppressed())return;
    if(activityMap?.click(event))return;
    if(lastState.placeMode){const place=map.getLayer('link-locality-points')&&map.queryRenderedFeatures(event.point,{layers:['link-locality-points','link-locality-labels']})[0];if(place)send('locality-toggle',{key:place.properties.key});return;}
    const hit=map.queryRenderedFeatures(event.point,{layers:[pointId]})[0]||map.queryRenderedFeatures(event.point,{layers:[labelId],filter:['!=',['get','kind'],'development']})[0];
    if(hit){selectPlace(hit.properties);return;}
    // Empty map clicks are navigation gestures. Only a pin can open an offer.
  });
  map.on('idle',()=>{if(step===5&&markerMath&&performance.now()-lastStreetAttempt>2000&&items.some(i=>!streetAnchors.has(i.featureId))){lastStreetAttempt=performance.now();const before=streetAnchors.size;const roads=map.isSourceLoaded('composite')?map.querySourceFeatures('composite',{sourceLayer:'road'}):[];for(const item of items)if(!streetAnchors.has(item.featureId)){const anchor=markerMath.nearestStreetAnchor(item.mapCoordinates,roads);if(anchor)streetAnchors.set(item.featureId,anchor);}if(streetAnchors.size>before)updatePlaces();}const order=map.getStyle().layers||[];if(map.getLayer(labelId)&&order.at(-1)?.id!==labelId){for(const id of [haloId,pointId,labelId])map.moveLayer(id);}});
  map.on('idle',()=>{if(lastState.placeMode)updateLocalities();});
  const ready=async()=>{mapReady=true;installLayers();if(pending){apply(pending);pending=null;}send('ready',{models:{status:'loading'}});try{const module=await import('./Nexus-3D-Map/link-runtime.js');models=module.nexusModels;models.setMarket(lastState.market,lastState.commercialMarkerIds||[]);updatePlaces();models.prewarm().then(progress=>{updatePlaces();send('models-ready',{models:progress});}).catch(()=>send('model-unavailable'));}catch{send('model-unavailable');}};
  if(map.loaded())ready();else map.once('load',ready);
  map.on('error',()=>{if(!map.isStyleLoaded())send('unavailable');});
  new ResizeObserver(()=>map.resize()).observe(document.body);
})();
