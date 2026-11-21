'use client'
// NEXUS Sync calendar (2026-11-21). Left: incoming viewing requests. Main: week / day grid in Malta time.
// Two ways to act on a request, both doing the same backend operation:
//   drag the request onto a time slot (mouse or finger), or tap the request, then tap a slot.
// Same time as requested -> accept. Another time -> propose it to the agent (ARGUS cancels this request and opens a
// 30-minute window at the proposed time; the agent re-books). A tap on an empty slot opens viewing hours there.
// Nothing shows as done until ARGUS answered; overlapping viewings are refused by the database itself.
// Without confirmed homes, a clearly labelled sample calendar (local only, nothing saved) keeps the page useful.
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, CalendarClock, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, GripVertical, Hand, MessageCircle, MousePointerClick, Plus, Sparkles, Trash2, UsersRound, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { liveProperties, sync, type LiveListing, type LiveViewing } from '@/lib/owner/live'

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
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const dayLabel = (key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric' }) => maltaDate(key, 12 * 60).toLocaleDateString('en-GB', { ...opts, timeZone: TZ })
const whenLabel = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const todayKey = () => malta(new Date()).key

// ── data shape shared by the live and the sample calendar ─────────────────────────────────────────────────────
type Win = { id: number; start: string; end: string; own: boolean; proposedFor: number | null }
type Home = { id: number; name: string; ref: string; hue: number; windows: Win[] }
type Result = { ok: true; text: string } | { ok: false; text: string }
type Api = {
  sample: boolean
  homes: Home[]
  viewings: LiveViewing[]
  accept: (v: LiveViewing) => Promise<Result>
  decline: (v: LiveViewing, note: string) => Promise<Result>
  propose: (v: LiveViewing, start: Date) => Promise<Result>
  addWindow: (home: number, start: Date, end: Date) => Promise<Result>
  removeWindow: (home: number, id: number) => Promise<Result>
  ask: (v: LiveViewing, text: string) => Promise<Result>
}
const HUES = [222, 12, 152, 268, 38, 190]

function useLiveApi(): Api {
  const s = useOwner()
  const listings = useMemo(() => liveProperties(s.live.owner), [s.live.owner])
  const homes = useMemo<Home[]>(() => listings.map((l: LiveListing, i) => ({
    id: l.sourcePropertyId, ref: l.ref, hue: HUES[i % HUES.length],
    name: l.state?.nickname || `${l.facts.type ? l.facts.type[0].toUpperCase() + l.facts.type.slice(1) : 'Home'} in ${l.facts.locality || 'Malta'}`,
    windows: ((l.state?.windows || []) as Win[]).map(w => ({ id: w.id, start: w.start, end: w.end, own: !!w.own, proposedFor: w.proposedFor ?? null })),
  })), [listings])
  const run = useCallback(async (op: string, body: Record<string, unknown>, okText: string): Promise<Result> => {
    const r = await sync(op, body)
    if (!r.ok) return { ok: false, text: r.message }
    await s.refreshLive()
    return { ok: true, text: okText }
  }, [s])
  // another representative or the agency may change things: refresh every 45 s and when the tab comes back
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') s.refreshLive() }, 45000)
    const f = () => s.refreshLive(); window.addEventListener('focus', f)
    return () => { clearInterval(t); window.removeEventListener('focus', f) }
  }, [s])
  return {
    sample: false, homes, viewings: s.live.viewings,
    accept: v => run('owner/viewings/decide', { viewingId: v.id, decision: 'accept' }, `Viewing confirmed for ${whenLabel(v.startsAt)}. The agency sees it now.`),
    decline: (v, note) => run('owner/viewings/decide', { viewingId: v.id, decision: 'decline', note }, 'Declined. The agency is told.'),
    propose: (v, at) => run('owner/viewings/decide', { viewingId: v.id, decision: 'propose', proposeStart: at.toISOString() }, `${whenLabel(at.toISOString())} proposed. The agent re-books at that time.`),
    addWindow: (home, a, b) => run('owner/window/add', { propertyId: home, start: a.toISOString(), end: b.toISOString() }, `Open for viewings ${hhmm(malta(a).min)}–${hhmm(malta(b).min)}.`),
    removeWindow: (home, id) => run('owner/window/remove', { propertyId: home, windowId: id }, 'Viewing hours removed.'),
    ask: async (v, text) => {
      const r = await sync('messages/send', { text: `About the viewing request ${whenLabel(v.startsAt)} (Ref ${v.ref}): ${text}`.slice(0, 900), propertyId: v.propertyId })
      return r.ok ? { ok: true, text: 'Question sent to the agency.' } : { ok: false, text: r.message }
    },
  }
}

