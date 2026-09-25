import {PROPERTY_GROUPS,PROPERTY_TYPE_KEYS,matchesPropertyType,typePickerMarkup,bindTypePicker,syncTypePicker} from './property-options.mjs';
import {normalizePlace} from './data.mjs';

export const SEARCH_MARKETS=[['longlets','Longlet'],['sales','Sales'],['stays','Shortlets & Stays'],['commercials','Commercial']];
export const HOME_TYPES=PROPERTY_GROUPS.flatMap(g=>[[g.id,g.label],...g.types]);
export const COMMERCIAL_TYPES=[['office','Offices'],['store','Stores'],['warehouse','Warehouses'],['other-commercial','Other spaces']];
export const typesForMarket=market=>market==='commercials'?COMMERCIAL_TYPES:HOME_TYPES;
const matches=(text,query)=>normalizePlace(query).split(' ').filter(Boolean).every(word=>normalizePlace(text).includes(word));

export function filterDiscovery(properties,filters,developments=[]){
 return properties.filter(p=>
  (!filters.market||filters.market==='all'||(p.market||'longlets')===filters.market)&&
  (!filters.types?.length||matchesPropertyType(p,filters.types))&&
  (!filters.maxPrice||(Number.isFinite(p.rent)&&p.rent<=filters.maxPrice))&&
  (!filters.bedrooms||p.bedrooms>=filters.bedrooms)&&
  (!filters.bathrooms||p.bathrooms>=filters.bathrooms)&&
  (!filters.query||matches([p.title,p.area,p.id,developments.find(d=>d.id===p.developmentId)?.name].join(' '),filters.query))
 );
}

export function searchPlaces(query,properties,developments,filters){
 const homes=filterDiscovery(properties,{...filters,query:''},developments);
 const areaNames=new Map();for(const item of [...developments,...properties]){const key=normalizePlace(item.area);if(key&&!areaNames.has(key))areaNames.set(key,item.area);}
 const areas=[...areaNames].map(([key,area])=>{const count=homes.filter(p=>normalizePlace(p.area)===key).length;return {
  kind:'area',id:area,name:area,coordinates:properties.find(p=>normalizePlace(p.area)===key&&p.coordinates)?.coordinates||developments.find(d=>normalizePlace(d.area)===key)?.coordinates,
  detail:`Area · ${count} ${count===1?'property':'properties'}`
 };});
 const landmarks=developments.map(d=>({...d,kind:'development',detail:`${d.area} · Landmark`}));
 const listings=homes.map(p=>({...p,kind:'property',name:p.title,detail:`${p.area} · Property`}));
 return [...areas,...landmarks,...listings].filter(item=>matches([item.name,item.area,item.id].join(' '),query)).slice(0,query.trim()?7:3);
}

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const searchIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></svg>';

