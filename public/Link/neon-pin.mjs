// Fixed-foot neon sprites: the geographic anchor never moves while the Nexus
// body breathes above it. Icons stay simple enough to read on a moving map.
const ACTIVITY_STYLE={promenades:['#36e8cf','swimming'],swimming:['#28d7ff','swimming'],sports:['#ff583f','sport'],gyms:['#ff583f','sport'],parks:['#34e59a','park'],restaurants:['#ff573c','food'],nightlife:['#ff2b93','drinks'],shopping:['#5ebcff','shopping'],wellness:['#37e2bb','wellness'],family:['#8b5cff','home'],events:['#ba63ff','events'],transport:['#55c8ff','transport'],marinas:['#29d7ee','transport'],culture:['#ba63ff','events'],other:['#7bdcff','events']};
function glyph(c,kind,x,y){
 c.save();c.translate(x,y);c.strokeStyle='#fff';c.fillStyle='#fff';c.lineWidth=3;c.lineCap='round';c.lineJoin='round';c.shadowColor='#fff';c.shadowBlur=5;c.beginPath();
 if(kind==='building'){c.rect(-10,-11,20,22);c.moveTo(-5,-6);c.lineTo(-5,-2);c.moveTo(1,-6);c.lineTo(1,-2);c.moveTo(6,-6);c.lineTo(6,-2);c.moveTo(-5,3);c.lineTo(-5,7);c.moveTo(1,3);c.lineTo(1,7);c.moveTo(6,3);c.lineTo(6,7);}
 else if(kind==='food'){c.moveTo(-7,-11);c.lineTo(-7,11);c.moveTo(-11,-11);c.lineTo(-11,-4);c.quadraticCurveTo(-7,0,-3,-4);c.lineTo(-3,-11);c.moveTo(7,-11);c.quadraticCurveTo(13,-3,7,2);c.lineTo(7,11);}
 else if(kind==='drinks'){c.moveTo(-10,-10);c.lineTo(10,-10);c.lineTo(1,0);c.lineTo(1,9);c.moveTo(-5,11);c.lineTo(7,11);}
 else if(kind==='sport'){c.arc(3,-8,3,0,Math.PI*2);c.moveTo(1,-4);c.lineTo(-4,3);c.lineTo(-11,8);c.moveTo(-4,3);c.lineTo(3,5);c.lineTo(8,11);c.moveTo(-1,-2);c.lineTo(8,0);}
 else if(kind==='swimming'){c.arc(0,-6,4,0,Math.PI*2);c.moveTo(-11,2);c.quadraticCurveTo(-6,-2,-1,2);c.quadraticCurveTo(4,6,10,2);c.moveTo(-11,8);c.quadraticCurveTo(-6,4,-1,8);c.quadraticCurveTo(4,12,10,8);}
 else if(kind==='park'){c.moveTo(0,10);c.lineTo(0,1);c.moveTo(-9,2);c.lineTo(0,-11);c.lineTo(9,2);c.closePath();}
 else if(kind==='shopping'){c.rect(-9,-5,18,15);c.moveTo(-5,-5);c.quadraticCurveTo(-5,-12,0,-12);c.quadraticCurveTo(5,-12,5,-5);}
 else if(kind==='wellness'){c.moveTo(-10,0);c.lineTo(10,0);c.moveTo(0,-10);c.lineTo(0,10);}
 else if(kind==='events'){c.moveTo(0,-12);c.quadraticCurveTo(2,-3,9,0);c.quadraticCurveTo(2,3,0,12);c.quadraticCurveTo(-2,3,-9,0);c.quadraticCurveTo(-2,-3,0,-12);}
 else if(kind==='transport'){c.rect(-9,-9,18,15);c.moveTo(-5,6);c.lineTo(-7,11);c.moveTo(5,6);c.lineTo(7,11);c.moveTo(-5,-4);c.lineTo(5,-4);}
 else {c.moveTo(-11,-1);c.lineTo(0,-11);c.lineTo(11,-1);c.moveTo(-8,-3);c.lineTo(-8,11);c.lineTo(8,11);c.lineTo(8,-3);c.moveTo(3,-8);c.lineTo(7,-8);c.lineTo(7,-4);}
 c.stroke();c.restore();
}
export function createNeonPin(housing=false,accent,icon){
 const canvas=document.createElement('canvas');canvas.width=112;canvas.height=164;
 const c=canvas.getContext('2d',{willReadFrequently:true}),color=accent||(housing?'#39d9ff':'#6df3cb'),kind=icon||(housing?'home':'building');
 function draw(seconds=0){
  const wave=Math.sin(seconds*Math.PI*2/5.8),breath=(wave+1)/2,y=49-breath*3,scale=1+wave*.035;c.clearRect(0,0,112,164);
  const aura=c.createRadialGradient(56,y,4,56,y,52);aura.addColorStop(0,color+'e8');aura.addColorStop(.28,color+'8a');aura.addColorStop(.7,color+'28');aura.addColorStop(1,color+'00');c.fillStyle=aura;c.fillRect(2,0,108,112);
  c.save();c.strokeStyle=color;c.shadowColor=color;c.shadowBlur=16;c.globalAlpha=.9;c.lineWidth=1.7;c.beginPath();c.moveTo(56,y+29);c.lineTo(56,153);c.stroke();c.shadowBlur=10;c.fillStyle=color;c.beginPath();c.arc(56,154,4.3,0,Math.PI*2);c.fill();c.globalAlpha=.24;c.beginPath();c.ellipse(56,154,15,4,0,0,Math.PI*2);c.stroke();c.restore();
  c.save();c.translate(56,y);c.rotate(.06+wave*.025);c.scale(scale,scale);const body=c.createRadialGradient(-7,-9,2,0,0,38);body.addColorStop(0,'#efffff');body.addColorStop(.16,color+'f4');body.addColorStop(.58,color+'9e');body.addColorStop(1,color+'28');c.fillStyle=body;c.strokeStyle='#dfffff';c.lineWidth=1.3;c.shadowColor=color;c.shadowBlur=22+breath*10;
  c.beginPath();c.moveTo(-29,-29);c.quadraticCurveTo(-6,-13,0,-4);c.quadraticCurveTo(6,-13,29,-29);c.quadraticCurveTo(13,-6,4,0);c.quadraticCurveTo(13,6,29,29);c.quadraticCurveTo(6,13,0,4);c.quadraticCurveTo(-6,13,-29,29);c.quadraticCurveTo(-13,6,-4,0);c.quadraticCurveTo(-13,-6,-29,-29);c.closePath();c.fill();c.stroke();
  c.globalAlpha=.72;c.strokeStyle='#fff';c.lineWidth=.8;c.shadowBlur=5;c.beginPath();c.moveTo(-23,-24);c.quadraticCurveTo(-5,-11,0,-4);c.quadraticCurveTo(5,-11,23,-24);c.stroke();c.restore();glyph(c,kind,56,y);c.shadowBlur=0;return c.getImageData(0,0,112,164);
 }
 return {draw};
}
export function createActivityPin(category){const [color,icon]=ACTIVITY_STYLE[category]||['#7bdcff','events'];return createNeonPin(false,color,icon);}
