// Synthetic demo owner for the local preview. No real owner, tenant or agency.
// Dates are relative to the preview's "today" so the calendar always has life.
import type {
  Agency, AvailabilityException, AvailabilityRule, DocumentItem, OwnerProfile, Property, Thread, ViewingRequest,
} from './model'
import { addDays, startOfWeek } from './engine'

const IMG = (f: string) => `/link-marketplace/assets/${f}`

export function maltaToday(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(d)
}

export function buildDemo(today = maltaToday()) {
  const mon = startOfWeek(today)
  const at = (offsetDays: number, hhmm: string) => `${addDays(today, offsetDays)}T${hhmm}`
  // next date after today on a weekday (0 = Sunday), so demo requests sit inside the viewing hours
  const next = (weekday: number, hhmm: string) => {
    for (let i = 1; i <= 7; i++) { const d = addDays(today, i); if (new Date(`${d}T12:00:00Z`).getUTCDay() === weekday) return `${d}T${hhmm}` }
    return `${addDays(today, 1)}T${hhmm}`
  }
  const now = `${today}T09:00`

  const agencies: Agency[] = [
    { id: 'ag-harbour', name: 'Harbour Homes', approved: true, agents: [{ id: 'gt-1', name: 'Daniel' }, { id: 'gt-2', name: 'Petra' }] },
    { id: 'ag-north', name: 'North Coast Lets', approved: true, agents: [{ id: 'gt-3', name: 'Luca' }] },
    { id: 'ag-valletta', name: 'Valletta Keys', approved: true, agents: [{ id: 'gt-4', name: 'Sara' }] },
    { id: 'ag-new', name: 'Island Nest', approved: false, agents: [{ id: 'gt-5', name: 'Omar' }] },
  ]

  const profile: OwnerProfile = {
    id: 'owner-demo',
    name: 'Maria',
    defaults: { nexusDirect: true, argusB2B: true, allApprovedAgencies: true, agencyIds: [], agentIds: [], exclusive: null, private: false },
    hidePriceFor: [],
    notify: { whatsapp: true, email: false, quietFrom: '21:00', quietTo: '08:00' },
    delegates: [{ name: 'Joseph (property manager)', role: 'manager', properties: [9001] }],
  }

  const properties: Property[] = [
    {
      id: 9001, ref: '2906-D901', name: 'Tower Road shared flat', address: 'Tower Road, Sliema', town: 'Sliema',
      photos: [IMG('sliema-harbour-promenade-frankbothe.webp'), IMG('gzira-promenade-baerwinkel-klaus.webp')],
      mode: 'rooms', modeHistory: [{ mode: 'long_let', from: '2023-02-01', to: '2025-08-31' }, { mode: 'rooms', from: '2025-09-01' }],
      bedrooms: 4, bathrooms: 2, sizeSqm: 128, listing: 'live',
      offers: [
        { id: 'o1', mode: 'rooms', price: 650, period: 'month', active: true, hidePriceFor: [] },
        { id: 'o1b', mode: 'long_let', price: 2400, period: 'month', active: false, hidePriceFor: [] },
      ],
      rooms: [
        { id: '9001-R1', label: 'Room 1', photo: IMG('sliema-harbour-promenade-frankbothe.webp'), price: 700, status: 'occupied', sizeSqm: 16, ensuite: true, occupiedUntil: addDays(today, 140), zone: { x: 0, y: 0, w: 4.5, h: 4 } },
        { id: '9001-R2', label: 'Room 2', photo: IMG('gzira-promenade-baerwinkel-klaus.webp'), price: 650, status: 'available', sizeSqm: 13, availableFrom: addDays(today, 10), zone: { x: 4.5, y: 0, w: 4, h: 4 } },
        { id: '9001-R3', label: 'Room 3', photo: IMG('msida-waterfront-txllxt.webp'), price: 600, status: 'available', sizeSqm: 11, availableFrom: today, zone: { x: 8.5, y: 0, w: 3.5, h: 4 } },
        { id: '9001-R4', label: 'Room 4', photo: IMG('valletta-old-bakery-street.webp'), price: 550, status: 'inactive', sizeSqm: 9, zone: { x: 8.5, y: 6, w: 3.5, h: 4 } },
      ],
      plan: {
        width: 12, depth: 10,
        shared: [{ label: 'Kitchen & living', x: 0, y: 4, w: 6, h: 6 }, { label: 'Bath', x: 6, y: 6, w: 2.5, h: 4 }, { label: 'Hall', x: 6, y: 4, w: 6, h: 2 }],
        doors: [{ x: 2, y: 4, side: 'n' }, { x: 6.5, y: 4, side: 'n' }, { x: 10, y: 4, side: 'n' }, { x: 10, y: 6, side: 's' }, { x: 7, y: 6, side: 's' }],
        windows: [{ x: 1, y: 0, side: 'n', len: 2 }, { x: 5.5, y: 0, side: 'n', len: 2 }, { x: 9.5, y: 0, side: 'n', len: 1.5 }, { x: 0, y: 6, side: 'w', len: 3 }],
      },
      lastConfirmedAt: addDays(today, -2), updatedAt: `${addDays(today, -2)}T18:20`,
      distribution: { inherit: false, override: { nexusDirect: true, argusB2B: false, allApprovedAgencies: false, agencyIds: [], agentIds: [], exclusive: null, private: false } },
      channels: [{ channel: 'NEXUS Direct', state: 'live', since: `${addDays(today, -40)}T10:00` }],
    },
    {
      id: 9002, ref: '2906-D902', name: 'Seafront apartment', address: 'Triq Sant Andrija, Swieqi', town: 'Swieqi',
      photos: [IMG('swieqi-triq-sant-andrija-txllxt.webp'), IMG('tal-ibrag-swieqi-alan-bonnici.webp')],
      mode: 'long_let', modeHistory: [{ mode: 'long_let', from: '2022-06-01' }],
      bedrooms: 2, bathrooms: 2, sizeSqm: 95, listing: 'live',
      offers: [{ id: 'o2', mode: 'long_let', price: 1650, period: 'month', active: true, hidePriceFor: [] }],
      rooms: [], availableFrom: addDays(today, 13),
      lastConfirmedAt: addDays(today, -1), updatedAt: `${addDays(today, -1)}T12:05`,
      distribution: { inherit: true, override: profile.defaults },
      channels: [
        { channel: 'NEXUS Direct', state: 'live', since: `${addDays(today, -60)}T10:00` },
        { channel: 'ARGUS agent network', state: 'live', since: `${addDays(today, -60)}T10:00` },
        { channel: 'Harbour Homes', agencyId: 'ag-harbour', state: 'live', since: `${addDays(today, -58)}T09:00` },
        { channel: 'North Coast Lets', agencyId: 'ag-north', state: 'live', since: `${addDays(today, -30)}T09:00` },
        { channel: 'Valletta Keys', agencyId: 'ag-valletta', state: 'pending', since: `${addDays(today, -1)}T16:00` },
      ],
    },
    {
      id: 9003, ref: '2906-D903', name: 'Rotunda townhouse', address: 'Triq il-Kungress Ewkaristiku, Mosta', town: 'Mosta',
      photos: [IMG('mosta-rotunda-pavleg97.webp')],
      mode: 'long_let', modeHistory: [{ mode: 'sale', from: '2024-03-01', to: '2024-11-30' }, { mode: 'long_let', from: '2024-12-01' }],
      bedrooms: 3, bathrooms: 2, sizeSqm: 160, listing: 'live',
      offers: [{ id: 'o3', mode: 'long_let', price: 2100, period: 'month', active: true, hidePriceFor: ['agencies'] }],
      rooms: [], availableFrom: addDays(today, 30),
      lastConfirmedAt: addDays(today, -9), updatedAt: `${addDays(today, -9)}T08:40`,
      distribution: { inherit: false, override: { nexusDirect: false, argusB2B: false, allApprovedAgencies: false, agencyIds: [], agentIds: [], exclusive: { agencyId: 'ag-harbour', until: addDays(today, 30), thenRelease: 'all_approved' }, private: false } },
      channels: [
        { channel: 'Harbour Homes (exclusive)', agencyId: 'ag-harbour', state: 'live', since: `${addDays(today, -1)}T11:00` },
        { channel: 'North Coast Lets', agencyId: 'ag-north', state: 'delisting', since: `${addDays(today, -1)}T11:00` },
      ],
    },
  ]

  const rules: AvailabilityRule[] = [
    { id: 'w1', propertyId: 9001, weekday: 1, start: '16:00', end: '19:00', slotMinutes: 20 },
    { id: 'w2', propertyId: 9001, weekday: 3, start: '10:00', end: '13:00', slotMinutes: 20 },
    { id: 'w3', propertyId: 9001, weekday: 5, start: '15:00', end: '18:00', slotMinutes: 20 },
    { id: 'w4', propertyId: 9002, weekday: 2, start: '17:00', end: '19:30', slotMinutes: 30 },
    { id: 'w5', propertyId: 9002, weekday: 6, start: '10:00', end: '12:00', slotMinutes: 30 },
    { id: 'w6', propertyId: 9003, weekday: 4, start: '16:30', end: '18:30', slotMinutes: 30 },
  ]
  const exceptions: AvailabilityException[] = [
    { id: 'x1', propertyId: 9001, date: addDays(mon, 11), kind: 'blocked', note: 'Away' },
    { id: 'x2', propertyId: 9002, date: addDays(mon, 3), kind: 'extra', start: '12:00', end: '13:00', note: 'Lunch slot' },
  ]

  const ev = (d: number, hhmm: string, actor: 'agent' | 'tenant' | 'argus' | 'owner', action: string, note?: string) => ({ at: at(d, hhmm), actor, action, note })
  const requests: ViewingRequest[] = [
    { id: 'rq1', propertyId: 9002, start: next(2, '17:30'), minutes: 30, status: 'awaiting_owner', source: 'argus_crm',
      requester: { kind: 'agent', agencyId: 'ag-harbour', agentName: 'Daniel', clientRef: 'HH-2231' },
      applicant: { adults: 2, children: 0, moveIn: addDays(today, 14), months: 12, pets: 'Two small dogs', working: 'Both employed' },
      history: [ev(-1, '19:12', 'agent', 'Requested via ARGUS')] },
    { id: 'rq2', propertyId: 9002, start: next(2, '17:30'), minutes: 30, status: 'awaiting_owner', source: 'nexus_housing',
      requester: { kind: 'tenant', clientRef: 'NX-8814' },
      applicant: { adults: 1, children: 0, moveIn: addDays(today, 20), months: 6, working: 'Remote worker' },
      history: [ev(-1, '21:40', 'tenant', 'Requested on NEXUS Housing')] },
    { id: 'rq3', propertyId: 9001, roomId: '9001-R2', start: next(3, '11:00'), minutes: 20, status: 'awaiting_owner', source: 'facebook_link',
      requester: { kind: 'tenant', clientRef: 'FB-5120' },
      applicant: { adults: 1, children: 0, moveIn: addDays(today, 12), months: 9, working: 'Student, part-time job' },
      history: [ev(0, '07:55', 'tenant', 'Requested through your booking link (shared on Facebook)')] },
    { id: 'rq4', propertyId: 9001, roomId: '9001-R3', start: next(1, '16:40'), minutes: 20, status: 'confirmed', source: 'agency_board',
      requester: { kind: 'agent', agencyId: 'ag-north', agentName: 'Luca', clientRef: 'NC-0412' },
      applicant: { adults: 1, children: 0, moveIn: today, months: 12, working: 'Employed' },
      history: [ev(-3, '10:00', 'agent', 'Requested from the agency board'), ev(-3, '12:30', 'owner', 'Viewing confirmed')] },
    { id: 'rq5', propertyId: 9003, start: next(4, '17:00'), minutes: 30, status: 'question', source: 'argus_crm',
      requester: { kind: 'agent', agencyId: 'ag-harbour', agentName: 'Petra', clientRef: 'HH-2240' },
      applicant: { adults: 2, children: 2, moveIn: addDays(today, 35), months: 24 },
      question: 'Is the family planning to use the roof terrace for a small trampoline?',
      history: [ev(-1, '15:00', 'agent', 'Requested via ARGUS'), ev(-1, '18:10', 'owner', 'Question asked', 'Is the family planning to use the roof terrace for a small trampoline?')] },
    { id: 'rq6', propertyId: 9002, start: at(-4, '18:00'), minutes: 30, status: 'completed', source: 'whatsapp',
      requester: { kind: 'agent', agencyId: 'ag-north', agentName: 'Luca', clientRef: 'NC-0398' },
      applicant: { adults: 2, children: 0, moveIn: addDays(today, 5), months: 12 },
      history: [ev(-7, '09:00', 'argus', 'Received on WhatsApp and turned into a request'), ev(-6, '10:00', 'owner', 'Viewing confirmed'), ev(-4, '18:40', 'argus', 'Viewing took place')] },
    { id: 'rq7', propertyId: 9001, roomId: '9001-R2', start: next(5, '15:20'), minutes: 20, status: 'new_time_proposed', proposedStart: next(5, '16:00'), source: 'direct_listing',
      requester: { kind: 'tenant', clientRef: 'DL-0071' },
      applicant: { adults: 1, children: 0, moveIn: addDays(today, 15), months: 12, working: 'Nurse' },
      history: [ev(-1, '11:00', 'tenant', 'Requested on your direct listing'), ev(-1, '13:00', 'owner', 'New time suggested', next(5, '16:00').replace('T', ' '))] },
  ]

  const threads: Thread[] = [
    { id: 't1', title: 'ARGUS Main', with: 'ARGUS Main', unread: 2, messages: [
      { id: 'm1', from: 'argus', at: at(-1, '19:13'), text: 'Harbour Homes asked to view the Seafront apartment next Tuesday at 17:30 for a couple moving in two weeks from now. They have two small dogs.',
        actions: [{ label: 'Accept', requestId: 'rq1', action: 'accept' }, { label: 'Suggest another time', requestId: 'rq1', action: 'propose' }, { label: 'Decline', requestId: 'rq1', action: 'decline' }] },
      { id: 'm2', from: 'argus', at: at(-1, '21:41'), text: 'A second request came in for the same Tuesday slot from NEXUS Housing. You can compare both in Requests; neither side sees the other.' },
      { id: 'm3', from: 'argus', at: at(0, '07:56'), text: 'Someone asked to see Room 2 in Sliema next Wednesday at 11:00 through your booking link.' },
    ] },
    { id: 't2', title: 'Harbour Homes · Rotunda townhouse', with: 'Harbour Homes', propertyId: 9003, requestId: 'rq5', unread: 0, messages: [
      { id: 'm4', from: 'owner', at: at(-1, '18:10'), text: 'Is the family planning to use the roof terrace for a small trampoline?' },
      { id: 'm5', from: 'argus', at: at(-1, '18:11'), text: 'Sent to Petra at Harbour Homes. I will let you know as soon as she answers.' },
    ] },
  ]

  const documents: DocumentItem[] = [
    { id: 'd1', propertyId: 9001, roomId: '9001-R1', title: 'Room 1 tenancy agreement', kind: 'contract', addedAt: addDays(today, -220), sharedWith: [] },
    { id: 'd2', propertyId: 9001, title: 'Inventory list (shared areas)', kind: 'inventory', addedAt: addDays(today, -300), sharedWith: [] },
    { id: 'd3', propertyId: 9002, title: 'Energy performance certificate', kind: 'certificate', addedAt: addDays(today, -500), sharedWith: ['Harbour Homes', 'North Coast Lets'] },
  ]

  return { today, now, profile, agencies, properties, rules, exceptions, requests, threads, documents }
}

export type Demo = ReturnType<typeof buildDemo>