// Both header searches share their filters, while keeping focus and open panels local.
export function createDiscoverySearch(host,{id,getFilters,getInventory,getMatches,developments,onChange,onBrowse,onLoad,onChooseMap}){
 host.classList.add('discovery-search');
 host.innerHTML=`<nav class="search-markets" aria-label="Search category · click or drag to change"><span class="search-market-thumb" aria-hidden="true"></span>${SEARCH_MARKETS.map(([key,label])=>`<button type="button" data-search-market="${key}" aria-pressed="false">${label}</button>`).join('')}</nav>
 <form class="search-form" role="search" aria-label="Find your place"><span class="search-icon">${searchIcon}</span><input id="${id}" type="search" maxlength="100" autocomplete="off" placeholder="Area, landmark or property…" aria-label="Search areas, landmarks or properties" aria-controls="${id}-suggestions"><button class="search-types-toggle" type="button" aria-expanded="false" aria-controls="${id}-types">Types <span></span></button><button class="search-submit" type="submit" aria-label="Search properties">↗</button></form>
 <div class="search-popover" hidden><section class="search-types" id="${id}-types" hidden><div class="search-panel-heading"><strong>Make room for possibilities.</strong><span>Choose as many as you like</span></div><div class="search-type-options"></div></section><section class="search-suggestions" id="${id}-suggestions" aria-label="Search suggestions"><div class="search-panel-heading"><strong>Find your place</strong><span>Areas, landmarks & properties</span></div><div class="search-results"></div></section><div class="search-panel-bottom"><span class="search-status" role="status"></span><button type="button" class="search-view">View properties ↗</button></div></div>`;
 host.querySelector('.search-form input').placeholder='Area, Block or Village';
 host.querySelector('.search-form input').setAttribute('aria-label','Area, Block or Village');
 host.insertAdjacentHTML('beforeend','<button type="button" class="search-map-select" aria-label="Select locations on map"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16"/></svg><span>Select on map</span></button>');
 host.querySelector('.search-map-select').onclick=()=>{close();onChooseMap?.();};
 const categoryIcons={longlets:'M3 11 12 3l9 8M5 10v11h14V10M10 21v-7h4v7',sales:'M3 5h11l7 7-9 9-9-9V5Zm5 3h.01',stays:'M3 18V7m18 11V9M3 15h18M6 11h5V7H6v4m5 0h10v4',commercials:'M4 21V7h9v14M13 11h7v10M7 10h3m-3 4h3m6 0h1M7 18h3'};
 host.querySelectorAll('[data-search-market]').forEach(button=>{const label=button.textContent;button.setAttribute('aria-label',label);button.title=label;button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${categoryIcons[button.dataset.searchMarket]}"/></svg><span class="market-label">${label}</span>`;});
 const input=host.querySelector('input'),panel=host.querySelector('.search-popover'),types=host.querySelector('.search-types'),toggle=host.querySelector('.search-types-toggle');
 let results=[],loading=false,loadError='',loadGeneration=0,drag=null,suppressClick=false;
 const marketTrack=host.querySelector('.search-markets'),marketButtons=[...host.querySelectorAll('[data-search-market]')];
 function setThumb(index){marketTrack.style.setProperty('--market-index',String(index));}
 function close(){panel.hidden=true;toggle.setAttribute('aria-expanded','false');}
 function render(){
  const filters=getFilters();if(document.activeElement!==input)input.value=filters.query;
  host.classList.toggle('search-market-open',filters.market==='all');host.querySelectorAll('[data-search-market]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.searchMarket===filters.market)));
  if(!drag)setThumb(SEARCH_MARKETS.findIndex(([key])=>key===filters.market));
  toggle.querySelector('span').textContent=filters.types.length?String(filters.types.length):'+';
  const options=typesForMarket(filters.market);
  const signature=options.map(t=>t[0]).join(',');
  const optionsNode=host.querySelector('.search-type-options');
  if(optionsNode.dataset.signature!==signature){optionsNode.dataset.signature=signature;optionsNode.innerHTML=filters.market!=='commercials'?typePickerMarkup(id+'-types'):options.map(([key,label])=>`<label><input type="checkbox" value="${key}"><span>${label}</span><i aria-hidden="true">✓</i></label>`).join('');}
  if(filters.market==='commercials')optionsNode.querySelectorAll('input').forEach(el=>el.checked=filters.types.includes(el.value));else syncTypePicker(optionsNode,filters.types);
  results=searchPlaces(filters.query,getMatches?getMatches({...filters,query:''}):getInventory(),developments,{...filters,maxPrice:0});
  host.querySelector('.search-results').innerHTML=results.length?results.map((r,i)=>`<button type="button" data-search-result="${i}"><span class="result-symbol" aria-hidden="true">${r.kind==='area'?'◎':r.kind==='development'?'◇':'⌂'}</span><span><strong>${escape(r.name)}</strong><small>${escape(r.detail)}</small></span><span class="result-arrow">↗</span></button>`).join(''):'<p class="search-no-results">No matching place. Try another area or clear your search.</p>';
  const homes=getMatches?getMatches(filters):filterDiscovery(getInventory(),filters,developments);const count=homes.length,direct=homes.filter(p=>p.searchMatch?.kind==='direct').length;
  host.querySelector('.search-status').textContent=loading?'Finding available properties…':loadError||(getMatches?`${direct} direct · ${count-direct} alternative matches`:`${count} ${count===1?'property':'properties'} in your selection`);
 }
 async function load(){const generation=++loadGeneration;loading=true;loadError='';host.classList.add('search-is-loading');render();try{await onLoad();}catch{if(generation===loadGeneration)loadError='Could not load properties. Please try again.';}finally{if(generation===loadGeneration){loading=false;host.classList.remove('search-is-loading');render();}}}
 function selectMarket(value){if(value===getFilters().market)return;const allowed=typesForMarket(value).map(t=>t[0]);onChange({...getFilters(),market:value,maxPrice:0,types:getFilters().types.filter(t=>allowed.includes(t))});close();load();}
 // The thumb follows the finger, and commits once on release rather than fetching every crossed tab.
 marketTrack.addEventListener('pointerdown',event=>{if(event.button!==0||drag)return;const bounds=marketTrack.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,bounds,moved:false,index:SEARCH_MARKETS.findIndex(([key])=>key===getFilters().market),clicked:event.target.closest('[data-search-market]')?.dataset.searchMarket};marketTrack.setPointerCapture(event.pointerId);});
 marketTrack.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;if(Math.abs(event.clientX-drag.x)>4)drag.moved=true;if(!drag.moved)return;marketTrack.classList.add('is-dragging');const index=Math.max(0,Math.min(3,(event.clientX-drag.bounds.left-4)/(drag.bounds.width-8)*4-.5));drag.index=Math.round(index);setThumb(index);});
 marketTrack.addEventListener('pointerup',event=>{if(!drag||event.pointerId!==drag.id)return;const value=drag;drag=null;marketTrack.classList.remove('is-dragging');marketTrack.releasePointerCapture(event.pointerId);if(value.moved||value.clicked){suppressClick=true;selectMarket(value.moved?SEARCH_MARKETS[value.index][0]:value.clicked);setTimeout(()=>suppressClick=false,0);}render();});
 marketTrack.addEventListener('pointercancel',()=>{drag=null;marketTrack.classList.remove('is-dragging');render();});
 marketTrack.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const current=SEARCH_MARKETS.findIndex(([key])=>key===getFilters().market);const index=event.key==='Home'?0:event.key==='End'?3:(current+(event.key==='ArrowRight'?1:3))%4;selectMarket(SEARCH_MARKETS[index][0]);marketButtons[index].focus();});
 function show(){panel.hidden=false;render();}
 function browse(value){close();Promise.resolve(onBrowse(value)).catch(()=>{loadError='Could not open the map. Please try again.';show();});}
 input.addEventListener('focus',()=>{show();load();});
 input.addEventListener('input',()=>{onChange({...getFilters(),query:input.value});show();});
 host.querySelector('.search-form').onsubmit=e=>{e.preventDefault();browse();};
 toggle.onclick=()=>{types.hidden=!(panel.hidden||types.hidden);panel.hidden=false;toggle.setAttribute('aria-expanded',String(!types.hidden));render();if(!loading)load();};
 host.querySelector('.search-view').onclick=()=>browse();
 host.addEventListener('change',event=>{if(!event.target.matches('.search-type-options input')||event.target.closest('.property-type-tree'))return;const selected=new Set(getFilters().types);event.target.checked?selected.add(event.target.value):selected.delete(event.target.value);onChange({...getFilters(),types:[...selected]});});
 host.addEventListener('click',event=>{
  const market=event.target.closest('[data-search-market]');
  if(market&&!suppressClick)selectMarket(market.dataset.searchMarket);
  const result=event.target.closest('[data-search-result]');if(result)browse(results[Number(result.dataset.searchResult)]);
 });
 host.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!panel.hidden){event.preventDefault();event.stopPropagation();close();input.focus();close();}
  if(event.key==='ArrowDown'&&event.target===input&&!panel.hidden){event.preventDefault();host.querySelector('[data-search-result]')?.focus();}
 });
 // A label briefly focuses the dialog before its checkbox; keep it open for that click.
 host.addEventListener('focusout',event=>{if(event.relatedTarget&&!host.contains(event.relatedTarget)&&event.relatedTarget.tagName!=='DIALOG')close();});
 document.addEventListener('pointerdown',event=>{if(!host.contains(event.target))close();});
 bindTypePicker(types,()=>getFilters().types,types=>onChange({...getFilters(),types}));
 render();return {render,close};
}
