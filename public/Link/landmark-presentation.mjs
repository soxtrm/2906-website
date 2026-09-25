// One public identity per development. Model pieces remain independent for rendering.
const approach=[14.498,35.907]; // Manoel Island / Gzira arrival side.
export function landmarkPresentations(developments,models=[]){
 const seen=new Set();
 return developments.filter(d=>{if(seen.has(d.id))return false;seen.add(d.id);return true;}).map(d=>{
  const pieces=models.filter(m=>d.markerIds?.some(id=>m.ids.includes(id)));
  const distance=m=>((m.coordinates[0]-approach[0])*.81)**2+(m.coordinates[1]-approach[1])**2;
  const front=pieces.sort((a,b)=>distance(a)-distance(b))[0];
  return {...d,kind:'development',markerId:front?.ids[0]||d.markerIds?.[0],mapCoordinates:front?.coordinates||d.coordinates};
 });
}
