// Orthographic land-dot globe. Uses public-domain Natural Earth coastlines.
export function createGlobe(canvas){
 const context=canvas.getContext('2d'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let dots=[],width=300,height=300,frame=0,last=0,started=performance.now(),visible=true;
 let longitude=-35,latitude=22,journey=null;
 const rad=Math.PI/180;
 fetch('./assets/globe-land.json').then(r=>r.json()).then(data=>{dots=data.map(([lon,lat])=>[lon*rad,lat*rad]);draw(performance.now());}).catch(()=>{});
 function project(lon,lat,rotation,tilt){const delta=lon-rotation,c=Math.cos(lat);return [c*Math.sin(delta),Math.sin(lat)*Math.cos(tilt)-c*Math.cos(delta)*Math.sin(tilt),Math.sin(lat)*Math.sin(tilt)+c*Math.cos(delta)*Math.cos(tilt)];}
 function draw(now){
  const elapsed=(now-started)/1000;
  if(journey){const t=Math.min(1,(now-journey.start)/journey.duration),ease=t*t*(3-2*t);longitude=journey.lon+(14.5-journey.lon)*ease;latitude=journey.lat+(35.9-journey.lat)*ease;}
  else if(!reduced.matches)longitude=-35+elapsed*5;
  const size=Math.min(width,height),cx=width/2,cy=height/2,r=size*.365,rotation=longitude*rad,tilt=latitude*rad;
  context.clearRect(0,0,width,height);
  const halo=context.createRadialGradient(cx,cy,r*.85,cx,cy,r*1.33);halo.addColorStop(0,'#c4b78838');halo.addColorStop(1,'#c4b78800');context.fillStyle=halo;context.fillRect(0,0,width,height);
  context.save();context.translate(cx,cy);context.rotate(-.36);context.beginPath();context.ellipse(0,0,r*1.28,r*.4,0,0,Math.PI*2);context.strokeStyle='#ae935c66';context.lineWidth=.7;context.stroke();context.restore();
  const sea=context.createRadialGradient(cx-r*.35,cy-r*.42,r*.02,cx,cy,r*1.1);sea.addColorStop(0,'#5c777b');sea.addColorStop(.35,'#243c44');sea.addColorStop(1,'#071921');context.fillStyle=sea;context.beginPath();context.arc(cx,cy,r,0,Math.PI*2);context.fill();
  context.save();context.beginPath();context.arc(cx,cy,r,0,Math.PI*2);context.clip();
  function line(points){let pen=false;context.beginPath();for(const [lon,lat]of points){const [x,y,z]=project(lon*rad,lat*rad,rotation,tilt);if(z>0){if(!pen)context.moveTo(cx+x*r,cy-y*r);else context.lineTo(cx+x*r,cy-y*r);pen=true;}else pen=false;}context.strokeStyle='#d6d2b923';context.lineWidth=.6;context.stroke();}
  for(let lon=-180;lon<180;lon+=30)line(Array.from({length:91},(_,i)=>[lon,-90+i*2]));
  for(let lat=-60;lat<=60;lat+=30)line(Array.from({length:181},(_,i)=>[-180+i*2,lat]));
  for(const [lon,lat]of dots){const[x,y,z]=project(lon,lat,rotation,tilt);if(z<=0)continue;context.fillStyle=`rgba(225,216,186,${.35+z*.57})`;context.beginPath();context.arc(cx+x*r,cy-y*r,Math.max(.35,size*.0038)*(.65+z*.35),0,Math.PI*2);context.fill();}
  context.restore();context.beginPath();context.arc(cx,cy,r,0,Math.PI*2);context.strokeStyle='#bda56a';context.lineWidth=.8;context.stroke();
  const [x,y,z]=project(14.5*rad,35.9*rad,rotation,tilt);
  if(z>0){const mx=cx+x*r,my=cy-y*r,pulse=reduced.matches?1:(Math.sin(now/850)+1)/2;context.strokeStyle=`rgba(242,208,129,${.25+pulse*.5})`;context.beginPath();context.arc(mx,my,5+pulse*5,0,Math.PI*2);context.stroke();context.fillStyle='#ffdfa0';context.shadowColor='#ffc46b';context.shadowBlur=10;context.beginPath();context.arc(mx,my,2.6,0,Math.PI*2);context.fill();context.shadowBlur=0;if(size>200){context.fillStyle='#f3e6c9';context.font='8px Manrope, sans-serif';context.fillText('MALTA',mx+14,my+3);}}
 }
 function tick(now){if(visible&&document.visibilityState==='visible'&&now-last>32){draw(now);last=now;}if(!reduced.matches||journey)frame=requestAnimationFrame(tick);}
 const observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;width=rect.width;height=rect.height;const scale=Math.min(devicePixelRatio,2);canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);context.setTransform(scale,0,0,scale,0,0);draw(performance.now());});observer.observe(canvas);
 const intersection=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;});intersection.observe(canvas);frame=requestAnimationFrame(tick);
 return {journey(duration=4000){journey={start:performance.now(),duration:reduced.matches?0:duration,lon:longitude%360,lat:latitude};if(reduced.matches){longitude=14.5;latitude=35.9;journey=null;draw(performance.now());}},idle(){journey=null;started=performance.now();},destroy(){cancelAnimationFrame(frame);observer.disconnect();intersection.disconnect();}};
}
