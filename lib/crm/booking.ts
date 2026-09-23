// ============================================================================
// lib/crm/booking.ts — shared types + Malta-time helpers for the booking
// engine (backend: services/bookingEngine.js, viewingWindows.js,
// calendarSync.js; routes under /api/crm/schedule-board). Kev, 2026-09-23.
// Every time an owner states is Malta wall-clock time, whatever timezone the
// agent's browser is in — so formatting and input both go through Malta here.
// ============================================================================
export type SlotState = 'free' | 'booked' | 'past'
// confirmed = inside what the OWNER confirmed; otherwise the slot is PROPOSED
// (booking it reserves it as "pending owner"). occupied = short-stay guests in
// the flat (connected Airbnb/Booking calendar) — a warning, never a block.
export type Slot = { start: string; end: string; state: SlotState; bookingId: number | null; confirmed: boolean; occupied: boolean }
export type BookingWindow = {
  id: number; kind: 'window'; start: string; end: string; label: string
  source: string; evidence: string | null; confidence: string; slots: Slot[]
  confirmation: 'full_window' | 'start_only' | 'approximate'
}
export type Booking = {
  id: number; propertyId: number; ref: string | null; town: string | null
  startsAt: string | null; endsAt: string | null; date: string | null; time: string | null
  label: string | null; durationMin: number | null
  appointmentType: string | null; appointmentLabel: string
  status: 'pending' | 'confirmed' | 'cancelled' | 'done' | 'no_show'
  source: string | null; windowId: number | null
  agent: { id: number | null; name: string | null; colorHex: string | null }
  party: { label: string | null; ref: string | null; size: number | null }
  notes: string | null; canEdit: boolean
  ownerConfirmed: boolean
  attention: { reason: string; at: string; seen: boolean } | null
}
export type CalendarFeed = {
  id: number; source: string; active: boolean; host: string | null
  lastSyncedAt: string | null; status: string | null; error: string | null; events: number
}
export type BookingView = {
  ref: string; town: string | null
  bookingsPossible: boolean; canBookSlots: boolean
  windows: BookingWindow[]
  viewingsFrom: { id: number; date: string; evidence: string | null; source: string } | null
  bookings: Booking[]
  occupied: { id: number; start: string; end: string; source: string; allDay: boolean }[]
  appointmentTypes: { key: string; label: string }[]
  durations: number[]; slotMinutes: number
  rentalModes: string[]; dualUse: boolean
  // Malta default season for the winter→short CLASSIFICATION — never confirmed availability
  defaultShortLetSeason: { fromMonth: number; toMonth: number }; seasonConfirmed: false
  standingPermission: boolean
  canManageCalendars: boolean; calendarFeeds: CalendarFeed[]; calendarExportUrl: string | null
  canSetWindow: boolean
}

export const TZ = 'Europe/Malta'
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })

export const timeLabel = (iso: string) => hm.format(new Date(iso))
export const dayLabel = (iso: string) => dayFmt.format(new Date(iso))
export function maltaDayKey(iso: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso)).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

// 'YYYY-MM-DD' + 'HH:MM' in Malta → ISO instant
export function maltaToIso(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, h, mi)
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(t)).map(x => [x.type, x.value]))
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000
  }
  const o1 = offset(guess)
  const t = guess - o1
  const o2 = offset(t)
  return new Date(o1 === o2 ? t : guess - o2).toISOString()
}

export const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed', pending: 'Proposed · pending owner', cancelled: 'Cancelled', done: 'Done', no_show: 'No show',
}

const hm12 = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
export const time12 = (iso: string) => hm12.format(new Date(iso))

// "Agent XY · Tue 29 Sep 4:00 PM · Confirmed"
export function bookingLine(b: Booking) {
  const when = b.startsAt ? `${dayLabel(b.startsAt)} ${time12(b.startsAt)}` : (b.label || b.date || '')
  return `${b.attention ? '⚠ ' : ''}${b.agent.name || 'Agent'} · ${when} · ${STATUS_LABEL[b.status] || b.status}`
}
