import {resolveLocality} from './places-selection.mjs';
import {normalizePlace} from './data.mjs';

export function median(values){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),n=sorted.length;return n?n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2:null;}
export function areaIntelligence(properties,{market='longlets'}={}){
 const groups=new Map(),seen=new Set();
 for(const p of properties){
  if(seen.has(p.id)||market!=='all'&&(p.market||'longlets')!==market||p.status!=='available'||!Number.isFinite(p.rent)||p.rent<=0)continue;
  seen.add(p.id);
  const itemMarket=p.market||'longlets';const locality=resolveLocality(p.area),areaKey=locality?.key||normalizePlace(p.area),period=itemMarket==='sales'?'sale':p.rentPeriod||'month',currency=p.currency||'EUR';
  const key=[areaKey,currency,period,itemMarket].join('|');
  if(!groups.has(key))groups.set(key,{key,localityKey:locality?.key,area:locality?.label||p.area,market:itemMarket,currency,period,homes:[]});
  groups.get(key).homes.push(p);
 }
 return [...groups.values()].map(group=>{
  const prices=group.homes.map(p=>p.rent),sizes=group.homes.filter(p=>Number.isFinite(p.size)&&p.size>0),located=group.homes.filter(p=>Array.isArray(p.coordinates)&&p.coordinates.length===2&&p.coordinates.every(Number.isFinite));
  return {...group,count:prices.length,min:Math.min(...prices),max:Math.max(...prices),median:median(prices),perSqm:median(sizes.map(p=>p.rent/p.size)),sizeCount:sizes.length,demo:group.homes.some(p=>p.demo),coordinates:located.length?[0,1].map(i=>located.reduce((sum,p)=>sum+p.coordinates[i],0)/located.length):null};
 }).sort((a,b)=>a.min-b.min);
}
export function priceLabel(value,currency='EUR'){return new Intl.NumberFormat('en-IE',{style:'currency',currency,maximumFractionDigits:0}).format(value);}
export function periodLabel(period){return ({month:'/ mo',week:'/ week',night:'/ night',day:'/ day',sale:'asking price'})[period]||`/ ${period}`;}
