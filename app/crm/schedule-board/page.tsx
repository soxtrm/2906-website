'use client'
// ============================================================================
// /schedule-board — the internal availability + location board.
//
// Filter row → Google Map → card grid, all three driven by one filter state
// that is mirrored into the URL so a search is bookmarkable and shareable.
//
// Data comes from /api/crm/schedule-board/* (see routes/crmScheduleBoard.js),
// which is firewalled: no street, no apt, no owner. The exact address is
// reduced server-side to `hasViewingLocation`, which is what enables the
// "Request Viewing-Location" button.
// ============================================================================
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { AnimatePresence } from 'framer-motion'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { CrmProvider, CrmShell, A, AD, AB, NAVY, F, FM, useCrm, useIsMobile } from '@/lib/crm/ui'
import { TOWNS, townKey, townLabel, townCoord, spread } from '@/lib/crm/towns'
import { BoardFilters, type BoardFilterValue } from '@/components/crm/board-filters'
import { AskDialog, BookDialog, StatusDialog, type StatusAction } from '@/components/crm/board-dialogs'

// "Mine" is navy rather than a separate green: on this board the distinction
// that matters is whose listing it is, and navy is the brand's own way of
// saying "ours". The availability traffic-light stays on AVAIL/VIEW.
const GREEN = NAVY
const GREEN_SOFT = 'rgba(27,42,74,0.08)'
const CARD = '#FFFDFA'
// The Maps key normally arrives from the backend (GET schedule-board/config),
// which hands it to logged-in agents only. A NEXT_PUBLIC_GOOGLE_MAPS_KEY still
// wins if one is set, but it would be inlined into a publicly downloadable
// chunk — and this repo is public — so the served key is the better default.
const BUNDLED_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || ''

type Listing = {
  id: number; ref: string; town: string | null; subLocation: string | null
  type: string | null; beds: number | null; baths: number | null
  sizeSqm: number | null; price: number | null; salePrice: number | null
  shortlet: boolean; availableStatus: string | null; availableDate: string | null
  viewingStatus: string | null; hasViewingLocation: boolean; exclusive: boolean
  // The upload timestamp. Sorted server-side, but carried here because the
  // client re-groups cards by town to place the pins and would otherwise lose
  // the server's newest-first ordering.
  createdAt: string | null
  // When somebody last pressed "Available" on this card, and why it last moved.
  lastConfirmedAvailableAt: string | null
  statusChangeReason: string | null
  // The firewall's verdict, decided by boardAction.emitPinPrecision. Always
  // 'locality_only' today: a pin is a village, never a doorstep.
  pinPrecision?: string | null
  // now / soon / a real date, decided server-side so the chip and the filter
  // can never disagree. Anything not clearly free now or dated is 'soon'.
  availability?: { kind: 'now' | 'soon' | 'date'; date: string | null; label: string }
  // Street name, no number, own listings only. null on everybody else's.
  streetName?: string | null
  // Read off the listing's own wording by services/listingRules.js.
  // true = it says yes · false = it says no · null = it does not say.
  // Three states on purpose: "no pets" and "nobody wrote it down" are different
  // answers to give a client, so null is never drawn as either.
  petFriendly?: boolean | null
  sharing?: boolean | null
  images: string[]; imageCount: number
  listedBy: { id: number | null; displayName: string | null; colorHex: string | null }
  isMine: boolean
  // Decided server-side: whether the two contact buttons are live, and the
  // sentence to show when they are not. The browser only renders the verdict.
  contact: {
    mode: 'owner' | 'agent'
    reachesName: string | null
    canAsk: boolean
    reason: string | null
    questionsUsed: number
    questionsPerDay: number
    canQuestion: boolean
    questionReason: string | null
  }
}

type Filters = BoardFilterValue & { towns: string[] }
const EMPTY: Filters = { q: '', beds: '', baths: '', min: '', max: '', type: '', towns: [] }

// Newest-first is the default because it is what the board is for: the listing
// that just came in is the one being asked about. The backend owns the actual
// ORDER BY (routes/crmScheduleBoard.js SORTS) — these are the options it
// accepts, and the label the menu shows.
const SORTS: Array<[string, string]> = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['stalest', 'Needs confirming'],
  ['confirmed', 'Just confirmed'],
  ['price_low', 'Price ↑'],
  ['price_high', 'Price ↓'],
]
const DEFAULT_SORT = 'newest'

// The next N months as { value: 'YYYY-MM', label: 'October 2026' }, starting
// with the current one — generated rather than hardcoded so the dropdown never
// offers a month that is already gone.
function nextMonths(n: number): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  const base = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    out.push({
      value: `${d.getFullYear()}-${mm}`,
      label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    })
  }
  return out
}

type Rect = { north: number; south: number; east: number; west: number }
// Centre + radius in metres. Kev asked for a circle because that is how an area
// is actually described ("within 2 km of Sliema"); a rectangle only happens to
// be easier to draw. google.maps.Circle is still supported — unlike
// DrawingManager, which was removed in Maps JS 3.65 and throws on use.
type Circ = { lat: number; lng: number; r: number }

function circToParam(c: Circ): string {
  return [c.lat.toFixed(5), c.lng.toFixed(5), Math.round(c.r)].join(',')
}
function parseCirc(s: string | null): Circ | null {
  if (!s) return null
  const p = s.split(',').map(Number)
  if (p.length !== 3 || p.some(n => !Number.isFinite(n))) return null
  const [lat, lng, r] = p
  if (r <= 0) return null
  return { lat, lng, r }
}
// Equirectangular approximation — at Malta's scale the error is centimetres,
// and it avoids pulling in a geo library for one distance check.
function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000
  const dLat = (bLat - aLat) * Math.PI / 180
  const dLng = (bLng - aLng) * Math.PI / 180
  const mLat = (aLat + bLat) / 2 * Math.PI / 180
  const x = dLng * Math.cos(mLat)
  return Math.sqrt(dLat * dLat + x * x) * R
}

// The drawn area travels in the URL as rect=north,south,east,west so a shared
// link restores the box, not just the filter row.
function rectToParam(r: Rect): string {
  return [r.north, r.south, r.east, r.west].map(n => n.toFixed(5)).join(',')
}
function parseRect(s: string | null): Rect | null {
  if (!s) return null
  const p = s.split(',').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) return null
  const [north, south, east, west] = p
  if (north <= south || east <= west) return null
  return { north, south, east, west }
}

// ── page ────────────────────────────────────────────────────────────────────
export default function ScheduleBoardPage() {
  return <CrmProvider><Board /></CrmProvider>
}

