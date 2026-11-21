'use client'
// NEXUS Smart Intelligence for the Marketplace (2026-11-21, Kev's redesign brief). Same engine as before
// (ARGUS places -> buildLifeOverview, routes from /api/nexus/property-routing = OpenStreetMap / self-hosted OSRM),
// new presentation: compact metrics, category tiles that expand into the real places, a contextual neutral map,
// travel modes Car (default) · Taxi / Cab · Walk. No bus. No made-up scores. A time appears only when a mapped
// route exists; otherwise the straight-line distance is shown and labelled as such.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { BriefcaseBusiness, CarFront, CarTaxiFront, ChevronDown, Coffee, Dumbbell, Footprints, GraduationCap, Hand, HeartPulse, MapPin, Ship, ShoppingBasket, Star, Utensils, Waves } from 'lucide-react'
import type { PropertyLifeOverview as Overview, PlaceDistance } from '@/lib/nexus-property-context'

type Key = Overview['categories'][number]['key']
type Mode = 'car' | 'taxi' | 'walk'
type Route = { id: string; drivingSeconds?: number | null; walkingSeconds?: number | null; drivingDistanceMetres?: number | null; walkingDistanceMetres?: number | null }
const MODE_KEY = 'nexus-travel-mode'
const MODES = [{ key: 'car', label: 'Car', Icon: CarFront }, { key: 'taxi', label: 'Taxi / Cab', Icon: CarTaxiFront }, { key: 'walk', label: 'Walk', Icon: Footprints }] as const
const ICON: Record<Key, typeof Waves> = { groceries: ShoppingBasket, coast: Waves, health: HeartPulse, movement: Dumbbell, school: GraduationCap, commute: BriefcaseBusiness, restaurant: Utensils, cafe: Coffee }
const ORDER: Key[] = ['groceries', 'coast', 'movement', 'health', 'restaurant', 'cafe', 'school', 'commute']
const SHORT: Partial<Record<Key, string>> = { groceries: 'Groceries', coast: 'Sea & Coast', movement: 'Fitness', health: 'Health', restaurant: 'Restaurants', cafe: 'Cafés', school: 'Schools', commute: 'Work Hubs' }
const ROLE: Record<string, string> = { 'weekly-shop': 'Weekly shop', 'top-up': 'Quick essentials', swimming: 'Swimming', gym: 'Gym', health: 'Health', school: 'School', commute: 'Work hub', restaurant: 'Restaurant', cafe: 'Café', mobility: 'Transport' }
const dist = (km: number) => (km < 1 ? `${Math.max(50, Math.round(km * 20) * 50)} m` : `${km.toFixed(1)} km`)
const mins = (s?: number | null) => (s != null && Number.isFinite(s) ? `${Math.max(1, Math.round(s / 60))} min` : null)

