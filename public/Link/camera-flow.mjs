// Continuous, bounded motion around a landmark; no waiting between camera phases.
export function framingPadding(width,height,cardHeight=0,focused=true){
 const top=Math.min(height*.13,width<760?72:98);
 const bottom=Math.min(Math.max(cardHeight,focused?height*.47:0),Math.max(0,height-top-48));
 return {top,bottom,left:0,right:0};
}
export function ambientPass(seconds,latitude){
 const envelope=1-Math.exp(-Math.max(0,seconds)/5),phase=seconds*Math.PI*2/38;
 return {
  zoom:-.38*Math.sin(phase)*envelope,
  pitch:4*Math.sin(phase*.7)*envelope,
  longitude:Math.sin(phase*.8)*.00012*envelope/Math.cos(latitude*Math.PI/180),
  latitude:(Math.cos(phase*.8)-1)*.00007*envelope
 };
}