function Board() {
  const params = useSearchParams()
  const isMobile = useIsMobile()
  const { me } = useCrm()

  // Filters initialise from the URL so a shared link restores the search.
  const [f, setF] = useState<Filters>(() => ({
    q: params.get('q') || '',
    beds: params.get('beds') || '',
    baths: params.get('baths') || '',
    min: params.get('min') || '',
    max: params.get('max') || '',
    type: params.get('type') || '',
    towns: (params.get('towns') || '').split(',').map(s => s.trim()).filter(Boolean),
  }))
  const [rect, setRect] = useState<Rect | null>(() => parseRect(params.get('rect')))
  const [circ, setCirc] = useState<Circ | null>(() => parseCirc(params.get('circ')))
  const [sort, setSort] = useState<string>(() => {
    const s = params.get('sort') || ''
    return SORTS.some(([v]) => v === s) ? s : DEFAULT_SORT
  })
  // 'board' = the active worklist (available + available_confirmed).
  // 'recheck' = the review queue, everything at pending_check: listings where
  // the classifier could not read an owner's reply, plus anything flagged by
  // hand. Two separate endpoints, one grid.
  const [view, setView] = useState<'board' | 'recheck'>(
    params.get('view') === 'recheck' ? 'recheck' : 'board')
  const [onlyConfirmed, setOnlyConfirmed] = useState(params.get('only_confirmed') === '1')
  // '' | 'now' | 'soon' | 'dated' | 'YYYY-MM'. The server owns what each means
  // (the ?avail= / ?avail_from= branches in crmScheduleBoard.js).
  const [avail, setAvail] = useState<string>(() => params.get('avail') || params.get('avail_from') || '')
  const [rows, setRows] = useState<Listing[]>([])
  const [recheckCount, setRecheckCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [focusRef, setFocusRef] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [booking, setBooking] = useState<Listing | null>(null)
  const [asking, setAsking] = useState<Listing | null>(null)
  const [statusing, setStatusing] = useState<{ r: Listing; action: StatusAction } | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const showToast = useCallback((kind: 'ok' | 'err' | 'info', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(t => (t && t.text === text ? null : t)), 5200)
  }, [])

  // ── URL mirror ────────────────────────────────────────────────────────────
  // history.replaceState, not router.replace: the URL here is a shareable
  // mirror of local state, nothing re-reads it after mount (the filters and
  // rect initialise from it once, above). router.replace would make every
  // keystroke a navigation with an RSC round trip, and once the round trip is
  // slow enough the route remounts mid-word — the initialiser then re-reads an
  // older ?q= and the characters typed in between are gone. Typing "Sliema"
  // over the production origin landed as "Slie".
  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams()
      if (f.q) q.set('q', f.q)
      if (f.beds) q.set('beds', f.beds)
      if (f.baths) q.set('baths', f.baths)
      if (f.min) q.set('min', f.min)
      if (f.max) q.set('max', f.max)
      if (f.type) q.set('type', f.type)
      if (f.towns.length) q.set('towns', f.towns.join(','))
      if (rect) q.set('rect', rectToParam(rect))
      if (circ) q.set('circ', circToParam(circ))
      if (sort !== DEFAULT_SORT) q.set('sort', sort)
      if (view !== 'board') q.set('view', view)
      if (onlyConfirmed) q.set('only_confirmed', '1')
      if (avail) q.set(/^[0-9]{4}-[0-9]{2}$/.test(avail) ? 'avail_from' : 'avail', avail)
      const qs = q.toString()
      window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
    }, 200)
    return () => clearTimeout(t)
  }, [f, rect, circ, sort, view, onlyConfirmed, avail])

  // ── fetch ─────────────────────────────────────────────────────────────────
  // Server-side filters are the numeric/enum ones. Town selection is applied
  // client-side because the canonical-town folding (Gzira/Gżira, five
  // spellings of St Paul's Bay) lives in the browser table, not in SQL.
  // Bumped after a question is sent, so the per-listing daily counter and the
  // greyed-out state come back from the server rather than being guessed here.
  const [refreshTick, setRefreshTick] = useState(0)
  const reload = useCallback(() => setRefreshTick(t => t + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const q = new URLSearchParams()
    if (f.beds) q.set('beds', f.beds)
    if (f.baths) q.set('baths', f.baths)
    if (f.min) q.set('price_min', f.min)
    if (f.max) q.set('price_max', f.max)
    if (f.type) q.set('type', f.type)
    q.set('sort', sort)
    if (onlyConfirmed) q.set('only_confirmed', '1')
    if (avail) q.set(/^[0-9]{4}-[0-9]{2}$/.test(avail) ? 'avail_from' : 'avail', avail)
    // The review queue is its own endpoint — pending_check is excluded from
    // /listings by the active filter, which is the point of both.
    const path = view === 'recheck'
      ? 'schedule-board/review-queue'
      : `schedule-board/listings?${q.toString()}`
    crmFetch(path)
      .then(d => { if (!alive) return; setRows(d.listings || []); setErr(null) })
      .catch(e => { if (alive) setErr(e?.message || 'Could not load listings') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [f.beds, f.baths, f.min, f.max, f.type, sort, view, onlyConfirmed, avail, refreshTick])

  // The recheck tab's badge. Fetched separately so the count is visible while
  // the agent is on the board — an unread review queue that only announces
  // itself once you open it is a queue nobody empties.
  useEffect(() => {
    let alive = true
    crmFetch('schedule-board/review-queue')
      .then(d => { if (alive) setRecheckCount((d.listings || []).length) })
      .catch(() => { if (alive) setRecheckCount(0) })
    return () => { alive = false }
  }, [refreshTick])

  // ── town index + positions ────────────────────────────────────────────────
  // Every listing gets a stable coordinate: town centre plus a deterministic
  // offset so listings in one village fan out instead of stacking.
  const positioned = useMemo(() => {
    const byTown: Record<string, Listing[]> = {}
    for (const r of rows) {
      const k = townKey(r.town) || '_unknown'
      ;(byTown[k] ||= []).push(r)
    }
    // Grouping by town is how the pins fan out; it must NOT become a re-sort of
    // the cards. Positions are collected into a map and then read back in the
    // server's order — the previous version pushed rows out town-bucket by
    // town-bucket, which silently clustered the grid by village and threw the
    // newest-first ordering away before it ever reached a card.
    const pos = new Map<string, { lat: number | null; lng: number | null; tkey: string }>()
    for (const [k, list] of Object.entries(byTown)) {
      const base = k === '_unknown' ? null : TOWNS[k]
      list.forEach((r, i) => {
        const p = base ? spread(base, i, list.length) : null
        pos.set(r.ref, { lat: p?.lat ?? null, lng: p?.lng ?? null, tkey: k })
      })
    }
    return rows.map(r => ({
      ...r,
      ...(pos.get(r.ref) || { lat: null, lng: null, tkey: '_unknown' }),
    }))
  }, [rows])

  const townOptions = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of rows) {
      const k = townKey(r.town)
      if (k) counts[k] = (counts[k] || 0) + 1
    }
    return Object.entries(counts)
      .map(([k, n]) => ({ key: k, label: TOWNS[k].label, n }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
  }, [rows])

  // ── visible set: filters ∩ town selection ∩ drawn rectangle ───────────────
  const visible = useMemo(() => {
    // Free text matches ref, town or sub-location. Applied here rather than in
    // SQL because the whole result set is already local — typing filters at
    // keystroke speed instead of a round trip per character.
    const needle = f.q.trim().toLowerCase()
    return positioned.filter(r => {
      if (f.towns.length && !f.towns.includes(r.tkey)) return false
      if (needle) {
        const hay = [r.ref, r.town, r.subLocation, r.type].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      if (rect) {
        if (r.lat == null || r.lng == null) return false
        if (r.lat > rect.north || r.lat < rect.south) return false
        if (r.lng > rect.east || r.lng < rect.west) return false
      }
      if (circ) {
        if (r.lat == null || r.lng == null) return false
        if (metresBetween(circ.lat, circ.lng, r.lat, r.lng) > circ.r) return false
      }
      return true
    })
  }, [positioned, f.towns, f.q, rect, circ])

  const mineCount = visible.filter(r => r.isMine).length

  function toggleTown(k: string) {
    setF(s => ({ ...s, towns: s.towns.includes(k) ? s.towns.filter(x => x !== k) : [...s.towns, k] }))
  }
  function reset() { setF(EMPTY); setRect(null); setCirc(null) }

  const onMarkerClick = useCallback((ref: string) => {
    setFocusRef(ref)
    const el = cardRefs.current[ref]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => setFocusRef(cur => (cur === ref ? null : cur)), 2400)
  }, [])

  // ── WhatsApp actions ──────────────────────────────────────────────────────
  // Fire-and-forget: the button never blocks, the result arrives as a toast.
  // Questions used to be a window.prompt straight down the wire. They now go
  // through AskDialog — write, rewrite, read, confirm — so `act` is left with
  // only the two one-click requests.
  async function act(kind: 'request-availability' | 'request-location', r: Listing) {
    const note: string | null = null
    showToast('info', kind === 'request-availability' && r.isMine
      ? `Contacting the owner of #${r.ref}…`
      : `Sending to ${r.listedBy.displayName || 'listing agent'}…`)
    try {
      const d = await crmJson(`schedule-board/listings/${encodeURIComponent(r.ref)}/${kind}`, 'POST', { note })
      if (d.status === 'dry_run') {
        showToast('info', `${d.message} (Fall A is not armed yet)`)
      } else {
        showToast('ok', d.message || `Sent for #${r.ref}.`)
      }
    } catch (e: any) {
      const d = e?.data || {}
      showToast('err', d.message || d.error || e?.message || 'Request failed')
    }
  }

  // ── availability buttons ──────────────────────────────────────────────────
  // "Available" is one click and nothing else: no dialog, no confirmation, no
  // message to anybody. The card stays exactly where it is and its timestamp
  // moves to now — which is why pressing it a second time is a real action and
  // not a no-op the UI should swallow.
  //
  // Optimistic, then reconciled with what the server actually wrote. The
  // operator clicked because they already know the answer; making them wait on
  // a round trip to see it is how a card gets clicked twice.
  const [busyRef, setBusyRef] = useState<string | null>(null)

  async function checkIn(r: Listing) {
    if (busyRef) return
    setBusyRef(r.ref)
    const optimistic = new Date().toISOString()
    setRows(rs => rs.map(x => x.ref === r.ref
      ? { ...x, availableStatus: 'available_confirmed', lastConfirmedAvailableAt: optimistic, statusChangeReason: null }
      : x))
    try {
      const d = await crmJson(
        `schedule-board/listings/${encodeURIComponent(r.ref)}/check-in`, 'POST', {})
      // Confirming is how a listing LEAVES the review queue, so in that view the
      // row goes; on the board it stays put with a fresh timestamp.
      if (view === 'recheck') {
        setRows(rs => rs.filter(x => x.ref !== r.ref))
        setRecheckCount(n => Math.max(0, n - 1))
      } else {
        // Take the server's timestamp over ours — the card should show what is
        // in the database, not what this browser guessed a moment ago.
        setRows(rs => rs.map(x => x.ref === r.ref
          ? { ...x, availableStatus: d.availableStatus || 'available_confirmed',
                    lastConfirmedAvailableAt: d.lastConfirmedAvailableAt || optimistic }
          : x))
      }
      showToast('ok', d.message || `#${r.ref} confirmed available.`)
    } catch (e: any) {
      // Put the card back the way it was. A refusal here is almost always the
      // rented/archived guard, and the reason matters more than the failure.
      setRows(rs => rs.map(x => x.ref === r.ref
        ? { ...x, availableStatus: r.availableStatus, lastConfirmedAvailableAt: r.lastConfirmedAvailableAt }
        : x))
      const d = e?.data || {}
      showToast('err', d.error || d.message || e?.message || 'Could not confirm this listing.')
      reload()
    } finally {
      setBusyRef(null)
    }
  }

  // The three removals all go through StatusDialog, which owns the POST so it
  // can show a refusal in place rather than as a toast over an empty gap. The
  // card is pulled the moment the server confirms — nothing is deleted, it has
  // just stopped being active, and it is still in Inventory and its history.
  function onStatusDone(msg: string, ref: string) {
    setRows(rs => rs.filter(x => x.ref !== ref))
    showToast('ok', msg)
    // Refresh the recheck badge — a card that just moved to pending_check is
    // now one more thing waiting in that queue.
    setRefreshTick(t => t + 1)
  }

  // ── filter bar ────────────────────────────────────────────────────────────
  const filterBar = (
    <BoardFilters
      value={f}
      onChange={patch => setF(s => ({ ...s, ...patch }))}
      onReset={reset}
      count={visible.length}
      mineCount={mineCount}
      loading={loading}
      extra={
        <>
          {/* Sort. Newest-first is the default and the reason the board reads
              top-left-first: the listing that just arrived is the one being
              asked about. The backend does the ordering. */}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            disabled={view === 'recheck'}
            title={view === 'recheck'
              ? 'The review queue is ordered oldest-doubt-first'
              : 'Order the board'}
            className="px-3 py-2 bg-off-white border-0 rounded text-sm text-navy/70
                       focus:outline-none focus:ring-1 focus:ring-gold/50 disabled:opacity-40"
          >
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>

          {/* Only listings somebody has actually stood behind, with a timestamp
              to prove it. */}
          {view === 'board' && (
            <button
              onClick={() => setOnlyConfirmed(v => !v)}
              title="Only listings an agent has confirmed as available"
              className={`px-3 py-2 rounded text-xs whitespace-nowrap transition-colors ${
                onlyConfirmed ? 'bg-navy text-white' : 'bg-off-white text-navy/60 hover:bg-navy/10'}`}
            >
              Confirmed only
            </button>
          )}

          {/* Free-from search. Months are generated from today, so the list
              never offers one that has already passed. */}
          {view === 'board' && (
            <select
              value={avail}
              onChange={e => setAvail(e.target.value)}
              title="Filter by when the property becomes free"
              className="px-3 py-2 bg-off-white border-0 rounded text-sm text-navy/70
                         focus:outline-none focus:ring-1 focus:ring-gold/50"
            >
              <option value="">Free — any</option>
              <option value="now">Free now</option>
              <option value="soon">Soon (no date)</option>
              <option value="dated">Has a date</option>
              {nextMonths(9).map(m => (
                <option key={m.value} value={m.value}>From {m.label}</option>
              ))}
            </select>
          )}

          {rect && (
            <button
              onClick={() => setRect(null)}
              className="flex items-center gap-1.5 px-3 py-2 rounded bg-navy text-white text-xs whitespace-nowrap"
              title="Clear the area drawn on the map"
            >
              Area drawn <span className="opacity-60">×</span>
            </button>
          )}
          {circ && (
            <button
              onClick={() => setCirc(null)}
              className="flex items-center gap-1.5 px-3 py-2 rounded bg-navy text-white text-xs whitespace-nowrap"
              title="Clear the circle drawn on the map"
            >
              {(circ.r / 1000).toFixed(1)} km circle <span className="opacity-60">×</span>
            </button>
          )}
        </>
      }
    />
  )

  return (
    <CrmShell
      title="Schedule Board"
      subtitle={me ? 'Availability and viewing locations across the whole team' : undefined}
      filterBar={filterBar}
    >
      <div style={{ padding: isMobile ? 14 : 22 }}>
        {err && <Notice text={err} />}

        {/* Active board ⇄ review queue. The board shows only what an agent can
            offer today; the queue holds the listings where the classifier could
            not read an owner's reply and refused to guess. */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center' }}>
          {([['board', 'Active board'], ['recheck', 'Needs recheck']] as const).map(([v, label]) => {
            const on = view === v
            return (
              <button key={v} onClick={() => setView(v)} style={{
                ...chip, borderRadius: 8,
                background: on ? NAVY : '#FFF',
                borderColor: on ? NAVY : '#E9E5DC',
                color: on ? '#FFF' : '#666',
                fontWeight: on ? 700 : 500,
              }}>
                {label}
                {v === 'recheck' && recheckCount > 0 && (
                  <span style={{
                    marginLeft: 6, fontFamily: FM, fontSize: 10,
                    background: on ? 'rgba(255,255,255,0.22)' : AD,
                    color: on ? '#FFF' : '#7A6534',
                    padding: '1px 5px', borderRadius: 999,
                  }}>{recheckCount}</span>
                )}
              </button>
            )
          })}
        </div>

        {view === 'recheck' && (
          <div style={{
            background: AD, border: `1px solid ${AB}`, borderRadius: 10,
            padding: '10px 14px', fontSize: 11.5, color: '#7A6534',
            marginBottom: 14, lineHeight: 1.5,
          }}>
            These owners replied, but the wording could not be read as a yes or a
            no — so nothing was assumed. Confirm it or take it off the board.
            Oldest doubt first.
          </div>
        )}

        {/* villages */}
        {townOptions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {townOptions.map(t => {
              const on = f.towns.includes(t.key)
              return (
                <button key={t.key} onClick={() => toggleTown(t.key)} style={{
                  ...chip,
                  background: on ? AD : '#FFF',
                  borderColor: on ? AB : '#E9E5DC',
                  color: on ? A : '#666',
                  fontWeight: on ? 700 : 500,
                }}>
                  {t.label} <span style={{ fontFamily: FM, fontSize: 10, opacity: 0.6 }}>{t.n}</span>
                </button>
              )
            })}
          </div>
        )}

        <MapPanel
          items={visible}
          rect={rect}
          onRect={setRect}
          circ={circ}
          onCirc={setCirc}
          onMarkerClick={onMarkerClick}
          selectedTowns={f.towns}
          isMobile={isMobile}
        />

        {/* cards */}
        <div style={{
          display: 'grid', gap: 14, marginTop: 18,
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill,minmax(268px,1fr))',
        }}>
          {visible.map(r => (
            <Card
              key={r.ref}
              r={r}
              focused={focusRef === r.ref}
              innerRef={el => { cardRefs.current[r.ref] = el }}
              onOpen={() => setDetail(r.ref)}
              onAct={act}
              onBook={() => setBooking(r)}
              onAsk={() => setAsking(r)}
              onCheckIn={() => checkIn(r)}
              onStatus={action => setStatusing({ r, action })}
              busy={busyRef === r.ref}
            />
          ))}
        </div>

        {!loading && !visible.length && !err && (
          <div style={{ padding: '48px 0', textAlign: 'center', color: '#BBB', fontSize: 13 }}>
            {view === 'recheck'
              ? 'Nothing waiting for a recheck.'
              : 'Nothing matches this search.'}
          </div>
        )}
      </div>

      {detail && <DetailModal refId={detail} onClose={() => setDetail(null)} onAct={act} />}

      <AnimatePresence>
        {booking && (
          <BookDialog
            key="book"
            refId={booking.ref}
            town={booking.town}
            onClose={() => setBooking(null)}
            onDone={msg => showToast('ok', msg)}
          />
        )}
        {asking && (
          <AskDialog
            key="ask"
            refId={asking.ref}
            town={asking.town}
            contact={asking.contact}
            onClose={() => setAsking(null)}
            // A sent question spends one of the day's two slots, so the cards
            // have to be refetched or the counter lies until the next reload.
            onDone={msg => { showToast('ok', msg); reload() }}
          />
        )}
        {statusing && (
          <StatusDialog
            key="status"
            refId={statusing.r.ref}
            town={statusing.r.town}
            action={statusing.action}
            onClose={() => setStatusing(null)}
            onDone={onStatusDone}
          />
        )}
      </AnimatePresence>

      {toast && <Toast kind={toast.kind} text={toast.text} onClose={() => setToast(null)} />}
    </CrmShell>
  )
}

