export const ORIGINAL = [14.499647, 35.908036];
export const DEFAULT_PLACEMENT = { east: 0, north: 0, heading: 0, lift: 0.4 };
export function sanitizePlacement(value = {}) {
  const bounds = { east: [-500, 500], north: [-500, 500], heading: [-180, 180], lift: [-20, 80] };
  return Object.fromEntries(Object.entries(DEFAULT_PLACEMENT).map(([key, fallback]) => {
    const n = Number(value[key]);
    return [key, Number.isFinite(n) ? Math.max(bounds[key][0], Math.min(bounds[key][1], n)) : fallback];
  }));
}
export function coordinates(east, north, original = ORIGINAL) {
  return [original[0] + east / (111320 * Math.cos(original[1] * Math.PI / 180)), original[1] + north / 111320];
}
export function offsets([lng, lat], original = ORIGINAL) {
  return { east: (lng - original[0]) * 111320 * Math.cos(original[1] * Math.PI / 180), north: (lat - original[1]) * 111320 };
}
export function footprint(p, original = ORIGINAL, halfSize = [54,13.5]) {
  const a = p.heading * Math.PI / 180;
  const [w,d]=halfSize;
  return [[-w,-d],[w,-d],[w,d],[-w,d]].map(([x,z]) => coordinates(p.east+x*Math.cos(a)+z*Math.sin(a),p.north+x*Math.sin(a)-z*Math.cos(a),original));
}
export function groundSamples(p, original = ORIGINAL, halfSize = [54,13.5]) {
  // Sample the whole platform on a <= 4 m grid, not just its corners.
  const [w,d]=halfSize,a=p.heading*Math.PI/180;
  const columns=Math.ceil(w*2/4),rows=Math.ceil(d*2/4),points=[];
  for(let i=0;i<=columns;i++)for(let j=0;j<=rows;j++){
    const x=-w+i*2*w/columns,z=-d+j*2*d/rows;
    points.push(coordinates(p.east+x*Math.cos(a)+z*Math.sin(a),p.north+x*Math.sin(a)-z*Math.cos(a),original));
  }
  return points;
}

export function platformLevels(elevations,lift){
  const valid=elevations.filter(v=>typeof v==='number'&&Number.isFinite(v));
  if(!valid.length)return null;
  const highest=Math.max(...valid),lowest=Math.min(...valid);
  // Permanent clearance covers interpolation between DEM sample locations.
  const altitude=highest+0.15+lift;
  return {altitude,depth:Math.max(.2,altitude-lowest+2),complete:valid.length===elevations.length};
}
