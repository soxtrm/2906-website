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
// Hot Property (migration 031). Deliberately its own colour, not the gold used
// for a personal Favourite and not the red used for "rented" — three different
// facts, three different colours, so a glance never confuses them.
const HOT = '#C7391A'
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
  // Whether the >60h robot has been told to leave THIS owner alone. A fact
  // about our own scheduler, not about the listing or the owner.
  autoReachoutOptOut?: boolean
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
  // Same three states, but no card icon by design — subletting is a search
  // filter only (Kev, 2026-08-16). Derived server-side by listingRules.js.
  subletting?: boolean | null
  // WATag: whether this listing has a stored group message to anchor a "." to.
  // 85 of the 215 listings predate the capture and have none — the button is
  // dead for those, and it says so rather than failing on click.
  canTag?: boolean
  // Whether THIS agent has starred it. Drives the star on the photo, which is a
  // toggle and so has to know which way it is already pointing.
  isFavourite?: boolean
  // Favourites only. When it was added, and the viewing it was added for —
  // a favourite exists because somebody booked a viewing, so the card shows it.
  favouritedAt?: string | null
  // Global Hot Property (migration 031) — admin-set, everyone sees it, sorted
  // first server-side. Unlike isFavourite this is the SAME value for every
  // agent looking at this card.
  isHotProperty?: boolean
  hotSince?: string | null
  // 0 normal, 1 favourite (mine only), 2 hot (global). Hot always wins the
  // display over this agent's own favourite — see routes/crmScheduleBoard.js
  // withCardFlags(). The star's one glyph reads this, not the two booleans
  // separately, so the card and the click handler can never disagree about
  // which step it is on.
  starStep?: number
  viewing?: { id: number; date: string; time: string | null; status: string } | null
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

// An availability answer this agent asked for, not yet seen on the website
// (GET schedule-board/notifications). Rides alongside the WhatsApp DM
// services/availability.js sends for the same answer — same firewalled
// fields (ref/town/beds/price/photo), no owner data.
type AvNotification = {
  id: number; ref: string; town: string | null; beds: number | null
  price: number | null; image: string | null; status: string; statusLabel: string
}

type Filters = BoardFilterValue & { towns: string[] }
const EMPTY: Filters = {
  q: '', beds: '', baths: '', min: '', max: '', type: '', towns: [],
  pets: '', sharing: '', sublet: false,
}

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

type BoardView = 'board' | 'recheck' | 'favourites'

// ── WATag ───────────────────────────────────────────────────────────────────
// The anti-spam ceiling. The backend enforces the same number and is the real
// limit — this copy exists so the agent is stopped at selection time with a
// sentence, instead of at send time with fifteen successes and a list of
// leftovers. If they ever disagree, the server wins.
const MAX_TAGS = 15

