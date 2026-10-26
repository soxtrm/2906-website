const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const component = fs.readFileSync(path.join(__dirname, '..', 'components', 'property-life-overview.tsx'), 'utf8')

assert.match(component, /walkingDetailVerified/)
assert.match(component, /mapped route/)
assert.match(component, /Walk \+ ferry/)
assert.match(component, /ROUTE SUMMARY ONLY · SELECT WALK TO CHECK FERRY/)
assert.match(component, /safeRouteGeometry/)
assert.match(component, /maxGap > 500/)
assert.match(component, /Official ferry corridor/)
assert.match(component, /Check the operator timetable/)
assert.match(component, /knownFerryEvidence/)
assert.match(component, /Tas-Sliema|tas-sliema/i)
assert.doesNotMatch(component, /`\$\{minutes\(routes\[p\.id\]\?\.walkingSeconds\)\} walk`/)

console.log('property route ferry presentation contract passed')
