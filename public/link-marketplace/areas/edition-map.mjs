import {createLocalityMap} from '../property-map.mjs';
const button=document.querySelector('.map-open');
button?.addEventListener('click',async()=>{
 const element=document.querySelector('.edition-map'),status=document.querySelector('.map-status');
 button.disabled=true;status.textContent='Loading the locality map…';element.hidden=false;
 try{const map=await createLocalityMap(element,element.dataset.center.split(',').map(Number),[],{centreLabel:element.dataset.centerLabel});if(!map)throw new Error('Map unavailable');button.setAttribute('aria-expanded','true');button.hidden=true;status.textContent='Drag to explore. Use + and − to zoom; scrolling the page stays available.';}
 catch{element.hidden=true;button.disabled=false;status.textContent='Map could not load. Try again, or use the map link above.';}
});
