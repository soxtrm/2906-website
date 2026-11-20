// node --test lib/owner/identity.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backfill, checkCode, matchOwner, normalizePhone, ownerView, passwordProblems, type ArgusOwnerRecord } from './identity.ts'

test('phone numbers in every usual Malta spelling become one', () => {
  for (const x of ['+356 7900 1234', '0035679001234', '79001234', '+356-7900-1234']) assert.equal(normalizePhone(x), '35679001234')
  assert.equal(normalizePhone('+49 151 2345 6789'), '4915123456789')
  assert.equal(normalizePhone('123'), null)
})

const recs: ArgusOwnerRecord[] = [
  { contactId: 1, phone: '+356 7900 1234', name: 'Maria', propertyIds: [9001, 9002], internalNotes: 'difficult, never call before 10', rating: 'C', doNotContact: false },
  { contactId: 2, phone: '79001234', name: 'Maria B.', propertyIds: [9003] },
  { contactId: 3, phone: '+356 9900 0000', name: 'Someone else', propertyIds: [7000] },
]

test('a number links homes only after it was confirmed with the code', () => {
  assert.deepEqual(matchOwner(recs, '79001234', false), [])
  const m = matchOwner(recs, '+35679001234', true)
  assert.deepEqual(m.flatMap(x => x.propertyIds).sort(), [9001, 9002, 9003])
  assert.equal(matchOwner(recs, '+356 1111 1111', true).length, 0)
})

test('the owner never sees what ARGUS wrote about them', () => {
  const v = ownerView(recs[0]) as unknown as Record<string, unknown>
  assert.deepEqual(Object.keys(v).sort(), ['contactId', 'name', 'propertyIds'])
  assert.ok(!JSON.stringify(matchOwner(recs, '79001234', true)).includes('difficult'))
})

test('confirmation code: right, wrong, expired, locked', () => {
  const st = { phone: '35679001234', code: '482913', sentAt: 1000, tries: 0 }
  assert.equal(checkCode(st, '482 913', 2000), 'ok')
  assert.equal(checkCode(st, '000000', 2000), 'wrong')
  assert.equal(checkCode(st, '482913', 1000 + 11 * 60_000), 'expired')
  assert.equal(checkCode({ ...st, tries: 5 }, '482913', 2000), 'locked')
  assert.equal(checkCode(null, '1', 0), 'none')
})

test('passwords: long enough, letters and digits', () => {
  assert.ok(passwordProblems('short1').length)
  assert.deepEqual(passwordProblems('Sliema2024flat'), [])
  assert.ok(passwordProblems('mariagrech123', 'mariagrech@example.com').includes('not your email name'))
})

test('owner details fill only empty ARGUS fields; differences are flagged, not overwritten', () => {
  const r = backfill({ legalName: 'Maria Grech', address: '' }, { legalName: 'Maria Borg', address: '12 Tower Road', companyNumber: 'C 12345' })
  assert.deepEqual(r.fill, { address: '12 Tower Road', companyNumber: 'C 12345' })
  assert.deepEqual(r.conflicts, [{ field: 'legalName', argus: 'Maria Grech', owner: 'Maria Borg' }])
})

import { acceptWaVerify, parseWaVerify, waLink, waToken } from './identity.ts'

test('WhatsApp verification: the sender of the prepared message is the confirmed number', () => {
  const t = waToken(() => 0.5)
  assert.match(t, /^[A-Z2-9]{6}$/)
  assert.equal(parseWaVerify(`sync verify ${t.toLowerCase()}`), t)
  assert.equal(parseWaVerify('hello'), null)
  assert.equal(waLink('+356 2000 0000', t), `https://wa.me/35620000000?text=SYNC%20verify%20${t}`)
  const p = { token: t, createdAt: 1000, accountEmail: 'm@example.com' }
  assert.deepEqual(acceptWaVerify(p, '+356 7900 1234', `SYNC verify ${t}`, 2000), { ok: true, phone: '35679001234' })
  assert.deepEqual(acceptWaVerify(p, '+356 7900 1234', 'SYNC verify ZZZZZZ', 2000), { ok: false, reason: 'mismatch' })
  assert.deepEqual(acceptWaVerify(p, '+356 7900 1234', `SYNC verify ${t}`, 1000 + 16 * 60_000), { ok: false, reason: 'expired' })
  assert.deepEqual(acceptWaVerify(null, '+356 7900 1234', `SYNC verify ${t}`, 2000), { ok: false, reason: 'no_token' })
})
