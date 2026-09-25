import {heroCollection,HERO_INTERVAL} from './hero-collection.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function installPropertyReel(host,{load,photoUrl,onSelect}){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let raf=0,timer=0,hitTimer=0,index=0,paused=false,hover=false,focused=false,nextAt=0,pressedId=null;
 const hero=host.parentElement.querySelector('.film-fed-image');
 function render(properties){
  if(!host.isConnected)return;
  const scenes=heroCollection(properties);
  if(!scenes.length){host.innerHTML='<span class="reel-label">YOUR NEXT CHAPTER IS TAKING SHAPE.</span>';return;}
  host.innerHTML=`<div class="reel-space">${scenes.slice(0,6).map(({property:p,image,scene},i)=>`<div class="reel-orbit" style="--reel-delay:${i*(-18/Math.min(6,scenes.length))}s"><button type="button" class="reel-property" data-reel-id="${escape(p.id)}" aria-label="Explore ${escape(p.title)}"><img src="${escape(photoUrl(image))}" alt="${escape(scene)} in ${escape(p.area)}" loading="lazy"><span><b>${escape(p.area)}</b><small>EXPLORE THIS HOME ↗</small></span><i></i></button></div>`).join('')}</div><span class="reel-label">PLACES. SPACES. YOUR POSSIBILITIES.</span>`;
  if(!hero)return;
  hero.classList.add('curated-hero');
  hero.innerHTML=scenes.map(({property:p,image,scene},i)=>`<button type="button" class="hero-scene curated-scene ${i===0?'is-current is-clickable':''}" data-reel-id="${escape(p.id)}" tabindex="${i===0?0:-1}" aria-label="Explore ${escape(p.title)} — ${escape(scene)}"><img src="${escape(photoUrl(image))}" alt="${escape(scene)} in ${escape(p.area)}" ${i>1?'loading="lazy"':''}></button>`).join('')+'<div class="hero-photo-controls"><button type="button" data-hero-pause aria-label="Pause homepage photos">Ⅱ</button><button type="button" data-hero-next aria-label="Next homepage photo">→</button></div>';
  host.parentElement.querySelector('.image-label').textContent='SELECTED HOMES';
  const buttons=[...hero.querySelectorAll('.curated-scene')],pause=hero.querySelector('[data-hero-pause]');
  function change(){
   const upcoming=(index+1)%buttons.length,img=buttons[upcoming].querySelector('img');img.loading='eager';
   if(!img.complete||!img.naturalWidth)return;
   clearTimeout(hitTimer);buttons.forEach(button=>{button.classList.remove('is-leaving','is-clickable');button.tabIndex=-1;});
   const previous=buttons[index],next=buttons[upcoming];previous.classList.remove('is-current');previous.classList.add('is-leaving','is-clickable');next.classList.add('is-current');index=upcoming;
   const enable=()=>{previous.classList.remove('is-clickable');next.classList.add('is-clickable');next.tabIndex=0;};
   if(reduced.matches)enable();else hitTimer=setTimeout(enable,320);
   buttons[(index+1)%buttons.length].querySelector('img').loading='eager';
  }
  function pauseLabel(){pause.textContent=paused||reduced.matches?'▶':'Ⅱ';pause.setAttribute('aria-label',paused||reduced.matches?'Play homepage photos':'Pause homepage photos');}
  pause.onclick=()=>{paused=!paused;nextAt=performance.now()+HERO_INTERVAL;pauseLabel();};
  hero.querySelector('[data-hero-next]').onclick=()=>{change();nextAt=performance.now()+HERO_INTERVAL;};
  hero.addEventListener('pointerenter',()=>{hover=true;});
  hero.addEventListener('pointerleave',()=>{hover=false;pressedId=null;nextAt=Math.max(nextAt,performance.now()+1000);});
  hero.addEventListener('focusin',()=>{focused=true;});hero.addEventListener('focusout',event=>{focused=hero.contains(event.relatedTarget);});
  hero.addEventListener('pointerdown',event=>{pressedId=event.target.closest('[data-reel-id]')?.dataset.reelId||null;});
  hero.addEventListener('click',event=>{const button=event.target.closest('[data-reel-id]');if(button){onSelect(pressedId||button.dataset.reelId);pressedId=null;}});
  nextAt=performance.now()+HERO_INTERVAL;pauseLabel();
  timer=setInterval(()=>{if(!host.isConnected){clearInterval(timer);clearTimeout(hitTimer);return;}if(document.hidden||reduced.matches||paused||hover||focused)return;if(performance.now()>=nextAt){change();nextAt=performance.now()+HERO_INTERVAL;}},100);
 }
 host.addEventListener('pointermove',event=>{if(reduced.matches||event.pointerType==='touch')return;cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{const r=host.getBoundingClientRect();host.style.setProperty('--reel-yaw',`${(event.clientX-r.left-r.width/2)/r.width*22}deg`);host.style.setProperty('--reel-pitch',`${-(event.clientY-r.top-r.height/2)/r.height*12}deg`);});},{passive:true});
 host.addEventListener('pointerleave',()=>{cancelAnimationFrame(raf);host.style.setProperty('--reel-yaw','0deg');host.style.setProperty('--reel-pitch','0deg');});
 host.addEventListener('click',event=>{const card=event.target.closest('[data-reel-id]');if(card)onSelect(card.dataset.reelId);});
 load().then(result=>render(result.properties||[])).catch(()=>{if(host.isConnected)host.innerHTML='<span class="reel-label">YOUR PLACES WILL APPEAR HERE.</span>';});
}
