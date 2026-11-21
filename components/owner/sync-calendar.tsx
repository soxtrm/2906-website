'use client'
// NEXUS Sync calendar 2.0 (2026-11-21, Kev "SYNC UX & Communications 2.0", milestone A).
// - Opens on the next seven days starting today (Fri → Sat → … → Thu); previous/next, a date picker, optional Mon–Sun week.
// - One home at a time (nickname or "Penthouse · Swieqi"), or all own homes together.
// - Viewing hours are ranges: drag down a day (desktop) or tap a time (touch) → "14:00–17:00", optionally every week.
//   Inside the hours NEXUS shows bookable slots (15 / 30 / 60 min per home). Own hours can be moved, resized, removed.
// - Every slot is a real target: add your own appointment (a neighbour, someone outside NEXUS), reserve it,
//   give it to a waiting request, change the hours, or open the booking that is there.
// - Requests stay on the left: drag one onto a slot (or tap it, then tap a slot). Same time → accept, another → propose.
// Nothing shows as done until ARGUS answered; two viewings of one home never overlap (checked and enforced by the database).
// Without confirmed homes, a clearly labelled sample calendar (local only, nothing saved) keeps the page useful.
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, CalendarClock, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, GripHorizontal, GripVertical, Hand, Lock, MessageCircle, MousePointerClick, Repeat, Sparkles, Trash2, UserRound, UsersRound, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { liveProperties, sync, type LiveListing, type LiveViewing } from '@/lib/owner/live'
import { titleCase } from '@/lib/public-property-title'

// ── Malta time helpers (DST-safe) ─────────────────────────────────────────────────────────────────────────────
const TZ = 'Europe/Malta'
const PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function malta(d: Date) {
  const p = Object.fromEntries(PARTS.formatToParts(d).map(x => [x.type, x.value]))
  return { key: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) }
}
function maltaDate(key: string, min: number) {
  const [y, m, d] = key.split('-').map(Number)
  const want = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60)
  let t = want
  for (let i = 0; i < 3; i++) { const w = malta(new Date(t)); const [wy, wm, wd] = w.key.split('-').map(Number); t += want - Date.UTC(wy, wm - 1, wd, Math.floor(w.min / 60), w.min % 60) }
  return new Date(t)
}
const addDays = (key: string, n: number) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const weekday = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
const monday = (key: string) => addDays(key, -((weekday(key) + 6) % 7))
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const dayLabel = (key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric' }) => maltaDate(key, 12 * 60).toLocaleDateString('en-GB', { ...opts, timeZone: TZ })
const whenLabel = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const todayKey = () => malta(new Date()).key
const endMin = (w: { start: string; end: string }, key: string) => (malta(new Date(w.end)).key === key ? malta(new Date(w.end)).min : 24 * 60)

// ── data shape shared by the live and the sample calendar ─────────────────────────────────────────────────────
type Win = { id: number; start: string; end: string; own: boolean; proposedFor: number | null }
type Home = { id: number; name: string; ref: string; hue: number; slot: number; windows: Win[] }
type Kind = 'agency' | 'manual' | 'reserved'
type CalViewing = LiveViewing & { kind: Kind; label: string | null; attention?: string | null }
type Result = { ok: true; text: string } | { ok: false; text: string }
type Api = {
  sample: boolean
  homes: Home[]
  viewings: CalViewing[]
  accept: (v: CalViewing) => Promise<Result>
  decline: (v: CalViewing, note: string) => Promise<Result>
  propose: (v: CalViewing, start: Date) => Promise<Result>
  ask: (v: CalViewing, text: string) => Promise<Result>
  addWindow: (home: number, start: Date, end: Date, repeatWeeks: number) => Promise<Result>
  updateWindow: (home: number, id: number, start: Date, end: Date) => Promise<Result>
  removeWindow: (home: number, id: number) => Promise<Result>
  appointment: (home: number, start: Date, minutes: number, kind: 'manual' | 'reserved', label: string) => Promise<Result>
  cancelAppointment: (v: CalViewing) => Promise<Result>
  setSlot: (home: number, minutes: number) => Promise<Result>
}
const HUES = [222, 12, 152, 268, 38, 190]
const homeName = (l: LiveListing) => l.state?.nickname || `${l.facts.type ? titleCase(l.facts.type) : 'Home'} · ${l.facts.locality ? titleCase(l.facts.locality) : 'Malta'}`
const rangeText = (a: Date, b: Date) => `${hhmm(malta(a).min)}–${malta(b).min === 0 && malta(b).key !== malta(a).key ? '24:00' : hhmm(malta(b).min)}`

function useLiveApi(): Api {
  const s = useOwner()
  const listings = useMemo(() => liveProperties(s.live.owner), [s.live.owner])
  const [cal, setCal] = useState<{ homes: { id: number; slotMinutes: number }[]; viewings: CalViewing[] } | null>(null)
  const loadCal = useCallback(async () => {
    const r = await sync<{ homes: { id: number; slotMinutes: number }[]; viewings: CalViewing[] }>('owner/cal')
    if (r.ok) setCal({ homes: r.homes, viewings: r.viewings })
  }, [])
  useEffect(() => { if (listings.length) loadCal() }, [listings.length, loadCal])
  const homes = useMemo<Home[]>(() => listings.map((l: LiveListing, i) => ({
    id: l.sourcePropertyId, ref: l.ref, hue: HUES[i % HUES.length], name: homeName(l),
    slot: cal?.homes.find(h => h.id === l.sourcePropertyId)?.slotMinutes || 30,
    windows: ((l.state?.windows || []) as Win[]).map(w => ({ id: w.id, start: w.start, end: w.end, own: !!w.own, proposedFor: w.proposedFor ?? null })),
  })), [listings, cal])
  // the calendar list carries the owner's own appointments; before it answers, the classic list is shown
  const viewings = useMemo<CalViewing[]>(() => cal?.viewings || s.live.viewings.map(v => ({ ...v, kind: 'agency' as Kind, label: null })), [cal, s.live.viewings])
  const refresh = useCallback(async () => { await Promise.all([s.refreshLive(), loadCal()]) }, [s, loadCal])
  const run = useCallback(async (op: string, body: Record<string, unknown>, okText: (d: Record<string, unknown>) => string): Promise<Result> => {
    const r = await sync(op, body)
    if (!r.ok) return { ok: false, text: r.message }
    await refresh()
    return { ok: true, text: okText(r as unknown as Record<string, unknown>) }
  }, [refresh])
  // another representative or the agency may change things: refresh every 45 s and when the tab comes back
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 45000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(t); window.removeEventListener('focus', refresh) }
  }, [refresh])
  return {
    sample: false, homes, viewings,
    accept: v => run('owner/viewings/decide', { viewingId: v.id, decision: 'accept' }, () => `Viewing confirmed for ${whenLabel(v.startsAt)}. The agency sees it now.`),
    decline: (v, note) => run('owner/viewings/decide', { viewingId: v.id, decision: 'decline', note }, () => 'Declined. The agency is told.'),
    propose: (v, at) => run('owner/viewings/decide', { viewingId: v.id, decision: 'propose', proposeStart: at.toISOString() }, () => `${whenLabel(at.toISOString())} proposed. The agent re-books at that time.`),
    ask: async (v, text) => {
      const r = await sync('messages/send', { text: `About the viewing request ${whenLabel(v.startsAt)} (Ref ${v.ref}): ${text}`.slice(0, 900), propertyId: v.propertyId })
      return r.ok ? { ok: true, text: 'Question sent to the agency.' } : { ok: false, text: r.message }
    },
    addWindow: (home, a, b, weeks) => run('owner/cal/window/add', { propertyId: home, start: a.toISOString(), end: b.toISOString(), repeatWeeks: weeks }, d => {
      const n = (d.created as unknown[] | undefined)?.length || 1, sk = (d.skipped as unknown[] | undefined)?.length || 0
      return `Open for viewings ${rangeText(a, b)}${n > 1 ? ` on ${n} weeks` : ''}.${sk ? ` ${sk} week${sk > 1 ? 's' : ''} skipped: already open then.` : ''}`
    }),
    updateWindow: (home, id, a, b) => run('owner/cal/window/update', { propertyId: home, windowId: id, start: a.toISOString(), end: b.toISOString() }, d => `Hours now ${rangeText(a, b)}.${Number(d.flagged) ? ` ${d.flagged} booking${Number(d.flagged) > 1 ? 's' : ''} outside: the agency is told to re-arrange.` : ''}`),
    removeWindow: (home, id) => run('owner/window/remove', { propertyId: home, windowId: id }, () => 'Viewing hours removed.'),
    appointment: (home, a, minutes, kind, label) => run('owner/cal/appointment', { propertyId: home, start: a.toISOString(), minutes, kind, label }, () => kind === 'reserved' ? `${hhmm(malta(a).min)} reserved.` : `Your appointment at ${hhmm(malta(a).min)} is in the calendar.`),
    cancelAppointment: v => run('owner/cal/appointment/cancel', { viewingId: v.id }, () => 'Removed from your calendar.'),
    setSlot: (home, minutes) => run('owner/cal/slot', { propertyId: home, minutes }, () => `Slots of ${minutes} minutes.`),
  }
}

