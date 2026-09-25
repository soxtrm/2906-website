// Public map coordinates only. These polygons describe a search, never an address.
export function pointInZone(point,ring){
 if(!Array.isArray(point)||!Array.isArray(ring)||ring.length<3)return false;
 const [x,y]=point;let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const [ax,ay]=ring[i],[bx,by]=ring[j];
  const cross=(x-ax)*(by-ay)-(y-ay)*(bx-ax);
  if(Math.abs(cross)<1e-10&&x>=Math.min(ax,bx)&&x<=Math.max(ax,bx)&&y>=Math.min(ay,by)&&y<=Math.max(ay,by))return true;
  if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
 }
 return inside;
}
export function normalizeZones(zones){
 if(!Array.isArray(zones))return [];
 return zones.slice(0,8).filter(ring=>Array.isArray(ring)&&ring.length>=3&&ring.length<=240&&ring.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=13.9&&p[0]<=14.85&&p[1]>=35.65&&p[1]<=36.25)).map(ring=>ring.map(p=>p.map(n=>Math.round(n*1e6)/1e6))).filter(ring=>{
  const area=ring.reduce((sum,p,i)=>{const next=ring[(i+1)%ring.length];return sum+p[0]*next[1]-next[0]*p[1];},0);
  return Math.abs(area)>0.0000005;
 });
}
export const inAnyZone=(point,zones)=>zones.some(ring=>pointInZone(point,ring));
