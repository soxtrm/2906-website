// Pure rules of the owner workspace: viewing windows, slots, double-booking,
// request transitions, operating-mode switches, distribution. No I/O, so the
// same functions run in the browser preview, in the tests and (ported 1:1) in
// the ARGUS backend that will own them.
import type {
  AvailabilityException, AvailabilityRule, Distribution, OperatingMode, OwnerProfile,
  Property, RequestEvent, ViewingRequest, Agency,
} from './model'

// Times are Malta wall-clock strings: 'YYYY-MM-DD' and 'YYYY-MM-DDTHH:MM'.
export const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
export const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
export const datePart = (iso: string) => iso.slice(0, 10)
export const timePart = (iso: string) => iso.slice(11, 16)
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay()
export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}
export function startOfWeek(date: string) { // Monday
  const wd = weekdayOf(date); return addDays(date, wd === 0 ? -6 : 1 - wd)
}

export interface Window { start: string; end: string; source: 'weekly' | 'extra'; roomId?: string }

/** Viewing windows for one property (optionally one room) on one date. */
export function windowsFor(rules: AvailabilityRule[], exceptions: AvailabilityException[], propertyId: number, date: string, roomId?: string): Window[] {
  const ex = exceptions.filter(e => e.propertyId === propertyId && e.date === date)
  if (ex.some(e => e.kind === 'blocked' && !e.start)) return []
  const wd = weekdayOf(date)
  let out: Window[] = rules
    .filter(r => r.propertyId === propertyId && r.weekday === wd && (!roomId || !r.roomId || r.roomId === roomId))
    .map(r => ({ start: r.start, end: r.end, source: 'weekly' as const, roomId: r.roomId }))
  for (const e of ex) if (e.kind === 'extra' && e.start && e.end) out.push({ start: e.start, end: e.end, source: 'extra' })
  // partial blocks cut windows
  for (const b of ex.filter(e => e.kind === 'blocked' && e.start && e.end)) {
    const bs = toMin(b.start!), be = toMin(b.end!)
    out = out.flatMap(w => {
      const ws = toMin(w.start), we = toMin(w.end)
      if (be <= ws || bs >= we) return [w]
      const parts: Window[] = []
      if (bs > ws) parts.push({ ...w, end: toHHMM(bs) })
      if (be < we) parts.push({ ...w, start: toHHMM(be) })
      return parts
    })
  }
  return out.sort((a, b) => toMin(a.start) - toMin(b.start))
}

export function slotsFor(rules: AvailabilityRule[], exceptions: AvailabilityException[], propertyId: number, date: string, slotMinutes = 30, roomId?: string): string[] {
  const slots = new Set<string>()
  for (const w of windowsFor(rules, exceptions, propertyId, date, roomId)) {
    for (let t = toMin(w.start); t + slotMinutes <= toMin(w.end); t += slotMinutes) slots.add(toHHMM(t))
  }
  return [...slots].sort()
}

const startMin = (iso: string) => toMin(timePart(iso))
export function overlaps(a: { start: string; minutes: number }, b: { start: string; minutes: number }) {
  if (datePart(a.start) !== datePart(b.start)) return false
  const as = startMin(a.start), bs = startMin(b.start)
  return as < bs + b.minutes && bs < as + a.minutes
}
/** A whole-property viewing clashes with any room viewing of the same flat, rooms only with the same room. */
export function sameSpace(a: { propertyId: number; roomId?: string }, b: { propertyId: number; roomId?: string }) {
  if (a.propertyId !== b.propertyId) return false
  return !a.roomId || !b.roomId || a.roomId === b.roomId
}

export function confirmedClash(all: ViewingRequest[], candidate: { id?: string; propertyId: number; roomId?: string; start: string; minutes: number }) {
  return all.find(r => r.id !== candidate.id && r.status === 'confirmed' && sameSpace(r, candidate) && overlaps(r, candidate)) || null
}

export function insideAvailability(rules: AvailabilityRule[], exceptions: AvailabilityException[], c: { propertyId: number; roomId?: string; start: string; minutes: number }) {
  const s = startMin(c.start), e = s + c.minutes
  return windowsFor(rules, exceptions, c.propertyId, datePart(c.start), c.roomId).some(w => toMin(w.start) <= s && e <= toMin(w.end))
}

