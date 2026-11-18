// node --test lib/owner/engine.test.ts   (Node 24 strips the types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsFor, slotsFor, act, competing, modeSwitchCheck, recipients, revokedBy, confirmedClash } from './engine.ts'
import type { AvailabilityRule, AvailabilityException, ViewingRequest, Property, Distribution, Agency } from './model.ts'

const rules: AvailabilityRule[] = [
  { id: 'r1', propertyId: 1, weekday: 1, start: '16:00', end: '19:00', slotMinutes: 30 }, // Monday
  { id: 'r2', propertyId: 1, weekday: 3, start: '10:00', end: '13:00', slotMinutes: 30 }, // Wednesday
]
const ex: AvailabilityException[] = [
  { id: 'e1', propertyId: 1, date: '2026-11-30', kind: 'blocked', start: '17:00', end: '18:00' },
  { id: 'e2', propertyId: 1, date: '2026-12-07', kind: 'blocked' },
  { id: 'e3', propertyId: 1, date: '2026-12-05', kind: 'extra', start: '11:00', end: '12:00' },
]
const base = (o: Partial<ViewingRequest>): ViewingRequest => ({
  id: 'q', propertyId: 1, start: '2026-11-30T16:00', minutes: 30, status: 'awaiting_owner', source: 'argus_crm',
  requester: { kind: 'agent', agencyId: 'a1', clientRef: 'C-1' }, applicant: { adults: 2, children: 0, moveIn: '2026-12-01', months: 12 },
  history: [], ...o,
})
const ctx = (all: ViewingRequest[], actor: 'owner' | 'agent' = 'owner') => ({ all, rules, exceptions: ex, now: '2026-11-28T09:00', actor })

test('weekly windows, partial block splits, full block removes, extra adds', () => {
  assert.deepEqual(windowsFor(rules, ex, 1, '2026-11-30').map(w => `${w.start}-${w.end}`), ['16:00-17:00', '18:00-19:00'])
  assert.equal(windowsFor(rules, ex, 1, '2026-12-07').length, 0)
  assert.deepEqual(windowsFor(rules, ex, 1, '2026-12-05').map(w => w.source), ['extra'])
  assert.deepEqual(slotsFor(rules, ex, 1, '2026-12-02'), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30'])
})

test('accept confirms; a second overlapping accept is refused (no double booking)', () => {
  const a = base({ id: 'a' }), b = base({ id: 'b', start: '2026-11-30T16:15' })
  const r1 = act(a, { type: 'accept' }, ctx([a, b]))
  assert.ok(r1.ok && r1.request.status === 'confirmed')
  const all = [r1.ok ? r1.request : a, b]
  const r2 = act(b, { type: 'accept' }, ctx(all))
  assert.equal(r2.ok, false)
})

test('whole-property viewing clashes with a room viewing; two different rooms do not', () => {
  const whole = base({ id: 'w', status: 'confirmed' })
  const room = base({ id: 'r', roomId: '1-R1' })
  assert.ok(confirmedClash([whole, room], room))
  const roomA = base({ id: 'ra', roomId: '1-R1', status: 'confirmed' })
  const roomB = base({ id: 'rb', roomId: '1-R2' })
  assert.equal(confirmedClash([roomA, roomB], roomB), null)
})

test('propose only inside viewing hours and not on a taken slot', () => {
  const r = base({ id: 'p' })
  assert.equal(act(r, { type: 'propose', start: '2026-11-30T20:00' }, ctx([r])).ok, false)
  assert.equal(act(r, { type: 'propose', start: '2026-11-30T17:30' }, ctx([r])).ok, false) // blocked hour
  const ok = act(r, { type: 'propose', start: '2026-12-02T11:00' }, ctx([r]))
  assert.ok(ok.ok && ok.request.status === 'new_time_proposed')
  if (ok.ok) {
    const back = act(ok.request, { type: 'accept_proposal' }, ctx([ok.request], 'agent'))
    assert.ok(back.ok && back.request.status === 'confirmed' && back.request.start === '2026-12-02T11:00')
  }
})

test('agents cannot confirm; owners cannot answer for the agent; terminal states stay terminal', () => {
  const r = base({})
  assert.equal(act(r, { type: 'accept' }, ctx([r], 'agent')).ok, false)
  const d = act(r, { type: 'decline' }, ctx([r]))
  assert.ok(d.ok)
  if (d.ok) assert.equal(act(d.request, { type: 'accept' }, ctx([d.request])).ok, false)
})

test('competing requests for one slot are listed separately', () => {
  const a = base({ id: 'a' }), b = base({ id: 'b', start: '2026-11-30T16:00', requester: { kind: 'tenant', clientRef: 'N-9' } })
  assert.deepEqual(competing([a, b], a).map(x => x.id), ['b'])
})

test('mode switch is blocked by occupied rooms and an active tenancy', () => {
  const p = { id: 1, mode: 'rooms', rooms: [{ id: '1-R1', label: 'Room 1', status: 'occupied', occupiedUntil: '2027-03-01' }], tenancyUntil: undefined } as unknown as Property
  assert.equal(modeSwitchCheck(p, 'long_let', [], '2026-11-28')[0].level, 'block')
  const q = { ...p, rooms: [], tenancyUntil: '2027-01-31', mode: 'long_let' } as unknown as Property
  assert.equal(modeSwitchCheck(q, 'sale', [], '2026-11-28')[0].level, 'block')
})

test('distribution: exclusive limits recipients; private hides; revoking lists who must delist', () => {
  const agencies: Agency[] = [{ id: 'a1', name: 'Agency A', approved: true, agents: [] }, { id: 'a2', name: 'Agency B', approved: true, agents: [{ id: 'g1', name: 'Mark' }] }]
  const open: Distribution = { nexusDirect: true, argusB2B: true, allApprovedAgencies: true, agencyIds: [], agentIds: [], exclusive: null, private: false }
  assert.equal(recipients(open, agencies, '2026-11-28').length, 4)
  const excl: Distribution = { ...open, exclusive: { agencyId: 'a1', until: '2026-12-28', thenRelease: 'all_approved' } }
  assert.deepEqual(recipients(excl, agencies, '2026-11-28').map(r => r.agencyId || r.channel), ['a1', 'NEXUS Direct'])
  assert.equal(recipients(excl, agencies, '2026-12-29').length, 4) // exclusivity over
  assert.equal(recipients({ ...open, private: true }, agencies, '2026-11-28').length, 0)
  assert.deepEqual(revokedBy(open, excl, agencies, '2026-11-28').map(r => r.agencyId || r.channel).sort(), ['ARGUS agent network', 'a2'])
})
