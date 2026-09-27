const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function composeEditorial(root,{name,guide,homes}){
 const variant=[...name].reduce((n,c)=>n+c.charCodeAt(0),0)%3;
 root.classList.add('editorial',`editorial-${variant}`);
 const cover=root.querySelector('.brochure-cover'),stories=root.querySelector('.brochure-stories'),map=root.querySelector('.brochure-map-section');
 root.querySelector('.brochure-emblem')?.remove();
 const photo=guide?.photo;
 if(photo?.url?.startsWith('https://')&&photo.sourceUrl?.startsWith('https://')){
  cover.classList.add('has-photography');
  cover.insertAdjacentHTML('beforeend',`<figure class="editorial-cover-photo"><img src="${esc(photo.url)}" alt="${esc(name)} — locality photograph" decoding="async"><figcaption><a href="${esc(photo.sourceUrl)}" target="_blank" rel="noopener">${esc(photo.author||photo.source)} · ${esc(photo.license)} ↗</a></figcaption></figure>`);
 }
 const story=stories?.querySelector('section');
 if(story){story.classList.add('editorial-story');cover.after(story);}
 const photos=homes.filter(p=>p.images?.[0]).slice(0,3);
 if(photos.length){
  const spread=document.createElement('section');spread.className='editorial-home-spread';
  spread.innerHTML=`<header><span>THE LIVING EDIT / ${esc(name)}</span><h3>A different<br>point of view.</h3><p>A glimpse inside homes listed in this locality.</p></header><div class="editorial-image-row">${photos.map((p,i)=>`<figure><img src="${esc(p.images[0])}" alt="${esc(p.title)} — listed home" loading="lazy" decoding="async"><figcaption><span>0${i+1} / ${esc(p.propertyType||'Home')}</span><b>${esc(p.title)}</b></figcaption></figure>`).join('')}</div>`;
  if(variant===1)cover.after(spread);else story?.after(spread);
 }
 // The map is a full editorial chapter, following the images and local story.
 stories?.after(map);
 const mapTitle=map?.querySelector('h3');if(mapTitle)mapTitle.innerHTML='The neighbourhood.<br>All connected.';
 root.querySelectorAll('.brochure-venues').forEach((section,i)=>section.classList.add(i%2?'editorial-venues-wide':'editorial-venues-index'));
 root.querySelector('.brochure-cover h2 em').textContent='The neighbourhood edition';
}
