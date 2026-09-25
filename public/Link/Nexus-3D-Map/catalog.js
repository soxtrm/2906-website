export function setupCatalog({map,features,assets,markers,select,list,status}) {
 const $=id=>document.getElementById(id);
 let category='housing',placing=false,editing=null,point=null,queue=Promise.resolve();
 const collection=()=>({type:'FeatureCollection',features});
 const backupKey='nexus-catalog-pending-v1';
 const categoryOf=f=>f.properties.category||'housing';
 document.querySelector('.panel-head').insertAdjacentHTML('beforeend',`<div class="collection-tabs"><button id="housing-tab" aria-pressed="true">Housing</button><button id="highlight-tab" aria-pressed="false">Highlights</button><button id="hotel-tab" aria-pressed="false">Hotels</button><button id="add-marker" aria-label="Neuen Marker setzen" title="Neuen Marker setzen">+</button></div><p class="catalog-hint">Rechtsklick auf einen Marker: Name & Kategorie</p>`);
 document.body.insertAdjacentHTML('beforeend',`<dialog id="marker-dialog"><form id="marker-form"><h2 id="marker-title">Neuer Marker</h2><label>Name<input id="marker-name" required maxlength="120" autocomplete="off"></label><label>Kategorie<select id="marker-category"><option value="housing">Housing · Residential / Commercial</option><option value="highlight">Highlight · Sightseeing</option><option value="hotel">Hotel</option></select></label><div class="actions"><button type="button" class="action secondary" id="marker-cancel">Abbrechen</button><button class="action" type="submit">Speichern</button></div></form></dialog>`);
 function save(){
  const body=JSON.stringify(collection());
  try{localStorage.setItem(backupKey,body);}catch{}
  status('Marker werden gespeichert…');
  queue=queue.catch(()=>{}).then(async()=>{
   try{
    const r=await fetch('/api/landmarks',{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(!r.ok)throw Error('Save failed');
    try{if(localStorage.getItem(backupKey)===body)localStorage.removeItem(backupKey);}catch{}
    status('Marker dauerhaft gespeichert.');
   }catch{status('Noch nicht in der Map-Datei gespeichert. Lokale Sicherung bleibt erhalten; beim nächsten Öffnen wird erneut gespeichert.');}
  });
  return queue;
 }
 function appearance(asset){
  const highlight=asset.ids.some(id=>categoryOf(features.find(f=>f.id===id)||{properties:{}})==='highlight');
  const hotel=asset.ids.some(id=>categoryOf(features.find(f=>f.id===id)||{properties:{}})==='hotel');
  asset.highlight=highlight;asset.hotel=hotel;
  const materials=new Set();
  asset.model?.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);});
  for(const m of materials){
   if(!m.color)continue;
   if(!m.userData.catalogOriginal)m.userData.catalogOriginal={color:m.color.clone(),metalness:m.metalness,roughness:m.roughness,emissive:m.emissive?.clone(),intensity:m.emissiveIntensity};
   const original=m.userData.catalogOriginal;
   m.color.copy(original.color);m.metalness=original.metalness;m.roughness=original.roughness;
   if(m.emissive&&original.emissive)m.emissive.copy(original.emissive);
   m.emissiveIntensity=original.intensity;
   if(highlight&&/limestone|gold|bronze|stone|concrete/i.test(m.name)){
    const dark=/bronze/i.test(m.name);m.color.set(dark?'#606974':'#f3f5f4');m.metalness=.12;
    if(m.emissive){m.emissive.set(dark?'#d9ecff':'#f1f6ff');m.emissiveIntensity=dark?.18:.07;}
   }
   if(hotel&&!asset.preserveMaterials){
    const name=m.name||'';
    if(/water|pool|plant|foliage|timber|wood/i.test(name))continue;
    const glazing=/glass|glaz|window/i.test(name);
    const dark=/bronze|metal|charcoal|frame/i.test(name);
    if(glazing){
     m.color.set('#172b43');m.metalness=.35;m.roughness=.28;
     // Opaque window panels glow warmly; transparent balcony rails stay cool.
     if(m.emissive){m.emissive.set(m.transparent?'#25405d':'#ffd597');m.emissiveIntensity=m.transparent?.035:.48;}
    }else{
     m.color.set(dark?'#34465e':'#b9c9dc');m.metalness=.16;m.roughness=.55;
     if(m.emissive){m.emissive.set(dark?'#20344f':'#a9c8f0');m.emissiveIntensity=dark?.025:.055;}
    }
   }
  }
  document.dispatchEvent(new Event('nexus-materials'));
  map.triggerRepaint();
 }
 function refresh(){
  list();
  for(const m of markers){const f=features.find(f=>f.id===Number(m.getElement().dataset.id));if(!f)continue;const el=m.getElement();el.classList.toggle('highlight',categoryOf(f)==='highlight');el.classList.toggle('hotel',categoryOf(f)==='hotel');el.hidden=categoryOf(f)!==category;el.setAttribute('aria-label',f.id+' '+f.properties.name);}
  const count=features.filter(f=>categoryOf(f)===category).length;
  document.querySelector('.count').textContent=count+' '+({housing:'Housing objects',highlight:'Highlight objects',hotel:'Hotels'}[category])+' · '+features.length+' insgesamt';
  $('housing-tab').setAttribute('aria-pressed',String(category==='housing'));$('highlight-tab').setAttribute('aria-pressed',String(category==='highlight'));$('hotel-tab').setAttribute('aria-pressed',String(category==='hotel'));
 }
 function switchTo(value){category=value;refresh();}
 function stopPlacing(){placing=false;$('add-marker').setAttribute('aria-pressed','false');map.getCanvas().style.cursor='';}
 function open(f=null,xy=null){editing=f;point=xy;$('marker-title').textContent=f?'Marker bearbeiten':'Neuer Marker';$('marker-name').value=f?.properties.name||'';$('marker-category').value=f?categoryOf(f):category;$('marker-dialog').showModal();$('marker-name').focus();}
 function context(event,f){event.preventDefault();event.stopPropagation();open(f);}
 function addPin(f){
  const b=document.createElement('button');b.className='pin';b.textContent=f.id;b.dataset.id=f.id;b.setAttribute('aria-label',f.id+' '+f.properties.name);
  b.onclick=e=>{e.stopPropagation();select(f.id);};b.oncontextmenu=e=>context(e,f);
  const marker=new mapboxgl.Marker({element:b,draggable:!assets.some(a=>a.ids.includes(f.id))}).setLngLat(f.geometry.coordinates).addTo(map);
  marker.on('dragend',()=>{const p=marker.getLngLat();f.geometry.coordinates=[p.lng,p.lat];save();});markers.push(marker);
 }
 $('housing-tab').onclick=()=>switchTo('housing');$('highlight-tab').onclick=()=>switchTo('highlight');$('hotel-tab').onclick=()=>switchTo('hotel');
 $('add-marker').onclick=()=>{if(placing){stopPlacing();status('');return;}placing=true;$('add-marker').setAttribute('aria-pressed','true');map.getCanvas().style.cursor='crosshair';status('Auf die Karte klicken, um einen Marker zu setzen. Esc bricht ab.');};
 map.on('click',e=>{if(!placing)return;stopPlacing();open(null,[e.lngLat.lng,e.lngLat.lat]);});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&placing){stopPlacing();status('');}});
 $('marker-cancel').onclick=()=>{$('marker-dialog').close();status('');};
 $('marker-dialog').addEventListener('cancel',()=>status(''));
 $('marker-form').onsubmit=e=>{
  e.preventDefault();const name=$('marker-name').value.trim();if(!name){$('marker-name').focus();return;}
  const value=$('marker-category').value;
  if(editing){
   editing.properties.name=name;editing.properties.category=value;
   const asset=assets.find(a=>a.ids.includes(editing.id));
   if(asset){for(const f of features)if(asset.ids.includes(f.id))f.properties.category=value;appearance(asset);}
  }else{const id=Math.max(0,...features.map(f=>f.id))+1;editing={type:'Feature',id,properties:{id,name,category:value},geometry:{type:'Point',coordinates:point}};features.push(editing);addPin(editing);}
  $('marker-dialog').close();switchTo(value);select(editing.id,false);save();
 };
 return {categoryOf,visible:f=>categoryOf(f)===category,context,appearance,refresh,addPin,collection,ensureVisible:f=>{if(categoryOf(f)!==category)switchTo(categoryOf(f));},restore(){
  try{const pending=JSON.parse(localStorage.getItem(backupKey)||'null');if(pending?.type==='FeatureCollection'&&Array.isArray(pending.features)){
   for(const f of pending.features){if(!Number.isInteger(f.id)||!f.properties?.name||!Array.isArray(f.geometry?.coordinates))continue;const index=features.findIndex(x=>x.id===f.id);if(index<0)features.push(f);else features[index]=f;}save();
  }}catch{}
 }};
}
