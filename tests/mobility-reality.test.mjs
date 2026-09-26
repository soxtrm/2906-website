import assert from 'node:assert/strict';
import {buildMobilityReality,modeOrder,normalizeMobilityObservation} from '../public/Link/mobility-reality.mjs';

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
assert.equal(unknown.monthly.money.length,0);

assert.equal(normalizeMobilityObservation({originArea:'A',destinationArea:'B',outcome:'rejected'}).outcome,'unknown');
console.log('mobility reality tests passed');
