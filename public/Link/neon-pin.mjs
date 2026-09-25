// Animate inside a fixed-size sprite: the geographic foot never moves.
export function createNeonPin(housing=false,accent){
 const canvas=document.createElement('canvas');canvas.width=112;canvas.height=164;
 const c=canvas.getContext('2d',{willReadFrequently:true}),color=accent||(housing?'#59bfff':'#96dfff');
 function draw(seconds=0){
  const breath=(Math.sin(seconds*Math.PI*2/5.8)+1)/2,y=51-breath*5;
  c.clearRect(0,0,112,164);
  const glow=c.createRadialGradient(56,y,5,56,y,50);glow.addColorStop(0,color+'b0');glow.addColorStop(.55,color+'45');glow.addColorStop(1,color+'00');c.fillStyle=glow;c.fillRect(0,0,112,115);
  c.shadowColor=color;c.shadowBlur=15+breath*7;c.strokeStyle=color;c.lineWidth=2;
  c.beginPath();c.moveTo(56,y+30);c.lineTo(56,155);c.stroke();
  c.beginPath();c.ellipse(56,155,13,3.5,0,0,Math.PI*2);c.stroke();
  c.globalAlpha=.22+breath*.12;c.beginPath();c.ellipse(56,155,23,6,0,0,Math.PI*2);c.stroke();c.globalAlpha=1;
  const body=c.createLinearGradient(30,y-30,80,y+32);body.addColorStop(0,'#b9e6ff');body.addColorStop(.13,'#48799c');body.addColorStop(.48,'#0c2b46');body.addColorStop(1,'#244f70');
  c.fillStyle='#071b2a';c.beginPath();c.ellipse(58,y+3,30,32,0,0,Math.PI*2);c.fill();
  c.fillStyle=body;c.beginPath();c.arc(56,y,30,0,Math.PI*2);c.fill();c.stroke();c.shadowBlur=0;
  c.strokeStyle='#e3f8ff';c.lineWidth=1;c.beginPath();c.arc(56,y,26,Math.PI*1.06,Math.PI*1.7);c.stroke();
   c.save();c.translate(56,y);c.rotate(Math.PI/4+seconds*.22);c.fillStyle=accent||(housing?'#c1f1ff':'#f8dfad');c.shadowColor=color;c.shadowBlur=18;
   c.beginPath();c.moveTo(-19,-19);c.quadraticCurveTo(0,-5,19,-19);c.quadraticCurveTo(5,0,19,19);c.quadraticCurveTo(0,5,-19,19);c.quadraticCurveTo(-5,0,-19,-19);c.fill();c.restore();
  c.shadowBlur=0;return c.getImageData(0,0,112,164);
 }
 return {draw};
}
