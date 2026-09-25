const tracks=new Map();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const observer=new IntersectionObserver(entries=>{for(const entry of entries){const state=tracks.get(entry.target);if(state)state.visible=entry.isIntersecting&&entry.intersectionRatio>.35;}},{threshold:[0,.35,.75]});
export function bindGalleryMotion(){
 for(const [track]of tracks)if(!track.isConnected){observer.unobserve(track);tracks.delete(track);}
 for(const track of document.querySelectorAll('.photo-track')){
  if(tracks.has(track))continue;
  const gallery=track.closest('.gallery'),state={visible:false,hover:false,held:false,paused:false,last:performance.now()};tracks.set(track,state);observer.observe(track);
  track.addEventListener('scroll',()=>{const index=Math.round(track.scrollLeft/track.clientWidth);gallery.querySelector('.photo-count').textContent=`${index+1} / ${track.children.length}`;},{passive:true});
  gallery.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse')state.hover=true;});gallery.addEventListener('pointerleave',()=>{state.hover=false;state.last=performance.now();});
  gallery.addEventListener('pointerdown',()=>{state.held=true;state.last=performance.now();});
  const release=()=>{state.held=false;state.last=performance.now();};gallery.addEventListener('pointerup',release);gallery.addEventListener('pointercancel',release);
  gallery.addEventListener('keydown',()=>{state.last=performance.now();});
  if(track.children.length<2)continue;
  const button=document.createElement('button');button.type='button';button.className='gallery-autoplay';
  function label(){button.textContent=state.paused?'▷':'Ⅱ';button.setAttribute('aria-label',state.paused?'Play photo slideshow':'Pause photo slideshow');button.setAttribute('aria-pressed',String(state.paused));}
  button.onclick=()=>{state.paused=!state.paused;state.last=performance.now();label();};label();gallery.append(button);
 }
}
setInterval(()=>{
 if(document.hidden||reduced.matches)return;
 const now=performance.now();
 for(const [track,state]of tracks){
  if(!track.isConnected){observer.unobserve(track);tracks.delete(track);continue;}
  if(!state.visible||state.hover||state.held||state.paused||track.closest('.gallery').contains(document.activeElement)||now-state.last<2500)continue;
  if(!track.clientWidth||track.children.length<2)continue;
  const index=Math.round(track.scrollLeft/track.clientWidth),next=(index+1)%track.children.length;
  track.scrollTo({left:next*track.clientWidth,behavior:'smooth'});state.last=now;
 }
},100);
