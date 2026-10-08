import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOutreachCountDraft } from '../lib/crm/outreach-count.ts'

test('keeps the previous valid value for an empty or invalid draft', () => {
  assert.equal(normalizeOutreachCountDraft('', 10, 50), 10)
  assert.equal(normalizeOutreachCountDraft('abc', 23, 50), 23)
})

test('accepts complete numeric drafts and preserves the existing range', () => {
  assert.equal(normalizeOutreachCountDraft('23', 10, 50), 23)
  assert.equal(normalizeOutreachCountDraft('30', 10, 50), 30)
  assert.equal(normalizeOutreachCountDraft('0', 10, 50), 1)
  assert.equal(normalizeOutreachCountDraft('51', 10, 50), 50)
})
