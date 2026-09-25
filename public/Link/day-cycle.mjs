export const DAY_CYCLE_DURATION = 600000;
export function dayAtElapsed(elapsedMs){
 const elapsed=Math.max(0,Number.isFinite(elapsedMs)?elapsedMs:0)%DAY_CYCLE_DURATION;
 const hour=(7+elapsed/DAY_CYCLE_DURATION*24)%24;
 const phase=hour>=6.5&&hour<8.5?'Sunrise':hour<12&&hour>=8.5?'Morning':hour>=12&&hour<18.5?'Day':hour>=18.5&&hour<20.5?'Sunset':'Night';
 const totalMinutes=Math.floor(hour*60);
 return {hour,phase,time:`${String(Math.floor(totalMinutes/60)).padStart(2,'0')}:${String(totalMinutes%60).padStart(2,'0')}`,progress:elapsed/DAY_CYCLE_DURATION};
}
