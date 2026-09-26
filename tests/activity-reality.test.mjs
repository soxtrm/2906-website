import assert from 'node:assert/strict';
import {activityPulse,localitySafety,radiusSafety,takeawaySitePotential} from '../public/Link/activity-reality.mjs';

const origin=[14.5,35.9];
const records=Array.from({length:12},(_,index)=>({
  id:`place-${index}`,
  name:`Place ${index}`,
  category:index<7?'restaurants':index<10?'nightlife':'parks',
  coordinates:[14.5+index*.00025,35.9]
}));

const pulse=activityPulse(origin,records,{radius:1000});
assert.ok(pulse.score>50);
assert.equal(pulse.count,12);
assert.match(pulse.residential,/Lively|Balanced/);
assert.match(pulse.commercial,/mapped venue-density/);

const stJulians=localitySafety("St Julian's",{market:'longlets'});
assert.equal(stJulians.overall.key,'two_to_five');
assert.equal(stJulians.lens.key,'two_to_five');
const commercial=localitySafety('Paceville',{market:'commercials'});
assert.equal(commercial.overall.key,'two_to_five');
assert.equal(commercial.lens.key,'five_plus');
assert.equal(localitySafety('A made-up block').overall.key,'unknown');

assert.equal(radiusSafety(origin,[],{radius:500}).status,'UNKNOWN');
const radius=radiusSafety(origin,[{coordinates:[14.5001,35.9],source:'official fixture',year:2025}],{radius:500});
assert.equal(radius.status,'KNOWN');
assert.equal(radius.count,1);

const delivery=takeawaySitePotential(origin,records,{});
assert.equal(delivery.status,'UNKNOWN');
assert.deepEqual(delivery.missing,['time-banded traffic','delivery demand','courier pickup and completion']);
assert.equal(delivery.restaurantCount,7);
console.log('activity reality tests passed');