export function SmartArea({ overview, area, fromCentre }: { overview: Overview; area: string; fromCentre: boolean }) {
  const reduce = useReducedMotion()
  const [mode, setModeState] = useState<Mode>('car')
  useEffect(() => { try { const m = localStorage.getItem(MODE_KEY); if (m === 'car' || m === 'taxi' || m === 'walk') setModeState(m) } catch { /* default Car */ } }, [])
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* not kept */ } }
  const cats = useMemo(() => ORDER.map(k => overview.categories.find(c => c.key === k)).filter((c): c is Overview['categories'][number] => !!c && c.places.length > 0), [overview])
  const [open, setOpen] = useState<Key | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [routes, setRoutes] = useState<Record<string, Route>>({})
  const [routesReady, setRoutesReady] = useState(false)
  const [origin, setOrigin] = useState<[number, number]>(overview.origin)
  const [leg, setLeg] = useState<{ id: string; mode: Mode; geometry: unknown; ferry: boolean } | null>(null)

  // one summary call: modelled car + walk times for every mapped place (OSRM), area-level origin
  useEffect(() => {
    let alive = true
    fetch(`/api/nexus/property-routing?ref=${encodeURIComponent(overview.reference)}`).then(r => (r.ok ? r.json() : null)).then(d => {
      if (!alive) return
      if (Array.isArray(d?.publicCoordinates)) setOrigin(d.publicCoordinates)
      if (Array.isArray(d?.places)) setRoutes(Object.fromEntries(d.places.map((p: Route) => [p.id, p])))
    }).catch(() => {}).finally(() => alive && setRoutesReady(true))
    return () => { alive = false }
  }, [overview.reference])

  const time = useCallback((id: string, m: Mode = mode) => mins(m === 'walk' ? routes[id]?.walkingSeconds : routes[id]?.drivingSeconds), [routes, mode])
  const all = useMemo(() => cats.flatMap(c => c.places.map(p => ({ ...p, connector: c.key }))), [cats])
  const within1 = all.filter(p => p.distanceKm <= 1).length
  const metric = (k: Key, role?: string) => { const c = cats.find(x => x.key === k); return c?.places.find(p => !role || p.role === role) || c?.places[0] }
  const stats = [
    { k: 'groceries' as Key, label: 'Supermarket', p: metric('groceries', 'weekly-shop') },
    { k: 'coast' as Key, label: 'Sea', p: metric('coast') },
    { k: 'movement' as Key, label: 'Gym', p: metric('movement') },
  ].filter(s => s.p)

  const active = cats.find(c => c.key === open) || null
  const selected = (chosen && all.find(p => p.id === chosen)) || active?.places[0] || null

  // the chosen place gets a full route (geometry for the map, ferry check for walking)
  useEffect(() => {
    if (!selected) { setLeg(null); return }
    const ctl = new AbortController()
    fetch(`/api/nexus/property-routing?ref=${encodeURIComponent(overview.reference)}&place=${encodeURIComponent(selected.id)}&mode=${mode === 'walk' ? 'walk' : 'car'}`, { signal: ctl.signal })
      .then(r => (r.ok ? r.json() : null)).then(d => { if (d) setLeg({ id: selected.id, mode, geometry: d.geometry || null, ferry: !!(d.includesFerry && Array.isArray(d.ferries) && d.ferries.length) }) }).catch(() => {})
    return () => ctl.abort()
  }, [overview.reference, selected?.id, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // contextual map (neutral NEXUS style); touch devices tap once to use it so it never traps page scrolling
  const frame = useRef<HTMLIFrameElement>(null)
  const [mapReady, setMapReady] = useState(0)
  const [mapOn, setMapOn] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { // the map loads when the section comes near, not with the page
    const el = box.current; if (!el) return
    const io = new IntersectionObserver(e => { if (e.some(x => x.isIntersecting)) { setShowMap(true); io.disconnect() } }, { rootMargin: '400px' })
    io.observe(el); return () => io.disconnect()
  }, [])
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.channel !== 'estate-area-map') return
      if (e.data.ready) setMapReady(n => n + 1)
      const hit = all.find(p => p.id === e.data.selected)
      if (hit) { setOpen(hit.connector); setChosen(hit.id) }
    }
    addEventListener('message', onMsg); return () => removeEventListener('message', onMsg)
  }, [all])
  useEffect(() => {
    const cat = active || cats[0]; if (!cat) return
    frame.current?.contentWindow?.postMessage({ channel: 'estate-area-map', intelligence: { origin, precision: 'AREA_ONLY', places: all }, category: cat.key, places: cat.places,
      selected: open ? selected?.id : undefined, geometry: leg && selected && leg.id === selected.id && leg.mode === mode ? leg.geometry : null, mode: mode === 'walk' ? 'walk' : 'car' }, location.origin)
  }, [mapReady, origin, all, active, cats, open, selected, leg, mode])

  if (!cats.length) return <p className="mp-muted">This area is not mapped well enough yet. It stays unknown instead of becoming a made-up score.</p>
  return (
    <div className="sa" ref={box}>
      <div className="sa-top">
        <div className="sa-stats">
          <div className="sa-stat"><b>{within1}</b><span>places within 1 km</span></div>
          {stats.map(s => { const I = ICON[s.k]; const t = time(s.p!.id); return (
            <button key={s.k} type="button" className="sa-stat" onClick={() => { setOpen(s.k); setChosen(s.p!.id) }}>
              <b><I size={15} aria-hidden="true" />{t || dist(s.p!.distanceKm)}</b><span>{s.label}{t ? ` · ${mode === 'walk' ? 'on foot' : 'by road'}` : ' · direct'}</span>
            </button>) })}
        </div>
        <div className="sa-modes" role="group" aria-label="Travel mode">
          {MODES.map(m => (
            <button key={m.key} type="button" aria-pressed={mode === m.key} onClick={() => setMode(m.key)}>
              {mode === m.key && <motion.i className="sa-glider" layoutId="sa-mode" transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 38 }} />}
              <m.Icon size={15} aria-hidden="true" /><span>{m.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sa-body">
        <motion.div className="sa-cats" initial={reduce ? false : 'h'} whileInView="v" viewport={{ once: true, margin: '-40px' }} variants={{ v: { transition: { staggerChildren: 0.035 } } }}>
          {cats.map(c => {
            const I = ICON[c.key]; const near = c.places[0]; const t = time(near.id)
            return (
              <motion.button key={c.key} type="button" className="sa-cat" aria-expanded={open === c.key} onClick={() => { setOpen(o => (o === c.key ? null : c.key)); setChosen(null) }}
                variants={{ h: { opacity: 0, y: 8 }, v: { opacity: 1, y: 0 } }} whileTap={reduce ? undefined : { scale: 0.98 }}>
                <span className="sa-ic" data-k={c.key}><I size={17} aria-hidden="true" /></span>
                <span className="sa-cat-txt"><b>{SHORT[c.key] || c.label}</b><small>{near.name}</small></span>
                <span className="sa-cat-val"><b>{t || dist(near.distanceKm)}</b><small>{c.places.length} {c.places.length === 1 ? 'place' : 'places'}</small></span>
              </motion.button>
            )
          })}
        </motion.div>
        <figure className="sa-map" data-on={mapOn || undefined}>
          {showMap && <iframe ref={frame} src="/link-marketplace/nexus-area-map.html?v=1" title={`Map of useful places around ${area}`} loading="lazy" onLoad={() => setMapReady(n => n + 1)} />}
          {!mapOn && <button type="button" className="sa-map-shield" onClick={() => setMapOn(true)} aria-label="Use the map"><Hand size={15} aria-hidden="true" />Tap to explore the map</button>}
          <figcaption><MapPin size={12} aria-hidden="true" />{fromCentre ? `${area} area point · no exact address before a viewing` : 'Property location'}</figcaption>
        </figure>
      </div>

      <AnimatePresence initial={false}>
        {active && (
          <motion.div key={active.key} className="sa-list" initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={reduce ? undefined : { opacity: 0, height: 0 }} transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}>
            <div className="sa-list-head"><b>{SHORT[active.key] || active.label}</b><span className="mp-muted small">{active.summary}</span><button type="button" onClick={() => setOpen(null)} aria-label="Close list"><ChevronDown size={16} /></button></div>
            <ol>{active.places.slice(0, 12).map((p: PlaceDistance, i) => {
              const car = time(p.id, 'car'), walk = time(p.id, 'walk'); const on = selected?.id === p.id
              return (
                <motion.li key={p.id} initial={reduce ? false : { opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 8) * 0.025 }}>
                  <button type="button" aria-pressed={on} onClick={() => setChosen(p.id)}>
                    <span className="sa-pl-name"><b>{p.name}</b><small>{ROLE[p.role] || p.kind.replace(/_/g, ' ')}{p.rating ? <> · <Star size={11} aria-hidden="true" />{p.rating.toFixed(1)}</> : null}</small></span>
                    <span className="sa-pl-times">
                      <i data-on={mode !== 'walk' || undefined}><CarFront size={12} aria-hidden="true" />{car || '—'}</i>
                      <i data-on={mode === 'walk' || undefined}><Footprints size={12} aria-hidden="true" />{on && leg?.id === p.id && leg.mode === 'walk' && leg.ferry ? <>{walk}<Ship size={11} aria-label="includes a ferry" /></> : walk || '—'}</i>
                      <small>{dist(p.distanceKm)} direct</small>
                    </span>
                  </button>
                </motion.li>
              )
            })}</ol>
          </motion.div>
        )}
      </AnimatePresence>
      <p className="sa-note">{routesReady && !Object.keys(routes).length ? 'Routes are not available right now; straight-line distances are shown. ' : ''}Times are modelled routes (OpenStreetMap / OSRM) from the {fromCentre ? 'area point' : 'property'}, no live traffic. Taxi / Cab follows the road route; fare and pickup are not included.</p>
    </div>
  )
}
