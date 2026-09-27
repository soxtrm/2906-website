'use strict';
(async()=>{
 const inventory=await (await fetch('http://127.0.0.1:3001/api/nexus/inventory')).json();
 const refs=inventory.properties.filter(p=>p.listable===true&&Array.isArray(p.coordinates)).map(p=>p.id);
 let connected=0,unavailable=0,walking=0,driving=0;
 for(const ref of refs){try{const result=await (await fetch(`http://127.0.0.1:3012/?ref=${encodeURIComponent(ref)}`,{signal:AbortSignal.timeout(30000)})).json();if(result.status==='CONNECTED'){connected++;walking+=result.places.filter(p=>Number.isFinite(p.walkingSeconds)).length;driving+=result.places.filter(p=>Number.isFinite(p.drivingSeconds)).length;}else unavailable++;}catch{unavailable++;}}
 console.log(JSON.stringify({properties:refs.length,connected,unavailable,walking,driving,at:new Date().toISOString()}));
})();
