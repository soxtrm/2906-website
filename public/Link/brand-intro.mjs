let running=null;
export function playBrandIntro(){
 if(running)return running;
 running=new Promise(resolve=>{
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const opener=document.activeElement;
  const dialog=document.createElement('dialog');dialog.className='brand-intro';dialog.setAttribute('aria-label','Link by Nexus introduction');
  dialog.innerHTML=`<span class="brand-intro-caption">PEOPLE. PLACES. POSSIBILITIES.</span><div class="brand-sequence" aria-hidden="true"><span class="intro-nexus-star original-symbol"></span></div><p class="sr-only">Nexus Link. Your next chapter.</p><button class="intro-skip">Skip intro <span aria-hidden="true">↗</span></button>`;
  document.body.append(dialog);
  document.documentElement.classList.add('brand-intro-playing');dialog.showModal();
  let ended=false,exitTimer,finishTimer,entryTimer,fadeTimer,targetHeader=null;
  const finish=()=>{if(ended)return;ended=true;clearTimeout(exitTimer);clearTimeout(finishTimer);clearTimeout(entryTimer);clearTimeout(fadeTimer);targetHeader?.classList.remove('intro-target-ready');dialog.close();dialog.remove();document.documentElement.classList.remove('brand-intro-playing');document.body.classList.remove('site-entering');void document.body.offsetWidth;document.body.classList.add('site-entering');entryTimer=setTimeout(()=>document.body.classList.remove('site-entering'),reduced.matches?0:900);running=null;if(opener?.isConnected&&opener!==document.body)opener.focus({preventScroll:true});resolve();};
  const leave=()=>{if(dialog.classList.contains('is-preparing')||dialog.classList.contains('is-leaving'))return;dialog.classList.add('is-preparing');targetHeader=document.querySelector('.header.search-shell');targetHeader?.classList.add('intro-target-ready');targetHeader?.querySelector('[data-compact="search"]')?.click();const star=dialog.querySelector('.intro-nexus-star');requestAnimationFrame(()=>requestAnimationFrame(()=>{const target=targetHeader?.querySelector('.brand-link'),from=star.getBoundingClientRect(),to=target?.getBoundingClientRect();if(to&&!reduced.matches){const dx=to.left+to.width/2-(from.left+from.width/2),dy=to.top+to.height/2-(from.top+from.height/2),scale=Math.min(to.width/from.width,to.height/from.height);star.animate([{transform:'translate3d(0,0,0) scale(1)',opacity:1},{offset:.72,transform:`translate3d(${dx*.84}px,${dy*.84}px,0) scale(${Math.max(scale*1.35,.34)})`,opacity:1},{transform:`translate3d(${dx}px,${dy}px,0) scale(${scale})`,opacity:.98}],{duration:720,easing:'cubic-bezier(.18,.72,.18,1)',fill:'forwards'});}fadeTimer=setTimeout(()=>dialog.classList.add('is-leaving'),reduced.matches?0:600);}));finishTimer=setTimeout(finish,reduced.matches?0:1180);};
  exitTimer=setTimeout(leave,reduced.matches?250:1050);
  dialog.querySelector('.intro-skip').onclick=()=>{clearTimeout(exitTimer);leave();};
  dialog.addEventListener('cancel',event=>{event.preventDefault();clearTimeout(exitTimer);leave();});
 });
 return running;
}