// Sample calendar: two homes, requests and hours around the next days. Local only, clearly labelled, nothing is saved.
function useSampleApi(): Api {
  const seed = useMemo(() => {
    const t = todayKey(); const at = (d: number, min: number) => maltaDate(addDays(t, d), min).toISOString()
    const end = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60e3).toISOString()
    const homes: Home[] = [
      { id: 1, name: 'Ivory', ref: 'S-101', hue: 222, slot: 30, windows: [] },
      { id: 2, name: 'Sea View', ref: 'S-102', hue: 12, slot: 30, windows: [] },
    ]
    let wid = 100
    const w = (h: number, d: number, a: number, b: number, own = true) => homes[h].windows.push({ id: wid++, start: at(d, a), end: end(at(d, a), b - a), own, proposedFor: null })
    w(0, 1, 14 * 60, 17 * 60); w(0, 3, 10 * 60, 12 * 60, false); w(1, 2, 16 * 60, 18 * 60); w(1, 5, 11 * 60, 13 * 60)
    const v = (id: number, home: number, d: number, min: number, status: string, agent: string | null, size: number | null, type: string | null, job: string | null, note: string | null, kind: Kind = 'agency', label: string | null = null): CalViewing => ({ id, propertyId: home, ref: homes.find(h => h.id === home)!.ref, startsAt: at(d, min), durationMin: 20, status, decision: status === 'confirmed' ? 'confirmed' : 'pending', round: 1, note, declineText: null, party: { size, type, job }, agent, kind, label })
    const viewings = [
      v(901, 1, 1, 14 * 60 + 30, 'pending', 'Olga · 2906 Estate', 2, 'couple', 'Software engineer', 'Moving from Berlin in January, long let.'),
      v(902, 2, 2, 16 * 60 + 30, 'pending', 'Adrian · 2906 Estate', 1, 'single', 'Nurse', null),
      v(903, 1, 4, 18 * 60, 'pending', 'Kevin · 2906 Estate', 3, 'family', 'Teacher', 'Family with one child, flexible on the date.'),
      v(904, 2, 1, 11 * 60, 'confirmed', 'Olga · 2906 Estate', 2, 'couple', 'Designer', null),
      v(905, 1, 1, 16 * 60, 'confirmed', null, null, null, null, null, 'manual', 'Neighbour (Maria)'),
    ]
    return { homes, viewings }
  }, [])
  const [homes, setHomes] = useState(seed.homes)
  const [viewings, setViewings] = useState(seed.viewings)
  const clash = (home: number, start: Date, min: number, except?: number) => viewings.find(x => x.propertyId === home && x.id !== except && ['pending', 'confirmed'].includes(x.status) &&
    new Date(x.startsAt).getTime() < start.getTime() + min * 60e3 && new Date(x.startsAt).getTime() + x.durationMin * 60e3 > start.getTime())
  const overlaps = (home: number, a: Date, b: Date, except?: number) => homes.find(h => h.id === home)?.windows.some(w => w.id !== except && new Date(w.start) < b && new Date(w.end) > a)
  const wait = () => new Promise(r => setTimeout(r, 320))
  const nid = () => Math.round(Math.random() * 1e9)
  return {
    sample: true, homes, viewings,
    accept: async v => { await wait(); setViewings(vs => vs.map(x => (x.id === v.id ? { ...x, status: 'confirmed', decision: 'confirmed' } : x))); return { ok: true, text: `Sample: viewing confirmed for ${whenLabel(v.startsAt)}.` } },
    decline: async v => { await wait(); setViewings(vs => vs.map(x => (x.id === v.id ? { ...x, status: 'cancelled', decision: 'declined' } : x))); return { ok: true, text: 'Sample: declined.' } },
    propose: async (v, at) => {
      await wait(); const c = clash(v.propertyId, at, 20, v.id)
      if (c) return { ok: false, text: `Another viewing is already booked at ${whenLabel(c.startsAt)}. Choose a free time.` }
      setViewings(vs => vs.map(x => (x.id === v.id ? { ...x, status: 'cancelled', decision: 'declined' } : x)))
      setHomes(hs => hs.map(h => (h.id === v.propertyId ? { ...h, windows: [...h.windows, { id: nid(), start: at.toISOString(), end: new Date(at.getTime() + 30 * 60e3).toISOString(), own: true, proposedFor: v.id }] } : h)))
      return { ok: true, text: `Sample: ${whenLabel(at.toISOString())} proposed to the agent.` }
    },
    ask: async () => { await wait(); return { ok: true, text: 'Sample: question sent.' } },
    addWindow: async (home, a, b, weeks) => {
      await wait()
      const add: Win[] = []; let skipped = 0
      for (let k = 0; k <= weeks; k++) {
        const ka = addDays(malta(a).key, 7 * k), wa = maltaDate(ka, malta(a).min), wb = new Date(wa.getTime() + (b.getTime() - a.getTime()))
        if (overlaps(home, wa, wb) || add.some(w => new Date(w.start) < wb && new Date(w.end) > wa)) { skipped++; continue }
        add.push({ id: nid(), start: wa.toISOString(), end: wb.toISOString(), own: true, proposedFor: null })
      }
      if (!add.length) return { ok: false, text: 'You already have viewing hours at this time.' }
      setHomes(hs => hs.map(h => (h.id === home ? { ...h, windows: [...h.windows, ...add] } : h)))
      return { ok: true, text: `Sample: open ${rangeText(a, b)}${add.length > 1 ? ` on ${add.length} weeks` : ''}.${skipped ? ` ${skipped} skipped.` : ''}` }
    },
    updateWindow: async (home, id, a, b) => {
      await wait()
      if (overlaps(home, a, b, id)) return { ok: false, text: 'Other viewing hours already cover part of this time.' }
      setHomes(hs => hs.map(h => (h.id === home ? { ...h, windows: h.windows.map(w => (w.id === id ? { ...w, start: a.toISOString(), end: b.toISOString() } : w)) } : h)))
      return { ok: true, text: `Sample: hours now ${rangeText(a, b)}.` }
    },
    removeWindow: async (home, id) => { await wait(); setHomes(hs => hs.map(h => (h.id === home ? { ...h, windows: h.windows.filter(w => w.id !== id) } : h))); return { ok: true, text: 'Sample: hours removed.' } },
    appointment: async (home, a, minutes, kind, label) => {
      await wait(); const c = clash(home, a, minutes)
      if (c) return { ok: false, text: `Another viewing is already booked at ${whenLabel(c.startsAt)}. Choose a free time.` }
      setViewings(vs => [...vs, { id: nid(), propertyId: home, ref: homes.find(h => h.id === home)?.ref || '', startsAt: a.toISOString(), durationMin: minutes, status: 'confirmed', decision: 'confirmed', round: 1, note: null, declineText: null, party: { size: null, type: null, job: null }, agent: null, kind, label: label || (kind === 'reserved' ? 'Reserved' : 'Own viewing') }])
      return { ok: true, text: kind === 'reserved' ? `Sample: ${hhmm(malta(a).min)} reserved.` : `Sample: appointment at ${hhmm(malta(a).min)} added.` }
    },
    cancelAppointment: async v => { await wait(); setViewings(vs => vs.map(x => (x.id === v.id ? { ...x, status: 'cancelled' } : x))); return { ok: true, text: 'Sample: removed.' } },
    setSlot: async (home, minutes) => { await wait(); setHomes(hs => hs.map(h => (h.id === home ? { ...h, slot: minutes } : h))); return { ok: true, text: `Sample: slots of ${minutes} minutes.` } },
  }
}

