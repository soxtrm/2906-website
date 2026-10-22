const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'crm', 'outreach', 'page.tsx'), 'utf8')
const planner = fs.readFileSync(path.join(__dirname, '..', 'ops', 'outreach-control', 'outreachPlanner.js'), 'utf8')

test('outreach planner retains account defaults while accepting targets up to 45', () => {
  assert.match(page, /account\.outreachAutoBaseCount \|\| defaultSeedCount\(account\)/)
  assert.match(page, /OUTREACH_LIST_MAX = 45/)
  assert.match(page, /starter_batch_limit/)
})

test('automatic preparation sends the operator base and persists the backend spread', () => {
  assert.match(page, /const seedCount = commitCountDraft\(\)/)
  assert.match(page, /baseCount: seedCount, message: seedText/)
  assert.match(planner, /resolvedBase \+ randomInt\(-3, 3\)/)
  assert.match(planner, /AUTO_DAILY_MINUTES_MIN = 16/)
  assert.match(planner, /AUTO_DAILY_MINUTES_MAX = 22/)
})

test('Argus 5 uses the same 45-contact plan ceiling as every outreach account', () => {
  assert.match(page, /const accountListMax = OUTREACH_LIST_MAX/)
  assert.match(planner, /function planLimit\(\) \{\s*return OUTREACH_PLAN_MAX\s*\}/)
  assert.doesNotMatch(planner, /NEXUSLINK_PLAN_MAX/)
})

test('five-day preparation supports manual checks and Auto checks all days', () => {
  assert.match(page, /Prepare free days/)
  assert.match(page, /setSelectedPrepareDays\(\[\.\.\.OUTREACH_DAY_LABELS\]\)/)
  assert.match(page, /labels: selectedLabels/)
  assert.match(planner, /selectedLabels && !selectedLabels\.has\(plan\.label\)/)
})
