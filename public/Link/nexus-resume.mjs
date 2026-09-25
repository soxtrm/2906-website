import {resumeSummary,semanticPreferences} from './nexus-semantics.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function pillarMarkup(property){
 const pillars=(property.nexusPillars||[]).filter(p=>p.confirmedCount);
 if(!pillars.length)return '';
 return `<section class="detail-section"><h2>Through the Nexus pillars.</h2><p>Confirmed features, grouped by the part of daily life they support.</p><div class="nexus-pillar-grid">${pillars.map(p=>`<article><h3>${escape(p.label)}</h3><p>${p.confirmed.map(t=>escape(t.label)).join(' · ')}</p></article>`).join('')}</div><p class="field-note">Feature groups are not personal fit scores. Area access and travel times need their own evidence.</p></section>`;
}
export function installNexusResume({getProfile,getHomes,getSaved,showModal}){
 const button=document.createElement('button');button.className='text-button';button.textContent='Your living résumé';button.dataset.nexusResume='';document.querySelector('.footer')?.append(button);
 const mapButton=button.cloneNode(true);mapButton.className='outline-button';document.querySelector('#nexus-map-portal [data-instrument-page="view"]')?.append(mapButton);
 document.addEventListener('click',async event=>{
  if(!event.target.closest('[data-nexus-resume]'))return;
  try{
   const response=await fetch('./nexus-taxonomy.json');if(!response.ok)throw new Error();const taxonomy=await response.json();
   const profile=getProfile(),saved=getSaved(),homes=getHomes().filter(p=>saved.has(p.id)&&!p.demo);
   const summary=resumeSummary(taxonomy,profile,homes);
   const preferences=semanticPreferences(taxonomy,profile);
   showModal('Your Malta living résumé.',`<p>Your stated priorities and saved homes, together. No account needed.</p><h3>Your priorities</h3>${preferences.length?`<ul>${preferences.map(p=>`<li>${escape(taxonomy.preferences.find(t=>t.key===p.key)?.label)} · ${escape(typeof p.value==='boolean'?'Selected':p.value)}</li>`).join('')}</ul>`:'<p>No priorities added yet. Your living scorecards let you choose what matters.</p>'}<h3>Saved homes · ${homes.length}</h3>${homes.map(p=>`<p><strong>${escape(p.title)}</strong><br>${escape(p.area)} · ${p.rent==null?'Price to confirm':`€${escape(p.rent)} / month`}</p>`).join('')||'<p>Save homes on the map to include them here.</p>'}<p class="field-note">Your preferences stay in this browser session. Email delivery and magic links are not connected yet.</p><button type="button" class="primary-button" id="download-nexus-resume">Download my résumé</button>`);
   document.querySelector('#download-nexus-resume').addEventListener('click',()=>{
    const content=['YOUR MALTA LIVING PROFILE','',...preferences.map(p=>`${taxonomy.preferences.find(t=>t.key===p.key)?.label}: ${typeof p.value==='boolean'?'Selected':p.value}`),'',`SAVED HOMES (${homes.length})`,...summary.homes.flatMap(h=>[`${h.title} — ${h.area}`,h.rent==null?'Price to confirm':`EUR ${h.rent} / month`,...h.pillars.map(p=>`${p.label}: ${p.tags.join(', ')}`),'']),'Locations are locality centroids. Unverified details and travel costs remain unknown.'].join('\n');
    const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='Nexus-Link-Resume.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
   });
  }catch{showModal('Your living résumé.','<p>The résumé could not be loaded. Please try again.</p>');}
 });
}