// ── the calendar ─────────────────────────────────────────────────────────────────────────────────────────────
const STEP = 15            // minutes per grid row
const ROW = 14             // px per row (56 px per hour)
type Slot = { key: string; min: number }
type Pop =
  | { kind: 'slot'; slot: Slot; home: number | null; x: number; y: number }
  | { kind: 'range'; key: string; a: number; b: number; home: number | null; x: number; y: number }
  | { kind: 'viewing'; v: CalViewing; x: number; y: number }
  | { kind: 'window'; home: Home; w: Win; x: number; y: number }
  | { kind: 'drop'; v: CalViewing; slot: Slot; x: number; y: number }
type Gesture =
  | { type: 'select'; key: string; a: number; b: number }
  | { type: 'move' | 'top' | 'bottom'; home: Home; w: Win; key: string; a: number; b: number }

export function SyncCalendar() {
  const s = useOwner()
  const live = useLiveApi()
  const sampleApi = useSampleApi()
  const hasHomes = live.homes.length > 0
  const [forceSample, setForceSample] = useState(false)
  const api = hasHomes && !forceSample ? live : sampleApi
  return <CalendarView api={api} ready={s.live.ready} canLeaveSample={hasHomes && forceSample} onSample={setForceSample} />
}

function CalendarView({ api, ready, canLeaveSample, onSample }: { api: Api; ready: boolean; canLeaveSample: boolean; onSample: (v: boolean) => void }) {
  const reduce = useReducedMotion()
  const [narrow, setNarrow] = useState(false)
  useEffect(() => { const m = window.matchMedia('(max-width: 820px)'); const on = () => setNarrow(m.matches); on(); m.addEventListener('change', on); return () => m.removeEventListener('change', on) }, [])
  const [mode, setMode] = useState<'next7' | 'week'>('next7')
  const [start, setStart] = useState(todayKey())          // first day shown (next7) or any day of the week (week)
  const [dayKey, setDayKey] = useState(todayKey())        // the one day shown on a phone
  const homes = api.homes
  const [homeSel, setHomeSel] = useState<number | 0>(0)   // 0 = all own homes together
  // the chosen home is remembered on this device; ?home= and ?day= open a specific place
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const h = Number(q.get('home')); const d = q.get('day')
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) { setStart(d); setDayKey(d) }
    let saved = 0; try { saved = Number(localStorage.getItem('nx-sync-cal-home')) || 0 } catch { /* private mode */ }
    if (h) setHomeSel(h); else if (saved) setHomeSel(saved)
  }, [])
  useEffect(() => { if (homes.length && homeSel && !homes.some(x => x.id === homeSel)) setHomeSel(homes.length === 1 ? homes[0].id : 0) }, [homes, homeSel])
  useEffect(() => { if (homes.length === 1 && homeSel !== homes[0].id) setHomeSel(homes[0].id) }, [homes, homeSel])
  const pickHome = (id: number) => { setHomeSel(id); try { localStorage.setItem('nx-sync-cal-home', String(id)) } catch { /* private mode */ } }
  const home = homes.find(h => h.id === homeSel) || null

  const [picked, setPicked] = useState<CalViewing | null>(null)        // tap-tap mode
  const [drag, setDrag] = useState<{ v: CalViewing; x: number; y: number } | null>(null)
  const [hover, setHover] = useState<Slot | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [pop, setPop] = useState<Pop | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Result | null>(null)
  const [sheet, setSheet] = useState(false)
  const say = (r: Result) => { setToast(r); setTimeout(() => setToast(t => (t === r ? null : t)), 4600) }
  const homeOf = (id: number) => homes.find(h => h.id === id)

  const days = narrow ? [dayKey] : mode === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(monday(start), i)) : Array.from({ length: 7 }, (_, i) => addDays(start, i))
  const stripDays = Array.from({ length: 7 }, (_, i) => addDays(mode === 'week' ? monday(start) : start, i))
  const shownHomes = home ? [home] : homes
  const visible = api.viewings.filter(v => (!home || v.propertyId === home.id) && v.status !== 'cancelled')
  const requests = visible.filter(v => v.status === 'pending' && v.kind === 'agency').sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const upcoming = visible.filter(v => v.status === 'confirmed' && new Date(v.startsAt).getTime() > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt))

  // hours shown: 08–21, widened to whatever the days hold
  const [from, to] = useMemo(() => {
    let a = 8 * 60, b = 21 * 60
    const inDays = (iso: string) => days.includes(malta(new Date(iso)).key)
    for (const v of visible) if (inDays(v.startsAt)) { const m = malta(new Date(v.startsAt)).min; a = Math.min(a, Math.floor(m / 60) * 60); b = Math.max(b, Math.ceil((m + v.durationMin) / 60) * 60) }
    for (const h of shownHomes) for (const w of h.windows) if (inDays(w.start)) { const k = malta(new Date(w.start)); a = Math.min(a, Math.floor(k.min / 60) * 60); b = Math.max(b, Math.min(24 * 60, Math.ceil(endMin(w, k.key) / 60) * 60)) }
    return [a, b]
  }, [visible, shownHomes, days.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (to - from) / STEP
  const y = (min: number) => ((min - from) / STEP) * ROW
  const minAt = (el: HTMLElement, clientY: number, snap = STEP) => {
    const r = el.getBoundingClientRect()
    return Math.max(from, Math.min(to - snap, from + Math.floor((clientY - r.top) / ROW) * STEP))
  }
  const snapTo = (min: number, slot: number) => Math.floor(min / slot) * slot

  const busyAt = (homeId: number, start: Date, minutes: number, except?: number) => api.viewings.find(x => x.propertyId === homeId && x.id !== except && ['pending', 'confirmed'].includes(x.status) &&
    new Date(x.startsAt).getTime() < start.getTime() + minutes * 60e3 && new Date(x.startsAt).getTime() + x.durationMin * 60e3 > start.getTime())
  const slotFree = (v: CalViewing | null, slot: Slot) => {
    const st = maltaDate(slot.key, slot.min)
    if (st.getTime() < Date.now() + 15 * 60e3 || st.getTime() > Date.now() + 60 * 86400e3) return false
    return !v || !busyAt(v.propertyId, st, 20, v.id)
  }
  const sameTime = (v: CalViewing, slot: Slot) => { const m = malta(new Date(v.startsAt)); return m.key === slot.key && Math.abs(m.min - slot.min) < 15 }
  const act = async (fn: () => Promise<Result>) => { setBusy(true); const r = await fn(); setBusy(false); say(r); if (r.ok) { setPop(null); setPicked(null) } return r }

  // the day column under the pointer, even when a block lies on top of the slot
  const hitUnder = (cx: number, cy: number) => document.elementFromPoint(cx, cy)?.closest<HTMLElement>('.sc-day')?.querySelector<HTMLElement>('[data-hit]') || null
  // request card → slot (mouse + touch)
  const startDrag = (v: CalViewing, e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,a,textarea,input,select')) return
    const x0 = e.clientX, y0 = e.clientY; let moving = false
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
      moving = true; ev.preventDefault(); setDrag({ v, x: ev.clientX, y: ev.clientY }); setSheet(false)
      const el = hitUnder(ev.clientX, ev.clientY)
      setHover(el ? { key: el.dataset.hit!, min: snapTo(minAt(el, ev.clientY), homeOf(v.propertyId)?.slot || 30) } : null)
    }
    const up = (ev: PointerEvent) => {
      cleanup(); if (!moving) return
      const el = hitUnder(ev.clientX, ev.clientY)
      setDrag(null); setHover(null)
      if (el) setPop({ kind: 'drop', v, slot: { key: el.dataset.hit!, min: snapTo(minAt(el, ev.clientY), homeOf(v.propertyId)?.slot || 30) }, x: ev.clientX, y: ev.clientY })
    }
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { setDrag(null); setHover(null); cleanup() } }
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', esc) }
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('keydown', esc)
  }

  // empty part of a day: drag down to mark hours (mouse/pen), a plain click or a tap opens that time
  const dayDown = (key: string, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const slotLen = home?.slot || 30
    const a0 = minAt(el, e.clientY)
    if (picked) { setPop({ kind: 'drop', v: picked, slot: { key, min: snapTo(a0, homeOf(picked.propertyId)?.slot || 30) }, x: e.clientX, y: e.clientY }); return }
    if (e.pointerType === 'touch') { setPop({ kind: 'slot', slot: { key, min: snapTo(a0, slotLen) }, home: home?.id ?? null, x: e.clientX, y: e.clientY }); return }
    e.preventDefault()
    let g: Gesture = { type: 'select', key, a: a0, b: a0 + STEP }, moved = false
    const move = (ev: PointerEvent) => {
      const m = minAt(el, ev.clientY) + STEP
      if (!moved && Math.abs(m - (a0 + STEP)) < STEP) return
      moved = true
      g = { type: 'select', key, a: Math.min(a0, m - STEP), b: Math.max(a0 + STEP, m) }
      setGesture(g)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      setGesture(null)
      if (moved && g.type === 'select' && g.b - g.a >= 15) setPop({ kind: 'range', key, a: g.a, b: g.b, home: home?.id ?? null, x: ev.clientX, y: ev.clientY })
      else setPop({ kind: 'slot', slot: { key, min: snapTo(a0, slotLen) }, home: home?.id ?? null, x: ev.clientX, y: ev.clientY })
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  // own hours: drag the bar to move (also to another day), drag an edge to extend or shorten
  const winDown = (h: Home, w: Win, type: 'move' | 'top' | 'bottom', e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    e.stopPropagation(); e.preventDefault()
    const k0 = malta(new Date(w.start)), a0 = k0.min, b0 = endMin(w, k0.key), y0 = e.clientY
    let g: Gesture = { type, home: h, w, key: k0.key, a: a0, b: b0 }, moved = false
    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientY - y0) / ROW) * STEP
      if (!moved && Math.abs(ev.clientY - y0) < 5) return
      moved = true
      const col = type === 'move' ? hitUnder(ev.clientX, ev.clientY) : null
      const key = col?.dataset.hit || k0.key
      if (type === 'move') { const len = b0 - a0; const a = Math.max(0, Math.min(24 * 60 - len, a0 + d)); g = { type, home: h, w, key, a, b: a + len } }
      else if (type === 'top') g = { type, home: h, w, key: k0.key, a: Math.max(0, Math.min(b0 - 15, a0 + d)), b: b0 }
      else g = { type, home: h, w, key: k0.key, a: a0, b: Math.min(24 * 60, Math.max(a0 + 15, b0 + d)) }
      setGesture(g)
    }
    const up = async (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      if (!moved) { setGesture(null); setPop({ kind: 'window', home: h, w, x: ev.clientX, y: ev.clientY }); return }
      if (g.type === 'select') return
      const a = maltaDate(g.key, g.a), b = maltaDate(g.key, g.b)
      if (a.getTime() === new Date(w.start).getTime() && b.getTime() === new Date(w.end).getTime()) { setGesture(null); return }
      setBusy(true); const r = await api.updateWindow(h.id, w.id, a, b); setBusy(false); setGesture(null); say(r)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPop(null); setPicked(null) } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])

  const step = (n: number) => { if (narrow) { const d = addDays(dayKey, n); setDayKey(d); if (!stripDays.includes(d)) setStart(n > 0 ? d : addDays(d, -6)) } else setStart(s => addDays(s, n * 7)) }
  const goToday = () => { setStart(todayKey()); setDayKey(todayKey()) }
  const title = narrow ? dayLabel(dayKey, { weekday: 'long', day: 'numeric', month: 'long' })
    : `${dayLabel(days[0], { weekday: 'short', day: 'numeric', month: 'short' })} – ${dayLabel(days[6], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`
  const nowM = malta(new Date())

  const requestList = (
    <div className="sc-reqs">
      <div className="sc-reqs-head"><b>Requests</b><span className="sc-count">{requests.length}</span></div>
      {!requests.length && <div className="sc-empty"><Sparkles size={18} aria-hidden="true" /><p>No requests waiting. New ones from the agency appear here.</p></div>}
      <AnimatePresence initial={false}>
        {requests.map(v => <RequestCard key={v.id} v={v} home={homeOf(v.propertyId)} picked={picked?.id === v.id} dragging={drag?.v.id === v.id} reduce={!!reduce} busy={busy}
          onPointerDown={e => startDrag(v, e)} onPick={() => { const on = picked?.id !== v.id; setPicked(on ? v : null); if (on) { const k = malta(new Date(v.startsAt)).key; setDayKey(k); if (!days.includes(k)) setStart(k) } setSheet(false); setPop(null) }}
          onAccept={() => act(() => api.accept(v))} onDecline={note => act(() => api.decline(v, note))} onAsk={text => act(() => api.ask(v, text))} />)}
      </AnimatePresence>
      {upcoming.length > 0 && <>
        <div className="sc-reqs-head sub"><b>Coming up</b></div>
        {upcoming.slice(0, 5).map(v => <button key={v.id} className="sc-next" data-kind={v.kind} onClick={() => { const k = malta(new Date(v.startsAt)).key; setDayKey(k); if (!days.includes(k)) setStart(k) }}>
          {v.kind === 'agency' ? <Check size={14} aria-hidden="true" /> : v.kind === 'reserved' ? <Lock size={14} aria-hidden="true" /> : <UserRound size={14} aria-hidden="true" />}
          <span><b>{whenLabel(v.startsAt)}</b>{homes.length > 1 ? `${homeOf(v.propertyId)?.name} · ` : ''}{v.kind === 'agency' ? v.agent || 'Agency' : v.label}</span></button>)}
      </>}
    </div>
  )

  return (
    <div className="sc">
      <header className="sc-top">
        <div className="sc-title">
          <span className="sc-kicker"><CalendarDays size={14} aria-hidden="true" />Calendar</span>
          <h1>Viewings <span className="sc-grad">at a glance.</span></h1>
        </div>
        <HomePicker homes={homes} value={homeSel} onChange={pickHome} />
      </header>

      {api.sample && (
        <div className="sc-sample" role="status">
          <Sparkles size={16} aria-hidden="true" />
          <span><b>Sample calendar.</b> {ready ? 'Your own homes appear here as soon as the agency has confirmed them. Try everything: nothing here is saved.' : 'Loading your homes…'}</span>
          {canLeaveSample && <button onClick={() => onSample(false)}>Back to my calendar</button>}
        </div>
      )}

      <div className="sc-bar">
        <div className="sc-nav">
          <button onClick={() => step(-1)} aria-label={narrow ? 'Previous day' : 'Previous 7 days'}><ChevronLeft size={18} /></button>
          <button className="sc-today" onClick={goToday}>Today</button>
          <button onClick={() => step(1)} aria-label={narrow ? 'Next day' : 'Next 7 days'}><ChevronRight size={18} /></button>
        </div>
        <span className="sc-range">{title}</span>
        <label className="sc-date"><CalendarClock size={15} aria-hidden="true" /><span className="sr-only">Go to date</span>
          <input type="date" value={narrow ? dayKey : start} onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { setStart(e.target.value); setDayKey(e.target.value) } }} />
        </label>
        {!narrow && <div className="sc-seg" role="group" aria-label="Days shown">
          <button aria-pressed={mode === 'next7'} onClick={() => { setMode('next7'); setStart(todayKey()) }}>Next 7 days</button>
          <button aria-pressed={mode === 'week'} onClick={() => setMode('week')}>Mon–Sun</button>
        </div>}
        {home && <div className="sc-seg" role="group" aria-label="Slot length">
          {[15, 30, 60].map(m => <button key={m} aria-pressed={home.slot === m} disabled={busy} onClick={() => home.slot !== m && act(() => api.setSlot(home.id, m))}>{m} min</button>)}
        </div>}
        <Legend />
        {!api.sample && <button className="sc-link" onClick={() => onSample(true)}>Try the sample</button>}
      </div>

      <AnimatePresence>
        {picked && (
          <motion.div className="sc-pickbar" initial={reduce ? false : { y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={reduce ? undefined : { y: -8, opacity: 0 }}>
            <Hand size={16} aria-hidden="true" /><span>Now tap a time for <b>{picked.agent || 'this request'}</b> ({homeOf(picked.propertyId)?.name}). Its requested time is marked.</span>
            <button onClick={() => setPicked(null)} aria-label="Cancel"><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`sc-split${narrow ? ' narrow' : ''}`}>
        {!narrow && <aside className="sc-side">{requestList}</aside>}

        <section className="sc-cal" aria-label="Calendar">
          {narrow && (
            <div className="sc-strip" role="tablist" aria-label="Day">
              {stripDays.map(k => (
                <button key={k} role="tab" aria-selected={k === dayKey} onClick={() => setDayKey(k)} data-today={k === todayKey() || undefined}>
                  <small>{dayLabel(k, { weekday: 'short' })}</small><b>{dayLabel(k, { day: 'numeric' })}</b>
                  {api.viewings.some(v => malta(new Date(v.startsAt)).key === k && v.status === 'pending' && v.kind === 'agency' && (!home || v.propertyId === home.id)) && <i aria-label="request" />}
                </button>
              ))}
            </div>
          )}
          <div className="sc-scroll">
            <div className="sc-grid" style={{ '--cols': days.length } as React.CSSProperties}>
              <div className="sc-corner" />
              {days.map(k => <div key={k} className="sc-dayhead" data-today={k === nowM.key || undefined}><small>{dayLabel(k, { weekday: 'short' })}</small><b>{dayLabel(k, { day: 'numeric' })}</b></div>)}
              <div className="sc-times" style={{ height: rows * ROW }}>{Array.from({ length: rows }, (_, i) => from + i * STEP).filter(m => m % 60 === 0).map(m => <span key={m} style={{ top: y(m) }}>{hhmm(m)}</span>)}</div>
              {days.map(k => {
                const hoverHere = hover && hover.key === k ? hover : null
                const pickedHere = picked && malta(new Date(picked.startsAt)).key === k ? malta(new Date(picked.startsAt)).min : null
                const dragV = drag?.v || picked
                const g = gesture && gesture.key === k ? gesture : null
                const winsHere = shownHomes.flatMap(h => h.windows.map(w => ({ h, w }))).filter(({ w }) => malta(new Date(w.start)).key === k)
                return (
                  <div key={k} className="sc-day" data-past={k < nowM.key || undefined} style={{ height: rows * ROW }}>
                    {Array.from({ length: rows }, (_, i) => <i key={i} className="sc-line" data-hour={(from + i * STEP) % 60 === 0 || undefined} data-half={(from + i * STEP) % 30 === 0 || undefined} style={{ top: i * ROW }} />)}
                    {k === nowM.key && nowM.min >= from && nowM.min <= to && <span className="sc-now" style={{ top: y(nowM.min) }} aria-hidden="true" />}
                    <div className="sc-hit" data-hit={k} onPointerDown={e => dayDown(k, e)} role="button" tabIndex={-1} aria-label={`Choose a time on ${dayLabel(k, { weekday: 'long', day: 'numeric', month: 'long' })}`} />
                    {/* viewing hours with their bookable slots */}
                    {winsHere.map(({ h, w }) => {
                      const a = malta(new Date(w.start)).min, b = endMin(w, k)
                      const editing = gesture && gesture.type !== 'select' && gesture.w.id === w.id
                      const slots: number[] = []; for (let m = Math.ceil(a / h.slot) * h.slot; m + h.slot <= b; m += h.slot) slots.push(m)
                      return (
                        <div key={`w${w.id}`} className="sc-win" data-own={w.own || undefined} data-prop={w.proposedFor ? true : undefined} data-editing={editing || undefined}
                          style={{ top: y(a), height: Math.max(ROW * 2, y(b) - y(a)), '--hue': h.hue } as React.CSSProperties}>
                          <div className="sc-win-bar" onPointerDown={e => winDown(h, w, 'move', e)} onClick={e => { e.stopPropagation(); if (e.detail === 0) setPop({ kind: 'window', home: h, w, x: e.clientX, y: e.clientY }) }}
                            role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') { const r = (e.target as HTMLElement).getBoundingClientRect(); setPop({ kind: 'window', home: h, w, x: r.left + 20, y: r.bottom }) } }}
                            aria-label={`${w.proposedFor ? 'Proposed time' : 'Viewing hours'} ${hhmm(a)}–${hhmm(b)}${homes.length > 1 ? `, ${h.name}` : ''}`}>
                            {w.own && !w.proposedFor && <GripHorizontal size={12} aria-hidden="true" />}
                            <span>{w.proposedFor ? <><ArrowRight size={11} aria-hidden="true" />Proposed</> : <>{hhmm(a)}–{hhmm(b)}</>}</span>
                            {!home && homes.length > 1 && <small>{h.name}</small>}
                            {!w.own && <small>set by the agency</small>}
                          </div>
                          {!w.proposedFor && slots.map(m => (
                            <button key={m} className="sc-slot" style={{ top: y(m) - y(a), height: (h.slot / STEP) * ROW }}
                              onClick={e => { e.stopPropagation(); if (picked) { setPop({ kind: 'drop', v: picked, slot: { key: k, min: m }, x: e.clientX, y: e.clientY }); return } setPop({ kind: 'slot', slot: { key: k, min: m }, home: h.id, x: e.clientX, y: e.clientY }) }}
                              aria-label={`${hhmm(m)}–${hhmm(m + h.slot)} slot, ${h.name}`}><em>{hhmm(m)}</em></button>
                          ))}
                          {w.own && !w.proposedFor && <>
                            <span className="sc-edge top" onPointerDown={e => winDown(h, w, 'top', e)} aria-hidden="true" />
                            <span className="sc-edge bottom" onPointerDown={e => winDown(h, w, 'bottom', e)} aria-hidden="true" />
                          </>}
                        </div>
                      )
                    })}
                    {/* live feedback while marking, moving or resizing hours */}
                    {g && <motion.span className="sc-sel" data-kind={g.type} initial={false} animate={{ top: y(g.a), height: Math.max(ROW, y(g.b) - y(g.a)) }} transition={{ duration: reduce ? 0 : 0.06 }}>
                      <b>{hhmm(g.a)}–{hhmm(g.b)}</b>
                      {g.type === 'select' && <small>{Math.floor((g.b - g.a) / (home?.slot || 30))} × {home?.slot || 30} min</small>}
                    </motion.span>}
                    {pickedHere != null && <span className="sc-ghostmark" style={{ top: y(pickedHere), height: ROW * 2 }} aria-hidden="true">requested</span>}
                    <AnimatePresence>
                      {hoverHere && dragV && (
                        <motion.span key={`${hoverHere.key}-${hoverHere.min}`} className="sc-target" data-ok={slotFree(dragV, hoverHere) || undefined}
                          initial={reduce ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
                          style={{ top: y(hoverHere.min), height: ((homeOf(dragV.propertyId)?.slot || 30) / STEP) * ROW }}>
                          {slotFree(dragV, hoverHere) ? `${sameTime(dragV, hoverHere) ? 'Accept' : 'Propose'} ${hhmm(hoverHere.min)}` : 'Taken'}
                        </motion.span>
                      )}
                    </AnimatePresence>
                    {/* viewings and the owner's own appointments */}
                    {lanes(visible.filter(v => malta(new Date(v.startsAt)).key === k)).map(({ v, lane, of }) => {
                      const m = malta(new Date(v.startsAt)).min
                      return (
                        <motion.button layout={!reduce} key={`v${v.id}`} className="sc-ev" data-status={v.status} data-kind={v.kind} data-attention={v.attention ? true : undefined}
                          style={{ top: y(m) + 1, height: Math.max(ROW * 2 - 2, (v.durationMin / STEP) * ROW - 2), left: `calc(${(lane / of) * 100}% + 4px)`, width: `calc(${100 / of}% - 8px)`, '--hue': homeOf(v.propertyId)?.hue ?? 222 } as React.CSSProperties}
                          onPointerDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); if (picked) { setPop({ kind: 'drop', v: picked, slot: { key: k, min: m }, x: e.clientX, y: e.clientY }); return } setPop({ kind: 'viewing', v, x: e.clientX, y: e.clientY }) }}>
                          {v.kind === 'reserved' ? <Lock size={12} aria-hidden="true" /> : v.kind === 'manual' ? <UserRound size={12} aria-hidden="true" /> : v.status === 'pending' ? <Clock size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                          <b>{hhmm(m)}</b><span>{v.kind === 'agency' ? v.agent?.split('·')[0].trim() || 'Viewing' : v.label}</span>
                        </motion.button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
          <p className="sc-hint">{narrow ? 'Tap a time to open viewing hours or add your own appointment. Tap a request, then a slot, to give it that time.'
            : 'Drag down a day to open viewing hours · click a slot for its options · drag a request onto a slot · drag the bar or an edge of your hours to move or resize them.'}</p>
        </section>
      </div>

      {narrow && (
        <motion.div className={`sc-sheet${sheet ? ' open' : ''}`} layout={!reduce}>
          <button className="sc-sheet-handle" onClick={() => setSheet(o => !o)} aria-expanded={sheet}>
            <span><b>{requests.length}</b> {requests.length === 1 ? 'request' : 'requests'} waiting</span><ChevronDown size={18} aria-hidden="true" />
          </button>
          {sheet && requestList}
        </motion.div>
      )}

      <AnimatePresence>
        {drag && (
          <motion.div className="sc-drag" style={{ left: drag.x, top: drag.y, '--hue': homeOf(drag.v.propertyId)?.hue ?? 222 } as React.CSSProperties}
            initial={reduce ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1, rotate: reduce ? 0 : -2 }} exit={{ opacity: 0 }}>
            <GripVertical size={14} aria-hidden="true" /><b>{drag.v.agent?.split('·')[0].trim() || 'Request'}</b><span>{hover ? `${dayLabel(hover.key)} ${hhmm(hover.min)}` : 'Drop on a time'}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>{pop && <Popover key={JSON.stringify([pop.kind, pop.x, pop.y])} pop={pop} api={api} homes={homes} busy={busy} reduce={!!reduce} slotFree={slotFree} sameTime={sameTime} homeOf={homeOf} busyAt={busyAt} requests={api.viewings.filter(v => v.status === 'pending' && v.kind === 'agency')}
        onClose={() => setPop(null)} act={act} onPick={v => { setPicked(v); setPop(null) }} onWindow={(h, w, x, yy) => setPop({ kind: 'window', home: h, w, x, y: yy })} />}</AnimatePresence>

      <AnimatePresence>
        {toast && <motion.div className="sc-toast" data-ok={toast.ok || undefined} role="status" initial={reduce ? false : { y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }}>{toast.ok ? <Check size={16} /> : <X size={16} />}{toast.text}</motion.div>}
      </AnimatePresence>
    </div>
  )
}

// compact property selector: nickname (or "Penthouse · Swieqi") with its colour; all homes together when there are several
function HomePicker({ homes, value, onChange }: { homes: Home[]; value: number; onChange: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!open) return; const d = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }; window.addEventListener('mousedown', d); return () => window.removeEventListener('mousedown', d) }, [open])
  if (!homes.length) return null
  const cur = homes.find(h => h.id === value)
  return (
    <div className="sc-picker" ref={box}>
      <span className="sc-picker-label">Property</span>
      <button className="sc-picker-btn" onClick={() => homes.length > 1 && setOpen(o => !o)} aria-haspopup={homes.length > 1 ? 'listbox' : undefined} aria-expanded={open} disabled={homes.length < 2}
        style={{ '--hue': cur?.hue ?? 222 } as React.CSSProperties}>
        <i aria-hidden="true" data-all={!cur || undefined} /><b>{cur ? cur.name : 'All homes'}</b>{homes.length > 1 && <ChevronDown size={16} aria-hidden="true" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul className="sc-picker-menu" role="listbox" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <li><button role="option" aria-selected={!cur} onClick={() => { onChange(0); setOpen(false) }}><i data-all aria-hidden="true" />All homes<small>{homes.length}</small></button></li>
            {homes.map(h => <li key={h.id}><button role="option" aria-selected={h.id === value} onClick={() => { onChange(h.id); setOpen(false) }} style={{ '--hue': h.hue } as React.CSSProperties}><i aria-hidden="true" />{h.name}<small>Ref {h.ref}</small></button></li>)}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

function lanes(list: CalViewing[]) {
  const sorted = [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const out: { v: CalViewing; lane: number; of: number }[] = []
  let group: typeof out = [], groupEnd = 0
  const flush = () => { const of = Math.max(1, ...group.map(g => g.lane + 1)); for (const g of group) out.push({ ...g, of }); group = [] }
  for (const v of sorted) {
    const a = new Date(v.startsAt).getTime(), b = a + Math.max(v.durationMin, 30) * 60e3
    if (group.length && a >= groupEnd) { flush(); groupEnd = 0 }
    const used = new Set(group.filter(g => new Date(g.v.startsAt).getTime() + Math.max(g.v.durationMin, 30) * 60e3 > a).map(g => g.lane))
    let lane = 0; while (used.has(lane)) lane++
    group.push({ v, lane, of: 1 }); groupEnd = Math.max(groupEnd, b)
  }
  flush()
  return out
}

function Legend() {
  return (
    <div className="sc-legend" aria-label="Legend">
      <span data-k="open">Open hours</span>
      <span data-k="pending"><Clock size={12} aria-hidden="true" />Request</span>
      <span data-k="confirmed"><Check size={12} aria-hidden="true" />Booked</span>
      <span data-k="manual"><UserRound size={12} aria-hidden="true" />Yours</span>
      <span data-k="reserved"><Lock size={12} aria-hidden="true" />Reserved</span>
    </div>
  )
}

function party(v: CalViewing) {
  const p = v.party
  return [p.size ? `${p.size} ${p.size === 1 ? 'person' : 'people'}` : null, p.type ? titleCase(p.type) : null, p.job].filter(Boolean).join(' · ')
}

function RequestCard({ v, home, picked, dragging, reduce, busy, onPointerDown, onPick, onAccept, onDecline, onAsk }: {
  v: CalViewing; home?: Home; picked: boolean; dragging: boolean; reduce: boolean; busy: boolean
  onPointerDown: (e: React.PointerEvent) => void; onPick: () => void; onAccept: () => void; onDecline: (note: string) => void; onAsk: (text: string) => void
}) {
  const [mode, setMode] = useState<null | 'decline' | 'ask'>(null)
  const [text, setText] = useState('')
  const past = new Date(v.startsAt).getTime() < Date.now()
  return (
    <motion.article layout={!reduce} className="sc-req" data-picked={picked || undefined} data-dragging={dragging || undefined} style={{ '--hue': home?.hue ?? 222 } as React.CSSProperties}
      initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: dragging ? 0.45 : 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, x: -24, height: 0, marginBottom: 0 }}
      onPointerDown={onPointerDown}>
      <div className="sc-req-top">
        <span className="sc-grip" aria-hidden="true"><GripVertical size={16} /></span>
        <span className="sc-avatar" aria-hidden="true">{(v.agent || 'A').trim()[0]}</span>
        <div className="sc-req-who"><b>{v.agent?.split('·')[0].trim() || 'Agency'}</b><small>{v.agent?.includes('·') ? v.agent.split('·')[1].trim() : 'Agency'}{v.round > 1 ? ` · request ${v.round}` : ''}</small></div>
        <span className="sc-chip"><Clock size={12} aria-hidden="true" />Waiting</span>
      </div>
      <p className="sc-req-when"><CalendarClock size={15} aria-hidden="true" />{whenLabel(v.startsAt)}<span>{v.durationMin} min</span></p>
      <p className="sc-req-home"><i aria-hidden="true" />{home?.name || `Ref ${v.ref}`}</p>
      {party(v) && <p className="sc-req-party"><UsersRound size={14} aria-hidden="true" />{party(v)}</p>}
      {v.note && <p className="sc-req-note">“{v.note}”</p>}
      <AnimatePresence initial={false}>
        {mode && (
          <motion.div className="sc-req-form" initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <textarea rows={2} maxLength={400} value={text} onChange={e => setText(e.target.value)} placeholder={mode === 'ask' ? 'Your question to the agency' : 'Optional: why not (the agency sees this)'} autoFocus />
            <div><button className="sc-btn quiet" onClick={() => { setMode(null); setText('') }}>Cancel</button>
              <button className="sc-btn" disabled={busy || (mode === 'ask' && !text.trim())} onClick={() => { (mode === 'ask' ? onAsk : onDecline)(text.trim()); setMode(null); setText('') }}>{mode === 'ask' ? 'Send question' : 'Decline'}</button></div>
          </motion.div>
        )}
      </AnimatePresence>
      {!mode && (
        <div className="sc-req-actions">
          <button className="sc-btn ok" disabled={busy || past} onClick={onAccept} title={past ? 'This time has passed' : undefined}><Check size={15} aria-hidden="true" />Accept</button>
          <button className="sc-btn" disabled={busy} onClick={onPick} aria-pressed={picked}><CalendarDays size={15} aria-hidden="true" />{picked ? 'Picking…' : 'Other time'}</button>
          <button className="sc-btn quiet" disabled={busy} onClick={() => setMode('ask')} aria-label="Ask a question"><MessageCircle size={15} aria-hidden="true" /></button>
          <button className="sc-btn quiet" disabled={busy} onClick={() => setMode('decline')} aria-label="Decline"><X size={15} aria-hidden="true" /></button>
        </div>
      )}
    </motion.article>
  )
}

const TIMES = Array.from({ length: 24 * 4 + 1 }, (_, i) => i * 15)
function TimeSelect({ value, onChange, min = 0, max = 24 * 60, label }: { value: number; onChange: (m: number) => void; min?: number; max?: number; label: string }) {
  return <select className="sc-time" aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))}>{TIMES.filter(m => m >= min && m <= max).map(m => <option key={m} value={m}>{m === 24 * 60 ? '24:00' : hhmm(m)}</option>)}</select>
}

function Popover({ pop, api, homes, busy, reduce, slotFree, sameTime, homeOf, busyAt, requests, onClose, act, onPick, onWindow }: {
  pop: Pop; api: Api; homes: Home[]; busy: boolean; reduce: boolean
  slotFree: (v: CalViewing | null, s: Slot) => boolean; sameTime: (v: CalViewing, s: Slot) => boolean; homeOf: (id: number) => Home | undefined
  busyAt: (home: number, start: Date, minutes: number, except?: number) => CalViewing | undefined; requests: CalViewing[]
  onClose: () => void; act: (fn: () => Promise<Result>) => Promise<Result>; onPick: (v: CalViewing) => void; onWindow: (h: Home, w: Win, x: number, y: number) => void
}) {
  const initialHome = (pop.kind === 'slot' || pop.kind === 'range') ? pop.home || homes[0]?.id || 0 : 0
  const [hid, setHid] = useState<number>(initialHome)
  const [form, setForm] = useState<null | 'appointment'>(null)
  const [who, setWho] = useState('')
  const [len, setLen] = useState(20)
  const [weeks, setWeeks] = useState(0)
  const [ra, setRa] = useState(pop.kind === 'range' ? pop.a : pop.kind === 'slot' ? pop.slot.min : 0)
  const [rb, setRb] = useState(pop.kind === 'range' ? pop.b : pop.kind === 'slot' ? pop.slot.min + 180 : 0)
  const wa = pop.kind === 'window' ? malta(new Date(pop.w.start)) : null
  const [wa0, setWa0] = useState(wa ? wa.min : 0)
  const [wb0, setWb0] = useState(pop.kind === 'window' ? endMin(pop.w, wa!.key) : 0)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: pop.x, top: pop.y })
  useEffect(() => {
    const el = box.current; if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    setPos({ left: Math.max(12, Math.min(window.innerWidth - w - 12, pop.x - w / 2)), top: pop.y + h + 24 > window.innerHeight ? Math.max(12, pop.y - h - 14) : pop.y + 14 })
  }, [pop, form])
  useEffect(() => { const d = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }; setTimeout(() => window.addEventListener('mousedown', d), 0); return () => window.removeEventListener('mousedown', d) }, [onClose])
  const homeChips = homes.length > 1 && <div className="sc-pop-homes">{homes.map(h => <button key={h.id} aria-pressed={hid === h.id} onClick={() => setHid(h.id)} style={{ '--hue': h.hue } as React.CSSProperties}><i />{h.name}</button>)}</div>
  const repeat = <label className="sc-repeat"><Repeat size={14} aria-hidden="true" />Every week for
    <select value={weeks} onChange={e => setWeeks(Number(e.target.value))} aria-label="Repeat weekly">{[0, 3, 7, 11].map(n => <option key={n} value={n}>{n === 0 ? 'this day only' : `${n + 1} weeks`}</option>)}</select></label>
  let body: React.ReactNode

  if (pop.kind === 'range') {
    const h = homeOf(hid); const a = maltaDate(pop.key, ra), b = maltaDate(pop.key, rb)
    const n = h ? Math.floor((rb - ra) / h.slot) : 0
    body = <>
      <b className="sc-pop-title">Open for viewings</b>
      <p className="sc-pop-sub">{dayLabel(pop.key, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      <div className="sc-times-row"><TimeSelect label="From" value={ra} onChange={setRa} max={rb - 15} /><span>to</span><TimeSelect label="Until" value={rb} onChange={setRb} min={ra + 15} /></div>
      {homeChips}
      {h && <p className="sc-pop-note">{n > 0 ? `${n} bookable slot${n > 1 ? 's' : ''} of ${h.slot} minutes for ${h.name}.` : `Shorter than one ${h.slot}-minute slot.`}</p>}
      {repeat}
      <button className="sc-btn ok wide" disabled={busy || !h || a.getTime() < Date.now() - 5 * 60e3} onClick={() => act(() => api.addWindow(hid, a, b, weeks))}><Check size={16} />Open {hhmm(ra)}–{rb === 24 * 60 ? '24:00' : hhmm(rb)}</button>
      {a.getTime() < Date.now() - 5 * 60e3 && <p className="sc-pop-warn">This time has passed.</p>}
    </>
  } else if (pop.kind === 'slot') {
    const h = homeOf(hid)
    const slotLen = h?.slot || 30
    const st = maltaDate(pop.slot.key, pop.slot.min)
    const label = `${dayLabel(pop.slot.key, { weekday: 'long', day: 'numeric', month: 'short' })}, ${hhmm(pop.slot.min)}–${hhmm(pop.slot.min + slotLen)}`
    const there = h ? busyAt(h.id, st, slotLen) : undefined
    const win = h?.windows.find(w => { const k = malta(new Date(w.start)); return k.key === pop.slot.key && k.min <= pop.slot.min && endMin(w, k.key) > pop.slot.min })
    const future = st.getTime() > Date.now() - 5 * 60e3
    const waiting = requests.filter(v => h && v.propertyId === h.id)
    body = <>
      <b className="sc-pop-title">{label}</b>
      {homeChips || (h && <p className="sc-pop-sub" style={{ '--hue': h.hue } as React.CSSProperties}><i className="sc-dot" />{h.name}{win ? ` · ${win.own ? 'your hours' : 'agency hours'}` : ''}</p>)}
      {there ? <>
        <p className="sc-pop-state" data-status={there.status}>{there.kind === 'agency' ? (there.status === 'pending' ? <><Clock size={14} />Request from {there.agent || 'the agency'}</> : <><Check size={14} />Booked by {there.agent || 'the agency'}</>) : <><UserRound size={14} />{there.label}</>}</p>
        <p className="sc-pop-note">{whenLabel(there.startsAt)} · {there.durationMin} min{party(there) ? ` · ${party(there)}` : ''}</p>
      </> : !future ? <p className="sc-pop-warn">This time has passed.</p> : form === 'appointment' ? <>
        <input className="sc-input" autoFocus maxLength={60} value={who} onChange={e => setWho(e.target.value)} placeholder="Who? e.g. Neighbour, Maria" aria-label="Who is coming" />
        <div className="sc-seg small" role="group" aria-label="Length">{[10, 20].map(m => <button key={m} aria-pressed={len === m} onClick={() => setLen(m)}>{m} min</button>)}</div>
        <p className="sc-pop-note">Confirmed at once and kept free for you: agencies cannot book over it.</p>
        <div className="sc-pop-durs"><button className="sc-btn quiet" onClick={() => setForm(null)}>Back</button>
          <button className="sc-btn ok" disabled={busy || !h} onClick={() => act(() => api.appointment(hid, st, len, 'manual', who.trim()))}><Check size={15} />Add appointment</button></div>
      </> : <>
        <div className="sc-actions">
          <button className="sc-act" disabled={busy || !h} onClick={() => setForm('appointment')}><UserRound size={16} /><span><b>Add your own appointment</b><small>Someone you show it to yourself, e.g. a neighbour</small></span></button>
          <button className="sc-act" disabled={busy || !h} onClick={() => act(() => api.appointment(hid, st, 20, 'reserved', ''))}><Lock size={16} /><span><b>Reserve this slot</b><small>Keep it free; nobody can book it</small></span></button>
          {waiting.length > 0 && <div className="sc-assign"><small>Give this time to a request</small>
            {waiting.slice(0, 4).map(v => <button key={v.id} className="sc-act tight" disabled={busy} onClick={() => act(() => (sameTime(v, pop.slot) ? api.accept(v) : api.propose(v, st)))}>
              <span className="sc-avatar small" aria-hidden="true">{(v.agent || 'A').trim()[0]}</span><span><b>{v.agent?.split('·')[0].trim() || 'Agency'}</b><small>asked {whenLabel(v.startsAt)} · {sameTime(v, pop.slot) ? 'accept' : 'propose this time'}</small></span></button>)}
          </div>}
          {win ? (win.own && <button className="sc-act" onClick={() => onWindow(h!, win, pop.x, pop.y)}><Clock size={16} /><span><b>Change these hours</b><small>Move, shorten, extend or remove</small></span></button>)
            : <div className="sc-open"><small>Open viewing hours from {hhmm(pop.slot.min)}</small>
              <div className="sc-pop-durs">{[60, 120, 180].map(m => <button key={m} className="sc-btn" disabled={busy || !h || pop.slot.min + m > 24 * 60} onClick={() => act(() => api.addWindow(hid, st, new Date(st.getTime() + m * 60e3), weeks))}>{m / 60} h</button>)}</div>
              {repeat}</div>}
        </div>
      </>}
    </>
  } else if (pop.kind === 'drop') {
    const v = pop.v, ok = slotFree(v, pop.slot), same = sameTime(v, pop.slot), start = maltaDate(pop.slot.key, pop.slot.min)
    const h = homeOf(v.propertyId)
    const inHours = h?.windows.some(w => new Date(w.start) <= start && new Date(w.end) >= new Date(start.getTime() + 20 * 60e3))
    body = <>
      <b className="sc-pop-title">{dayLabel(pop.slot.key, { weekday: 'long', day: 'numeric', month: 'short' })}, {hhmm(pop.slot.min)}</b>
      <p className="sc-pop-sub">{v.agent?.split('·')[0].trim() || 'Request'} · {h?.name}</p>
      {!ok ? <p className="sc-pop-warn">Not possible: this time has passed, is more than 60 days away, or another viewing of {h?.name || 'this home'} is booked then.</p>
        : same ? <button className="sc-btn ok wide" disabled={busy} onClick={() => act(() => api.accept(v))}><Check size={16} />Accept this viewing</button>
          : <>
            <p className="sc-pop-note">You propose {hhmm(pop.slot.min)} to the agent. ARGUS closes the current request and holds this time; the agent books it with the client.{!inHours ? ' It is outside your viewing hours.' : ''}</p>
            <button className="sc-btn ok wide" disabled={busy} onClick={() => act(() => api.propose(v, start))}><ArrowRight size={16} />Propose {hhmm(pop.slot.min)}</button>
          </>}
    </>
  } else if (pop.kind === 'viewing') {
    const v = pop.v
    body = <>
      <b className="sc-pop-title">{whenLabel(v.startsAt)}</b>
      <p className="sc-pop-sub">{v.kind === 'agency' ? `${v.agent || 'Agency'} · ` : ''}{homeOf(v.propertyId)?.name}</p>
      {v.kind === 'agency' && party(v) && <p className="sc-pop-sub"><UsersRound size={13} /> {party(v)}</p>}
      {v.kind !== 'agency'
        ? <p className="sc-pop-state" data-status="confirmed">{v.kind === 'reserved' ? <><Lock size={14} />Reserved by you</> : <><UserRound size={14} />{v.label} · your appointment</>}</p>
        : <p className="sc-pop-state" data-status={v.status}>{v.status === 'pending' ? <><Clock size={14} />Waiting for your answer</> : v.status === 'confirmed' ? <><Check size={14} />Confirmed</> : v.status === 'done' ? <><Check size={14} />Done</> : titleCase(v.status)}</p>}
      {v.attention && <p className="sc-pop-warn">{v.attention}</p>}
      {v.kind === 'agency' && v.status === 'pending' && new Date(v.startsAt).getTime() > Date.now() && <div className="sc-pop-durs">
        <button className="sc-btn ok" disabled={busy} onClick={() => act(() => api.accept(v))}><Check size={14} />Accept</button>
        <button className="sc-btn" disabled={busy} onClick={() => onPick(v)}><CalendarDays size={14} />Other time</button>
        <button className="sc-btn quiet" disabled={busy} onClick={() => act(() => api.decline(v, ''))}><X size={14} />Decline</button>
      </div>}
      {v.kind !== 'agency' && v.status === 'confirmed' && <button className="sc-btn quiet wide" disabled={busy} onClick={() => act(() => api.cancelAppointment(v))}><Trash2 size={14} />Remove from my calendar</button>}
    </>
  } else {
    const { home: h, w } = pop
    const key = wa!.key
    body = <>
      <b className="sc-pop-title">{w.proposedFor ? 'Proposed time' : 'Viewing hours'}</b>
      <p className="sc-pop-sub">{h.name} · {dayLabel(key, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      {w.proposedFor ? <p className="sc-pop-note">You proposed this time to the agent. It becomes a viewing when they book it.</p>
        : !w.own ? <p className="sc-pop-note">The agency set these hours ({hhmm(wa0)}–{hhmm(wb0)}). Ask them in Messages to change them.</p> : <>
          <div className="sc-times-row"><TimeSelect label="From" value={wa0} onChange={setWa0} max={wb0 - 15} /><span>to</span><TimeSelect label="Until" value={wb0} onChange={setWb0} min={wa0 + 15} /></div>
          <p className="sc-pop-note">{Math.floor((wb0 - wa0) / h.slot)} slots of {h.slot} minutes. Bookings that end up outside stay, and the agency is told to re-arrange them.</p>
          <button className="sc-btn ok wide" disabled={busy || (wa0 === wa!.min && wb0 === endMin(w, key))} onClick={() => act(() => api.updateWindow(h.id, w.id, maltaDate(key, wa0), maltaDate(key, wb0)))}><Check size={15} />Save {hhmm(wa0)}–{wb0 === 24 * 60 ? '24:00' : hhmm(wb0)}</button>
          <div className="sc-open"><small>Same hours on the following weeks</small>
            <div className="sc-pop-durs">{[1, 3, 7].map(n => <button key={n} className="sc-btn" disabled={busy} onClick={() => act(() => api.addWindow(h.id, maltaDate(addDays(key, 7), wa0), maltaDate(addDays(key, 7), wb0), n - 1))}><Repeat size={13} />{n === 1 ? 'Next week' : `${n} weeks`}</button>)}</div></div>
          <button className="sc-btn quiet wide" disabled={busy} onClick={() => act(() => api.removeWindow(h.id, w.id))}><Trash2 size={14} />Remove these hours</button>
        </>}
    </>
  }
  return (
    <motion.div ref={box} className="sc-pop" role="dialog" aria-label="Calendar action" style={pos}
      initial={reduce ? false : { opacity: 0, scale: 0.96, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, scale: 0.97 }} transition={{ duration: 0.14 }}>
      <button className="sc-pop-x" onClick={onClose} aria-label="Close"><X size={15} /></button>
      {body}
      {busy && <span className="sc-pop-busy" aria-live="polite">Saving with ARGUS…</span>}
    </motion.div>
  )
}

// small entry for the overview and a home's page
export function CalendarTeaser({ homeId }: { homeId?: number }) {
  return (
    <Link href={homeId ? `/owner/calendar?home=${homeId}` : '/owner/calendar'} className="sc-teaser">
      <CalendarDays size={18} aria-hidden="true" /><span><b>Calendar</b><small>Requests, viewings and your hours</small></span><MousePointerClick size={16} aria-hidden="true" />
    </Link>
  )
}
