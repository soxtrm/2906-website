const clean=value=>String(value||'').trim();
const esc=value=>clean(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function normalizePlace(raw){
 const coordinates=Array.isArray(raw.coordinates)?raw.coordinates:
  Number.isFinite(raw.longitude)&&Number.isFinite(raw.latitude)?[raw.longitude,raw.latitude]:
  Number.isFinite(raw.location?.longitude)&&Number.isFinite(raw.location?.latitude)?[raw.location.longitude,raw.location.latitude]:null;
 return {placeId:clean(raw.placeId||raw.id||raw.googlePlaceId),name:clean(raw.name||raw.displayName?.text||raw.displayName),address:clean(raw.address||raw.formattedAddress||raw.name),coordinates};
}

export function installWorkplaceSearch(host,{getAnchor,onSelect,onClear}){
 if(!host)return {destroy(){}};
 const input=host.querySelector('[data-workplace-query]'),results=host.querySelector('[data-workplace-results]'),status=host.querySelector('[data-workplace-status]');
 let timer=0,controller=null;
 const selected=getAnchor();
 if(selected?.coordinates){status.innerHTML=`<span aria-hidden="true">●</span><strong>Pin connected</strong><small>${esc(selected.address||selected.location)}</small>`;host.classList.add('has-pin');}
 const search=async()=>{
  const query=clean(input.value);controller?.abort();results.innerHTML='';
  if(query.length<3){status.textContent='Enter at least 3 characters to connect a precise pin.';return;}
  controller=new AbortController();status.textContent='Connecting to Google Places…';
  try{
   const url=new URL('/api/nexus/workplaces/search',location.origin);url.searchParams.set('q',query);
   const response=await fetch(url,{headers:{Accept:'application/json'},signal:controller.signal});
   const payload=await response.json();
   if(!response.ok||payload?.status!=='CONNECTED')throw new Error(payload?.reason||'GOOGLE_PLACES_UNAVAILABLE');
   const places=(payload.records||payload.places||payload.results||payload.suggestions||[]).map(normalizePlace).filter(p=>p.placeId&&p.coordinates?.length===2).slice(0,5);
   if(!places.length){status.textContent='No precise Google pin found. Try a company name plus locality.';return;}
   status.textContent='Choose the correct workplace pin.';
   results.innerHTML=places.map((p,i)=>`<button type="button" data-workplace-result="${i}"><span aria-hidden="true">⌖</span><span><strong>${esc(p.name)}</strong><small>${esc(p.address)}</small></span></button>`).join('');
   results.onclick=event=>{const button=event.target.closest('[data-workplace-result]');if(!button)return;const place=places[Number(button.dataset.workplaceResult)];onSelect(place);input.value=place.name||place.address;results.innerHTML='';host.classList.add('has-pin');status.innerHTML=`<span aria-hidden="true">●</span><strong>Pin connected</strong><small>${esc(place.address)}</small>`;};
  }catch(error){if(error.name==='AbortError')return;status.textContent='Google Places is not connected right now. This step stays locked rather than guessing a pin.';}
 };
 input.addEventListener('input',()=>{onClear(input.value);host.classList.remove('has-pin');clearTimeout(timer);timer=setTimeout(search,320);});
 input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(timer);search();}});
 return {destroy(){clearTimeout(timer);controller?.abort();}};
}