// Sample calendar: two homes, requests and hours around this week. Local only, clearly labelled, nothing is saved.
function useSampleApi(): Api {
  const seed = useMemo(() => {
    const t = todayKey(); const at = (d: number, min: number) => maltaDate(addDays(t, d), min).toISOString()
    const end = (iso: string, min: number) => new Date(new Date(iso).getTime() + min * 60e3).toISOString()
    const homes: Home[] = [
      { id: 1, name: 'Sea-view apartment in Sliema', ref: 'S-101', hue: 222, windows: [] },
      { id: 2, name: 'Maisonette in Swieqi', ref: 'S-102', hue: 12, windows: [] },
    ]
    const w = (h: number, d: number, a: number, b: number, own = true) => homes[h].windows.push({ id: Math.round(Math.random() * 1e9), start: at(d, a), end: end(at(d, a), b - a), own, proposedFor: null })
    w(0, 1, 17 * 60, 19 * 60); w(0, 3, 10 * 60, 12 * 60, false); w(1, 2, 16 * 60, 18 * 60); w(1, 5, 11 * 60, 13 * 60)
    const v = (id: number, home: number, d: number, min: number, status: string, agent: string, size: number, type: string, job: string | null, note: string | null): LiveViewing => ({ id, propertyId: home, ref: homes.find(h => h.id === home)!.ref, startsAt: at(d, min), durationMin: 20, status, decision: status === 'confirmed' ? 'confirmed' : 'pending', round: 1, note, declineText: null, party: { size, type, job }, agent })
    const viewings = [
      v(901, 1, 1, 17 * 60 + 30, 'pending', 'Olga · 2906 Estate', 2, 'couple', 'Software engineer', 'Moving from Berlin in January, long let.'),
      v(902, 2, 2, 16 * 60 + 30, 'pending', 'Adrian · 2906 Estate', 1, 'single', 'Nurse', null),
      v(903, 1, 4, 18 * 60, 'pending', 'Kevin · 2906 Estate', 3, 'family', 'Teacher', 'Family with one child, flexible on the date.'),
      v(904, 2, 1, 11 * 60, 'confirmed', 'Olga · 2906 Estate', 2, 'couple', 'Designer', null),
      v(905, 1, 3, 10 * 60 + 30, 'confirmed', 'Adrian · 2906 Estate', 1, 'single', 'Accountant', null),
    ]
    return { homes, viewings }
  }, [])
  const [homes, setHomes] = useState(seed.homes)
  const [viewings, setViewings] = useState(seed.viewings)
  const clash = (home: number, start: Date, min: number, except?: number) => viewings.find(x => x.propertyId === home && x.id !== except && ['pending', 'confirmed'].includes(x.status) &&
    new Date(x.startsAt).getTime() < start.getTime() + min * 60e3 && new Date(x.startsAt).getTime() + x.durationMin * 60e3 > start.getTime())
  const wait = () => new Promise(r => setTimeout(r, 380))
  return {
    sample: true, homes, viewings,
    accept: async v => { await wait(); setViewings(vs => vs.map(x => (x.id === v.id ? { ...x, status: 'confirmed', decision: 'confirmed' } : x))); return { ok: true, text: `Sample: viewing confirmed for ${whenLabel(v.startsAt)}.` } },
    decline: async v => { await wait(); setViewings(vs => vs.map(x => (x.id === v.id ? { ...x, status: 'cancelled', decision: 'declined' } : x))); return { ok: true, text: 'Sample: declined.' } },
    propose: async (v, at) => {
      await wait(); const c = clash(v.propertyId, at, 30, v.id)
      if (c) return { ok: false, text: `Another viewing is already booked at ${whenLabel(c.startsAt)}. Choose a free time.` }
      setViewings(vs => vs.map(x => (x.id === v.id ? { ...x, status: 'cancelled', decision: 'declined' } : x)))
      setHomes(hs => hs.map(h => (h.id === v.propertyId ? { ...h, windows: [...h.windows, { id: Date.now(), start: at.toISOString(), end: new Date(at.getTime() + 30 * 60e3).toISOString(), own: true, proposedFor: v.id }] } : h)))
      return { ok: true, text: `Sample: ${whenLabel(at.toISOString())} proposed to the agent.` }
    },
    addWindow: async (home, a, b) => {
      await wait()
      if (homes.find(h => h.id === home)?.windows.some(w => new Date(w.start) < b && new Date(w.end) > a)) return { ok: false, text: 'You already have viewing hours at this time.' }
      setHomes(hs => hs.map(h => (h.id === home ? { ...h, windows: [...h.windows, { id: Date.now(), start: a.toISOString(), end: b.toISOString(), own: true, proposedFor: null }] } : h)))
      return { ok: true, text: `Sample: open for viewings ${hhmm(malta(a).min)}–${hhmm(malta(b).min)}.` }
    },
    removeWindow: async (home, id) => { await wait(); setHomes(hs => hs.map(h => (h.id === home ? { ...h, windows: h.windows.filter(w => w.id !== id) } : h))); return { ok: true, text: 'Sample: hours removed.' } },
    ask: async () => { await wait(); return { ok: true, text: 'Sample: question sent.' } },
  }
}

