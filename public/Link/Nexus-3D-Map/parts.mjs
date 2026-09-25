export const ZERO_PART={east:0,north:0,heading:0,lift:0};
export function partLocalOffset(p,heading){
 const a=heading*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
 return [p.east*c+p.north*s,p.east*s-p.north*c];
}
export function partCentre(asset,part){
 const a=asset.placement.heading*Math.PI/180,c=Math.cos(a),s=Math.sin(a),[x,z]=part.pivot;
 return {east:asset.placement.east+x*c+z*s+part.placement.east,north:asset.placement.north+x*s-z*c+part.placement.north};
}
export function applyPart(asset,part){
 const [dx,dz]=partLocalOffset(part.placement,asset.placement.heading);
 part.node.position.set(part.pivot[0]+dx,part.placement.lift,part.pivot[1]+dz);
 part.node.rotation.y=part.placement.heading*Math.PI/180;
}
export function transformedPolygons(asset){
 if(!asset.parts?.length)return asset.layout;
 return asset.parts.flatMap(part=>{
  const [dx,dz]=partLocalOffset(part.placement,asset.placement.heading),[px,pz]=part.pivot;
  const a=part.placement.heading*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  return part.polygons.map(poly=>poly.map(([x,z])=>[px+dx+(x-px)*c+(z-pz)*s,pz+dz-(x-px)*s+(z-pz)*c]));
 });
}
