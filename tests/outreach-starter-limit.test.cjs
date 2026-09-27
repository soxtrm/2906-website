const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'crm', 'outreach', 'page.tsx'), 'utf8')

test('outreach planner exposes a ten-contact starter ceiling', () => {
  assert.match(page, /OUTREACH_STARTER_BATCH_MAX = 10/)
  assert.match(page, /max=\{OUTREACH_STARTER_BATCH_MAX\}/)
  assert.match(page, /starter_batch_limit/)
})

test('saved automatic counts are clamped before list generation', () => {
  assert.match(page, /Math\.min\(OUTREACH_STARTER_BATCH_MAX, last\?\.count/)
  assert.match(page, /Math\.min\(OUTREACH_STARTER_BATCH_MAX, overrideCount \?\? count\)/)
})
