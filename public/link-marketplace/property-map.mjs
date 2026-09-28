let leafletLoading;
async function leaflet(){
 if(window.L)return window.L;
 if(!leafletLoading)leafletLoading=Promise.all([new Promise((resolve,reject)=>{const css=document.createElement('link');css.rel='stylesheet';css.href='/link-marketplace/vendor/leaflet.css';css.onload=resolve;css.onerror=reject;document.head.append(css);}),new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/link-marketplace/vendor/leaflet.js';script.onload=resolve;script.onerror=reject;document.head.append(script);})]).then(()=>window.L);
 return leafletLoading;
}
const colours={swimming:'#21e1ef',daily:'#f6c66b',social:'#ff788f',wellbeing:'#7fe8a6',mobility:'#a797ff'};
const latlng=coordinates=>[coordinates[1],coordinates[0]];
export async function createPropertyMap(element,intelligence,{onSelect}={}){
 const L=await leaflet();if(!element.isConnected||!intelligence.origin)return null;
 element.classList.add('nexus-dark-map');
 const map=L.map(element,{scrollWheelZoom:false,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false,zoomControl:false,attributionControl:true,preferCanvas:false}).setView(latlng(intelligence.origin),15);
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
 const anchor=L.circleMarker(latlng(intelligence.origin),{radius:10,color:'#397d91',weight:2,fillColor:'#7aa5b0',fillOpacity:.48}).addTo(map);
 anchor.bindTooltip(intelligence.precision==='AREA_ONLY'?'Approximate area':'Approximate home location');
 L.circle(latlng(intelligence.origin),{radius:intelligence.precision==='AREA_ONLY'?200:65,color:'#65969e',weight:1,dashArray:'3 7',fillOpacity:.055,interactive:false}).addTo(map);
 const markers=new Map();
 for(const place of intelligence.places){const marker=L.circleMarker(latlng(place.coordinates),{className:'nexus-poi-glow',radius:5,color:'#a4ecdc',weight:1.5,fillColor:'#64d8be',fillOpacity:.95}).addTo(map);const label=document.createElement('span');label.textContent=place.name;marker.bindTooltip(label,{direction:'top'});marker.on('click',()=>onSelect?.(place.id));markers.set(place.id,{marker,place});}
 let route=null;const bounds=points=>L.latLngBounds([latlng(intelligence.origin),...points.map(p=>latlng(p.coordinates))]);
 const observer=new ResizeObserver(()=>map.invalidateSize({pan:false}));observer.observe(element);
 return {
  select(key,places){for(const {marker,place}of markers.values()){const active=place.connector===key;marker.setStyle({fillOpacity:active?1:.13,opacity:active?1:.2,radius:active?6:3,weight:active?1.5:.6});marker.options.interactive=active;}if(places.length)map.fitBounds(bounds(places.slice(0,6)),{padding:[38,38],maxZoom:16,animate:!matchMedia('(prefers-reduced-motion:reduce)').matches,duration:.6});},
  focus(id){for(const {marker}of markers.values())marker.closeTooltip();const hit=markers.get(id);if(hit){hit.marker.openTooltip();map.fitBounds(bounds([hit.place]),{padding:[50,50],maxZoom:17});}},
  route(geometry,mode='walk'){if(route)map.removeLayer(route);route=null;if(geometry){const colour=mode==='car'?'#f3c66f':'#67ecff';route=L.featureGroup([L.geoJSON(geometry,{style:{className:'nexus-route-halo',color:colour,weight:14,opacity:.14,lineCap:'round'}}),L.geoJSON(geometry,{style:{color:'#071d2a',weight:7,opacity:.96,lineCap:'round'}}),L.geoJSON(geometry,{style:{className:'nexus-route-flow',color:colour,weight:3.5,opacity:1,lineCap:'round',dashArray:'2 11'}})]).addTo(map);map.fitBounds(route.getBounds(),{padding:[35,35],maxZoom:17});}},
  recenter(){map.setView(latlng(intelligence.origin),15,{animate:true});},
  zoom(direction){if(direction>0)map.zoomIn(1);else map.zoomOut(1);},
  destroy(){observer.disconnect();map.stop();map.remove();}
 };
}

export async function createLocalityMap(element,center,places,{onSelect}={}){
 const L=await leaflet();if(!element.isConnected||!center)return null;
 element.classList.add('nexus-dark-map');
 const map=L.map(element,{scrollWheelZoom:false,preferCanvas:true}).setView(latlng(center),14);
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
 const circle=L.circle(latlng(center),{radius:2000,color:'#dabc7f',weight:1,dashArray:'4 8',fillColor:'#dabc7f',fillOpacity:.035}).addTo(map);map.fitBounds(circle.getBounds());
 L.marker(latlng(center),{icon:L.divIcon({className:'locality-star',html:'✦',iconSize:[32,32],iconAnchor:[16,16]})}).addTo(map).bindTooltip('Locality centre · 2 km radius');
 const markers=new Map();
 for(const place of places){const colour=colours[place.connector]||'#f6c66b';const marker=L.circleMarker(latlng(place.coordinates),{radius:5,weight:1,color:colour,fillColor:colour,fillOpacity:.9}).addTo(map);const text=document.createElement('span');text.textContent=place.name;marker.bindTooltip(text);marker.on('click',()=>onSelect?.(place.id));markers.set(place.id,marker);}
 const resize=new ResizeObserver(()=>map.invalidateSize({pan:false}));resize.observe(element);
 return {focus(id){const marker=markers.get(id);if(marker){map.setView(marker.getLatLng(),16);marker.openTooltip();}},filter(kinds){for(const place of places){const marker=markers.get(place.id);if(!kinds||kinds.includes(place.kind)){if(!map.hasLayer(marker))marker.addTo(map);}else if(map.hasLayer(marker))map.removeLayer(marker);}},destroy(){resize.disconnect();map.remove();}};
}