// ── Google map ──────────────────────────────────────────────────────────────
// Loaded lazily via the official loader script.
//
// The rectangle tool is hand-rolled from map mouse events. google.maps.drawing
// .DrawingManager was REMOVED in Maps JavaScript API 3.65 — asking for it does
// not degrade, it throws, and an uncaught throw here takes the whole board down
// with it. google.maps.Rectangle is still supported, so the box is drawn by
// anchoring on mousedown and resizing until mouseup.
// There is exactly one rectangle at a time and it can be cleared and redrawn.
function MapPanel({ items, rect, onRect, circ, onCirc, onMarkerClick, selectedTowns, isMobile }: {
  items: Array<Listing & { lat: number | null; lng: number | null; tkey: string }>
  rect: Rect | null
  onRect: (r: Rect | null) => void
  circ: Circ | null
  onCirc: (c: Circ | null) => void
  onMarkerClick: (ref: string) => void
  selectedTowns: string[]
  isMobile: boolean
}) {
  const divRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const shapeRef = useRef<any>(null)
  const areaRef = useRef<any[]>([])
  const anchorRef = useRef<any>(null)
  const overlayRef = useRef<any>(null)
  const [ready, setReady] = useState(false)
  // null = not drawing. 'rect' and 'circle' share every pointer handler below;
  // only the shape they build differs.
  const [drawing, setDrawing] = useState<null | 'rect' | 'circle'>(null)
  const circleRef = useRef<any>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  // null = still asking the backend, '' = there is no key
  const [mapsKey, setMapsKey] = useState<string | null>(BUNDLED_MAPS_KEY || null)

  useEffect(() => {
    if (mapsKey !== null) return
    let alive = true
    crmFetch('schedule-board/config')
      .then(d => { if (alive) setMapsKey((d && d.mapsKey) || '') })
      .catch(() => { if (alive) setMapsKey('') })
    return () => { alive = false }
  }, [mapsKey])

  // load the script once the key is known
  useEffect(() => {
    if (mapsKey === null) return
    if (!mapsKey) { setLoadErr('no-key'); return }
    const w = window as any
    if (w.google?.maps?.Map) { setReady(true); return }
    const existing = document.getElementById('gmaps-js') as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => setReady(true))
      existing.addEventListener('error', () => setLoadErr('load-failed'))
      return
    }
    const s = document.createElement('script')
    s.id = 'gmaps-js'
    s.async = true
    // No `libraries=drawing`: that library's DrawingManager is gone since 3.65
    // and the rectangle below is drawn from pointer events instead.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}`
    s.onload = () => setReady(true)
    s.onerror = () => setLoadErr('load-failed')
    document.head.appendChild(s)
  }, [mapsKey])

  // init map
  useEffect(() => {
    if (!ready || !divRef.current || mapRef.current) return
    const g = (window as any).google
    mapRef.current = new g.maps.Map(divRef.current, {
      center: { lat: 35.9042, lng: 14.4600 },
      zoom: isMobile ? 10 : 11,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      styles: [
        { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] },
      ],
    })
    // An empty OverlayView exists purely for its projection: it is the only
    // supported way to turn a pixel inside the map container into a coordinate,
    // which is what the area tool below needs.
    const ov = new g.maps.OverlayView()
    ov.onAdd = () => {}
    ov.draw = () => {}
    ov.onRemove = () => {}
    ov.setMap(mapRef.current)
    overlayRef.current = ov
  }, [ready, isMobile])

  // ── the area tool ─────────────────────────────────────────────────────────
  // Armed by the "Draw area" button. While armed the map stops panning, so a
  // drag draws the box instead of moving Malta. A drag too small to be a real
  // selection counts as "changed my mind" and clears instead of filtering
  // everything away.
  //
  // The events are DOM pointer events on the map container, NOT map events:
  // google.maps.Map fires click, mousemove and the drag events, but it has no
  // mousedown or mouseup, so a rectangle tracked through map listeners never
  // starts. Pointer events also cover touch and pen for free. Pixels become
  // coordinates through the OverlayView projection created above.
  useEffect(() => {
    if (!ready || !mapRef.current || !divRef.current) return
    const g = (window as any).google
    const map = mapRef.current
    const div = divRef.current

    if (!drawing) {
      map.setOptions({ draggable: true, draggableCursor: null })
      div.style.touchAction = ''
      return
    }
    const mode = drawing
    map.setOptions({ draggable: false, draggableCursor: 'crosshair' })
    div.style.touchAction = 'none'   // otherwise a touch drag scrolls the page

    const toLatLng = (ev: PointerEvent) => {
      const proj = overlayRef.current && overlayRef.current.getProjection()
      if (!proj) return null
      const r = div.getBoundingClientRect()
      return proj.fromContainerPixelToLatLng(
        new g.maps.Point(ev.clientX - r.left, ev.clientY - r.top))
    }
    const boundsOf = (a: any, b: any) => new g.maps.LatLngBounds(
      { lat: Math.min(a.lat(), b.lat()), lng: Math.min(a.lng(), b.lng()) },
      { lat: Math.max(a.lat(), b.lat()), lng: Math.max(a.lng(), b.lng()) },
    )

    const clearShapes = () => {
      if (shapeRef.current) { shapeRef.current.setMap(null); shapeRef.current = null }
      if (circleRef.current) { circleRef.current.setMap(null); circleRef.current = null }
    }

    const onDown = (ev: PointerEvent) => {
      const ll = toLatLng(ev)
      if (!ll) return
      ev.preventDefault()
      anchorRef.current = ll
      clearShapes()
      if (mode === 'circle') {
        // Anchor is the CENTRE and the drag is the radius — the natural gesture
        // for "within X of here".
        circleRef.current = new g.maps.Circle({
          map, center: ll, radius: 0,
          fillColor: A, fillOpacity: 0.10, strokeColor: A, strokeWeight: 1.5, clickable: false,
        })
      } else {
        shapeRef.current = new g.maps.Rectangle({
          map,
          bounds: boundsOf(ll, ll),
          fillColor: A, fillOpacity: 0.10, strokeColor: A, strokeWeight: 1.5, clickable: false,
        })
      }
    }
    const onMove = (ev: PointerEvent) => {
      if (!anchorRef.current) return
      const ll = toLatLng(ev)
      if (!ll) return
      if (mode === 'circle') {
        if (!circleRef.current) return
        circleRef.current.setRadius(
          metresBetween(anchorRef.current.lat(), anchorRef.current.lng(), ll.lat(), ll.lng()))
      } else {
        if (!shapeRef.current) return
        shapeRef.current.setBounds(boundsOf(anchorRef.current, ll))
      }
    }
    const onUp = (ev: PointerEvent) => {
      const anchor = anchorRef.current
      anchorRef.current = null
      if (!anchor) return
      const ll = toLatLng(ev) || anchor
      setDrawing(null)

      if (mode === 'circle') {
        const r = metresBetween(anchor.lat(), anchor.lng(), ll.lat(), ll.lng())
        // A tap rather than a drag means "changed my mind" — clearing beats
        // filtering everything away with a 5-metre circle.
        if (r < 150) { clearShapes(); onCirc(null); return }
        onCirc({ lat: anchor.lat(), lng: anchor.lng(), r })
        return
      }

      const b = boundsOf(anchor, ll)
      const ne = b.getNorthEast(), sw = b.getSouthWest()
      const tiny = Math.abs(ne.lat() - sw.lat()) < 0.0008 && Math.abs(ne.lng() - sw.lng()) < 0.0008
      if (tiny) { clearShapes(); onRect(null); return }
      onRect({ north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng() })
    }

    // Capture phase, because the map's own panes sit inside this container and
    // swallow some events on the way up. mouseup goes on the window so a
    // release outside the map still finishes the box.
    div.addEventListener('pointerdown', onDown, true)
    div.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    return () => {
      div.removeEventListener('pointerdown', onDown, true)
      div.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      div.style.touchAction = ''
    }
  }, [ready, drawing, onRect, onCirc])

  // A rect restored from a shared link has no rectangle on the map yet — draw
  // it once so the box is visible, not just silently filtering.
  useEffect(() => {
    if (!ready || !mapRef.current || !rect || shapeRef.current) return
    const g = (window as any).google
    shapeRef.current = new g.maps.Rectangle({
      map: mapRef.current,
      bounds: { north: rect.north, south: rect.south, east: rect.east, west: rect.west },
      fillColor: A, fillOpacity: 0.10, strokeColor: A, strokeWeight: 1.5, clickable: false,
    })
    mapRef.current.fitBounds(shapeRef.current.getBounds())
  }, [ready, rect])

  // A circ restored from a shared link has no shape on the map yet.
  useEffect(() => {
    if (!ready || !mapRef.current || !circ || circleRef.current) return
    const g = (window as any).google
    circleRef.current = new g.maps.Circle({
      map: mapRef.current,
      center: { lat: circ.lat, lng: circ.lng }, radius: circ.r,
      fillColor: A, fillOpacity: 0.10, strokeColor: A, strokeWeight: 1.5, clickable: false,
    })
    mapRef.current.fitBounds(circleRef.current.getBounds())
  }, [ready, circ])

  // markers
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = (window as any).google
    markersRef.current.forEach(m => m.setMap(null))
    markersRef.current = []
    for (const it of items) {
      if (it.lat == null || it.lng == null) continue
      const colour = it.isMine ? GREEN : A
      const m = new g.maps.Marker({
        position: { lat: it.lat, lng: it.lng },
        map: mapRef.current,
        title: `#${it.ref} · ${it.price ? '€' + it.price.toLocaleString() : 'price n/a'}`,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: colour,
          fillOpacity: 0.95,
          strokeColor: '#FFFDFA',
          strokeWeight: 2,
        },
      })
      m.addListener('click', () => onMarkerClick(it.ref))
      markersRef.current.push(m)
    }
  }, [ready, items, onMarkerClick])

  // soft highlight over the selected villages
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = (window as any).google
    areaRef.current.forEach(c => c.setMap(null))
    areaRef.current = []
    for (const k of selectedTowns) {
      const t = TOWNS[k]
      if (!t) continue
      areaRef.current.push(new g.maps.Circle({
        map: mapRef.current,
        center: { lat: t.lat, lng: t.lng },
        radius: 900,
        fillColor: A, fillOpacity: 0.10,
        strokeColor: A, strokeOpacity: 0.35, strokeWeight: 1,
        clickable: false,
      }))
    }
  }, [ready, selectedTowns])

  function startDraw(mode: 'rect' | 'circle') {
    if (!mapRef.current) return
    if (shapeRef.current) { shapeRef.current.setMap(null); shapeRef.current = null }
    if (circleRef.current) { circleRef.current.setMap(null); circleRef.current = null }
    // One area at a time — two overlapping area filters is a set nobody can read.
    onRect(null); onCirc(null)
    setDrawing(mode)
  }
  function clearDraw() {
    if (shapeRef.current) { shapeRef.current.setMap(null); shapeRef.current = null }
    if (circleRef.current) { circleRef.current.setMap(null); circleRef.current = null }
    setDrawing(null)
    onRect(null); onCirc(null)
  }

  const height = isMobile ? 260 : 420

  if (loadErr === 'no-key') {
    return (
      <div style={{ ...mapBox, height, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20 }}>
        <div>
          <div style={{ fontFamily: F, fontWeight: 700, color: '#8A6412', fontSize: 14 }}>Map needs a Google Maps key</div>
          <div style={{ fontSize: 12, marginTop: 6, maxWidth: 420, lineHeight: 1.5, color: '#999' }}>
            Set <code style={{ fontFamily: FM }}>SCHEDULE_BOARD_MAPS_KEY</code> in the backend
            <code style={{ fontFamily: FM }}> .env</code> and restart it — no frontend deploy needed.
            Filters, villages and cards below all work without it.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <div ref={divRef} style={{ ...mapBox, height }} />
      {!ready && !loadErr && (
        <div style={{ ...mapBox, height, position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#BBB', fontSize: 12 }}>
          loading map…
        </div>
      )}
      {loadErr === 'load-failed' && (
        <div style={{ ...mapBox, height, position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#B91C1C', fontSize: 12, textAlign: 'center', padding: 16 }}>
          Google Maps failed to load. Check the API key restrictions and that Maps JavaScript API is enabled.
        </div>
      )}
      {ready && (
        <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 6 }}>
          <button onClick={() => startDraw('circle')} style={{ ...btn, background: drawing === 'circle' ? A : '#FFF', color: drawing === 'circle' ? '#FFF' : '#444', boxShadow: '0 1px 4px rgba(0,0,0,0.16)', border: 'none' }}>
            {drawing === 'circle' ? 'Drag out a radius…' : '◯ Circle area'}
          </button>
          <button onClick={() => startDraw('rect')} style={{ ...btn, background: drawing === 'rect' ? A : '#FFF', color: drawing === 'rect' ? '#FFF' : '#444', boxShadow: '0 1px 4px rgba(0,0,0,0.16)', border: 'none' }}>
            {drawing === 'rect' ? 'Draw a box…' : '▭ Box'}
          </button>
          {(rect || circ) && (
            <button onClick={clearDraw} style={{ ...btn, background: '#FFF', color: '#444', boxShadow: '0 1px 4px rgba(0,0,0,0.16)', border: 'none' }}>
              ✕ Clear area
            </button>
          )}
        </div>
      )}
      {ready && (
        <div style={{ position: 'absolute', bottom: 10, left: 10, display: 'flex', gap: 12, background: 'rgba(255,253,250,0.94)', padding: '6px 10px', borderRadius: 8, fontSize: 10, color: '#666', boxShadow: '0 1px 4px rgba(0,0,0,0.10)' }}>
          <Dot c={GREEN} /> yours <Dot c={A} /> team
        </div>
      )}
    </div>
  )
}

const Dot = ({ c }: { c: string }) => (
  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, marginRight: 3 }} />
)

