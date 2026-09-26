async function createValletta(map,onChange){
 const [data,boundary,defaults]=await Promise.all([fetch('valletta-layer.geojson?v=2').then(r=>r.json()),fetch('valletta-boundary.json').then(r=>r.json()),fetch('valletta-state.json').then(r=>r.ok?r.json():{}).catch(()=>({}))]);
 let state={enabled:true,detached:[],hidden:[],...defaults};try{state={...state,...JSON.parse(localStorage.getItem('nexus-valletta-v1')||'{}')};}catch{}
 state.placement={east:0,north:0,heading:0,lift:0,...state.placement};
 let selected=null,exclusions=[];
 const anchor=[14.514,35.899],metersLat=111320,metersLng=111320*Math.cos(anchor[1]*Math.PI/180);
 function transform(c){const p=state.placement,a=p.heading*Math.PI/180,x=(c[0]-anchor[0])*metersLng,y=(c[1]-anchor[1])*metersLat;return [anchor[0]+(x*Math.cos(a)+y*Math.sin(a)+p.east)/metersLng,anchor[1]+(-x*Math.sin(a)+y*Math.cos(a)+p.north)/metersLat];}
 function positioned(){return {...data,features:data.features.map(f=>({...f,geometry:{...f.geometry,coordinates:f.geometry.coordinates.map(r=>r.map(transform))}}))};}
 const ui=document.createElement('section');ui.className='valletta-controls';ui.innerHTML='<button id="valletta-toggle" class="action secondary">Valletta layer</button><button id="valletta-focus" class="action secondary">Valletta ansehen</button><details><summary>Valletta: einzelne Mauern</summary><p>Auswahl aktivieren, dann eine Mauer anklicken.</p><label><input type="checkbox" id="valletta-pick"> Bauwerke auswaehlen</label><p id="valletta-selection">Kein Bauwerk ausgewaehlt</p><button id="valletta-detach">Separat fuehren</button><button id="valletta-hide">Ausblenden</button><button id="valletta-restore">Alle wieder einblenden</button></details>';
 document.querySelector('.panel-head').append(ui);
 const placement=document.createElement('div');placement.hidden=true;placement.innerHTML='<p>Gesamte Mauer: goldenen Griff ziehen oder Werte einstellen.</p>'+[['east','Ost / West (m)'],['north','Nord / Sued (m)'],['heading','Rotation (Grad)'],['lift','Hoehe (m)']].map(([key,label])=>'<label>'+label+' <input type="number" step="0.5" id="wall-'+key+'" value="'+state.placement[key]+'"></label>').join('');ui.prepend(placement);
 const handle=document.createElement('button');handle.textContent='✥';handle.title='Gesamte Valletta-Mauer verschieben';handle.setAttribute('aria-label',handle.title);handle.style.cssText='width:42px;height:42px;border:2px solid #e9c477;border-radius:50%;background:#172330;color:#ffe0a1;font-size:28px;cursor:move;';handle.hidden=true;
 const marker=new mapboxgl.Marker({element:handle,draggable:true}).setLngLat(transform(anchor)).addTo(map);
 marker.on('drag',()=>{const c=marker.getLngLat();state.placement.east=(c.lng-anchor[0])*metersLng;state.placement.north=(c.lat-anchor[1])*metersLat;applyPlacement();});
 marker.on('dragend',save);
 placement.addEventListener('input',e=>{const key=e.target.id.replace('wall-',''),value=Number(e.target.value);if(key in state.placement&&Number.isFinite(value)){state.placement[key]=value;applyPlacement();save();}});
 const $=id=>document.getElementById(id);
 map.addSource('valletta-city',{type:'geojson',data});
 for(const [id,kind] of [['valletta-buildings','building'],['valletta-walls','wall'],['valletta-detached','detached']])map.addLayer({id,type:'fill-extrusion',source:'valletta-city',minzoom:12,paint:{'fill-extrusion-color':'#d3bd94','fill-extrusion-height':['get','height'],'fill-extrusion-opacity':1,'fill-extrusion-vertical-gradient':true}});
 function applyPlacement(){
  map.getSource('valletta-city').setData(positioned());
  for(const id of ['valletta-walls','valletta-detached']){map.setPaintProperty(id,'fill-extrusion-base',Math.max(0,state.placement.lift));map.setPaintProperty(id,'fill-extrusion-height',['max',0,['+',['get','height'],state.placement.lift]]);}
  marker.setLngLat(transform(anchor));
  for(const key of Object.keys(state.placement)){const input=$('wall-'+key);if(input&&document.activeElement!==input)input.value=state.placement[key].toFixed(1);}
 }
 function refresh(){
  const visible=['!', ['in',['get','key'],['literal',state.hidden]]];
  lastBase=JSON.stringify(map.getPaintProperty('nexus-buildings-main','fill-extrusion-color'));
  for(const id of ['valletta-buildings','valletta-walls','valletta-detached'])map.setLayoutProperty(id,'visibility',id==='valletta-buildings'?'none':id==='valletta-detached'||state.enabled?'visible':'none');
  map.setFilter('valletta-buildings',['all',visible,['==',['get','kind'],'building'],['!',['in',['get','key'],['literal',state.detached]]],...exclusions]);
  map.setFilter('valletta-walls',['all',visible,['==',['get','kind'],'wall'],['!',['in',['get','key'],['literal',state.detached]]]]);
  map.setFilter('valletta-detached',['all',['==',['get','kind'],'wall'],visible,['in',['get','key'],['literal',state.detached]],...exclusions]);
  $('valletta-toggle').textContent='Valletta '+(state.enabled?'an':'aus');$('valletta-toggle').setAttribute('aria-pressed',String(state.enabled));
  $('valletta-detach').textContent=state.detached.includes(selected)?'Zurueck in Basislayer':'Separat fuehren';$('valletta-detach').disabled=!selected;$('valletta-hide').disabled=!selected;
 }
 function save(){localStorage.setItem('nexus-valletta-v1',JSON.stringify(state));refresh();onChange();}
 $('valletta-toggle').onclick=()=>{state.enabled=!state.enabled;save();};
 const focus=()=>{if(!state.enabled){state.enabled=true;save();}map.fitBounds([transform([14.5065,35.8948]),transform([14.5213,35.9034])],{padding:90,pitch:52,bearing:35,duration:1200});};
 $('valletta-focus').onclick=focus;
 $('valletta-detach').onclick=()=>{if(selected&&!state.detached.includes(selected)){state.detached.push(selected);save();$('valletta-selection').textContent+=' â€” separates Bauwerk';}};
 $('valletta-hide').onclick=()=>{if(selected&&!state.hidden.includes(selected)){state.hidden.push(selected);selected=null;save();$('valletta-selection').textContent='Ausgeblendet';}};
 $('valletta-restore').onclick=()=>{state.hidden=[];save();};
 map.on('click',e=>{if(!$('valletta-pick').checked)return;const f=map.queryRenderedFeatures(e.point,{layers:['valletta-walls','valletta-detached']})[0];if(!f)return;selected=f.properties.key;$('valletta-selection').textContent=f.properties.name+' Â· '+selected;refresh();});
 let lastPalette='',lastBase=null;
 function theme(){const h=Number(document.getElementById('timeSlider').value),night=h<6.5||h>=20.5,dusk=h>=18.5||h<8.5;
  const palette=night?'night':dusk?'dusk':'day',base=JSON.stringify(map.getPaintProperty('nexus-buildings-main','fill-extrusion-color'));if(lastPalette===palette&&base===lastBase)return;lastPalette=palette;
  for(const id of ['nexus-buildings-main','nexus-buildings-warm']){if(map.getLayer(id)){const previous=map.getPaintProperty(id,'fill-extrusion-color');const fallback=Array.isArray(previous)&&previous[0]==='case'&&previous[1]?.[0]==='within'?previous[3]:previous;map.setPaintProperty(id,'fill-extrusion-color',['case',['within',boundary],night?'#ac9570':dusk?'#c7a779':'#d3bd94',fallback]);map.setPaintProperty(id,'fill-extrusion-height',['*',['coalesce',['get','height'],14],['case',['within',boundary],1.2,1]]);}}
  for(const id of ['valletta-buildings','valletta-walls','valletta-detached'])map.setPaintProperty(id,'fill-extrusion-color',night?'#ac9570':dusk?'#c7a779':'#d3bd94');
 }
 document.addEventListener('nexus-theme-applied',()=>queueMicrotask(theme));
 document.addEventListener('input',e=>{if(e.target.id==='timeSlider')theme();});document.addEventListener('click',e=>{if(e.target.closest('.theme-btn'))theme();});
 applyPlacement();refresh();theme();onChange();return {selectWalls(fly=true){placement.hidden=false;handle.hidden=false;if(!state.enabled){state.enabled=true;save();}$('valletta-pick').checked=true;ui.querySelector('details').open=true;if(fly)focus();},leaveSelection(){placement.hidden=true;handle.hidden=true;$('valletta-pick').checked=false;ui.querySelector('details').open=false;},focus,state:()=>state,boundary,enabled:()=>state.enabled,setExclusions(value){exclusions=value;refresh();}};
}

const setupByMap=new WeakMap();
export function setupValletta(map,onChange){
 if(!setupByMap.has(map))setupByMap.set(map,createValletta(map,onChange).catch(error=>{setupByMap.delete(map);throw error;}));
 return setupByMap.get(map);
}