/** Other open requests for the same space and time — shown side by side, never merged. */
export function competing(all: ViewingRequest[], r: ViewingRequest) {
  return all.filter(o => o.id !== r.id && ['awaiting_owner', 'question'].includes(o.status) && sameSpace(o, r) && overlaps(o, r))
}

export type Action =
  | { type: 'accept' }
  | { type: 'decline'; note?: string }
  | { type: 'propose'; start: string }
  | { type: 'ask'; question: string }
  | { type: 'answer'; note: string }
  | { type: 'accept_proposal' }
  | { type: 'cancel'; note?: string }
  | { type: 'complete' }

export interface ActCtx {
  all: ViewingRequest[]
  rules: AvailabilityRule[]
  exceptions: AvailabilityException[]
  now: string
  actor: RequestEvent['actor']
}
export type ActResult = { ok: true; request: ViewingRequest } | { ok: false; error: string }

const ALLOWED: Record<Action['type'], { from: ViewingRequest['status'][]; actors: RequestEvent['actor'][] }> = {
  accept: { from: ['awaiting_owner', 'question'], actors: ['owner'] },
  decline: { from: ['awaiting_owner', 'question', 'new_time_proposed'], actors: ['owner'] },
  propose: { from: ['awaiting_owner', 'question', 'confirmed'], actors: ['owner'] },
  ask: { from: ['awaiting_owner'], actors: ['owner'] },
  answer: { from: ['question'], actors: ['agent', 'tenant'] },
  accept_proposal: { from: ['new_time_proposed'], actors: ['agent', 'tenant'] },
  cancel: { from: ['awaiting_owner', 'question', 'new_time_proposed', 'confirmed'], actors: ['owner', 'agent', 'tenant'] },
  complete: { from: ['confirmed'], actors: ['owner', 'argus'] },
}

/** The one place a viewing request changes state. Confirming never accepts a tenant. */
export function act(r: ViewingRequest, a: Action, ctx: ActCtx): ActResult {
  const rule = ALLOWED[a.type]
  if (!rule.from.includes(r.status)) return { ok: false, error: `This request is ${r.status.replace(/_/g, ' ')} and can't be changed that way.` }
  if (!rule.actors.includes(ctx.actor)) return { ok: false, error: 'You are not allowed to do that on this request.' }
  const ev = (action: string, note?: string): RequestEvent => ({ at: ctx.now, actor: ctx.actor, action, note })
  switch (a.type) {
    case 'accept': {
      if (r.start <= ctx.now) return { ok: false, error: 'This time has already passed. Suggest another time instead.' }
      const clash = confirmedClash(ctx.all, r)
      if (clash) return { ok: false, error: `You already have a confirmed viewing at ${timePart(clash.start)} for this ${clash.roomId && r.roomId ? 'room' : 'property'}.` }
      return { ok: true, request: { ...r, status: 'confirmed', history: [...r.history, ev('Viewing confirmed', 'Confirms the viewing only, not the tenant.')] } }
    }
    case 'decline':
      return { ok: true, request: { ...r, status: 'declined', history: [...r.history, ev('Declined', a.note)] } }
    case 'propose': {
      const cand = { ...r, start: a.start }
      if (a.start <= ctx.now) return { ok: false, error: 'Pick a time in the future.' }
      if (!insideAvailability(ctx.rules, ctx.exceptions, cand)) return { ok: false, error: 'That time is outside your viewing hours. Add it to your calendar first.' }
      if (confirmedClash(ctx.all, cand)) return { ok: false, error: 'That time is already taken by a confirmed viewing.' }
      return { ok: true, request: { ...r, status: 'new_time_proposed', proposedStart: a.start, history: [...r.history, ev('New time suggested', a.start.replace('T', ' '))] } }
    }
    case 'ask':
      if (!a.question.trim()) return { ok: false, error: 'Write the question first.' }
      return { ok: true, request: { ...r, status: 'question', question: a.question.trim(), history: [...r.history, ev('Question asked', a.question.trim())] } }
    case 'answer':
      return { ok: true, request: { ...r, status: 'awaiting_owner', history: [...r.history, ev('Question answered', a.note)] } }
    case 'accept_proposal': {
      const moved = { ...r, start: r.proposedStart!, proposedStart: undefined }
      if (confirmedClash(ctx.all, moved)) return { ok: false, error: 'That time was taken in the meantime.' }
      return { ok: true, request: { ...moved, status: 'confirmed', history: [...r.history, ev('New time accepted')] } }
    }
    case 'cancel':
      return { ok: true, request: { ...r, status: 'cancelled', history: [...r.history, ev('Cancelled', a.note)] } }
    case 'complete':
      if (r.start > ctx.now) return { ok: false, error: 'The viewing has not happened yet.' }
      return { ok: true, request: { ...r, status: 'completed', history: [...r.history, ev('Viewing took place')] } }
  }
}

