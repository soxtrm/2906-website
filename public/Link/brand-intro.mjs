let running=null;
export function playBrandIntro(){
 if(running)return running;
 running=new Promise(resolve=>{
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const opener=document.activeElement;
  const dialog=document.createElement('dialog');dialog.className='brand-intro';dialog.setAttribute('aria-label','Link by Nexus introduction');
  dialog.innerHTML=`<div class="brand-sequence" aria-hidden="true"><span class="intro-nexus-star original-symbol"></span><span class="intro-nexus-satellite original-symbol"></span></div><p class="sr-only">Nexus Link is loading.</p>`;
  document.body.append(dialog);
  document.documentElement.classList.add('brand-intro-playing');dialog.showModal();
  let ended=false,exitTimer,finishTimer;
  const finish=()=>{if(ended)return;ended=true;clearTimeout(exitTimer);clearTimeout(finishTimer);dialog.close();dialog.remove();document.documentElement.classList.remove('brand-intro-playing');running=null;if(opener?.isConnected&&opener!==document.body)opener.focus({preventScroll:true});resolve();};
  const leave=()=>{if(dialog.classList.contains('is-leaving'))return;dialog.classList.add('is-leaving');finishTimer=setTimeout(finish,reduced.matches?0:430);};
  exitTimer=setTimeout(leave,reduced.matches?180:820);
  dialog.addEventListener('cancel',event=>{event.preventDefault();clearTimeout(exitTimer);leave();});
 });
 return running;
}
