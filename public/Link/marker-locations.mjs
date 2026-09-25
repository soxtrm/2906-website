// Only local streets are eligible. Unknown road classes never become display anchors.
const LOCAL_STREETS=new Set(['street','street_limited','residential','living_street','service','pedestrian','unclassified']);
export function isLocalStreet(feature){
 const p=feature.properties||{},kind=String(p.class||p.highway||'').toLowerCase();
 return LOCAL_STREETS.has(kind)&&!/(motorway|trunk|primary|secondary|_link|ramp)/i.test(`${p.type||''} ${p.subclass||''} ${p.highway||''}`)&&p.structure!=='tunnel'&&p.structure!=='bridge';
}
// Pin locations are a separate display anchor; the camera still targets the 3D building.
export function nearestStreetAnchor(origin,features,maxMeters=90){
 const lngScale=111320*Math.cos(origin[1]*Math.PI/180),latScale=111320;
 let closest=null,best=maxMeters*maxMeters;
 for(const feature of features){
  if(!isLocalStreet(feature))continue;
  const geometry=feature.geometry;
  const lines=geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
  for(const points of lines)for(let i=1;i<points.length;i++){
   const a=[(points[i-1][0]-origin[0])*lngScale,(points[i-1][1]-origin[1])*latScale],b=[(points[i][0]-origin[0])*lngScale,(points[i][1]-origin[1])*latScale];
   const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;if(!length)continue;
   const t=Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/length)),x=a[0]+t*dx,y=a[1]+t*dy,d=x*x+y*y;
   if(d<best){best=d;const side=x||y?Math.sign(x*-dy+y*dx)||1:1,offset=6;
    closest=[origin[0]+(x+side*dy/Math.sqrt(length)*offset)/lngScale,origin[1]+(y-side*dx/Math.sqrt(length)*offset)/latScale];
   }
  }
 }
 return closest;
}