// The server's off-market guard, mirrored. A tag invites somebody to forward
// the listing, so a flat that has gone must not be offered one. Favourites is
// the tab where this bites: it deliberately keeps showing a listing that went
// off-market after you booked a viewing on it.
// routes/crmScheduleBoard.js lockedReason() is the real gate; this only decides
// whether the control is drawn.
function lockedStatus(s: string | null | undefined) {
  return s === 'rented' || s === 'archived'
}

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
  const isAdmin = me?.role === 'admin'

  // Filters initialise from the URL so a shared link restores the search.
  const [f, setF] = useState<Filters>(() => ({
    q: params.get('q') || '',
    beds: params.get('beds') || '',
    baths: params.get('baths') || '',
    min: params.get('min') || '',
    max: params.get('max') || '',
    type: params.get('type') || '',
    towns: (params.get('towns') || '').split(',').map(s => s.trim()).filter(Boolean),
    // Tenancy rules. Narrowed back to the union so a hand-edited URL like
    // ?pets=maybe falls back to "don't care" instead of filtering everything out.
    pets: (params.get('pets') === 'yes' || params.get('pets') === 'no'
      ? params.get('pets') : '') as '' | 'yes' | 'no',
    sharing: (params.get('sharing') === 'yes' || params.get('sharing') === 'no'
      ? params.get('sharing') : '') as '' | 'yes' | 'no',
    sublet: params.get('sublet') === '1',
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
  // hand.
  // 'favourites' = the listings this agent has a viewing on. Filled
  // automatically by the Book button, and NOT filtered to what is still on the
  // market — a booking on a flat that just went is the one thing you must not
  // stop seeing. Three endpoints, one grid.
  const [view, setView] = useState<BoardView>(
    params.get('view') === 'recheck' ? 'recheck'
      : params.get('view') === 'favourites' ? 'favourites' : 'board')
  const [onlyConfirmed, setOnlyConfirmed] = useState(params.get('only_confirmed') === '1')
  // '' | 'now' | 'soon' | 'dated' | 'YYYY-MM'. The server owns what each means
  // (the ?avail= / ?avail_from= branches in crmScheduleBoard.js).
  const [avail, setAvail] = useState<string>(() => params.get('avail') || params.get('avail_from') || '')
  const [rows, setRows] = useState<Listing[]>([])
  const [recheckCount, setRecheckCount] = useState(0)
  const [favCount, setFavCount] = useState(0)
  // ── WATag selection ───────────────────────────────────────────────────────
  // Refs, not ids: the API speaks refs, and a ref is what the agent reads off
  // the card. A Set keeps "is this one picked?" O(1) across 200 cards.
  //
  // Insertion ORDER is load-bearing. Over fifteen the tail is dropped, so
  // "the first fifteen" has to mean the first fifteen the agent clicked — a Set
  // preserves that, and the backend re-applies the same rule on the order it
  // receives.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tagging, setTagging] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [focusRef, setFocusRef] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [booking, setBooking] = useState<Listing | null>(null)
  const [asking, setAsking] = useState<Listing | null>(null)
  const [statusing, setStatusing] = useState<{ r: Listing; action: StatusAction } | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Collapsible: the map was permanently taking ~420px above the cards, and a
  // plain scroll over it used to zoom instead of moving the page (fixed via
  // gestureHandling below). Open by default so existing behaviour is
  // unsurprising; agents who only use the town chips can now hide it.
  const [mapOpen, setMapOpen] = useState(true)

  const showToast = useCallback((kind: 'ok' | 'err' | 'info', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(t => (t && t.text === text ? null : t)), 5200)
  }, [])

  // ── availability-answer notifications ────────────────────────────────────
  // "You have an answer" for a request-availability click, without a full
  // request-tracking inbox (that's separate, later work). Polled rather than
  // pushed — this board has no websocket — and left on screen until the agent
  // dismisses it, unlike the auto-hiding Toast: a photo + status is worth more
  // than 5 seconds of attention.
  const [avNotifications, setAvNotifications] = useState<AvNotification[]>([])

  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const d = await crmFetch('schedule-board/notifications')
        if (!alive || !Array.isArray(d?.notifications)) return
        setAvNotifications(prev => {
          const known = new Set(prev.map((n: AvNotification) => n.id))
          const fresh = (d.notifications as AvNotification[]).filter(n => !known.has(n.id))
          return fresh.length ? [...prev, ...fresh] : prev
        })
      } catch { /* a missed poll just tries again next interval */ }
    }
    poll()
    const t = setInterval(poll, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const dismissAvNotification = useCallback((id: number) => {
    setAvNotifications(prev => prev.filter(n => n.id !== id))
    crmJson(`schedule-board/notifications/${id}/seen`, 'POST', {}).catch(() => {})
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
      // Selection is NOT mirrored into the URL. A shared board link is a
      // search, and fifteen refs a colleague did not pick riding along in it
      // would be a WATag run waiting to be fired by somebody else.
      if (f.pets) q.set('pets', f.pets)
      if (f.sharing) q.set('sharing', f.sharing)
      if (f.sublet) q.set('sublet', '1')
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
    // The review queue and Favourites are each their own endpoint. Neither can
    // be a query parameter on /listings: pending_check is excluded there by the
    // active filter (which is the point of both), and Favourites is joined to
    // this agent's own bookmark rows.
    //
    // Neither takes the sort or the server-side filters, so the sort control is
    // disabled on those tabs rather than sending a parameter that is ignored.
    const path = view === 'recheck'
      ? 'schedule-board/review-queue'
      : view === 'favourites'
      ? 'schedule-board/favourites'
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

  // Same idea for the Favourites badge: a booking that silently added a card to
  // a tab nobody is looking at is a card nobody finds again.
  useEffect(() => {
    let alive = true
    crmFetch('schedule-board/favourites')
      .then(d => { if (alive) setFavCount((d.listings || []).length) })
      .catch(() => { if (alive) setFavCount(0) })
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
      // ── tenancy rules ─────────────────────────────────────────────────────
      // Three states, so match EXACTLY: 'yes' keeps only true, 'no' keeps only
      // false, and null (nobody wrote it down) is excluded by both. That is the
      // honest reading — a listing that never mentions pets is not evidence
      // either way, so it must not be returned for "pet-friendly" and must not
      // be hidden as if it said no. Applied here with the other client-side
      // filters because petFriendly / sharing / subletting are derived from the
      // listing's own wording by services/listingRules.js, not stored columns.
      if (f.pets === 'yes' && r.petFriendly !== true) return false
      if (f.pets === 'no' && r.petFriendly !== false) return false
      if (f.sharing === 'yes' && r.sharing !== true) return false
      if (f.sharing === 'no' && r.sharing !== false) return false
      if (f.sublet && r.subletting !== true) return false
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
  }, [positioned, f.towns, f.q, f.pets, f.sharing, f.sublet, rect, circ])

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

  // ── pause the robot for one owner ─────────────────────────────────────────
  // The per-listing exception to the reachout schedule (backend migration 019).
  // Optimistic like check-in, and rolled back on failure: the whole point of
  // this control is trust, so a click that silently did nothing would be worse
  // than an error toast.
  async function optOut(r: Listing, next: boolean) {
    if (busyRef) return
    setBusyRef(r.ref)
    setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, autoReachoutOptOut: next } : x))
    try {
      const d = await crmJson(
        `schedule-board/listings/${encodeURIComponent(r.ref)}/reachout-opt-out`,
        'POST', { optOut: next })
      setRows(rs => rs.map(x => x.ref === r.ref
        ? { ...x, autoReachoutOptOut: d.optOut === true } : x))
      showToast('ok', d.message || (next
        ? `Robot paused for #${r.ref}.` : `Robot may ask about #${r.ref} again.`))
    } catch (e: any) {
      setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, autoReachoutOptOut: !next } : x))
      const d = e?.data || {}
      showToast('err', d.error || e?.message || 'Could not change it')
    } finally {
      setBusyRef(null)
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

  // ── WATag ─────────────────────────────────────────────────────────────────
  // Drops a "." into the listing's own category group as a reply to the listing
  // message. The dot is a handle, not a comment: an agent taps the quote above
  // it, WhatsApp jumps to the listing, and they forward that.
  //
  // Two ways in — one card at a time, or a selection from the toolbar — and
  // both land on services/waTag.js, so the ceiling and the one-account rule are
  // the same rule in both.

  function toggleSelect(ref: string) {
    setSelected(s => {
      const next = new Set(s)
      if (next.has(ref)) { next.delete(ref); return next }
      // The stop happens HERE, at the click that would be the sixteenth,
      // because that is the moment the agent can still choose differently. The
      // alternative — letting them pick thirty and truncating at send — tells
      // them which fifteen they got only after the dots are already sent.
      if (next.size >= MAX_TAGS) {
        showToast('info',
          `${MAX_TAGS} is the limit. Unpick one first, or tag these ${MAX_TAGS} and select the rest after.`)
        return s
      }
      next.add(ref)
      return next
    })
  }

  // "Select all" over a filtered board is how the map and the search become the
  // selection tool: draw a circle round Sliema, search 2-bed, hit select.
  // Only listings that CAN be tagged, and only up to the ceiling.
  function selectVisible() {
    const eligible = visible.filter(r => r.canTag !== false && !lockedStatus(r.availableStatus))
    const take = eligible.slice(0, MAX_TAGS).map(r => r.ref)
    setSelected(new Set(take))
    if (eligible.length > MAX_TAGS) {
      showToast('info',
        `Picked the first ${MAX_TAGS} of ${eligible.length}. Unpick any you do not want, or send these and select the rest after.`)
    } else if (!take.length) {
      showToast('info', 'None of these listings has a group message to anchor to.')
    }
  }

  async function tagOne(r: Listing) {
    if (tagging) return
    setTagging(true)
    try {
      const d = await crmJson(
        `schedule-board/listings/${encodeURIComponent(r.ref)}/watag`, 'POST', {})
      showToast('ok', d.message || `#${r.ref} tagged.`)
    } catch (e: any) {
      const d = e?.data || {}
      showToast('err', d.error || d.message || e?.message || 'Could not tag this listing.')
    } finally {
      setTagging(false)
    }
  }

  async function tagSelected() {
    if (tagging || !selected.size) return
    setTagging(true)
    const refs = [...selected]
    showToast('info', `Tagging ${refs.length} listing${refs.length === 1 ? '' : 's'}…`)
    try {
      const d = await crmJson('schedule-board/watag', 'POST', { refs })
      showToast(d.tagged ? 'ok' : 'err', d.message || `${d.tagged} tagged.`)
      // Keep only what did NOT go out, so a second click finishes the job
      // instead of repeating it. Anything the server refused by name stays
      // picked and visible; everything it tagged is dropped.
      const failed = new Set<string>([
        ...(d.skipped || []),
        ...((d.results || []) as Array<{ ref: string; status: string }>)
          .filter(x => x.status !== 'ok' && x.status !== 'duplicate')
          .map(x => x.ref),
      ])
      setSelected(new Set(refs.filter(x => failed.has(x))))
    } catch (e: any) {
      const d = e?.data || {}
      showToast('err', d.error || e?.message || 'WATag failed')
    } finally {
      setTagging(false)
    }
  }

  // ── the star ──────────────────────────────────────────────────────────────
  // Top-left of every card. Filled = on this agent's Favourites. Booking still
  // fills the list by itself; this is the manual half, for the flat you found
  // and want to keep before there is a viewing to book.
  //
  // Optimistic and rolled back on failure, like check-in: the agent already
  // knows what they meant, and a star that waits for a round trip gets clicked
  // twice. Removing the bookmark never touches the viewing.
  async function toggleFavourite(r: Listing, next: boolean) {
    setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, isFavourite: next } : x))
    setFavCount(n => Math.max(0, n + (next ? 1 : -1)))
    try {
      const d = await crmJson(
        `schedule-board/listings/${encodeURIComponent(r.ref)}/favourite`,
        next ? 'POST' : 'DELETE', {})
      // On the Favourites tab an unstarred card has no reason to still be there.
      if (!next && view === 'favourites') setRows(rs => rs.filter(x => x.ref !== r.ref))
      showToast('ok', d.message || (next
        ? `#${r.ref} saved to Favourites.`
        : `#${r.ref} removed from Favourites.`))
    } catch (e: any) {
      setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, isFavourite: !next } : x))
      setFavCount(n => Math.max(0, n + (next ? -1 : 1)))
      const d = e?.data || {}
      showToast('err', d.error || e?.message || 'Could not change it')
    }
  }

  // ── the star, stage 2: Hot Property (migration 031) ────────────────────────
  // One icon, three clicks. Stage 0<->1 is the toggleFavourite above, entirely
  // unchanged — this only adds what happens on top of it:
  //   admin,     step 0 -> click -> step 1  (toggleFavourite, as before)
  //   admin,     step 1 -> click -> step 2  (POST  .../hot)
  //   admin,     step 2 -> click -> step 0  (DELETE .../hot — server also
  //                                          drops this admin's own favourite,
  //                                          so the reset is a real reset)
  //   non-admin, step 2 -> click -> nothing. Hot is locked for them; the
  //                                  server would 403 it anyway, so the
  //                                  frontend does not even round-trip to find
  //                                  that out.
  //   non-admin, step 0/1 -> click -> toggleFavourite, exactly as any agent's
  //                                    star always worked.
  // Optimistic + rolled back on failure, same as toggleFavourite.
  async function toggleStar(r: Listing) {
    const step = starStepOf(r)
    if (!isAdmin) {
      if (step === 2) { showToast('err', 'Only an admin can change a Hot property.'); return }
      return toggleFavourite(r, !r.isFavourite)
    }
    if (step === 0) return toggleFavourite(r, true)
    if (step === 1) {
      setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, isHotProperty: true } : x))
      try {
        const d = await crmJson(`schedule-board/listings/${encodeURIComponent(r.ref)}/hot`, 'POST', {})
        showToast('ok', d.message || `#${r.ref} is now Hot.`)
      } catch (e: any) {
        setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, isHotProperty: false } : x))
        const d = e?.data || {}
        showToast('err', d.error || e?.message || 'Could not mark it Hot')
      }
      return
    }
    // step === 2
    setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, isHotProperty: false, isFavourite: false } : x))
    try {
      const d = await crmJson(`schedule-board/listings/${encodeURIComponent(r.ref)}/hot`, 'DELETE', {})
      showToast('ok', d.message || `#${r.ref} is no longer Hot.`)
    } catch (e: any) {
      setRows(rs => rs.map(x => x.ref === r.ref ? { ...x, isHotProperty: true, isFavourite: r.isFavourite } : x))
      const d = e?.data || {}
      showToast('err', d.error || e?.message || 'Could not clear Hot')
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
            disabled={view !== 'board'}
            title={view === 'recheck'
              ? 'The review queue is ordered oldest-doubt-first'
              : view === 'favourites'
              ? 'Favourites are ordered by when you saved them, newest first'
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
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          {([['board', 'Active board'], ['recheck', 'Needs recheck'],
             ['favourites', 'Favourites']] as const).map(([v, label]) => {
            const on = view === v
            const badge = v === 'recheck' ? recheckCount : v === 'favourites' ? favCount : 0
            return (
              <button key={v} data-tab={v} onClick={() => {
                setView(v)
                // Drop the selection when the grid underneath it changes. A ref
                // picked on the active board that is not in Favourites would
                // still be sent — an invisible selection is the kind of thing
                // that puts a dot in a group nobody meant to touch.
                setSelected(new Set())
              }} style={{
                ...chip, borderRadius: 8,
                background: on ? NAVY : '#FFF',
                borderColor: on ? NAVY : '#E9E5DC',
                color: on ? '#FFF' : '#666',
                fontWeight: on ? 700 : 500,
              }}>
                {label}
                {badge > 0 && (
                  <span style={{
                    marginLeft: 6, fontFamily: FM, fontSize: 10,
                    background: on ? 'rgba(255,255,255,0.22)' : AD,
                    color: on ? '#FFF' : '#7A6534',
                    padding: '1px 5px', borderRadius: 999,
                  }}>{badge}</span>
                )}
              </button>
            )
          })}
          {/* The owner-reachout switch. Sits here rather than in a settings page
              because this is where you notice the robot's work, and it is where
              Kev asked for it (2026-08-16). Admin only, and read-only for
              everybody else — an agent still benefits from seeing whether the
              robot is chasing owners before deciding to chase one himself. */}
          <ReachoutSwitch />
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

        {view === 'favourites' && (
          <div style={{
            background: '#F3F6F4', border: '1px solid rgba(47,111,87,0.22)', borderRadius: 10,
            padding: '10px 14px', fontSize: 11.5, color: '#3C5A4C',
            marginBottom: 14, lineHeight: 1.5,
          }}>
            Everything you have booked a viewing on, newest first. Listings land
            here by themselves when a booking goes through — including ones that
            have since gone off the market, because that is a viewing somebody
            still has to be told about.
          </div>
        )}

        {/* ── WATag toolbar ──────────────────────────────────────────────────
            The multi-select half of WATag. It appears only once something is
            picked, so the board is not carrying a dead bar around all day, and
            it names the count in the button rather than beside it — the number
            is the thing you check before firing. */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          marginBottom: 14,
        }}>
          <button
            data-watag-selectall
            onClick={selectVisible}
            disabled={!visible.length}
            title={`Pick the first ${MAX_TAGS} listings in this search that can be tagged`}
            style={{
              ...chip, borderRadius: 8, background: '#FFF', borderColor: '#E9E5DC',
              color: visible.length ? '#666' : '#C9C4B8',
              cursor: visible.length ? 'pointer' : 'not-allowed',
            }}>
            Select for WATag
          </button>

          {selected.size > 0 && (
            <>
              <button
                data-watag-send
                onClick={tagSelected}
                disabled={tagging}
                title={`Put a "." under each of these ${selected.size} listings in its group`}
                style={{
                  ...chip, borderRadius: 8, background: tagging ? '#8A93A6' : NAVY,
                  borderColor: tagging ? '#8A93A6' : NAVY, color: '#FFF', fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  cursor: tagging ? 'wait' : 'pointer',
                }}>
                <PersonGlyph color="#FFF" />
                {tagging ? 'Tagging…' : `WATag ${selected.size}`}
              </button>
              <button
                onClick={() => setSelected(new Set())}
                style={{ ...subtleLink, fontSize: 11 }}>
                clear
              </button>
              {/* Say the ceiling out loud once it is reached, rather than
                  letting the next click look broken. */}
              <span style={{ fontSize: 10.5, color: selected.size >= MAX_TAGS ? '#B08968' : '#B5AFA2' }}>
                {selected.size >= MAX_TAGS
                  ? `${MAX_TAGS} is the maximum — send these, then pick the rest.`
                  : `${MAX_TAGS - selected.size} more can be picked`}
              </span>
            </>
          )}
        </div>

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

        <button
          onClick={() => setMapOpen(v => !v)}
          style={{
            ...chip, marginBottom: mapOpen ? 8 : 14, background: '#FFF',
            borderColor: '#E9E5DC', color: '#666', fontWeight: 600,
          }}
        >
          {mapOpen ? '▾ Hide map' : '▸ Show map'}
        </button>

        {mapOpen && <MapPanel
          items={visible}
          rect={rect}
          onRect={setRect}
          circ={circ}
          onCirc={setCirc}
          onMarkerClick={onMarkerClick}
          selectedTowns={f.towns}
          isMobile={isMobile}
        />}

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
              onOptOut={next => optOut(r, next)}
              busy={busyRef === r.ref}
              selected={selected.has(r.ref)}
              onSelect={() => toggleSelect(r.ref)}
              onTag={() => tagOne(r)}
              tagging={tagging}
              onStar={() => toggleStar(r)}
              onUnfavourite={view === 'favourites' ? () => toggleFavourite(r, false) : undefined}
            />
          ))}
        </div>

        {!loading && !visible.length && !err && (
          <div style={{ padding: '48px 0', textAlign: 'center', color: '#BBB', fontSize: 13 }}>
            {view === 'recheck'
              ? 'Nothing waiting for a recheck.'
              : view === 'favourites'
              ? 'No favourites yet. Book a viewing and the listing lands here.'
              : 'Nothing matches this search.'}
          </div>
        )}
      </div>

      {detail && (
        <DetailModal
          refId={detail}
          onClose={() => setDetail(null)}
          onAct={act}
          // The modal used to offer one button — "Request availability" — while
          // the card behind it offered five. Opening a listing to read it made
          // every other action disappear (Kev, 2026-08-16). These are the same
          // handlers the card uses, so the two surfaces cannot drift.
          onTag={r => tagOne(r)}
          tagging={tagging}
          onStar={r => toggleStar(r)}
          onBook={r => { setDetail(null); setBooking(r) }}
        />
      )}

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
      {avNotifications.length > 0 && (
        <AvNotificationStack items={avNotifications} onDismiss={dismissAvNotification} />
      )}
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
      // 'greedy' (Maps JS default outside an iframe) grabs a bare mouse-wheel
      // as a zoom, so scrolling the page while the cursor happens to be over
      // the map gets you stuck zooming instead. 'cooperative' needs
      // ctrl/⌘+scroll to zoom and lets a plain wheel pass through to the page;
      // a one-finger drag still pans, a two-finger drag still zooms on touch.
      gestureHandling: 'cooperative',
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

  // Was 420/260 — the map ate almost a full screen of scroll before the
  // cards even started. Still tall enough to draw a usable area with the
  // circle/box tool; the "Hide map" toggle above covers the rest.
  const height = isMobile ? 220 : 320

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