// ── the calendar ─────────────────────────────────────────────────────────────────────────────────────────────
const ROW = 30            // px per 30 minutes
const STEP = 30           // minutes per slot
type Slot = { key: string; min: number }
type Pop = { kind: 'slot'; slot: Slot; x: number; y: number } | { kind: 'viewing'; v: LiveViewing; x: number; y: number } | { kind: 'window'; home: Home; w: Win; x: number; y: number } | { kind: 'drop'; v: LiveViewing; slot: Slot; x: number; y: number }

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
  const [view, setView] = useState<'week' | 'day'>('week')
  useEffect(() => { if (narrow) setView('day') }, [narrow])
  const [anchor, setAnchor] = useState(todayKey())
  const [homeFilter, setHomeFilter] = useState<number | 0>(0)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const h = Number(q.get('home')); if (h) setHomeFilter(h)
    const d = q.get('day'); if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) { setAnchor(d); jumped.current = true }
  }, [])
  const [picked, setPicked] = useState<LiveViewing | null>(null)        // tap-tap mode
  const [drag, setDrag] = useState<{ v: LiveViewing; x: number; y: number } | null>(null)
  const [hover, setHover] = useState<Slot | null>(null)
  const [pop, setPop] = useState<Pop | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Result | null>(null)
  const [sheet, setSheet] = useState(false)
  const grid = useRef<HTMLDivElement>(null)
  const say = (r: Result) => { setToast(r); setTimeout(() => setToast(t => (t === r ? null : t)), 4200) }

  const homes = api.homes
  const homeOf = (id: number) => homes.find(h => h.id === id)
  // first load: when this week holds nothing but requests are waiting, open the week of the first request
  const jumped = useRef(false)
  useEffect(() => {
    if (jumped.current || !api.viewings.length) return
    jumped.current = true
    const wk = Array.from({ length: 7 }, (_, i) => addDays(monday(todayKey()), i))
    const inWeek = api.viewings.some(v => v.status !== 'cancelled' && wk.includes(malta(new Date(v.startsAt)).key))
    const next = api.viewings.filter(v => v.status === 'pending' && new Date(v.startsAt).getTime() > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
    if (!inWeek && next) setAnchor(malta(new Date(next.startsAt)).key)
  }, [api.viewings])
  const shownHomes = homeFilter ? homes.filter(h => h.id === homeFilter) : homes
  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(monday(anchor), i)) : [anchor]
  const visible = api.viewings.filter(v => !homeFilter || v.propertyId === homeFilter)
  const requests = visible.filter(v => v.status === 'pending').sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const upcoming = visible.filter(v => v.status === 'confirmed' && new Date(v.startsAt).getTime() > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt))

  // hours shown: 08–21, widened to whatever the week holds
  const [from, to] = useMemo(() => {
    let a = 8 * 60, b = 21 * 60
    const inDays = (iso: string) => days.includes(malta(new Date(iso)).key)
    for (const v of visible) if (inDays(v.startsAt)) { const m = malta(new Date(v.startsAt)).min; a = Math.min(a, Math.floor(m / 60) * 60); b = Math.max(b, Math.ceil((m + v.durationMin) / 60) * 60) }
    for (const h of shownHomes) for (const w of h.windows) if (inDays(w.start)) { a = Math.min(a, Math.floor(malta(new Date(w.start)).min / 60) * 60); b = Math.max(b, Math.min(24 * 60, Math.ceil(malta(new Date(w.end)).min / 60) * 60 || 24 * 60)) }
    return [a, b]
  }, [visible, shownHomes, days.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (to - from) / STEP

  const slotAt = (key: string, clientY: number, el: HTMLElement): Slot => {
    const r = el.getBoundingClientRect()
    const min = from + Math.max(0, Math.min(rows - 1, Math.floor((clientY - r.top) / ROW))) * STEP
    return { key, min }
  }
  const slotFree = (v: LiveViewing | null, slot: Slot) => {
    const start = maltaDate(slot.key, slot.min)
    if (start.getTime() < Date.now() + 15 * 60e3 || start.getTime() > Date.now() + 60 * 86400e3) return false
    if (!v) return true
    return !api.viewings.some(x => x.propertyId === v.propertyId && x.id !== v.id && ['pending', 'confirmed'].includes(x.status) &&
      new Date(x.startsAt).getTime() < start.getTime() + 30 * 60e3 && new Date(x.startsAt).getTime() + x.durationMin * 60e3 > start.getTime())
  }
  const sameTime = (v: LiveViewing, slot: Slot) => { const m = malta(new Date(v.startsAt)); return m.key === slot.key && Math.floor(m.min / STEP) === Math.floor(slot.min / STEP) }

  const act = async (fn: () => Promise<Result>) => { setBusy(true); const r = await fn(); setBusy(false); say(r); if (r.ok) { setPop(null); setPicked(null) } return r }

  // the day column under the pointer, even when a viewing or hours block lies on top of the slot
  const hitUnder = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('.sc-day')?.querySelector<HTMLElement>('[data-hit]') || null
  // pointer drag (mouse + touch) of a request card onto a slot
  const startDrag = (v: LiveViewing, e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,a,textarea,input')) return
    const x0 = e.clientX, y0 = e.clientY; let moving = false
    const move = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
      moving = true; ev.preventDefault(); setDrag({ v, x: ev.clientX, y: ev.clientY }); setSheet(false)
      const el = hitUnder(ev.clientX, ev.clientY)
      setHover(el ? slotAt(el.dataset.hit!, ev.clientY, el) : null)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', esc)
      if (!moving) return
      const el = hitUnder(ev.clientX, ev.clientY)
      setDrag(null); setHover(null)
      if (el) { const slot = slotAt(el.dataset.hit!, ev.clientY, el); setPop({ kind: 'drop', v, slot, x: ev.clientX, y: ev.clientY }) }
    }
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { setDrag(null); setHover(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) } }
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('keydown', esc)
  }
  // while a request is picked, a tap on any block also means "this time"
  const pickDrop = (e: React.MouseEvent) => { if (!picked) return false; const el = hitUnder(e.clientX, e.clientY); if (!el) return false; setPop({ kind: 'drop', v: picked, slot: slotAt(el.dataset.hit!, e.clientY, el), x: e.clientX, y: e.clientY }); return true }
  const hitClick = (key: string, e: React.MouseEvent<HTMLDivElement>) => {
    const slot = slotAt(key, e.clientY, e.currentTarget)
    setPop(picked ? { kind: 'drop', v: picked, slot, x: e.clientX, y: e.clientY } : { kind: 'slot', slot, x: e.clientX, y: e.clientY })
  }
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPop(null); setPicked(null) } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])

  const nav = (n: number) => setAnchor(a => addDays(a, n * (view === 'week' ? 7 : 1)))
  const title = view === 'week'
    ? `${dayLabel(days[0], { day: 'numeric', month: 'short' })} – ${dayLabel(days[6], { day: 'numeric', month: 'short', year: 'numeric' })}`
    : dayLabel(anchor, { weekday: 'long', day: 'numeric', month: 'long' })
  const nowM = malta(new Date())

  const requestList = (
    <div className="sc-reqs">
      <div className="sc-reqs-head"><b>Requests</b><span className="sc-count">{requests.length}</span></div>
      {!requests.length && <div className="sc-empty"><Sparkles size={18} aria-hidden="true" /><p>No requests waiting. New ones from the agency appear here.</p></div>}
      <AnimatePresence initial={false}>
        {requests.map(v => <RequestCard key={v.id} v={v} home={homeOf(v.propertyId)} picked={picked?.id === v.id} dragging={drag?.v.id === v.id} reduce={!!reduce} busy={busy}
          onPointerDown={e => startDrag(v, e)} onPick={() => { const on = picked?.id !== v.id; setPicked(on ? v : null); if (on) setAnchor(malta(new Date(v.startsAt)).key); setSheet(false); setPop(null) }}
          onAccept={() => act(() => api.accept(v))} onDecline={note => act(() => api.decline(v, note))} onAsk={text => act(() => api.ask(v, text))} />)}
      </AnimatePresence>
      {upcoming.length > 0 && <>
        <div className="sc-reqs-head sub"><b>Confirmed next</b></div>
        {upcoming.slice(0, 4).map(v => <div key={v.id} className="sc-next"><Check size={14} aria-hidden="true" /><span><b>{whenLabel(v.startsAt)}</b>{homeOf(v.propertyId)?.name} · {v.agent || 'Agency'}</span></div>)}
      </>}
    </div>
  )

  return (
    <div className="sc">
      <header className="sc-top">
        <div className="sc-title">
          <span className="sc-kicker"><CalendarDays size={14} aria-hidden="true" />Calendar</span>
          <h1>Viewings <span className="sc-grad">at a glance.</span></h1>
          <p>Drag a request onto a time, or tap it and then tap a slot. Tap an empty slot to open viewing hours.</p>
        </div>
        <div className="sc-controls">
          <div className="sc-seg" role="group" aria-label="View">
            <button aria-pressed={view === 'week'} onClick={() => setView('week')} disabled={narrow}>Week</button>
            <button aria-pressed={view === 'day'} onClick={() => setView('day')}>Day</button>
          </div>
          <div className="sc-nav">
            <button onClick={() => nav(-1)} aria-label="Previous"><ChevronLeft size={18} /></button>
            <button className="sc-today" onClick={() => setAnchor(todayKey())}>Today</button>
            <button onClick={() => nav(1)} aria-label="Next"><ChevronRight size={18} /></button>
          </div>
        </div>
      </header>

      {api.sample && (
        <div className="sc-sample" role="status">
          <Sparkles size={16} aria-hidden="true" />
          <span><b>Sample calendar.</b> {ready ? 'Your own homes appear here as soon as the agency has confirmed them. Try everything: nothing here is saved.' : 'Loading your homes…'}</span>
          {canLeaveSample && <button onClick={() => onSample(false)}>Back to my calendar</button>}
        </div>
      )}

      <div className="sc-bar">
        <div className="sc-homes" role="group" aria-label="Home">
          {homes.length > 1 && <button aria-pressed={!homeFilter} onClick={() => setHomeFilter(0)}>All homes</button>}
          {homes.map(h => <button key={h.id} aria-pressed={homeFilter === h.id || homes.length === 1} onClick={() => setHomeFilter(h.id)} style={{ '--hue': h.hue } as React.CSSProperties}><i aria-hidden="true" />{h.name}</button>)}
        </div>
        <span className="sc-range">{title}</span>
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
              {Array.from({ length: 7 }, (_, i) => addDays(monday(anchor), i)).map(k => (
                <button key={k} role="tab" aria-selected={k === anchor} onClick={() => setAnchor(k)} data-today={k === todayKey() || undefined}>
                  <small>{dayLabel(k, { weekday: 'short' })}</small><b>{dayLabel(k, { day: 'numeric' })}</b>
                  {api.viewings.some(v => malta(new Date(v.startsAt)).key === k && v.status === 'pending' && (!homeFilter || v.propertyId === homeFilter)) && <i aria-label="request" />}
                </button>
              ))}
            </div>
          )}
          <div className="sc-grid" ref={grid} style={{ '--cols': days.length } as React.CSSProperties}>
            <div className="sc-corner" />
            {days.map(k => <div key={k} className="sc-dayhead" data-today={k === nowM.key || undefined}><small>{dayLabel(k, { weekday: 'short' })}</small><b>{dayLabel(k, { day: 'numeric' })}</b></div>)}
            <div className="sc-times" style={{ height: rows * ROW }}>{Array.from({ length: rows }, (_, i) => from + i * STEP).filter(m => m % 60 === 0).map(m => <span key={m} style={{ top: ((m - from) / STEP) * ROW }}>{hhmm(m)}</span>)}</div>
            {days.map(k => {
              const hoverHere = hover && hover.key === k ? hover : null
              const pickedHere = picked && malta(new Date(picked.startsAt)).key === k ? malta(new Date(picked.startsAt)).min : null
              const dragV = drag?.v || picked
              return (
                <div key={k} className="sc-day" data-past={k < nowM.key || undefined} style={{ height: rows * ROW }}>
                  {Array.from({ length: rows }, (_, i) => <i key={i} className="sc-line" data-hour={(from + i * STEP) % 60 === 0 || undefined} style={{ top: i * ROW }} />)}
                  {k === nowM.key && nowM.min >= from && nowM.min <= to && <span className="sc-now" style={{ top: ((nowM.min - from) / STEP) * ROW }} aria-hidden="true" />}
                  <div className="sc-hit" data-hit={k} onClick={e => hitClick(k, e)} role="button" tabIndex={-1} aria-label={`Choose a time on ${dayLabel(k, { weekday: 'long', day: 'numeric', month: 'long' })}`} />
                  {/* viewing hours (background) */}
                  {shownHomes.flatMap(h => h.windows.map(w => ({ h, w }))).filter(({ w }) => malta(new Date(w.start)).key === k).map(({ h, w }) => {
                    const a = malta(new Date(w.start)).min, b = malta(new Date(w.end)).key === k ? malta(new Date(w.end)).min : 24 * 60
                    return (
                      <button key={`w${w.id}`} className="sc-win" data-own={w.own || undefined} data-prop={w.proposedFor ? true : undefined}
                        style={{ top: ((a - from) / STEP) * ROW, height: Math.max(ROW / 2, ((b - a) / STEP) * ROW), '--hue': h.hue } as React.CSSProperties}
                        onClick={e => { e.stopPropagation(); if (pickDrop(e)) return; setPop({ kind: 'window', home: h, w, x: e.clientX, y: e.clientY }) }}>
                        <span>{w.proposedFor ? <><ArrowRight size={11} aria-hidden="true" />Proposed</> : <>Open {hhmm(a)}–{hhmm(b % (24 * 60))}</>}</span>
                        {!homeFilter && homes.length > 1 && <small>{h.name}</small>}
                      </button>
                    )
                  })}
                  {/* the requested time of the picked request */}
                  {pickedHere != null && <span className="sc-ghostmark" style={{ top: ((pickedHere - from) / STEP) * ROW, height: ROW }} aria-hidden="true">requested</span>}
                  {/* slot highlight while dragging */}
                  <AnimatePresence>
                    {hoverHere && dragV && (
                      <motion.span key={`${hoverHere.key}-${hoverHere.min}`} className="sc-target" data-ok={slotFree(dragV, hoverHere) || undefined}
                        initial={reduce ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
                        style={{ top: ((hoverHere.min - from) / STEP) * ROW, height: ROW }}>
                        {slotFree(dragV, hoverHere) ? `${sameTime(dragV, hoverHere) ? 'Accept' : 'Propose'} ${hhmm(hoverHere.min)}` : 'Taken'}
                      </motion.span>
                    )}
                  </AnimatePresence>
                  {/* viewings */}
                  {lanes(visible.filter(v => malta(new Date(v.startsAt)).key === k && v.status !== 'cancelled')).map(({ v, lane, of }) => {
                    const m = malta(new Date(v.startsAt)).min
                    return (
                      <motion.button layout={!reduce} key={`v${v.id}`} className="sc-ev" data-status={v.status}
                        style={{ top: ((m - from) / STEP) * ROW + 1, height: Math.max(ROW - 2, (v.durationMin / STEP) * ROW - 2), left: `calc(${(lane / of) * 100}% + 3px)`, width: `calc(${100 / of}% - 6px)`, '--hue': homeOf(v.propertyId)?.hue ?? 222 } as React.CSSProperties}
                        onClick={e => { e.stopPropagation(); if (pickDrop(e)) return; setPop({ kind: 'viewing', v, x: e.clientX, y: e.clientY }) }}>
                        {v.status === 'pending' ? <Clock size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                        <b>{hhmm(m)}</b><span>{v.agent?.split('·')[0].trim() || 'Viewing'}</span>
                      </motion.button>
                    )
                  })}
                </div>
              )
            })}
          </div>
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

      {/* drag ghost */}
      <AnimatePresence>
        {drag && (
          <motion.div className="sc-drag" style={{ left: drag.x, top: drag.y, '--hue': homeOf(drag.v.propertyId)?.hue ?? 222 } as React.CSSProperties}
            initial={reduce ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1, rotate: reduce ? 0 : -2 }} exit={{ opacity: 0 }}>
            <GripVertical size={14} aria-hidden="true" /><b>{drag.v.agent?.split('·')[0].trim() || 'Request'}</b><span>{hover ? `${dayLabel(hover.key)} ${hhmm(hover.min)}` : 'Drop on a time'}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>{pop && <Popover pop={pop} api={api} homes={homes} homeFilter={homeFilter} busy={busy} reduce={!!reduce} slotFree={slotFree} sameTime={sameTime} homeOf={homeOf}
        onClose={() => setPop(null)} act={act} onPick={v => { setPicked(v); setPop(null) }} />}</AnimatePresence>

      <AnimatePresence>
        {toast && <motion.div className="sc-toast" data-ok={toast.ok || undefined} role="status" initial={reduce ? false : { y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }}>{toast.ok ? <Check size={16} /> : <X size={16} />}{toast.text}</motion.div>}
      </AnimatePresence>
    </div>
  )
}

function lanes(list: LiveViewing[]) {
  const sorted = [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const out: { v: LiveViewing; lane: number; of: number }[] = []
  let group: typeof out = [], groupEnd = 0
  const flush = () => { const of = Math.max(1, ...group.map(g => g.lane + 1)); for (const g of group) out.push({ ...g, of }); group = [] }
  for (const v of sorted) {
    const a = new Date(v.startsAt).getTime(), b = a + v.durationMin * 60e3
    if (group.length && a >= groupEnd) { flush(); groupEnd = 0 }
    const used = new Set(group.filter(g => new Date(g.v.startsAt).getTime() + g.v.durationMin * 60e3 > a).map(g => g.lane))
    let lane = 0; while (used.has(lane)) lane++
    group.push({ v, lane, of: 1 }); groupEnd = Math.max(groupEnd, b)
  }
  flush()
  return out
}

function Legend() {
  return (
    <div className="sc-legend" aria-label="Legend">
      <span data-k="pending"><Clock size={12} aria-hidden="true" />Waiting for you</span>
      <span data-k="confirmed"><Check size={12} aria-hidden="true" />Confirmed</span>
      <span data-k="open">Open hours</span>
      <span data-k="prop"><ArrowRight size={12} aria-hidden="true" />Proposed</span>
    </div>
  )
}

function party(v: LiveViewing) {
  const p = v.party
  return [p.size ? `${p.size} ${p.size === 1 ? 'person' : 'people'}` : null, p.type ? p.type[0].toUpperCase() + p.type.slice(1) : null, p.job].filter(Boolean).join(' · ')
}

function RequestCard({ v, home, picked, dragging, reduce, busy, onPointerDown, onPick, onAccept, onDecline, onAsk }: {
  v: LiveViewing; home?: Home; picked: boolean; dragging: boolean; reduce: boolean; busy: boolean
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

function Popover({ pop, api, homes, homeFilter, busy, reduce, slotFree, sameTime, homeOf, onClose, act, onPick }: {
  pop: Pop; api: Api; homes: Home[]; homeFilter: number; busy: boolean; reduce: boolean
  slotFree: (v: LiveViewing | null, s: Slot) => boolean; sameTime: (v: LiveViewing, s: Slot) => boolean; homeOf: (id: number) => Home | undefined
  onClose: () => void; act: (fn: () => Promise<Result>) => Promise<Result>; onPick: (v: LiveViewing) => void
}) {
  const [home, setHome] = useState<number>(homeFilter || homes[0]?.id || 0)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: pop.x, top: pop.y })
  useEffect(() => {
    const el = box.current; if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    setPos({ left: Math.max(12, Math.min(window.innerWidth - w - 12, pop.x - w / 2)), top: pop.y + h + 24 > window.innerHeight ? Math.max(12, pop.y - h - 14) : pop.y + 14 })
  }, [pop])
  useEffect(() => { const d = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }; setTimeout(() => window.addEventListener('mousedown', d), 0); return () => window.removeEventListener('mousedown', d) }, [onClose])
  let body: React.ReactNode
  if (pop.kind === 'slot' || pop.kind === 'drop') {
    const start = maltaDate(pop.slot.key, pop.slot.min)
    const label = `${dayLabel(pop.slot.key, { weekday: 'long', day: 'numeric', month: 'short' })}, ${hhmm(pop.slot.min)}`
    if (pop.kind === 'drop') {
      const v = pop.v, ok = slotFree(v, pop.slot), same = sameTime(v, pop.slot)
      body = <>
        <b className="sc-pop-title">{label}</b>
        <p className="sc-pop-sub">{v.agent?.split('·')[0].trim() || 'Request'} · {homeOf(v.propertyId)?.name}</p>
        {!ok ? <p className="sc-pop-warn">This time is not possible: it has passed, is more than 60 days away, or another viewing of this home is booked then.</p>
          : same ? <button className="sc-btn ok wide" disabled={busy} onClick={() => act(() => api.accept(v))}><Check size={16} />Accept this viewing</button>
            : <>
              <p className="sc-pop-note">You propose this time to the agent. ARGUS closes the current request and opens this slot; the agent books it with the client.</p>
              <button className="sc-btn ok wide" disabled={busy} onClick={() => act(() => api.propose(v, start))}><ArrowRight size={16} />Propose {hhmm(pop.slot.min)}</button>
            </>}
      </>
    } else {
      const free = slotFree(null, pop.slot)
      body = <>
        <b className="sc-pop-title">{label}</b>
        {!free ? <p className="sc-pop-warn">Choose a time from 15 minutes from now, within the next three months.</p> : homes.length === 0 ? <p className="sc-pop-warn">No home yet.</p> : <>
          <p className="sc-pop-sub">Open this time for viewings</p>
          {homes.length > 1 && <div className="sc-pop-homes">{homes.map(h => <button key={h.id} aria-pressed={home === h.id} onClick={() => setHome(h.id)} style={{ '--hue': h.hue } as React.CSSProperties}><i />{h.name}</button>)}</div>}
          <div className="sc-pop-durs">{[30, 60, 120, 180].map(m => <button key={m} className="sc-btn" disabled={busy || !home} onClick={() => act(() => api.addWindow(home, start, new Date(start.getTime() + m * 60e3)))}><Plus size={14} />{m < 60 ? `${m} min` : `${m / 60} h`}</button>)}</div>
        </>}
      </>
    }
  } else if (pop.kind === 'viewing') {
    const v = pop.v
    body = <>
      <b className="sc-pop-title">{whenLabel(v.startsAt)}</b>
      <p className="sc-pop-sub">{v.agent || 'Agency'} · {homeOf(v.propertyId)?.name}</p>
      {party(v) && <p className="sc-pop-sub"><UsersRound size={13} /> {party(v)}</p>}
      <p className="sc-pop-state" data-status={v.status}>{v.status === 'pending' ? <><Clock size={14} />Waiting for your answer</> : v.status === 'confirmed' ? <><Check size={14} />Confirmed</> : v.status}</p>
      {v.status === 'pending' && new Date(v.startsAt).getTime() > Date.now() && <div className="sc-pop-durs">
        <button className="sc-btn ok" disabled={busy} onClick={() => act(() => api.accept(v))}><Check size={14} />Accept</button>
        <button className="sc-btn" disabled={busy} onClick={() => onPick(v)}><CalendarDays size={14} />Other time</button>
        <button className="sc-btn quiet" disabled={busy} onClick={() => act(() => api.decline(v, ''))}><X size={14} />Decline</button>
      </div>}
    </>
  } else {
    const { home: h, w } = pop
    body = <>
      <b className="sc-pop-title">{w.proposedFor ? 'Proposed time' : 'Open for viewings'}</b>
      <p className="sc-pop-sub">{h.name} · {whenLabel(w.start)} – {new Date(w.end).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}</p>
      <p className="sc-pop-note">{w.proposedFor ? 'You proposed this time to the agent. It becomes a viewing when they book it.' : w.own ? 'Agents can book viewings inside these hours.' : 'The agency set these hours. Ask them in the chat to change them.'}</p>
      {w.own && <button className="sc-btn quiet wide" disabled={busy} onClick={() => act(() => api.removeWindow(h.id, w.id))}><Trash2 size={14} />Remove</button>}
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
