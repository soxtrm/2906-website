'use strict';
function routeSegments(route) {
  const steps = (route?.legs || []).flatMap(leg => leg.steps || []);
  const ferries = steps.filter(step => step.mode === 'ferry').map(step => ({
    name: step.name || 'Ferry crossing',
    durationSeconds: Number.isFinite(step.duration) ? step.duration : null,
    distanceMetres: Number.isFinite(step.distance) ? step.distance : null,
  }));
  return { includesFerry: ferries.length > 0, ferries, ferrySchedule: 'UNKNOWN', ferryWaitSeconds: null };
}
module.exports = { routeSegments };
