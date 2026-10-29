import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const matrixMap=readFileSync(new URL('../public/Link/map-view/index.html',import.meta.url),'utf8');
const mobileMap=readFileSync(new URL('../public/Link/Nexus-3D-Map/index.html',import.meta.url),'utf8');
const surface=readFileSync(new URL('../public/Link/nexus-surface.js',import.meta.url),'utf8');

test('all Nexus map entry points use the dark Mapbox basemap',()=>{
 for(const html of [matrixMap,mobileMap]){
  assert.match(html,/mapbox:\/\/styles\/mapbox\/dark-v11/);
  assert.doesNotMatch(html,/mapbox:\/\/styles\/mapbox\/light-v11/);
  assert.match(html,/nexus-surface\.js\?v=dark-20261030/);
 }
});

test('daytime themes remain dark graphite instead of returning to pale plastic surfaces',()=>{
 for(const color of ['#18232a','#1b272e','#1d2930','#172129','#0d171f'])assert.match(surface,new RegExp(color,'i'));
 assert.doesNotMatch(surface,/#(?:9badab|adbdb8|a8bab4|8d9694|4b5a61)/i);
 assert.match(surface,/saturation:\.78,contrast:1\.08,brightness:p\.brightness/);
});
