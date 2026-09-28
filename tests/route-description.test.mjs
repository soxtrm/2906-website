import assert from 'node:assert/strict';
import {routeDescription} from '../public/link-marketplace/route-description.mjs';
assert.match(routeDescription({includesFerry:true,ferries:[{name:'Sliema ferry'}]}),/Walk \+ ferry.*Sliema ferry/);
assert.match(routeDescription({includesFerry:true},'car'),/Drive \+ ferry.*waiting time and fare not verified/);
assert.doesNotMatch(routeDescription({includesFerry:false}),/\+ ferry/);
assert.doesNotMatch(routeDescription({}),/\+ ferry/);
console.log('Ferry route description checks passed');