// ── freshness ladder ────────────────────────────────────────────────────────
// The Available button's green is a staleness gauge, not a boolean: the harder
// it burns, the more recently a human stood behind it. An agent reads the
// reliability of "available" off the colour without doing arithmetic.
//
//   never confirmed    outline only   uploaded, nobody has vouched for it yet
//   < 30h              full strength  fresh, safe to quote to a client
//   30–60h             half strength  ageing, still usable
//   > 60h              faint + ring   stale; this is the auto-reachout band
//
// The hue is #2F6F57 — the green already in this file's vocabulary (the isMine
// border) — and deliberately NOT the GREEN/NAVY token above, which means
// "ours" rather than "fresh". Two different questions, two different colours.
const FRESH_HUE = '47,111,87'
const FRESH_HOURS = 30
const AGEING_HOURS = 60

type Freshness = {
  tier: 'unconfirmed' | 'fresh' | 'ageing' | 'stale'
  hours: number | null
  bg: string
  fg: string
  border: string
  label: string
}

function freshness(iso: string | null): Freshness {
  if (!iso) {
    return {
      tier: 'unconfirmed', hours: null,
      bg: '#FFF', fg: `rgba(${FRESH_HUE},0.75)`, border: `1px solid rgba(${FRESH_HUE},0.35)`,
      label: 'Not confirmed yet',
    }
  }
  const t = Date.parse(iso)
  const hours = Number.isFinite(t) ? (Date.now() - t) / 3600000 : null
  if (hours == null) {
    return { tier: 'unconfirmed', hours: null, bg: '#FFF', fg: `rgba(${FRESH_HUE},0.75)`,
             border: `1px solid rgba(${FRESH_HUE},0.35)`, label: 'Not confirmed yet' }
  }
  if (hours < FRESH_HOURS) {
    return { tier: 'fresh', hours,
             bg: `rgb(${FRESH_HUE})`, fg: '#FFF', border: `1px solid rgb(${FRESH_HUE})`,
             label: 'Confirmed — fresh' }
  }
  if (hours < AGEING_HOURS) {
    return { tier: 'ageing', hours,
             bg: `rgba(${FRESH_HUE},0.55)`, fg: '#FFF', border: `1px solid rgba(${FRESH_HUE},0.55)`,
             label: 'Confirmed — getting older' }
  }
  return { tier: 'stale', hours,
           bg: `rgba(${FRESH_HUE},0.16)`, fg: `rgb(${FRESH_HUE})`,
           border: '1px solid rgba(201,138,26,0.55)',
           label: 'Confirmation is stale — owner is being re-asked' }
}