// ── operating mode ──────────────────────────────────────────────────────────
export interface Blocker { level: 'block' | 'warn'; text: string }
export function modeSwitchCheck(p: Property, to: OperatingMode, requests: ViewingRequest[], today: string): Blocker[] {
  const out: Blocker[] = []
  if (to === p.mode) return out
  if (p.tenancyUntil && p.tenancyUntil > today) out.push({ level: 'block', text: `A tenancy runs until ${p.tenancyUntil}. Switch after it ends.` })
  const occupied = p.rooms.filter(r => r.status === 'occupied' && (!r.occupiedUntil || r.occupiedUntil > today))
  if (p.mode === 'rooms' && to !== 'rooms' && occupied.length) {
    out.push({ level: 'block', text: `${occupied.length} room${occupied.length > 1 ? 's are' : ' is'} occupied (${occupied.map(r => r.label).join(', ')}). The whole flat can only be offered once they are free.` })
  }
  const future = requests.filter(r => r.propertyId === p.id && r.status === 'confirmed' && datePart(r.start) >= today)
  if (future.length) out.push({ level: 'warn', text: `${future.length} confirmed viewing${future.length > 1 ? 's' : ''} stay booked; tell the visitors the offer changed.` })
  if (to === 'shortlet') out.push({ level: 'warn', text: 'Short lets in Malta need an MTA licence before going live.' })
  return out
}

// ── distribution ────────────────────────────────────────────────────────────
export function effectiveDistribution(profile: OwnerProfile, p: Property): Distribution {
  return p.distribution.inherit ? profile.defaults : p.distribution.override
}
export function exclusiveActive(d: Distribution, today: string) {
  return !!d.exclusive && d.exclusive.until >= today
}
/** Who may see this property right now. Changes propagate only to these. */
export function recipients(d: Distribution, agencies: Agency[], today: string): { channel: string; agencyId?: string }[] {
  if (d.private) return []
  if (exclusiveActive(d, today)) {
    const a = agencies.find(x => x.id === d.exclusive!.agencyId)
    return [{ channel: a ? `${a.name} (exclusive until ${d.exclusive!.until})` : 'Exclusive agency', agencyId: d.exclusive!.agencyId },
      ...(d.nexusDirect ? [{ channel: 'NEXUS Direct' }] : [])]
  }
  const out: { channel: string; agencyId?: string }[] = []
  if (d.nexusDirect) out.push({ channel: 'NEXUS Direct' })
  if (d.argusB2B) out.push({ channel: 'ARGUS agent network' })
  const ids = new Set(d.allApprovedAgencies ? agencies.filter(a => a.approved).map(a => a.id) : d.agencyIds)
  for (const a of agencies) if (ids.has(a.id)) out.push({ channel: a.name, agencyId: a.id })
  for (const a of agencies) for (const ag of a.agents) if (d.agentIds.includes(ag.id) && !ids.has(a.id)) out.push({ channel: `${ag.name} (${a.name})`, agencyId: a.id })
  return out
}
/** Channels that lose access when going from `before` to `after` → must be delisted. */
export function revokedBy(before: Distribution, after: Distribution, agencies: Agency[], today: string) {
  const keep = new Set(recipients(after, agencies, today).map(r => r.agencyId || r.channel))
  return recipients(before, agencies, today).filter(r => !keep.has(r.agencyId || r.channel))
}
