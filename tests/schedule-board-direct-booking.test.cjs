'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'crm', 'schedule-board', 'page.tsx'),
  'utf8',
)

test('card and deep-link booking open the booking dialog directly', () => {
  const openBook = source.match(/const openBook = useCallback\(\(r: Listing\) => \{([\s\S]*?)\n  \}, \[\]\)/)
  assert.ok(openBook, 'openBook callback exists')
  assert.match(openBook[1], /setBooking\(r\)/)
  assert.doesNotMatch(openBook[1], /setDetail\(r\.ref\)/)
  assert.match(source, /if \(action === 'book'\) openBook\(row\)/)
  assert.match(source, /if \(action === 'book'\) openBook\(d\)/)
})

test('mobile cards do not animate or scrub photos while the user scrolls', () => {
  assert.match(source, /className=\{isMobile \? 'crm-listing-card' : 'crm-listing-card transition-transform/)
  assert.match(source, /onPointerMove=\{isMobile \? undefined : previewPhotoAtPointer\}/)
})
