const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'crm', 'outreach', 'page.tsx'), 'utf8')

test('outreach planner keeps ten as the default while accepting exact targets up to 45', () => {
  assert.match(page, /OUTREACH_DEFAULT_COUNT = 10/)
  assert.match(page, /OUTREACH_LIST_MAX = 45/)
  assert.match(page, /starter_batch_limit/)
})

test('automatic preparation uses the operator target exactly and replaces the preview', () => {
  assert.match(page, /const seedCount = commitCountDraft\(\)/)
  assert.match(page, /count: seedCount, topUp: false/)
})
