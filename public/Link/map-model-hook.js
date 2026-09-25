import {modelPresentation} from '../model-presentation.mjs';
let presentationMarket='all',commercialPrimeIds=[];
// Appended only to the embedded map module by the local preview server.
// Model placements remain owned by the supplied map, including saved offsets.
const breathingBases=new WeakMap();
const breatheMotion=matchMedia('(prefers-reduced-motion: reduce)');
let lampFlareTexture;
function installLampFlares(asset){
 if(asset.nexusFlares)return;
 asset.nexusFlares=[];
 if(!lampFlareTexture){const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const c=canvas.getContext('2d'),g=c.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'#fff9e9');g.addColorStop(.08,'#ffe8bdcc');g.addColorStop(.3,'#f5c58444');g.addColorStop(1,'#edc79300');c.fillStyle=g;c.fillRect(0,0,64,64);lampFlareTexture=new THREE.CanvasTexture(canvas);}
 const lamps=[];asset.model.updateMatrixWorld(true);
 asset.model.traverse(mesh=>{if(mesh.isMesh&&/Nexus lamp/i.test(mesh.material?.name||''))lamps.push(mesh);});
 for(const mesh of lamps){
  if(!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();
  const center=mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
  const count=mesh.isInstancedMesh?mesh.count:1;
  for(let i=0;i<count&&asset.nexusFlares.length<16;i++){
   const point=center.clone();if(mesh.isInstancedMesh){const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);point.applyMatrix4(matrix);}point.applyMatrix4(mesh.matrixWorld);asset.model.worldToLocal(point);
   const material=new THREE.SpriteMaterial({map:lampFlareTexture,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthTest:true,depthWrite:false,toneMapped:false});
   const flare=new THREE.Sprite(material);flare.name='Nexus existing lamp halo';flare.position.copy(point);flare.scale.set(1.8,1.8,1);asset.model.add(flare);asset.nexusFlares.push(flare);
  }
 }
}
export const nexusModels = {
  async prewarm(){
    // Warm the arrival chunk, not every parsed model on the island.
    const bounds=map.getBounds(),center=map.getCenter();
    const required=assets.filter(a=>a===active||bounds.contains(coordinates(a.placement.east,a.placement.north,a.origin))).sort((a,b)=>a===active?-1:b===active?1:Math.hypot(a.origin[0]-center.lng,a.origin[1]-center.lat)-Math.hypot(b.origin[0]-center.lng,b.origin[1]-center.lat)).slice(0,6);
    arrivalPreload=new Set(required);
    loadNearby();
    await new Promise(resolve=>{const poll=setInterval(()=>{if(required.every(a=>a.model||a.failedAt)){clearInterval(poll);resolve();}},150);});
    await Promise.all(required.map(a=>a.compiled));
    arrivalPreload=null;
    return {loaded:required.filter(a=>a.model).length,total:required.length};
  },
  setMarket(market,commercialIds=[]){
    presentationMarket=market||'all';commercialPrimeIds=commercialIds;
    for(const asset of assets){
      const policy=modelPresentation(asset,presentationMarket,commercialPrimeIds);
      asset.nexusPrime=policy.prime;
      for(const part of asset.parts||[]){part.node.userData.nexusMuted=policy.mutedParts.includes(part.id);part.node.traverse(o=>{if(o.isMesh&&o.userData.nexusOwnMaterials)for(const m of Array.isArray(o.material)?o.material:[o.material])m.userData.nexusMuted=part.node.userData.nexusMuted;});}
    }
    for(const asset of assets)if(asset.model){asset.materials=new Set();asset.model.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])asset.materials.add(m);});}
    updateLighting();
    for(const asset of assets)for(const part of asset.parts||[])if(part.node.userData.nexusMuted){
      part.node.traverse(mesh=>{if(!mesh.isMesh)return;
        if(!mesh.userData.nexusOwnMaterials){mesh.material=Array.isArray(mesh.material)?mesh.material.map(m=>m.clone()):mesh.material.clone();mesh.userData.nexusOwnMaterials=true;}
        for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material]){if(/water|pool|plant|foliage/i.test(m.name))continue;m.userData.nexusMuted=true;m.color?.set('#344653');if(m.emissiveIntensity!==undefined)m.emissiveIntensity=.008;}
      });
    }
  },
  snapshot() {
    return assets.map(asset => ({
      ids: asset.ids,
      name: asset.name,
      key: asset.key,
      coordinates: coordinates(asset.placement.east, asset.placement.north, asset.origin),
      zoom: asset.zoom,
      bearing: asset.viewBearing ?? 20,
      ready: Boolean(asset.model)
    }));
  },
  prepare(id) { select(id, false); },
  illuminate() {
    for(const asset of assets){
      const model=asset.model;if(!model)continue;
      let base=breathingBases.get(model);
      if(!base){const bounds=new THREE.Box3().setFromObject(model);base={scale:model.scale.y,y:model.position.y,floor:bounds.min.y};breathingBases.set(model,base);}
      installLampFlares(asset);
      const activity=windowActivity(Number($('timeSlider')?.value??13));
      for(const flare of asset.nexusFlares){flare.visible=activity>.01;flare.material.opacity=Math.min(.62,activity*.6);}
      // 0.14% vertical breathing, anchored at the foundation. No change to map placement.
      const wave=breatheMotion.matches?0:(1-Math.cos(performance.now()/1000*Math.PI*2/7.4+asset.ids[0]*.73))*.5;
      const factor=1+wave*.0014;model.scale.y=base.scale*factor;model.position.y=base.y+(base.floor-base.y)*(1-factor);
    }
    // A restrained architectural fill; original facade/window lighting still owns the day cycle.
    for (const asset of assets) for (const material of asset.materials || []) {
      if (!material.emissive || material.userData.exteriorBeam || !/stone|limestone|concrete|facade/i.test(material.name)) continue;
      material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, .018);
    }
  }
};

document.addEventListener('nexus-model-loaded',()=>nexusModels.setMarket(presentationMarket,commercialPrimeIds));