// The star. Same shape at every step so the card never shifts on click —
// only the fill changes: outline (0, normal), solid white (1, favourite —
// the wrapping button supplies the gold), solid white again (2, hot — the
// wrapping button supplies red/orange instead). The glyph itself only needs
// to know "is this the outline state or not".
const StarGlyph = ({ filled, size = 15 }: { filled: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false"
    fill={filled ? '#FFF' : 'none'} style={{ flexShrink: 0 }}>
    <path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85L12 3.6z"
      stroke={filled ? '#FFF' : '#7A7A7A'} strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
)

// starStep helper — the one place that turns the two flags into the number
// the click handler and the render both key off. Falls back to the plain
// isFavourite boolean for a payload from before migration 031.
function starStepOf(r: { isHotProperty?: boolean; isFavourite?: boolean }): number {
  return r.isHotProperty ? 2 : (r.isFavourite ? 1 : 0)
}

// The WATag mark. A person, per Kev's brief — the tag is about handing a
// listing to another human, which is not something a paperclip or an arrow
// says. Inline SVG like the paw and the people icon above it, so the card does
// not pull an icon package in for one glyph.
const PersonGlyph = ({ color = 'currentColor', size = 13 }: { color?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false"
    style={{ flexShrink: 0 }}>
    <circle cx="12" cy="8" r="3.4" stroke={color} strokeWidth="1.9" />
    <path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6"
      stroke={color} strokeWidth="1.9" strokeLinecap="round" />
  </svg>
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
// ── the owner-reachout switch ────────────────────────────────────────────────
//
// One control for the whole robot flow (backend: reachout_settings, migration
// 019). Reading is open to any board user; only an admin may move it.
//
// It shows the EFFECTIVE state, not just the setting. There is a second,
// independent kill switch in the backend's environment, and a UI that said
// "every 3 days" while that flag was off would be lying about what happens.
function ReachoutSwitch() {
  // `canEdit` comes from the server (it re-reads the live role), so this
  // component does not need the role from context — and cannot disagree with
  // the backend about who may change the schedule.
  const [s, setS] = useState<{
    mode: string; retryDays: number | null; dailyCap: number; enabled: boolean
    envArmed: boolean; effective: boolean; optedOutCount: number; canEdit: boolean
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    crmFetch('schedule-board/reachout-settings')
      .then(d => { if (alive) setS(d) })
      .catch(() => { if (alive) setS(null) })
    return () => { alive = false }
  }, [])

  if (!s) return null

  const LABEL: Record<string, string> = {
    '2d': 'every 2 days', '3d': 'every 3 days', weekly: 'weekly',
    monthly: 'monthly', never: 'off',
  }

  async function change(mode: string) {
    setSaving(true); setNote(null)
    try {
      const d = await crmJson('schedule-board/reachout-settings', 'PUT', { mode })
      setS(prev => (prev ? { ...prev, ...d } : prev))
      setNote(d.message || null)
    } catch (e: any) {
      setNote(e?.data?.error || e?.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const on = s.effective
  return (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 10.5, color: '#B5AFA2', whiteSpace: 'nowrap' }}>
        auto owner check
      </span>
      {s.canEdit ? (
        <select
          value={s.mode}
          disabled={saving}
          onChange={e => change(e.target.value)}
          title={s.envArmed
            ? 'How often the robot may re-ask one owner whether a listing is still on the market'
            : 'The backend kill switch (AVAILABILITY_AUTO_REACHOUT) is off, so nothing is sent whatever this says'}
          style={{
            ...chip, borderRadius: 8, cursor: saving ? 'wait' : 'pointer',
            background: on ? NAVY : '#FFF',
            borderColor: on ? NAVY : '#E9E5DC',
            color: on ? '#FFF' : '#666',
            fontWeight: on ? 700 : 500,
            paddingRight: 8,
          }}>
          {(['never', '2d', '3d', 'weekly', 'monthly'] as const).map(m => (
            <option key={m} value={m} style={{ color: '#222', background: '#FFF' }}>
              {LABEL[m]}
            </option>
          ))}
        </select>
      ) : (
        <span style={{
          ...chip, borderRadius: 8, background: on ? NAVY : '#FFF',
          borderColor: on ? NAVY : '#E9E5DC', color: on ? '#FFF' : '#666',
        }}>
          {LABEL[s.mode] || s.mode}
        </span>
      )}
      {/* The setting says on, the environment says no. Say so out loud rather
          than letting somebody believe owners are being contacted. */}
      {s.enabled && !s.envArmed && (
        <span title="AVAILABILITY_AUTO_REACHOUT is not set in the backend environment"
          style={{ fontSize: 10, color: '#B91C1C', fontWeight: 700 }}>
          blocked by backend
        </span>
      )}
      {s.optedOutCount > 0 && (
        <span title={`${s.optedOutCount} listing(s) have the robot paused individually`}
          style={{ fontSize: 10, color: '#B08968', fontFamily: FM }}>
          {s.optedOutCount} paused
        </span>
      )}
      {note && (
        <span style={{ fontSize: 10, color: '#7A6534', maxWidth: 260, lineHeight: 1.3 }}>
          {note}
        </span>
      )}
    </div>
  )
}

function Card({ r, focused, innerRef, onOpen, onAct, onBook, onAsk, onCheckIn, onStatus, onOptOut, busy,
                selected, onSelect, onTag, tagging, onStar, onUnfavourite }: {
  r: Listing
  focused: boolean
  innerRef: (el: HTMLDivElement | null) => void
  onOpen: () => void
  onAct: (kind: 'request-availability' | 'request-location', r: Listing) => void
  onBook: () => void
  onAsk: () => void
  onCheckIn: () => void
  onStatus: (action: StatusAction) => void
  onOptOut: (next: boolean) => void
  busy: boolean
  // WATag. `selected` drives the tick in the corner; `onTag` is the per-card
  // button, which does not touch the selection at all — one listing, one dot.
  selected: boolean
  onSelect: () => void
  onTag: () => void
  tagging: boolean
  // The star, top-left. Passed everywhere, on every tab. Owns the whole
  // 3-click cycle (see Board():toggleStar) — the card only ever fires it and
  // reads r.starStep back, never decides the transition itself.
  onStar: () => void
  // Only passed on the Favourites tab. Its absence is what hides the control
  // everywhere else, rather than a second copy of "which tab am I on".
  onUnfavourite?: () => void
}) {
  // Role decides which of the rarer controls this card even offers. Read from
  // context rather than passed down: every card wants the same answer, and
  // threading it through the list would be one more prop to forget.
  const { me } = useCrm()
  const isAdmin = me?.role === 'admin'
  const confirmed = r.availableStatus === 'available_confirmed'
  // Can this listing be anchored at all? Two independent reasons it cannot:
  // there is no stored group message to quote (85 of 215 listings), or it is
  // off the market and must not be offered for forwarding. The server refuses
  // both; this decides whether the control is drawn live or dead.
  const offMarket = lockedStatus(r.availableStatus)
  const noAnchor  = r.canTag === false
  const canTag    = !offMarket && !noAnchor
  const tagWhy    = offMarket
    ? 'Off the market — tagging it would invite somebody to forward it.'
    : noAnchor
    ? 'This listing has no saved group message to anchor a tag to.'
    : 'Put a "." under this listing in its group, so it can be forwarded quickly'
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
        {/* The star. Top-left corner, Kev's call (2026-08-16) — the first place
            the eye lands on a card, and the same corner the Inventory star
            lives in. Three steps (migration 031): outline = normal, gold =
            your Favourite, red = Hot Property (global, admin-set — see
            Board():toggleStar for the click cycle this fires into).
            stopPropagation: the photo opens the detail modal, and starring a
            listing is not asking to read it. */}
        <button
          data-favourite={r.ref}
          data-star-step={starStepOf(r)}
          aria-pressed={starStepOf(r) > 0}
          onClick={e => { e.stopPropagation(); onStar() }}
          title={
            starStepOf(r) === 2
              ? (isAdmin
                  ? 'HOT property — visible to everyone. Click to clear.'
                  : 'HOT property — set by an admin, visible to everyone.')
              : starStepOf(r) === 1
                ? (isAdmin
                    ? 'On your Favourites — click to make it Hot for everyone.'
                    : 'On your Favourites — click to remove. The viewing, if any, stays.')
                : 'Save to your Favourites'
          }
          style={{
            position: 'absolute', top: 7, left: 7,
            width: 30, height: 30, borderRadius: 8, padding: 0,
            display: 'grid', placeItems: 'center', lineHeight: 0,
            background: starStepOf(r) === 2 ? HOT : starStepOf(r) === 1 ? 'rgba(212,137,26,0.95)' : 'rgba(255,255,255,0.86)',
            border: `1.5px solid ${starStepOf(r) === 2 ? HOT : starStepOf(r) === 1 ? A : 'rgba(0,0,0,0.14)'}`,
            cursor: 'pointer',
          }}>
          <StarGlyph filled={starStepOf(r) > 0} />
        </button>

        {r.isHotProperty && (
          <span style={{ position: 'absolute', top: 9, left: 44, background: HOT, color: '#FFF', fontSize: 9, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', padding: '3px 7px', borderRadius: 5 }}>
            Hot
          </span>
        )}
        {r.isMine && !r.isHotProperty && (
          <span style={{ position: 'absolute', top: 9, left: 44, background: GREEN, color: '#FFF', fontSize: 9, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', padding: '3px 7px', borderRadius: 5 }}>
            Yours
          </span>
        )}
        {r.imageCount > 1 && (
          <span style={{ position: 'absolute', bottom: 9, right: 9, background: 'rgba(0,0,0,0.55)', color: '#FFF', fontSize: 10, fontFamily: FM, padding: '2px 6px', borderRadius: 4 }}>
            {r.imageCount}
          </span>
        )}

        {/* The WATag pick box. Bottom-left of the photo, out of the way of the
            "Yours" badge and the freshness timer, and 30px square so it clears
            the tap floor the mobile pass enforces.
            stopPropagation because the photo itself opens the detail modal —
            picking a listing and opening it are different intentions. */}
        {canTag && (
          <button
            data-watag-pick={r.ref}
            aria-pressed={selected}
            onClick={e => { e.stopPropagation(); onSelect() }}
            title={selected ? 'Picked for WATag — click to unpick' : 'Pick for WATag'}
            style={{
              position: 'absolute', bottom: 7, left: 7,
              width: 30, height: 30, borderRadius: 8, padding: 0,
              display: 'grid', placeItems: 'center',
              background: selected ? NAVY : 'rgba(255,255,255,0.86)',
              border: `1.5px solid ${selected ? NAVY : 'rgba(0,0,0,0.14)'}`,
              color: selected ? '#FFF' : '#7A7A7A',
              cursor: 'pointer', lineHeight: 0,
            }}>
            {selected
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7" stroke="#FFF" strokeWidth="2.6"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              : <PersonGlyph color="#7A7A7A" size={15} />}
          </button>
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
              a phone, which tests/schedule-board.test.js catches.

              ADMIN ONLY since 2026-08-16 (Kev). Two different reasons:
              • archive is irreversible from this board — it is the one action
                that takes a listing out of the review queue as well.
              • recheck is redundant for an agent: a listing nobody has
                confirmed goes stale on its own (STALE_HOURS, backend) and shows
                up in "Needs recheck" without anybody clicking anything.
              The routes still accept both from any agent — this hides the
              buttons, it does not change permissions. */}
          {isAdmin && (
            <>
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
            </>
          )}
        </div>

        {/* "Leave this owner alone" — the per-listing exception to the robot's
            reachout schedule. Shown to an admin and to the agent the listing
            belongs to; the backend enforces the same rule and 403s otherwise.
            Deliberately NOT a status: it changes nothing about the listing, only
            whether our scheduler is allowed to message this owner. */}
        {(isAdmin || r.isMine) && (
          <button
            onClick={() => onOptOut(!r.autoReachoutOptOut)}
            disabled={busy}
            title={r.autoReachoutOptOut
              ? 'The robot is not asking this owner. Click to allow it again.'
              : 'Stop the automatic owner check for this listing. You can still ask by hand.'}
            style={{
              ...subtleLink,
              marginBottom: 10,
              alignSelf: 'flex-start',
              color: r.autoReachoutOptOut ? '#B08968' : '#B5AFA2',
              opacity: busy ? 0.5 : 1,
            }}>
            {r.autoReachoutOptOut ? '⏸ robot paused for this owner' : 'pause robot for this owner'}
          </button>
        )}

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
            {/* Kev, 2026-08-16: the label is the QUESTION we are about to ask,
                not the topic. "Availability" reads like a status you are being
                shown; this reads like the message that is about to go out. */}
            Still on Market?
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
            {/* Kev asked for "Ask Owner" (2026-08-16). It says Owner only where
                that is TRUE: routes/crmScheduleBoard.js ask/send resolves the
                owner with `isMine ? ownerFor(...) : null`, so on a colleague's
                listing this question reaches the listing AGENT. A button that
                said "Ask Owner" there would be a lie about who we messaged. */}
            {r.isMine ? 'Ask Owner' : 'Ask Agent'}
          </button>

          {/* Booking is internal — never blocked by a contact rule. */}
          <button
            onClick={onBook}
            title="Book a viewing"
            style={{ ...btn, background: '#FFF', color: NAVY, border: `1px solid ${AB}`, fontWeight: 700 }}>
            Book
          </button>

          {/* WATag, one listing. Deliberately separate from the pick box on the
              photo: this is "tag this one now", that is "add it to a batch".
              Drawn even when it cannot fire, greyed with the reason in the
              tooltip — a button that vanishes teaches nobody why. */}
          <button
            data-watag-one={r.ref}
            onClick={() => canTag && !tagging && onTag()}
            disabled={!canTag || tagging}
            title={tagWhy}
            style={{
              ...btn,
              background: '#FFF',
              color: canTag ? NAVY : '#C9C4B8',
              border: `1px solid ${canTag ? 'rgba(27,42,74,0.18)' : '#EDE9E0'}`,
              cursor: canTag && !tagging ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
            {/* Person + @, no word (Kev, 2026-08-16). The row already carries
                three worded buttons; a fourth pushed the set onto two lines on a
                laptop. The tooltip is where the sentence lives. */}
            <PersonGlyph color={canTag ? NAVY : '#C9C4B8'} size={14} />
            <span style={{ fontFamily: FM, fontSize: 13, fontWeight: 600, lineHeight: 1 }}>@</span>
          </button>

          {!r.isMine && !r.hasViewingLocation && c.canAsk && (
            <button onClick={() => onAct('request-location', r)}
              style={{ ...btn, background: '#FFF', color: '#7A6534', border: `1px solid ${AB}` }}
              title="Ask the listing agent where the viewing is">
              Location
            </button>
          )}
        </div>

        {/* Favourites only: the viewing this card is here for, and a way off the
            list. Reads under the buttons so the card's shape does not change
            between tabs. */}
        {onUnfavourite && (
          <div style={{
            marginTop: 8, paddingTop: 8, borderTop: '1px solid #F1EEE7',
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 10.5, color: GREEN, fontWeight: 600 }}>
              {r.viewing
                ? `Viewing ${fmtDay(r.viewing.date)}${r.viewing.time ? ` at ${r.viewing.time}` : ''}`
                : 'Saved'}
            </span>
            {r.viewing && r.viewing.status !== 'confirmed' && (
              <span style={{ fontSize: 9.5, color: '#B08968' }}>{r.viewing.status}</span>
            )}
            <button
              data-unfavourite={r.ref}
              onClick={onUnfavourite}
              title="Take it off Favourites. The viewing stays in the diary."
              style={{ ...subtleLink, marginLeft: 'auto', fontSize: 10.5 }}>
              remove
            </button>
          </div>
        )}

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
function DetailModal({ refId, onClose, onAct, onTag, tagging, onStar, onBook }: {
  refId: string
  onClose: () => void
  onAct: (kind: 'request-availability' | 'request-location', r: Listing) => void
  onTag: (r: Listing) => void
  tagging: boolean
  // Same shared cycle as the card (Board():toggleStar) — the modal hands it a
  // Listing shaped from its OWN local fav/hot state (not the board's row,
  // which the modal never touches) and mirrors the result back locally.
  onStar: (r: Listing) => Promise<void>
  onBook: (r: Listing) => void
}) {
  const { me } = useCrm()
  const isAdmin = me?.role === 'admin'
  const [d, setD] = useState<any>(null)
  const [e, setE] = useState<string | null>(null)
  const [i, setI] = useState(0)
  // The star's state lives here as well as on the board: the modal fetches its
  // own copy of the listing, so it would otherwise keep showing the value it
  // loaded with after the star is clicked.
  const [fav, setFav] = useState(false)
  const [hot, setHot] = useState(false)

  useEffect(() => {
    let alive = true
    crmFetch(`schedule-board/listings/${encodeURIComponent(refId)}`)
      .then(x => { if (alive) { setD(x); setFav(!!x.isFavourite); setHot(!!x.isHotProperty) } })
      .catch(x => { if (alive) setE(x?.message || 'Could not load listing') })
    return () => { alive = false }
  }, [refId])

  // Mirrors Board():toggleStar's decision locally so the modal's own star
  // updates in place, then lets the same shared function make the real call
  // (and, for admin's own view on the board, keep the list card in sync too).
  async function clickStar() {
    const step = hot ? 2 : (fav ? 1 : 0)
    if (!isAdmin && step === 2) return // locked, same rule as the card
    if (step === 0) setFav(true)
    else if (step === 1) { if (isAdmin) setHot(true); else setFav(false) }
    else { setHot(false); setFav(false) }
    await onStar({ ...d, isFavourite: fav, isHotProperty: hot })
  }

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
                <>
                  {/* click-through arrows, not the small dots agents kept missing on
                      touch — wrap around at both ends so there is no dead end */}
                  <button
                    onClick={ev => { ev.stopPropagation(); setI(n => (n - 1 + d.images.length) % d.images.length) }}
                    aria-label="Previous photo"
                    style={{
                      position: 'absolute', top: '50%', left: 10, transform: 'translateY(-50%)',
                      border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.45)', color: '#FFF',
                      width: 34, height: 34, borderRadius: '50%', fontSize: 18, lineHeight: 1,
                    }}
                  >‹</button>
                  <button
                    onClick={ev => { ev.stopPropagation(); setI(n => (n + 1) % d.images.length) }}
                    aria-label="Next photo"
                    style={{
                      position: 'absolute', top: '50%', right: 10, transform: 'translateY(-50%)',
                      border: 'none', cursor: 'pointer', background: 'rgba(0,0,0,0.45)', color: '#FFF',
                      width: 34, height: 34, borderRadius: '50%', fontSize: 18, lineHeight: 1,
                    }}
                  >›</button>
                  <div style={{
                    position: 'absolute', bottom: 10, right: 12, fontFamily: FM, fontSize: 11,
                    color: '#FFF', background: 'rgba(0,0,0,0.45)', borderRadius: 10, padding: '3px 8px',
                  }}>{i + 1} / {d.images.length}</div>
                </>
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

                {/* Book, WATag and the star — the rest of what the card offers.
                    Same verdicts as the card: off-market or no stored group
                    message means the tag is drawn dead with the reason on it. */}
                <button
                  onClick={() => onBook(d)}
                  style={{ ...btn, background: '#FFF', color: NAVY, border: `1px solid ${AB}`, fontWeight: 700 }}>
                  Book
                </button>

                {(() => {
                  const off = lockedStatus(d.availableStatus)
                  const can = !off && d.canTag !== false
                  return (
                    <button
                      data-watag-one={d.ref}
                      onClick={() => can && !tagging && onTag(d)}
                      disabled={!can || tagging}
                      title={off
                        ? 'Off the market — tagging it would invite somebody to forward it.'
                        : d.canTag === false
                        ? 'This listing has no saved group message to anchor a tag to.'
                        : 'Put a "." under this listing in its group, so it can be forwarded quickly'}
                      style={{
                        ...btn, background: '#FFF',
                        color: can ? NAVY : '#C9C4B8',
                        border: `1px solid ${can ? 'rgba(27,42,74,0.18)' : '#EDE9E0'}`,
                        cursor: can && !tagging ? 'pointer' : 'not-allowed',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}>
                      <PersonGlyph color={can ? NAVY : '#C9C4B8'} size={14} />
                      <span style={{ fontFamily: FM, fontSize: 13, fontWeight: 600, lineHeight: 1 }}>@</span>
                    </button>
                  )
                })()}

                <button
                  data-favourite={d.ref}
                  aria-pressed={hot || fav}
                  onClick={clickStar}
                  title={
                    hot
                      ? (isAdmin ? 'HOT property — click to clear' : 'HOT property — set by an admin')
                      : fav
                        ? (isAdmin ? 'On your Favourites — click to make it Hot for everyone' : 'On your Favourites — click to remove')
                        : 'Save to your Favourites'
                  }
                  style={{
                    ...btn,
                    background: hot ? HOT : fav ? 'rgba(212,137,26,0.95)' : '#FFF',
                    border: `1px solid ${hot ? HOT : fav ? A : AB}`,
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    color: hot || fav ? '#FFF' : '#7A6534',
                  }}>
                  <StarGlyph filled={hot || fav} size={14} />
                  {hot ? 'Hot' : fav ? 'Saved' : 'Save'}
                </button>
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

// Self-explanatory by design: photo + town/beds/price + status, so an agent
// who asked about "#204" days ago does not have to go back to the board to
// remember which flat that was. Click anywhere on a card (or its ×) to mark
// it seen — see dismissAvNotification above.
function AvNotificationStack({ items, onDismiss }: {
  items: AvNotification[]
  onDismiss: (id: number) => void
}) {
  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 310,
      display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320, width: 'calc(100vw - 32px)',
    }}>
      {items.map(n => {
        const facts = [
          townLabel(n.town),
          n.beds != null ? `${n.beds} bed${n.beds === 1 ? '' : 's'}` : null,
          n.price ? `€${n.price.toLocaleString()}` : null,
        ].filter(Boolean).join(' · ')
        return (
          <div key={n.id} onClick={() => onDismiss(n.id)} style={{
            display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer',
            background: CARD, borderRadius: 12, padding: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,0.22)', fontFamily: F,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: 8, background: '#F1EEE7',
              flexShrink: 0, overflow: 'hidden',
            }}>
              {n.image
                ? <img src={n.image} alt={`#${n.ref}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                : null}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontFamily: FM, fontSize: 11, color: A }}>#{n.ref} · {n.statusLabel}</div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#222', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {facts || 'Availability answered'}
              </div>
            </div>
            <button onClick={ev => { ev.stopPropagation(); onDismiss(n.id) }} style={{
              border: 'none', background: 'none', color: '#B5AFA2', cursor: 'pointer',
              fontSize: 16, lineHeight: 1, padding: 4, flexShrink: 0,
            }}>×</button>
          </div>
        )
      })}
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
