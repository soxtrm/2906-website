// Scalable interpretation of the user-supplied X / link. / by NEXUS artwork.
export const nexusShape='M3 3C26 22 38 33 50 33S74 22 97 3C78 26 67 38 67 50S78 74 97 97C74 78 62 67 50 67S26 78 3 97C22 74 33 62 33 50S22 26 3 3Z';
export const nexusMark=(className='')=>`<svg class="nexus-mark ${className}" viewBox="0 0 100 100" aria-hidden="true"><path d="${nexusShape}" fill="currentColor"/></svg>`;
export const nexusWordmark=()=>'<span class="original-logo living-logo" role="img" aria-label="Link"><span class="logo-symbol original-symbol" aria-hidden="true"></span><span class="logo-word original-word" aria-hidden="true"></span><span class="logo-satellite original-symbol" aria-hidden="true"></span></span>';

// Keep the supplied artwork. Only the symbol moves; the word remains the original mask.
export function installBrandMoments(){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 document.querySelectorAll('.original-logo:not(.living-logo)').forEach(el=>{el.outerHTML=nexusWordmark();});
 function play(logo){
  if(!logo||reduced.matches||logo.classList.contains('is-sparkling')||logo.classList.contains('is-brand-held')||document.hidden||document.querySelector('.brand-intro[open]'))return;
  logo.classList.add('is-sparkling');
  setTimeout(()=>logo.classList.remove('is-sparkling'),3200);
 }
 document.addEventListener('pointerover',event=>{if(event.pointerType==='touch')return;const logo=event.target.closest('.brand-link,.immersive-brand')?.querySelector('.living-logo');if(logo&&!logo.contains(event.relatedTarget)&&!logo.classList.contains('is-brand-held'))play(logo);});
 // A long press is a brand moment, not a second navigation action.
 let hold=null,holdTimer=0,resetTimer=0,suppressUntil=0;
 function finishHold(){clearTimeout(holdTimer);hold=null;}
 document.addEventListener('pointerdown',event=>{
  const button=event.target.closest('.immersive-brand');
  if(!button||innerWidth>760||event.button!==0)return;
  const logo=button.querySelector('.living-logo');clearTimeout(resetTimer);logo.classList.remove('is-brand-held');
  hold={id:event.pointerId,x:event.clientX,y:event.clientY,button};
  holdTimer=setTimeout(()=>{if(!hold)return;hold.fired=true;suppressUntil=performance.now()+3500;logo.classList.remove('is-sparkling');logo.classList.add('is-brand-held');resetTimer=setTimeout(()=>logo.classList.remove('is-brand-held'),2700);},420);
 });
 document.addEventListener('pointermove',event=>{if(hold&&event.pointerId===hold.id&&Math.hypot(event.clientX-hold.x,event.clientY-hold.y)>12)finishHold();},{passive:true});
 document.addEventListener('pointerup',()=>{if(hold?.fired)suppressUntil=performance.now()+500;finishHold();});
 document.addEventListener('pointercancel',finishHold);document.addEventListener('visibilitychange',finishHold);
 document.addEventListener('contextmenu',event=>{if(innerWidth<=760&&event.target.closest('.immersive-brand'))event.preventDefault();});
 document.addEventListener('click',event=>{if(event.target.closest('.immersive-brand')&&performance.now()<suppressUntil){event.preventDefault();event.stopImmediatePropagation();suppressUntil=0;}},true);
 document.addEventListener('focusin',event=>play(event.target.closest('.brand-link')?.querySelector('.living-logo')));
 setInterval(()=>{for(const logo of document.querySelectorAll('.brand-link .living-logo,.immersive-brand .living-logo')){const r=logo.getBoundingClientRect();if(r.width&&r.bottom>0&&r.top<innerHeight&&logo.checkVisibility({visibilityProperty:true}))play(logo);}},150000);
}

let iconId=0;
export function dimensionalIcon(name,path,cls=''){
 const id=`nexus-metal-${++iconId}`;
 const building=name==='building';
 return `<svg class="icon sculpted-icon ${building?'sculpted-building':''} ${cls}" viewBox="-4 -4 34 34" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fbfcf8"/><stop offset=".24" stop-color="#9caebe"/><stop offset=".5" stop-color="#e4e8df"/><stop offset=".74" stop-color="#8d9caa"/><stop offset="1" stop-color="#c8b47e"/></linearGradient></defs><ellipse class="icon-ground" cx="13" cy="26" rx="10" ry="2" fill="#77818b" opacity=".13"/><g class="icon-sculpture">${building?`<path d="m4 5 10-5 10 5-10 5Z" fill="#f4f5ef" stroke="#aeb8c0" stroke-width=".6"/><path d="M4 5v18l10 5V10Z" fill="url(#${id})" stroke="#919faf" stroke-width=".6"/><path d="m14 10 10-5v18l-10 5Z" fill="#667d94" stroke="#879aab" stroke-width=".6"/><path d="m7 10 4 2m-4 3 4 2m-4 3 4 2m6-10 4-2m-4 7 4-2m-4 7 4-2" stroke="#d6f1ff" stroke-width="1.4" class="icon-windows"/>`:`<path d="${path}" transform="translate(1.7 2.1)" stroke="#758699" stroke-width="3.2"/><path d="${path}" transform="translate(.8 1)" stroke="#a0aeb6" stroke-width="3.2"/><path d="${path}" stroke="url(#${id})" stroke-width="2.7"/><path d="${path}" transform="translate(-.3 -.4)" stroke="#f7fbff" stroke-width=".5" opacity=".85"/>`}</g></svg>`;
}