// "2h ago" beats a raw timestamp on a card whose only question is how stale the
// confirmation is. Only ever called for rows fetched in an effect, so there is
// no server render of a clock to mismatch on hydration.
function ago(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'recently'
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

// "13 Aug", or "13 Aug 25" once it is not this year — a bare "13 Aug" on a
// listing from last April reads as recent, which is the opposite of the point.
function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return '—'
  const d = t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const sameYear = t.getFullYear() === new Date().getFullYear()
  return sameYear ? d : `${d} ${String(t.getFullYear()).slice(2)}`
}

// The free-from chip. 'soon' is deliberately the loudest of the three: it means
// "nobody has told us", and an agent should feel that before quoting a date to a
// client.
function availChip(a?: Listing['availability']) {
  const kind = a?.kind || 'soon'
  if (kind === 'now') {
    return { text: 'now', bg: 'rgba(47,111,87,0.14)', fg: 'rgb(47,111,87)',
             title: 'Free now — a date on file, on or before today' }
  }
  if (kind === 'date') {
    return { text: a?.label || 'dated', bg: AD, fg: '#7A6534',
             title: `Free from ${a?.date || 'a date the owner gave'}` }
  }
  return { text: 'soon', bg: '#F1EFEA', fg: '#8A8578',
           title: 'No clear date on file — treated as soon, never as "now"' }
}

