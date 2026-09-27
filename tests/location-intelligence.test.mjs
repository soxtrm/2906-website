import assert from 'node:assert/strict';
import {buildLocationIntelligence,mapPosition,placeTravelEvidence,propertyLocationPrecision,SEARCH_RADII} from '../public/link-marketplace/location-intelligence.mjs';

const property={id:'2906-test',coordinates:[14.5,35.91],locationDisclosure:'approximate'};
const records=[
  {id:'beach',name:'Public Beach',kind:'beach',coordinates:[14.501,35.91]},
  {id:'shop',name:'Daily Market',kind:'grocery',coordinates:[14.502,35.91]},
  {id:'gym',name:'Public Gym',kind:'gym',coordinates:[14.503,35.91],routeVerified:true,walkingSeconds:420,drivingSeconds:180},
  {id:'far',name:'Far Away',kind:'restaurant',coordinates:[15.1,36.4]}
];

const intelligence=buildLocationIntelligence(property,records);
assert.equal(propertyLocationPrecision(property),'APPROXIMATE');
assert.equal(intelligence.places.length,3);
assert.equal(intelligence.connectors.find(item=>item.key==='swimming').places[0].name,'Public Beach');
assert.equal(intelligence.connectors.find(item=>item.key==='daily').places[0].name,'Daily Market');
assert.equal(intelligence.routeEvidence,1);
assert.deepEqual(SEARCH_RADII,[250,500,1000,2000,5000]);
assert.equal(intelligence.connectors.find(item=>item.key==='daily').places[0].connection.origin_id,'2906-test');
assert.equal(intelligence.connectors.find(item=>item.key==='daily').places[0].connection.straight_line_m>0,true);
assert.deepEqual(placeTravelEvidence(records[0]),{walk:'UNKNOWN',drive:'UNKNOWN',confidence:'UNKNOWN'});
assert.deepEqual(placeTravelEvidence(records[2]),{walk:'7 min',drive:'3 min',confidence:'LIVE / ROUTED'});
assert.deepEqual(placeTravelEvidence({walkableRoute:true,walkingDistanceMetres:500}),{walk:'7 min',drive:'UNKNOWN',confidence:'MODELLED · 4.5 KM/H'});
assert.deepEqual(mapPosition(property.coordinates,property.coordinates),{x:50,y:50});
assert.equal(propertyLocationPrecision({coordinates:null,locationDisclosure:'exact'}),'AREA_ONLY');
console.log('property location intelligence passed');
