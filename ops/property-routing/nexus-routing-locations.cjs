'use strict';
const db=require('/app/db');
db.query('SELECT p.ref,l.latitude,l.longitude,l.precision FROM nexus_property_locations l JOIN properties p ON p.id=l.property_id').then(result=>{process.stdout.write(JSON.stringify(result.rows.map(r=>({ref:r.ref,coordinates:[Number(r.longitude),Number(r.latitude)],precision:r.precision}))));process.exit(0)}).catch(()=>process.exit(1));
