// Stable public type keys shared by profile matching and quick discovery.
export const PROPERTY_GROUPS=[
 {id:'houses',label:'Houses',types:[['semi-detached-villa','Semi Detached Villa'],['detached-villa','Detached Villa'],['bungalow','Bungalow'],['terraced-house','Terraced House'],['farmhouse','Farmhouse'],['townhouse','Townhouse'],['palazzo','Palazzo'],['boathouse','Boathouse'],['house-of-character','House of Character']]},
 {id:'apartments',label:'Apartments',types:[['maisonette','Maisonettes'],['top-level-apartment','Top Level Apartment'],['apartment','Apartments'],['penthouse','Penthouses'],['duplex-apartment','Duplex Apartment'],['duplex-penthouse','Duplex Penthouse'],['duplex-maisonette','Duplex Maisonette'],['studio','Studio'],['studio-maisonette','Studio Maisonette'],['studio-penthouse','Studio Penthouse'],['serviced-apartment','Serviced Apartment'],['studio-dwelling','Studio Dwelling']]},
 {id:'block',label:'Block',types:[]},
 {id:'developments',label:'Developments',types:[['site','Sites'],['shellform','Shellform'],['prebuild','Prebuild'],['finished','Finished']]}
];
export const PROPERTY_TYPE_KEYS=new Set(['house',...PROPERTY_GROUPS.flatMap(g=>[g.id,...g.types.map(t=>t[0])])]);
export const asTypes=value=>Array.isArray(value)?value:typeof value==='string'?[value]:[];
export function matchesPropertyType(property,value){
 const selected=asTypes(value);if(!selected.length)return true;
 const group=PROPERTY_GROUPS.find(g=>g.id===property.propertyType||g.types.some(t=>t[0]===property.propertyType)||(g.id==='houses'&&property.propertyType==='house'));
 return selected.includes(property.propertyType)||Boolean(group&&selected.includes(group.id));
}
export function typeLabel(key){return PROPERTY_GROUPS.find(g=>g.id===key)?.label||PROPERTY_GROUPS.flatMap(g=>g.types).find(t=>t[0]===key)?.[1]||key;}

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function typePickerMarkup(prefix){
 return `<div class="property-type-tree">${PROPERTY_GROUPS.map(g=>`<section class="type-group"><div class="type-group-heading"><label><input type="checkbox" data-type-group="${g.id}" value="${g.id}" aria-label="All ${escape(g.label)}"><span>${g.label}</span><i aria-hidden="true">✓</i></label>${g.types.length?`<button type="button" class="type-group-expand" aria-label="Show ${escape(g.label)} types" aria-expanded="false" aria-controls="${prefix}-${g.id}">⌄</button>`:''}</div>${g.types.length?`<div class="type-group-children" id="${prefix}-${g.id}" hidden>${g.types.map(([id,label])=>`<label><input type="checkbox" value="${id}" aria-label="${escape(label)}"><span>${label}</span><i aria-hidden="true">✓</i></label>`).join('')}</div>`:''}</section>`).join('')}</div>`;
}
export function syncTypePicker(root,value){
 const selected=asTypes(value);
 root.querySelectorAll('.property-type-tree input').forEach(input=>{
  const group=PROPERTY_GROUPS.find(g=>g.id===input.value||g.types.some(t=>t[0]===input.value));
  input.checked=selected.includes(input.value)||Boolean(group&&selected.includes(group.id));
  input.indeterminate=Boolean(input.dataset.typeGroup&&!input.checked&&group?.types.some(t=>selected.includes(t[0])));
 });
}
export function togglePropertyType(value,key,checked){
 let selected=asTypes(value),group=PROPERTY_GROUPS.find(g=>g.id===key||g.types.some(t=>t[0]===key));
 if(group?.id===key){selected=selected.filter(t=>t!==key&&!group.types.some(x=>x[0]===t));return checked?[...selected,key]:selected;}
 if(group&&selected.includes(group.id))selected=[...selected.filter(t=>t!==group.id),...group.types.map(t=>t[0])];
 return checked?[...new Set([...selected,key])]:selected.filter(t=>t!==key);
}
export function bindTypePicker(root,getValue,onChange){
 root.addEventListener('click',event=>{const button=event.target.closest('.type-group-expand');if(!button)return;const children=root.querySelector(`[id="${button.getAttribute('aria-controls')}"]`);children.hidden=!children.hidden;button.setAttribute('aria-expanded',String(!children.hidden));});
 root.addEventListener('change',event=>{if(!event.target.matches('.property-type-tree input'))return;onChange(togglePropertyType(getValue(),event.target.value,event.target.checked));syncTypePicker(root,getValue());});
 syncTypePicker(root,getValue());
}
