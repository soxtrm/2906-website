'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseUploadCommand,
  stripUploadCommands,
  groupCommandDedupKey,
  uploadEventDedupKey,
} = require('../services/gptUploadCommand')

test('legacy !upload digit semantics are preserved', () => {
  for (let digit = 1; digit <= 9; digit += 1) {
    assert.deepEqual(parseUploadCommand(`!upload${digit}`), { variantSuffix: String(digit), intakeMode: null, photoMode: null })
  }
  assert.deepEqual(parseUploadCommand('!upload'), { variantSuffix: '', intakeMode: null, photoMode: null })
  assert.deepEqual(parseUploadCommand('!upload 4835'), { variantSuffix: '', intakeMode: null, photoMode: null })
})

test('gpt variants accept compact and spaced digits with identical suffix', () => {
  assert.deepEqual(parseUploadCommand('!gptupload4 force'), { variantSuffix: '4', intakeMode: null, photoMode: 'pimp' })
  assert.deepEqual(parseUploadCommand('!gptupload 4 group'), { variantSuffix: '4', intakeMode: null, photoMode: 'pimp' })
  assert.deepEqual(parseUploadCommand('!gptuploadv9'), { variantSuffix: '9', intakeMode: null, photoMode: 'vision' })
  assert.deepEqual(parseUploadCommand('!gptuploadv 9 noad'), { variantSuffix: '9', intakeMode: null, photoMode: 'vision' })
})

test('other upload commands do not collide', () => {
  assert.equal(parseUploadCommand('!uploadlisting'), null)
  assert.equal(parseUploadCommand('!uploadstatus 2906-1'), null)
})

test('command is removed while listing text remains', () => {
  assert.equal(stripUploadCommands('Apartment Sliema\n!gptuploadv 9 force group'), 'Apartment Sliema\n')
})

test('all group commands have one cross-session logical key', () => {
  for (const command of ['!gptupload6', '!ask 9454 client details', '!av 9430', '!book 9430']) {
    const a = groupCommandDedupKey({ chatId: 'team@g.us', timestamp: 1792018932, text: command })
    const b = groupCommandDedupKey({ chatId: 'team@g.us', timestamp: 1792018932000, text: `  ${command.toUpperCase()}  ` })
    assert.equal(a, b)
    assert.match(a, /^group-command:/)
  }
})

test('confirmation replies are deduplicated but normal group chat is not', () => {
  const input = { chatId: 'team@g.us', actorId: 'agent@lid', timestamp: 1792018932 }
  assert.match(groupCommandDedupKey({ ...input, text: 'Yes' }), /^group-command:/)
  assert.notEqual(
    groupCommandDedupKey({ ...input, text: 'Yes' }),
    groupCommandDedupKey({ ...input, actorId: 'other-agent@lid', text: 'Yes' }),
  )
  assert.equal(groupCommandDedupKey({ ...input, text: 'ordinary message' }), null)
})

test('legacy upload-only key remains compatible', () => {
  assert.match(uploadEventDedupKey({ chatId: 'team@g.us', timestamp: 1792018932, text: '!gptupload6' }), /^group-command:/)
  assert.equal(uploadEventDedupKey({ chatId: 'team@g.us', timestamp: 1792018932, text: '!ask 9454' }), null)
})
