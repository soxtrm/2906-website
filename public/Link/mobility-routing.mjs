export function mergeMappedRoutes(existing=[],payload={}){
 const mapped=(payload.status==='CONNECTED'?payload.places||[]:[]).flatMap(place=>['walk','car'].flatMap(mode=>{
  const seconds=place[mode==='walk'?'walkingSeconds':'drivingSeconds'],metres=place[mode==='walk'?'walkingDistanceMetres':'drivingDistanceMetres'];
  if(!Number.isFinite(seconds)||seconds<0||!Number.isFinite(metres)||metres<0)return [];
  return [{mode,anchorPlaceId:place.id,durationMinutes:seconds/60,distanceMetres:metres,confidence:'MODELLED',source:place.routeSource||payload.source,observedAt:place.routeObservedAt||payload.observedAt,originBasis:payload.originBasis}];
 }));
 const keys=new Set(mapped.map(r=>r.mode+':'+r.anchorPlaceId));
 return [...existing.filter(r=>!keys.has(r.mode+':'+r.anchorPlaceId)),...mapped];
}
