import {pointInZone,normalizeZones,inAnyZone} from './spatial-zones.mjs';
let outline;
const getOutline=()=>outline||=fetch('./assets/malta-outline.json').then(r=>{if(!r.ok)throw new Error('Outline unavailable');return r.json();});
const centres={gozo:[14.253,36.046],north:[14.385,35.945],central:[14.49,35.908],south:[14.445,35.827],'south-east':[14.54,35.86]};
const colours={gozo:'#7981b6',north:'#499797',central:'#668da9',south:'#b29a71','south-east':'#897ea7'};
export function createPlaceMolecules(host,regions,onSelect,{onDraw=()=>{},getZones=()=>[]}={}){
 host.classList.add('place-molecules');
 host.innerHTML='<div class="molecule-stage"><div class="molecule-universe"></div><div class="molecule-choices"></div></div><div class="molecule-draw-tools"><button type="button" class="molecule-draw" aria-pressed="false">＋ Draw a zone</button><button type="button" class="molecule-finish" hidden>Use drawn zone ✓</button><span class="molecule-hint" role="status">Hold & circle anywhere</span></div><span class="molecule-caption">REGION GUIDES · DRAW FREELY ACROSS THEM</span>';
 let selected=new Map(),sync=()=>{},armed=false,gesture=null,timer=0,svg,project,inverse,draft=[];
 const stage=host.querySelector('.molecule-stage'),hint=host.querySelector('.molecule-hint'),drawButton=host.querySelector('.molecule-draw'),finishButton=host.querySelector('.molecule-finish');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 drawButton.onclick=()=>{armed=!armed;drawButton.setAttribute('aria-pressed',String(armed));hint.textContent=armed?'Circle a zone, or tap its corners':'Hold & circle anywhere';if(!armed){draft=[];finishButton.hidden=true;svg?.querySelector('.molecule-lasso')?.setAttribute('d','');}host.classList.toggle('draw-armed',armed);};
 function resetTilt(){stage.style.setProperty('--tilt-x','0deg');stage.style.setProperty('--tilt-y','0deg');}
 getOutline().then(data=>{
  if(!host.isConnected)return;const polys=data.geometry.type==='MultiPolygon'?data.geometry.coordinates:[data.geometry.coordinates],all=polys.flatMap(p=>p[0]);
  const minX=Math.min(...all.map(p=>p[0])),maxX=Math.max(...all.map(p=>p[0])),minY=Math.min(...all.map(p=>p[1])),maxY=Math.max(...all.map(p=>p[1]));
  const scale=Math.min(350/((maxX-minX)*.81),223/(maxY-minY)),cx=(minX+maxX)/2,cy=(maxY+minY)/2;
  project=([x,y])=>[(x-cx)*.81*scale+200,(cy-y)*scale+145];
  inverse=([x,y])=>[(x-200)/(.81*scale)+cx,cy-(y-145)/scale];
  const seeds=Object.entries(centres).map(([key,p])=>({key,p:project(p)}));
  const rings=polys.map(p=>p.map(r=>r.map(project))),points=[];
  for(let y=29;y<267;y+=7)for(let x=18;x<384;x+=7){const p=[x+((Math.round(y/7)%2)*3),y];if(rings.some(poly=>pointInZone(p,poly[0])&&!poly.slice(1).some(r=>pointInZone(p,r)))){
   const near=seeds.map(s=>({...s,d:Math.hypot(s.p[0]-p[0],s.p[1]-p[1])})).sort((a,b)=>a.d-b.d);
   if(near[1].d-near[0].d<3)continue; // A visible seam between approximate region guides.
   points.push({p,region:near[0].key,geo:inverse(p)});
  }}
  const edges=points.flatMap(({p,region},i)=>points.slice(i+1).filter(q=>q.region===region&&Math.hypot(p[0]-q.p[0],p[1]-q.p[1])<10).map(q=>`<path d="M${p.join(' ')}L${q.p.join(' ')}"/>`)).join('');
  const paths=rings.map(poly=>`<path d="${poly.map(r=>'M'+r.map(p=>p.join(' ')).join('L')+'Z').join('')}"/>`).join('');
  host.querySelector('.molecule-universe').innerHTML=`<svg viewBox="0 0 400 310" class="molecule-land" aria-label="Draw your search zones on Malta and Gozo"><g class="molecule-outline">${paths}</g><g class="molecule-bonds">${edges}</g><g class="molecule-atoms">${points.map(({p:[x,y],region},i)=>`<circle cx="${x}" cy="${y}" r="${i%9===0?2:1.35}" style="--region:${colours[region]};--delay:${(i%21)*.035}s;--drift-x:${Math.sin(i*7)*60}px;--drift-y:${Math.cos(i*5)*55}px"/>`).join('')}</g><g class="molecule-zones"></g><path class="molecule-lasso"/></svg><div class="molecule-swarm" aria-hidden="true">${Array.from({length:18},(_,i)=>`<i style="left:${(i*37)%100}%;top:${(i*23)%100}%;--delay:-${i*.7}s"></i>`).join('')}</div>`;
  svg=host.querySelector('svg');const circles=[...svg.querySelectorAll('circle')],zoneLayer=svg.querySelector('.molecule-zones'),lasso=svg.querySelector('.molecule-lasso');
  const local=event=>{const matrix=svg.getScreenCTM();if(!matrix)return [0,0];const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());return [p.x,p.y];};
  const pathOf=ring=>'M'+ring.map(p=>p.join(' ')).join('L')+'Z';
  sync=(animate=false,filling=null)=>{
   if(!getZones().length&&!armed&&!gesture&&!draft.length)hint.textContent='Hold & circle anywhere';
   const zones=getZones();zoneLayer.innerHTML=zones.map(ring=>`<path d="${pathOf(ring.map(project))}"/>`).join('');
   const last=zones.at(-1),centre=last?project(last.reduce((sum,p)=>[sum[0]+p[0]/last.length,sum[1]+p[1]/last.length],[0,0])):[200,145];
   points.forEach((point,i)=>{const active=inAnyZone(point.geo,zones)||selected.get(point.region)==='all',dot=circles[i],before=dot.classList.contains('is-selected');dot.classList.toggle('is-selected',active);
    if(animate&&active&&(!before||filling?.has(i))&&!reduced.matches){dot.getAnimations().forEach(animation=>animation.cancel());dot.animate([{opacity:.25,r:1,filter:'drop-shadow(0 0 0px #a3e8f9)'},{opacity:1,r:3,offset:.65,filter:'drop-shadow(0 0 4px #a3e8f9)'},{opacity:1,r:2}],{duration:650,delay:Math.hypot(point.p[0]-centre[0],point.p[1]-centre[1])*3,easing:'cubic-bezier(.16,1,.3,1)'});}
   });
   host.querySelectorAll('[data-molecule-region]').forEach(button=>{const value=selected.get(button.dataset.moleculeRegion)||'none';button.setAttribute('aria-pressed',value==='all'?'true':value==='partial'?'mixed':'false');});
  };
  for(const region of regions){const centre=centres[region.key];if(!centre)continue;const [x,y]=project(centre),button=document.createElement('button');button.type='button';button.dataset.moleculeRegion=region.key;button.innerHTML='<i aria-hidden="true"></i><span></span>';button.querySelector('span').textContent=region.label;button.setAttribute('aria-label',`Toggle ${region.label} region`);button.style.left=`${x/4}%`;button.style.top=`${y/3.1}%`;button.style.setProperty('--region',colours[region.key]);button.onclick=()=>onSelect(region.key);host.querySelector('.molecule-choices').append(button);}
  function begin(){if(!gesture)return;gesture.drawing=true;host.classList.add('is-drawing');resetTilt();hint.textContent='Circle your zone · release to fill';lasso.setAttribute('d','M'+gesture.points[0].join(' '));}
  svg.addEventListener('pointerdown',event=>{if(event.button!==0||gesture)return;event.preventDefault();gesture={id:event.pointerId,points:[local(event)],start:[event.clientX,event.clientY],drawing:false};svg.setPointerCapture(event.pointerId);if(armed)begin();else timer=setTimeout(begin,260);});
  svg.addEventListener('pointermove',event=>{
   if(gesture?.id===event.pointerId){
    if(gesture.drawing){const p=local(event),last=gesture.points.at(-1);if(Math.hypot(p[0]-last[0],p[1]-last[1])>2){gesture.points.push(p);lasso.setAttribute('d',pathOf(gesture.points));}return;}
    if(Math.hypot(event.clientX-gesture.start[0],event.clientY-gesture.start[1])>9)clearTimeout(timer);
   }
   if(!reduced.matches&&!host.classList.contains('has-selection')&&!host.classList.contains('is-drawing')){const rect=host.getBoundingClientRect();stage.style.setProperty('--tilt-x',`${-(event.clientY-rect.top-rect.height/2)/rect.height*7}deg`);stage.style.setProperty('--tilt-y',`${(event.clientX-rect.left-rect.width/2)/rect.width*9}deg`);}
  });
  function commit(ring){const valid=normalizeZones([ring]);if(!valid.length||!points.some(point=>pointInZone(point.geo,valid[0])))return false;if(getZones().length>=8){hint.textContent='Up to 8 zones · remove one to redraw';return false;}const filling=new Set(points.flatMap((point,i)=>pointInZone(point.geo,valid[0])&&!circles[i].classList.contains('is-selected')?[i]:[]));onDraw(valid[0]);sync(true,filling);hint.textContent='Zone connected. Find your favourites below.';armed=false;drawButton.setAttribute('aria-pressed','false');host.classList.remove('draw-armed');draft=[];finishButton.hidden=true;lasso.setAttribute('d','');return true;}
  finishButton.onclick=()=>{if(!commit(draft.map(inverse)))hint.textContent='Include a little more of Malta';};
  function finish(event){if(!gesture||gesture.id!==event.pointerId)return;clearTimeout(timer);const current=gesture;gesture=null;host.classList.remove('is-drawing');lasso.setAttribute('d','');if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);
   if(current.drawing&&event.type==='pointerup'){
    if(current.points.length<3&&armed){draft.push(current.points[0]);lasso.setAttribute('d',pathOf(draft));finishButton.hidden=draft.length<3;hint.textContent=`${draft.length} corners · add more, then use zone`;}
    else {const step=Math.max(1,Math.ceil(current.points.length/180)),ring=current.points.filter((_,i)=>i%step===0).map(inverse);if(!commit(ring))hint.textContent='Circle a little more of Malta to select a zone';}

   }
   resetTilt();
  }
  svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',finish);svg.addEventListener('pointerleave',()=>{if(!gesture)resetTilt();});svg.addEventListener('contextmenu',event=>event.preventDefault());
  sync();
 }).catch(()=>{host.hidden=true;});
 return {update(states,{animate=false}={}){selected=states;sync(animate);},showResults(show){host.classList.toggle('has-selection',show);if(show)resetTilt();}};
}
