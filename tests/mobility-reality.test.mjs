import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildMobilityReality,MALTA_OVERVIEW_ANCHORS,modeOrder,normalizeMobilityObservation} from '../public/Link/mobility-reality.mjs';

assert.deepEqual(modeOrder('bus'),['bus','bolt','walk','car']);
assert.deepEqual(modeOrder('car'),['car','bolt','bus','walk']);

const property={area:'Mellieħa',mobilityObservations:[
 {originArea:'Mellieħa',destinationArea:'Sliema',direction:'outbound',weekday:1,hour:18,season:'summer',durationMinutes:33,quotedPrice:12,pickupMinutes:7,outcome:'accepted'},
 {originArea:'Mellieha',destinationArea:'Sliema',direction:'outbound',weekday:2,hour:18,season:'summer',durationMinutes:41,actualPrice:16,pickupMinutes:11,outcome:'cancelled'}
]};
const profile={transport:'bus',anchors:[{type:'work',person:'You',location:'Sliema',days:5,time:'18:00'}]};
const [journey]=buildMobilityReality(property,profile);
assert.equal(journey.modes[0].mode,'bus');
assert.equal(journey.modes.length,4);
assert.equal(journey.modes[0].confidence,'LOCAL PRIOR');
assert.match(journey.modes[0].warning,/High crowding risk/);
assert.equal(journey.modes[1].mode,'bolt');
assert.equal(journey.modes[1].confidence,'OBSERVED');
assert.match(journey.modes[1].cost,/expected/);
assert.equal(Math.round(journey.journeysPerMonth),43);
assert.equal(journey.monthly.money.length,1);
assert.equal(journey.monthly.time.length,1);

const unknown=buildMobilityReality({area:'Rabat'},{transport:'walk',anchors:[{type:'work',person:'You',location:'Mosta',days:3,time:'09:00'}]})[0];
assert.equal(unknown.modes[0].time,'UNKNOWN');
assert.equal(unknown.modes[0].confidence,'UNKNOWN');

const overview=buildMobilityReality({area:'Sliema',coordinates:[14.50,35.91]},{transport:null,anchors:[]});
assert.equal(overview.length,6);
assert.deepEqual(overview.map(item=>item.anchor.location),MALTA_OVERVIEW_ANCHORS.map(item=>item.location));
assert.ok(overview.every(item=>item.anchor.overview===true));
assert.equal(buildMobilityReality({area:'Victoria',island:'GOZO',coordinates:[14.24,36.04]},{transport:null,anchors:[]}).length,0);
assert.equal(buildMobilityReality({area:'Sliema'},{transport:null,anchors:[{type:'gym',location:'A gym'}]}).length,1);
assert.equal(unknown.monthly.money.length,0);

assert.equal(normalizeMobilityObservation({originArea:'A',destinationArea:'B',outcome:'rejected'}).outcome,'unknown');
const paid=buildMobilityReality({area:'Swieqi',mobilityObservations:[{originArea:'Swieqi',destinationArea:'Kalkara',direction:'outbound',durationMinutes:25,actualPrice:33.88,additionalCharges:.62,totalPaid:34.5,outcome:'accepted'}]},{transport:'bolt',anchors:[{type:'work',person:'You',location:'Kalkara',days:1,time:'11:00'}]})[0];
assert.equal(paid.modes[0].costExpected,34.5);
assert.equal(paid.modes[0].costDetail.low,null);
const registry=JSON.parse(readFileSync(new URL('../public/Link/mobility-observations.json',import.meta.url),'utf8'));
assert.equal(registry.observations.length,5);
assert.ok(registry.observations.every(item=>!('address' in item)&&!('driverName' in item)));
assert.equal(registry.observations[0].actualPrice,null);
console.log('mobility reality tests passed');
