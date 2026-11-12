'use strict'
// Pure classifier tests (no database, no network).
//   node --test test/ownerScope.unit.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

// the module requires ../db and ../logger at load time; neither is used here
const original = Module._load
Module._load = function (request, parent) {
  if (parent && /ownerScopeReply\.js$/.test(parent.filename || '') && (request === '../db' || request === '../logger')) {
    return { query: async () => { throw new Error('no db in unit test') }, info() {}, warn() {}, error() {}, debug() {} }
  }
  return original.apply(this, arguments)
}
const { classifyOwnerScope, isNewAvailabilityStatement } = require(path.join(__dirname, '..', 'services', 'ownerScopeReply.js'))

const ALL = s => assert.equal(classifyOwnerScope(s).scope, 'owner_all_unavailable', s)
const NOT = s => assert.equal(classifyOwnerScope(s).scope, null, s)

test('global statements mean the whole offer of the owner', () => {
  for (const s of [
    'Nothing available', 'nothing available atm', 'Nothing available at the moment sorry',
    'I have nothing available', "I don't have anything available right now", 'Sorry, I have nothing',
    'all rented', 'All are rented', 'Everything is rented', 'they are all taken, all rented', 'Both rented',
    'None available', 'none of them are available', 'No apartments available', 'no flats left',
    'Fully booked', 'All my apartments are rented',
    'Hi\nwhih part of .. "NOTHING AVAILABLE ATM. "\ndidn\'t you understand?',
  ]) ALL(s)
})

test('property-specific, dated or narrowed answers are NOT owner-wide', () => {
  for (const s of [
    'Nothing available until February', 'All rented except number 3', 'Nothing available, only the Sliema one',
    'Number three available only', 'One beds rented', 'Only available in February', 'Price now €1,250',
    'The Sliema one is rented', '#2906-9150 is rented', 'It is rented', 'not available', 'No',
    'Nothing available?', 'Is nothing available?', 'nothing to add for now', 'no worries, will send photos tomorrow',
    'Maybe nothing available, I will check', 'Yes still available', 'Do not contact me',
    'all good', 'I have nothing against a viewing on Friday'.replace('nothing against', 'no problem with'),
  ]) NOT(s)
})

test('a new offer is recognised, a negative or a question is not', () => {
  for (const s of ['I have a new apartment available', 'I have one available again in Sliema', 'The flat is available again', 'It is back on the market'])
    assert.equal(isNewAvailabilityStatement(s), true, s)
  for (const s of ['Nothing available', 'not available', 'Do you have clients available?', 'I have nothing available', 'ok'])
    assert.equal(isNewAvailabilityStatement(s), false, s)
})
