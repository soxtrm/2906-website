// A living mesh, rendered locally. No stock video or external image dependency.
let threePromise;
export async function createMembrane(canvas,{wings=false}={}){
 const THREE=await (threePromise??=import('./Nexus-3D-Map/vendor/three.module.js'));
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let renderer;
 try{renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});}catch{return {destroy(){},resize(){},journey(){}};}
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.1,40);
 camera.position.z=10;
 const geometry=new THREE.PlaneGeometry(wings?6:12,wings?8:4.4,90,34);
 const material=new THREE.ShaderMaterial({transparent:true,side:THREE.DoubleSide,uniforms:{time:{value:0},weave:{value:0},growth:{value:1}},vertexShader:`
   uniform float time; varying vec3 vNormal; varying vec3 vPosition; varying vec2 vUv;
   float wave(vec2 p){return .48*sin(p.x*1.25+time*.38)+.38*cos(p.y*1.8-p.x*.7+time*.24)+.22*sin(p.x*2.5+p.y*1.6-time*.28);}
   void main(){vec3 p=position;p.z+=wave(p.xy);float dx=(wave(p.xy+vec2(.015,0.))-wave(p.xy-vec2(.015,0.)))/.03;float dy=(wave(p.xy+vec2(0.,.015))-wave(p.xy-vec2(0.,.015)))/.03;vNormal=normalize(normalMatrix*vec3(-dx,-dy,1.));vUv=uv;vec4 mv=modelViewMatrix*vec4(p,1.);vPosition=mv.xyz;gl_Position=projectionMatrix*mv;}
 `,fragmentShader:`
   precision mediump float; uniform float weave; uniform float growth; varying vec3 vNormal; varying vec3 vPosition; varying vec2 vUv;
   void main(){vec3 n=normalize(vNormal);if(!gl_FrontFacing)n=-n;vec3 eye=normalize(-vPosition);float rim=pow(1.-abs(dot(n,eye)),2.);vec3 light=normalize(vec3(-.4,.9,1.));float diffuse=max(0.,dot(n,light));float spec=pow(max(0.,dot(reflect(-light,n),eye)),38.);float sheen=sin(n.x*5.+n.y*4.+vUv.x*5.)*.5+.5;vec3 ice=vec3(.55,.71,.83),violet=vec3(.73,.62,.86),pearl=vec3(.93,.95,.94),gold=vec3(.86,.78,.61);vec3 tint=mix(ice,violet,sheen*.65);tint=mix(tint,gold,pow(max(0.,n.y),3.)*.48);vec3 color=mix(tint,pearl,diffuse*.72)+spec*.65+rim*.3;float edge=smoothstep(0.,.06,vUv.x)*smoothstep(0.,.06,1.-vUv.x);vec2 grid=abs(fract(vUv*vec2(92.,38.))-.5);float thread=max(smoothstep(.465,.493,grid.x),smoothstep(.46,.491,grid.y));float formed=1.-smoothstep(growth-.15,growth+.06,vUv.x);float alpha=mix(.94,.06+thread*.82,weave)*mix(1.,formed,weave);gl_FragColor=vec4(color,edge*alpha);}
 `});
 const fabric=new THREE.Mesh(geometry,material);fabric.rotation.set(-.45,-.22,-.34);fabric.position.y=-.8;scene.add(fabric);
 const second=wings?new THREE.Mesh(geometry,material):null;if(second)scene.add(second);
 const resize=()=>{const bounds=canvas.getBoundingClientRect();if(!bounds.width||!bounds.height)return;renderer.setSize(bounds.width,bounds.height,false);camera.aspect=bounds.width/bounds.height;camera.position.z=camera.aspect<.8?13:10;camera.updateProjectionMatrix();renderer.render(scene,camera);};
 const observer=new ResizeObserver(resize);observer.observe(canvas);
 let frame=0,last=0,time=0,visible=true,destroyed=false,flightStart=performance.now();
 const visibility=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;});visibility.observe(canvas);
 const tick=now=>{if(destroyed)return;frame=requestAnimationFrame(tick);if(now-last<40)return;const delta=Math.min(80,now-last);last=now;if(!visible||document.hidden)return;if(!reduced.matches){time+=delta/1000;material.uniforms.time.value=time;fabric.rotation.z=-.34+Math.sin(time*.12)*.08;fabric.position.y=-.8+Math.sin(time*.2)*.12;}if(wings){const t=reduced.matches?1:Math.min(1,(now-flightStart)/3600),u=t*t;fabric.position.set(-4.2+Math.sin(t*Math.PI)*1.3,0,u*7);fabric.rotation.set(.12,-.6,-.2);second.position.set(4.2-Math.sin(t*Math.PI)*1.3,0,u*7+.3);second.rotation.set(-.12,.6,.2);}const ambient=canvas.parentElement?.classList.contains('page-membrane');material.uniforms.weave.value+=(Number(ambient)-material.uniforms.weave.value)*.035;if(ambient){const progress=Math.min(1,window.scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight));material.uniforms.growth.value+=(Math.min(1.2,.32+progress*1.2)-material.uniforms.growth.value)*.03;fabric.rotation.y=-.22+progress*.32;fabric.position.y=-.8+progress*1.2;}renderer.render(scene,camera);};
 resize();frame=requestAnimationFrame(tick);
 return {resize,journey(){flightStart=performance.now();},destroy(){destroyed=true;cancelAnimationFrame(frame);observer.disconnect();visibility.disconnect();geometry.dispose();material.dispose();renderer.dispose();}};
}