// ── pets / sharing ──────────────────────────────────────────────────────────
// Two questions clients ask before anything else, answered on the card instead
// of three clicks deeper. The flag comes from the server (services/listingRules.js
// reads the listing's own wording); this only draws it.
//
// THREE STATES, because that is what the data says:
//   yes     → solid icon, brand navy. The listing says so.
//   no      → outline with a slash. The listing says the opposite.
//   unknown → nothing at all. Not a faint icon, not a grey one: 168 of 200
//             listings say nothing about pets, and 200 faint paws on a board
//             would be noise that also invites reading them as "no".
const PAW_PATH =
  'M4.5 10.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm3.4-3.3c-1 0-1.9-1-1.9-2.2S6.9 2.8 7.9 2.8s1.9 1 1.9 2.2-.9 2.2-1.9 2.2Zm4.2 0c-1 0-1.9-1-1.9-2.2s.9-2.2 1.9-2.2 1.9 1 1.9 2.2-.9 2.2-1.9 2.2Zm3.4 3.3c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm-5.5.4c1.7 0 3.1.8 4 2 .8 1 .6 2.4-.4 3-.9.6-2.2.3-3.6.3s-2.7.3-3.6-.3c-1-.6-1.2-2 .4-3 .5-1.2 1.9-2 3.2-2Z'
const PEOPLE_PATH =
  'M7 9a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 7 9Zm6.2.4a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM7 10.6c-2.5 0-4.6 1.4-4.6 3.1v1.1h9.2v-1.1c0-1.7-2.1-3.1-4.6-3.1Zm6.2.5c-.5 0-1 .05-1.5.16.9.7 1.5 1.6 1.5 2.6v.95h4.4v-.95c0-1.5-1.8-2.76-4.4-2.76Z'

function RuleIcon({ state, label, path }: {
  state: boolean | null | undefined
  label: string
  path: string
}) {
  if (state !== true && state !== false) return null
  const yes = state === true
  return (
    <span
      title={yes ? `${label}: the listing says yes` : `${label}: the listing says no`}
      style={{ display: 'inline-flex', lineHeight: 0 }}
    >
      <svg width="15" height="15" viewBox="0 0 20 20" aria-label={`${label} ${yes ? 'yes' : 'no'}`}>
        <path
          d={path}
          fill={yes ? NAVY : 'none'}
          stroke={yes ? 'none' : '#C9C3B6'}
          strokeWidth={yes ? 0 : 1.2}
        />
        {!yes && (
          <line x1="3.2" y1="16.8" x2="16.8" y2="3.2"
            stroke="#C0392B" strokeWidth="1.4" strokeLinecap="round" opacity="0.75" />
        )}
      </svg>
    </span>
  )
}

// ── download the photos ─────────────────────────────────────────────────────
// For the agents who post to Facebook by hand. The order is the ranked order the
// board already shows (Gemini best-first), so the first file is the one that
// should lead the post.
//
// HOW, and why not the obvious way. A `download` attribute is IGNORED
// cross-origin, so a plain anchor click navigates instead of saving. Cloudinary's
// fl_attachment transformation fixes that by sending Content-Disposition — but
// firing fifteen of those in a row does NOT give fifteen files: each top-level
// navigation cancels the download the previous one had just started, and you end
// up with exactly one file, the last. (Measured: 1 of 15.)
//
// So: fetch the bytes (res.cloudinary.com sends Access-Control-Allow-Origin: *)
// and save each one from a blob URL, which is same-origin and therefore honours
// both `download` and our own filename — #ref-01.jpg, not
// rvmrl3rwsvsncckyjfd6.jpg. fl_attachment is kept only as the fallback for a
// fetch that fails, opened in a tab so it cannot cancel anything.
function attachmentUrl(url: string, name: string): string | null {
  const marker = '/image/upload/'
  const at = url.indexOf(marker)
  if (at === -1) return null
  return `${url.slice(0, at + marker.length)}fl_attachment:${encodeURIComponent(name)}/${url.slice(at + marker.length)}`
}

function clickDownload(href: string, filename?: string) {
  const a = document.createElement('a')
  a.href = href
  if (filename) a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function downloadPhotos(r: Listing, onProgress: (done: number) => void) {
  const urls = r.images || []
  for (let i = 0; i < urls.length; i++) {
    const name = `${r.ref}-${String(i + 1).padStart(2, '0')}.jpg`
    try {
      const res = await fetch(urls[i], { mode: 'cors' })
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      clickDownload(objectUrl, name)
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
    } catch {
      // CORS refused or the network blinked. Fall back to Cloudinary's own
      // attachment URL in a new tab: slower and noisier, but it cannot cancel
      // the files that already landed.
      const direct = attachmentUrl(urls[i], name.replace(/\.jpg$/, ''))
      if (direct) window.open(direct, '_blank', 'noopener')
    }
    onProgress(i + 1)
    // Chrome coalesces downloads fired in the same tick; a small gap keeps them
    // all and is invisible to the agent.
    if (i < urls.length - 1) await new Promise(res => setTimeout(res, 120))
  }
}

// The button itself. Its own tiny component so the download state belongs to one
// card and a click cannot bubble up into "open the listing".
function PhotoDownload({ r }: { r: Listing }) {
  const [done, setDone] = useState<number | null>(null)
  const n = r.imageCount || (r.images || []).length
  const running = done !== null && done < n

  if (!n) {
    return (
      <span title="No photos on this listing" style={{ opacity: 0.3, cursor: 'default' }}>
        {DownloadGlyph}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        if (running) return
        setDone(0)
        downloadPhotos(r, d => setDone(d))
      }}
      title={`Download ${n} photo${n === 1 ? '' : 's'} of #${r.ref}, best first — for posting to Facebook`}
      aria-label={`Download ${n} photos`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', padding: 0, cursor: running ? 'default' : 'pointer',
        color: running ? NAVY : '#B5AFA2', fontFamily: FM, fontSize: 9.5,
      }}
    >
      {running ? `${done}/${n}` : done === n ? '✓' : ''}
      {DownloadGlyph}
    </button>
  )
}

