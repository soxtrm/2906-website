'use strict';
const VERIFIED_FERRY_CORRIDORS = [
  {
    pattern: /tas-sliema\s*-\s*marsamxett|sliema\s*-\s*valletta/i,
    corridor: 'Sliema–Valletta',
    authorityUrl: 'https://www.transport.gov.mt/maritime/local-waters/passenger-transport-by-sea/ferry-service-grand-harbour-marsamxett-110',
    operatorScheduleUrl: 'https://www.vallettaferryservices.com/schedule/',
    verifiedOn: '2026-10-26',
  },
];

function ferryEvidence(name) {
  const match = VERIFIED_FERRY_CORRIDORS.find(item => item.pattern.test(String(name || '')));
  return match ? {
    status: 'OFFICIAL_CORRIDOR',
    corridor: match.corridor,
    authorityUrl: match.authorityUrl,
    operatorScheduleUrl: match.operatorScheduleUrl,
    verifiedOn: match.verifiedOn,
  } : {
    status: 'ROUTED_ONLY',
    corridor: null,
    authorityUrl: null,
    operatorScheduleUrl: null,
    verifiedOn: null,
  };
}

function routeSegments(route) {
  const steps = (route?.legs || []).flatMap(leg => leg.steps || []);
  const ferries = steps.filter(step => step.mode === 'ferry').map(step => ({
    name: step.name || 'Ferry crossing',
    durationSeconds: Number.isFinite(step.duration) ? step.duration : null,
    distanceMetres: Number.isFinite(step.distance) ? step.distance : null,
    evidence: ferryEvidence(step.name),
  }));
  return {
    includesFerry: ferries.length > 0,
    ferries,
    ferryEvidenceStatus: ferries.length && ferries.every(item => item.evidence.status === 'OFFICIAL_CORRIDOR') ? 'OFFICIAL_CORRIDOR' : ferries.length ? 'ROUTED_ONLY' : 'NONE',
    ferrySchedule: 'LIVE_CHECK_REQUIRED',
    ferryWaitSeconds: null,
  };
}
module.exports = { ferryEvidence, routeSegments };
