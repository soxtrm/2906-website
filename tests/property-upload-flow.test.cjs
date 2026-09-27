const assert = require('assert')
const fs = require('fs')

const source = fs.readFileSync('app/crm/property/new/page.tsx', 'utf8')
assert.match(source, /router\.replace\(`\/crm\/property\/\$\{r\.id\}`\)/)
assert.doesNotMatch(source, /router\.replace\(`\/property\/\$\{r\.id\}`\)/)
for (const label of ['CRM record', 'Agent Board', 'Website status', 'Facebook status', 'Owner groups', 'Client matching']) {
  assert.ok(source.includes(label), `missing upload destination ${label}`)
}
console.log('PASS: canonical property upload returns to CRM and exposes downstream channel states')
