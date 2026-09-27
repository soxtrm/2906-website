'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const source = fs.readFileSync('app/crm/schedule-board/page.tsx', 'utf8')

test('admin card explains why owner contact is locked', () => {
  assert.match(source, /data-contact-block-reason/)
  assert.match(source, /Why this action is locked/)
  assert.match(source, /Last contact/)
})

test('admin menu exposes unit copy and owner contact controls', () => {
  assert.match(source, /Copy unit/)
  assert.match(source, /Block owner/)
  assert.match(source, /Pause 24h/)
  assert.match(source, /DuplicateUnitDialog/)
})

test('multi-unit stock is visible on every grouped card', () => {
  assert.match(source, /data-unit-stock/)
  assert.match(source, /units\.available/)
  assert.match(source, /units\.total/)
})
