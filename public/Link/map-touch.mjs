export const orbitDegrees=degrees=>degrees*(160/45);
export function gestureTurn(previous,current,center){
 const a=[previous.x-center.x,previous.y-center.y],b=[current.x-center.x,current.y-center.y];
 if(Math.hypot(...a)<80||Math.hypot(...b)<80)return (current.x-previous.x)*.6;
 let degrees=(Math.atan2(b[1],b[0])-Math.atan2(a[1],a[0]))*180/Math.PI;
 degrees=((degrees+540)%360)-180;return Math.max(-28,Math.min(28,orbitDegrees(degrees)));
}
export function installTouchOrbit(map,{active,onStart,reduced}){
 const canvas=map.getCanvas(),container=map.getCanvasContainer();let gesture=null,timer=null,frame=0,target=0,previousTime=0,swallowUntil=0;
 const stop=()=>{clearTimeout(timer);cancelAnimationFrame(frame);frame=0;if(gesture?.orbit){map.dragPan.enable();container.classList.remove('is-touch-orbit');swallowUntil=performance.now()+500;}gesture=null;};
 const tick=now=>{const dt=Math.min(50,now-(previousTime||now-16));previousTime=now;const current=map.getBearing(),delta=((target-current+540)%360)-180;map.jumpTo({bearing:current+delta*(1-Math.exp(-dt/95)),padding:0});if(gesture?.orbit||Math.abs(delta)>.05)frame=requestAnimationFrame(tick);else frame=0;};
 container.addEventListener('pointerdown',event=>{
  if(event.pointerType!=='touch'||!active())return;if(gesture){stop();return;}
  cancelAnimationFrame(frame);frame=0;previousTime=0;
  const start={x:event.clientX,y:event.clientY};gesture={id:event.pointerId,start,previous:start,orbit:false};
  timer=setTimeout(()=>{if(!gesture)return;gesture.orbit=true;target=map.getBearing();previousTime=0;map.dragPan.disable();map.stop();onStart();container.classList.add('is-touch-orbit');canvas.setPointerCapture(event.pointerId);frame=requestAnimationFrame(tick);},340);
 },true);
 container.addEventListener('pointermove',event=>{
  if(!gesture||gesture.id!==event.pointerId)return;const current={x:event.clientX,y:event.clientY};
  if(!gesture.orbit){if(Math.hypot(current.x-gesture.start.x,current.y-gesture.start.y)>9)stop();return;}
  event.preventDefault();event.stopImmediatePropagation();const r=canvas.getBoundingClientRect();target+=gestureTurn(gesture.previous,current,{x:r.left+r.width/2,y:r.top+r.height/2});gesture.previous=current;
 },{capture:true,passive:false});
 const release=event=>{if(!gesture||event.pointerId!==gesture.id)return;const orbit=gesture.orbit;clearTimeout(timer);gesture=null;if(orbit){event.preventDefault();event.stopPropagation();map.dragPan.enable();container.classList.remove('is-touch-orbit');swallowUntil=performance.now()+500;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);if(reduced.matches){cancelAnimationFrame(frame);frame=0;map.jumpTo({bearing:target,padding:0});}}};
 container.addEventListener('pointerup',release,true);container.addEventListener('pointercancel',stop,true);
 // Preserve native pinch / two-finger rotation and double-tap zoom.
 container.addEventListener('touchstart',event=>{if(event.touches.length>1)stop();},{capture:true,passive:true});
 container.addEventListener('touchmove',event=>{if(gesture?.orbit&&event.touches.length===1){event.preventDefault();event.stopImmediatePropagation();}},{capture:true,passive:false});
 container.addEventListener('contextmenu',event=>{if(gesture?.orbit||performance.now()<swallowUntil)event.preventDefault();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
 return {stop,isClickSuppressed:()=>Boolean(gesture?.orbit)||performance.now()<swallowUntil};
}