const DownloadGlyph = (
  <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden>
    <path d="M10 3v8m0 0 3.2-3.2M10 11 6.8 7.8" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3.6 13.2v1.6c0 .9.7 1.6 1.6 1.6h9.6c.9 0 1.6-.7 1.6-1.6v-1.6"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

// ── card ────────────────────────────────────────────────────────────────────
function Card({ r, focused, innerRef, onOpen, onAct, onBook, onAsk, onCheckIn, onStatus, busy }: {
  r: Listing
  focused: boolean
  innerRef: (el: HTMLDivElement | null) => void
  onOpen: () => void
  onAct: (kind: 'request-availability' | 'request-location', r: Listing) => void
  onBook: () => void
  onAsk: () => void
  onCheckIn: () => void
  onStatus: (action: StatusAction) => void
  busy: boolean
}) {
  const confirmed = r.availableStatus === 'available_confirmed'
  // Drives the button's green and the timer badge — both read the same
  // timestamp, so the colour and the number can never disagree.
  const fresh = freshness(r.lastConfirmedAvailableAt)
  const avail = availChip(r.availability)
  const status = confirmed ? { c: GREEN, t: 'confirmed available' }
    : r.availableStatus === 'available' ? { c: GREEN, t: 'available' }
    : r.availableStatus === 'rented' ? { c: '#B91C1C', t: 'rented' }
    : r.availableStatus === 'pending_check' ? { c: '#C98A1A', t: 'needs a recheck' }
    : r.availableStatus === 'not_available' ? { c: '#B91C1C', t: 'not available' }
    : { c: '#C9C4B8', t: 'unknown' }
  // Older cached responses predate the contact block; default to "usable" so a
  // stale payload degrades to the previous behaviour instead of a dead card.
  const c = r.contact || {
    mode: r.isMine ? 'owner' : 'agent', reachesName: r.listedBy.displayName,
    canAsk: true, reason: null, questionsUsed: 0, questionsPerDay: 2,
    canQuestion: true, questionReason: null,
  }

  return (
    <div
      ref={innerRef}
      // The ref on the DOM node, so a test can assert "this listing's card shows
      // that icon" instead of matching on position in the grid.
      data-ref={r.ref}
      style={{
        background: CARD,
        borderRadius: 14,
        overflow: 'hidden',
        border: focused ? `2px solid ${A}` : `1px solid ${r.isMine ? 'rgba(47,111,87,0.28)' : '#EDE9E0'}`,
        boxShadow: focused ? '0 6px 22px rgba(212,137,26,0.20)' : '0 1px 3px rgba(0,0,0,0.05)',
        transition: 'box-shadow 0.18s, border-color 0.18s',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div onClick={onOpen} style={{ cursor: 'pointer', position: 'relative', height: 150, background: '#F1EEE7' }}>
        {r.images[0]
          ? <img src={r.images[0]} alt={`#${r.ref}`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#CCC', fontSize: 11 }}>no photo</div>}
        {r.isMine && (
          <span style={{ position: 'absolute', top: 9, left: 9, background: GREEN, color: '#FFF', fontSize: 9, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', padding: '3px 7px', borderRadius: 5 }}>
            Yours
          </span>
        )}
        {r.imageCount > 1 && (
          <span style={{ position: 'absolute', bottom: 9, right: 9, background: 'rgba(0,0,0,0.55)', color: '#FFF', fontSize: 10, fontFamily: FM, padding: '2px 6px', borderRadius: 4 }}>
            {r.imageCount}
          </span>
        )}
        {/* The timer, top right. Same source as the button's green, so the
            number explains the colour instead of competing with it. */}
        <span
          title={fresh.label}
          style={{
            position: 'absolute', top: 9, right: 9,
            background: fresh.tier === 'unconfirmed' ? 'rgba(0,0,0,0.45)' : fresh.bg,
            color: fresh.tier === 'unconfirmed' ? '#FFF' : fresh.fg,
            border: fresh.tier === 'stale' ? '1px solid rgba(201,138,26,0.8)' : '1px solid transparent',
            fontSize: 9.5, fontFamily: FM, fontWeight: 600,
            padding: '2px 6px', borderRadius: 999,
          }}>
          {fresh.hours == null
            ? 'unconfirmed'
            : fresh.hours < 1 ? 'just now' : `${Math.floor(fresh.hours)}h`}
        </span>
      </div>

      <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span onClick={onOpen} style={{ fontFamily: FM, fontSize: 12, fontWeight: 500, color: A, cursor: 'pointer' }}>#{r.ref}</span>
          <span style={{ fontFamily: FM, fontSize: 14, fontWeight: 500, color: '#0F0F0F' }}>
            {r.price ? `€${r.price.toLocaleString()}` : r.salePrice ? `€${r.salePrice.toLocaleString()}` : '—'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: status.c, flexShrink: 0 }} title={status.t} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{townLabel(r.town)}</span>
          {/* Free from when, on the right. 'soon' is the default whenever the
              listing is not clearly free now or carrying a real date — the
              server decides, so this chip and the filter cannot disagree. */}
          <span title={avail.title} style={{
            marginLeft: 'auto', flexShrink: 0,
            fontFamily: FM, fontSize: 9.5, fontWeight: 700,
            padding: '2px 7px', borderRadius: 999,
            background: avail.bg, color: avail.fg,
          }}>
            {avail.text}
          </span>
        </div>

        {/* The street, where we have one. Number never shown, and only on your
            own listing — see streetWithoutNumber() on the server. */}
        {r.streetName && (
          <div style={{ fontSize: 11, color: '#7A6534', marginTop: 3 }}>
            {r.streetName}
          </div>
        )}

        <div style={{
          fontSize: 11, color: '#999', marginTop: 4,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>
            {[r.beds != null ? `${r.beds} bed` : null, r.baths != null ? `${r.baths} bath` : null, r.type]
              .filter(Boolean).join(' · ')}
          </span>
          {/* Sharing and pets, whenever the listing actually says. Nothing is
              drawn when it does not — see RuleIcon. */}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <RuleIcon state={r.sharing} label="Sharing" path={PEOPLE_PATH} />
            <RuleIcon state={r.petFriendly} label="Pets" path={PAW_PATH} />
          </span>
        </div>

        {/* Uploaded vs free-from, side by side. Kev: "so we can see how
            accurate they are" — a listing uploaded in April that still claims
            "now" is exactly what this pairing exposes. */}
        <div style={{
          display: 'flex', gap: 10, marginTop: 8, fontSize: 9.5, fontFamily: FM,
          color: '#B5AFA2', flexWrap: 'wrap',
        }}>
          <span title={r.createdAt ? new Date(r.createdAt).toLocaleString('en-GB') : 'no upload date'}>
            up <strong style={{ color: '#8A8578', fontWeight: 700 }}>{fmtDay(r.createdAt)}</strong>
          </span>
          <span title={r.availableDate ? `free from ${r.availableDate}` : 'no date on file — treated as soon'}>
            free <strong style={{ color: '#8A8578', fontWeight: 700 }}>
              {r.availableDate ? fmtDay(r.availableDate) : 'soon'}
            </strong>
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <PhotoDownload r={r} />
          </span>
        </div>

        <div style={{ fontSize: 10, color: '#B5AFA2', marginTop: 6, marginBottom: 10 }}>
          Listed by {r.listedBy.displayName || 'unassigned'}
        </div>

        {/* ── availability ──────────────────────────────────────────────────
            The two buttons Kev works the board with. Neither sends a message to
            anybody: they record what this agent knows right now.
              Available   → the card stays, the timestamp moves to now
              Not available → the card leaves the active board immediately
            Nothing is deleted either way — the listing keeps its row, its
            photos and its history, and Inventory still has all of it. */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button
            onClick={onCheckIn}
            disabled={busy}
            title={`${fresh.label}${fresh.hours != null ? ` · last confirmed ${ago(r.lastConfirmedAvailableAt!)}` : ''} — click to confirm as of now`}
            style={{
              ...btn, flex: 1,
              // The whole ladder, straight from the timestamp.
              background: fresh.bg,
              color: fresh.fg,
              border: fresh.border,
              fontWeight: 700,
              opacity: busy ? 0.5 : 1,
              cursor: busy ? 'wait' : 'pointer',
            }}>
            {fresh.tier === 'unconfirmed' ? 'ON MARKET' : '✓ ON MARKET'}
          </button>
          <button
            onClick={() => onStatus('check-out')}
            disabled={busy}
            title="Off market — asks for a reason, then takes it off the board"
            style={{
              ...btn, flex: 1, border: '1px solid rgba(185,28,28,0.22)',
              background: '#FFF', color: '#B91C1C', fontWeight: 700,
              opacity: busy ? 0.5 : 1,
            }}>
            OFF MARKET
          </button>
        </div>

        {/* The timestamp is the whole product of the button above it. Without a
            date on the card, "confirmed" is a claim with no expiry. */}
        <div style={{ fontSize: 9.5, color: '#B5AFA2', marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>
            {r.lastConfirmedAvailableAt
              ? <>Confirmed <strong style={{ color: GREEN, fontWeight: 700 }}>{ago(r.lastConfirmedAvailableAt)}</strong></>
              : 'Never confirmed'}
          </span>
          {/* Quiet by design — these are the rarer actions — but still real tap
              targets. minHeight 30 is the floor this board holds everything to:
              at the 14px an underlined text run gives you, these were a miss on
              a phone, which tests/schedule-board.test.js catches. */}
          <button
            onClick={() => onStatus('recheck')}
            title="Park this in the review queue until somebody checks"
            style={{ ...subtleLink, marginLeft: 'auto' }}>
            recheck
          </button>
          <button
            onClick={() => onStatus('archive')}
            title="Archive — off the board for good, still in Inventory"
            style={subtleLink}>
            archive
          </button>
        </div>

        {/* Why it last moved — the review queue is unusable without it. */}
        {r.statusChangeReason && (
          <div style={{ fontSize: 9.5, color: '#B08968', marginBottom: 10, lineHeight: 1.35 }}>
            {r.statusChangeReason}
          </div>
        )}

        {/* Contact actions. `canAsk` / `canQuestion` are the server's verdict —
            a do-not-contact owner, one already messaged today, or a listing
            with no reachable agent all arrive here already decided. */}
        <div style={{ marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            onClick={() => c.canAsk && onAct('request-availability', r)}
            disabled={!c.canAsk}
            title={c.reason || (r.isMine ? 'Message the owner' : `Ask ${c.reachesName || 'the listing agent'}`)}
            style={{
              ...btn, flex: 1, border: 'none',
              background: c.canAsk ? (r.isMine ? GREEN : A) : '#F1EFEA',
              color: c.canAsk ? '#FFF' : '#B5AFA2',
              cursor: c.canAsk ? 'pointer' : 'not-allowed',
            }}>
            Availability
          </button>

          <button
            onClick={() => c.canQuestion && onAsk()}
            disabled={!c.canQuestion}
            title={c.questionReason || 'Ask a question — you approve the wording before it sends'}
            style={{
              ...btn,
              background: '#FFF',
              color: c.canQuestion ? NAVY : '#C9C4B8',
              border: `1px solid ${c.canQuestion ? 'rgba(27,42,74,0.18)' : '#EDE9E0'}`,
              cursor: c.canQuestion ? 'pointer' : 'not-allowed',
            }}>
            Ask
          </button>

          {/* Booking is internal — never blocked by a contact rule. */}
          <button
            onClick={onBook}
            title="Book a viewing"
            style={{ ...btn, background: '#FFF', color: NAVY, border: `1px solid ${AB}`, fontWeight: 700 }}>
            Book
          </button>

          {!r.isMine && !r.hasViewingLocation && c.canAsk && (
            <button onClick={() => onAct('request-location', r)}
              style={{ ...btn, background: '#FFF', color: '#7A6534', border: `1px solid ${AB}` }}
              title="Ask the listing agent where the viewing is">
              Location
            </button>
          )}
        </div>

        {/* One line of truth under the buttons: why they are off, or where a
            working button actually sends. */}
        {!c.canAsk && c.reason ? (
          <div style={{ fontSize: 9.5, color: '#B08968', marginTop: 6, lineHeight: 1.35 }}>
            {c.reason}
          </div>
        ) : c.canAsk && !c.canQuestion && c.questionReason ? (
          <div style={{ fontSize: 9.5, color: '#B08968', marginTop: 6, lineHeight: 1.35 }}>
            {c.questionReason}
          </div>
        ) : r.isMine ? (
          <div style={{ fontSize: 9.5, color: GREEN, marginTop: 6, opacity: 0.8 }}>
            Reaches the owner directly · {c.questionsPerDay - c.questionsUsed} question
            {c.questionsPerDay - c.questionsUsed === 1 ? '' : 's'} left today
          </div>
        ) : (
          <div style={{ fontSize: 9.5, color: '#B5AFA2', marginTop: 6 }}>
            Goes to {c.reachesName || 'the listing agent'} — never to the owner
          </div>
        )}
      </div>
    </div>
  )
}

// ── detail modal ────────────────────────────────────────────────────────────
function DetailModal({ refId, onClose, onAct }: {
  refId: string
  onClose: () => void
  onAct: (kind: 'request-availability' | 'request-location', r: Listing) => void
}) {
  const [d, setD] = useState<any>(null)
  const [e, setE] = useState<string | null>(null)
  const [i, setI] = useState(0)

  useEffect(() => {
    let alive = true
    crmFetch(`schedule-board/listings/${encodeURIComponent(refId)}`)
      .then(x => { if (alive) setD(x) })
      .catch(x => { if (alive) setE(x?.message || 'Could not load listing') })
    return () => { alive = false }
  }, [refId])

  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(19,19,19,0.55)', zIndex: 200,
      display: 'grid', placeItems: 'center', padding: 16,
    }}>
      <div onClick={ev => ev.stopPropagation()} style={{
        background: CARD, borderRadius: 16, maxWidth: 720, width: '100%',
        maxHeight: '88vh', overflowY: 'auto', fontFamily: F,
        boxShadow: '0 18px 60px rgba(0,0,0,0.30)',
      }}>
        {e && <div style={{ padding: 26 }}><Notice text={e} /></div>}
        {!d && !e && <div style={{ padding: 44, textAlign: 'center', color: '#BBB', fontSize: 12 }}>loading…</div>}
        {d && (
          <>
            <div style={{ position: 'relative', height: 300, background: '#F1EEE7' }}>
              {d.images?.length
                ? <img src={d.images[i]} alt={`#${d.ref}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                : <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#CCC', fontSize: 12 }}>no photos</div>}
              <button onClick={onClose} style={{
                position: 'absolute', top: 12, right: 12, border: 'none', cursor: 'pointer',
                background: 'rgba(0,0,0,0.55)', color: '#FFF', width: 30, height: 30,
                borderRadius: '50%', fontSize: 15, lineHeight: 1,
              }}>×</button>
              {d.images?.length > 1 && (
                <div style={{ position: 'absolute', bottom: 10, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 5 }}>
                  {d.images.map((_: string, n: number) => (
                    <button key={n} onClick={() => setI(n)} style={{
                      width: 7, height: 7, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
                      background: n === i ? '#FFF' : 'rgba(255,255,255,0.45)',
                    }} />
                  ))}
                </div>
              )}
            </div>

            <div style={{ padding: '18px 22px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontFamily: FM, fontSize: 12, color: A }}>#{d.ref}</div>
                  <h2 style={{ margin: '3px 0 0', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
                    {townLabel(d.town)}
                  </h2>
                </div>
                <div style={{ fontFamily: FM, fontSize: 19, fontWeight: 500 }}>
                  {d.price ? `€${d.price.toLocaleString()}` : d.salePrice ? `€${d.salePrice.toLocaleString()}` : '—'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
                {[
                  d.beds != null && `${d.beds} bed`,
                  d.baths != null && `${d.baths} bath`,
                  d.type,
                  d.sizeSqm && `${d.sizeSqm} m²`,
                  d.availableStatus,
                  d.exclusive && 'exclusive',
                ].filter(Boolean).map((t: any, n: number) => (
                  <span key={n} style={{ ...chip, background: '#F6F4EF', borderColor: '#E9E5DC', color: '#666' }}>{t}</span>
                ))}
              </div>

              {d.description && (
                <p style={{ fontSize: 13, lineHeight: 1.65, color: '#444', whiteSpace: 'pre-wrap', margin: '0 0 14px' }}>
                  {d.description}
                </p>
              )}

              {!!d.features?.length && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                  {d.features.map((x: string, n: number) => (
                    <span key={n} style={{ ...chip, background: AD, borderColor: AB, color: '#7A6534' }}>{x}</span>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 11, color: '#B5AFA2', marginBottom: 14 }}>
                Listed by {d.listedBy?.displayName || 'unassigned'}
                {d.isMine && <span style={{ color: GREEN, fontWeight: 700 }}> · yours</span>}
                {' · '}
                {d.hasViewingLocation ? 'viewing location on file' : 'no viewing location on file'}
              </div>

              {/* Same verdict the cards use, so the modal cannot offer a
                  button the card has greyed out. */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  onClick={() => d.contact?.canAsk !== false && onAct('request-availability', d)}
                  disabled={d.contact?.canAsk === false}
                  title={d.contact?.reason || undefined}
                  style={{
                    ...btn, border: 'none',
                    background: d.contact?.canAsk === false ? '#F1EFEA' : (d.isMine ? GREEN : A),
                    color: d.contact?.canAsk === false ? '#B5AFA2' : '#FFF',
                    cursor: d.contact?.canAsk === false ? 'not-allowed' : 'pointer',
                  }}>
                  {d.isMine ? 'Ask the owner' : 'Request availability'}
                </button>
                {!d.isMine && !d.hasViewingLocation && d.contact?.canAsk !== false && (
                  <button onClick={() => onAct('request-location', d)} style={{ ...btn, background: '#FFF', color: '#7A6534', border: `1px solid ${AB}` }}>
                    Request viewing location
                  </button>
                )}
              </div>
              {d.contact?.canAsk === false && d.contact?.reason && (
                <div style={{ fontSize: 11, color: '#B08968', marginTop: 8 }}>{d.contact.reason}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── small pieces ────────────────────────────────────────────────────────────
function Seg({ label, value, onChange, opts }: {
  label: string; value: string; onChange: (v: string) => void; opts: Array<[string, string]>
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: 9, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{label}</span>
      <div style={{ display: 'flex', border: '1px solid #E9E5DC', borderRadius: 7, overflow: 'hidden', background: '#FFF' }}>
        {opts.map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)} style={{
            border: 'none', cursor: 'pointer', padding: '5px 9px', fontSize: 11, fontFamily: F,
            background: value === v ? A : 'transparent',
            color: value === v ? '#FFF' : '#777',
            fontWeight: value === v ? 700 : 500,
          }}>{l}</button>
        ))}
      </div>
    </div>
  )
}

function Num({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      inputMode="numeric"
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      style={{
        width: 78, padding: '6px 9px', fontSize: 11, fontFamily: FM,
        border: '1px solid #E9E5DC', borderRadius: 7, background: '#FFF', color: '#444', outline: 'none',
      }}
    />
  )
}

function Notice({ text }: { text: string }) {
  return (
    <div style={{ background: '#FEE2E2', color: '#B91C1C', borderRadius: 10, padding: '10px 14px', fontSize: 12, fontWeight: 600, marginBottom: 14 }}>
      {text}
    </div>
  )
}

function Toast({ kind, text, onClose }: { kind: 'ok' | 'err' | 'info'; text: string; onClose: () => void }) {
  const bg = kind === 'ok' ? GREEN : kind === 'err' ? '#B91C1C' : '#131313'
  return (
    <div onClick={onClose} style={{
      position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
      background: bg, color: '#FFF', padding: '11px 18px', borderRadius: 10,
      fontSize: 12.5, fontFamily: F, fontWeight: 600, zIndex: 300, cursor: 'pointer',
      boxShadow: '0 8px 28px rgba(0,0,0,0.28)', maxWidth: '90vw', textAlign: 'center',
    }}>
      {text}
    </div>
  )
}

// minHeight on both: 30px is the floor for a reliable tap on a phone, and the
// village chips sat at 27px. Desktop is unaffected — the padding already
// exceeded it there.
const btn: React.CSSProperties = {
  padding: '7px 11px', borderRadius: 7, fontSize: 11, fontFamily: F,
  fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 32,
}
// The two low-frequency card actions. Reads as a text link, sized as a button:
// 30px is the same tap floor the buttons and village chips hold to.
const subtleLink: React.CSSProperties = {
  border: 'none', background: 'none', padding: '7px 4px', minHeight: 30,
  font: 'inherit', color: '#B5AFA2', cursor: 'pointer',
  textDecoration: 'underline', lineHeight: 1,
}
const chip: React.CSSProperties = {
  padding: '6px 11px', borderRadius: 999, fontSize: 11, fontFamily: F,
  border: '1px solid', cursor: 'pointer', background: '#FFF', minHeight: 32,
}
const mapBox: React.CSSProperties = {
  width: '100%', borderRadius: 14, overflow: 'hidden',
  border: '1px solid #EDE9E0', background: '#EFECE4',
}
