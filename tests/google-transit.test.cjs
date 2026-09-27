const assert=require('node:assert/strict');
const {normalizeTransit,transitRoute}=require('../ops/property-routing/google-transit.cjs');
const result=normalizeTransit({routes:[{duration:'1800s',distanceMeters:8000,legs:[{steps:[{travelMode:'WALK',staticDuration:'300s'},{travelMode:'TRANSIT',transitDetails:{transitLine:{nameShort:'13',vehicle:{type:'BUS'}}}},{travelMode:'TRANSIT'},{travelMode:'WALK',staticDuration:'120s'}]}],travelAdvisory:{transitFare:{currencyCode:'EUR',units:'2',nanos:500000000}}}]});
assert.equal(result.durationMinutes,30);assert.equal(result.walkingMinutes,7);assert.equal(result.transfers,1);assert.equal(result.cost,2.5);assert.equal(result.reliability,'UNKNOWN');assert.equal(result.confidence,'MODELLED');assert.equal(result.frequencyMinutes,null);
assert.equal(normalizeTransit({}).reason,'NO_TRANSIT_ROUTE');
assert.equal(normalizeTransit({routes:[{legs:[{steps:[{travelMode:'WALK'}]}]}]}).reason,'NO_TRANSIT_LEG');
assert.equal(normalizeTransit({routes:[{legs:[{steps:[{travelMode:'TRANSIT'},{travelMode:'WALK'}]}]}]}).walkingMinutes,null);
(async()=>{let body;await transitRoute([14.5,35.9],[14.51,35.89],{key:'fixture-only',fetcher:async(url,options)=>{body=JSON.parse(options.body);return{ok:true,json:async()=>({})}}});assert.equal(body.travelMode,'TRANSIT');assert.deepEqual(body.transitPreferences.allowedTravelModes,['BUS']);assert.equal(body.routingPreference,undefined);console.log('Transit normalization and request fixtures passed');})().catch(e=>{console.error(e);process.exitCode=1});
