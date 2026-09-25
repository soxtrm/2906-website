// Presentation only: never changes source geometry or listing eligibility.
export function modelPresentation(asset,market='all',commercialIds=[]){
 const hotel=asset.hotel||['hard-rock-hotel','doubletree','phoenicia','ihg'].includes(asset.key);
 const prime=market==='commercials'?asset.ids.some(id=>commercialIds.includes(id)):!hotel||market==='stays'||market==='all';
 return {prime,hotel,mutedParts:asset.key==='verdala-terraces'&&market!=='stays'&&market!=='all'?['south','hotel-pool']:[]};
}
