'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { ArrowUpRight, BusFront, CarFront, Check, CircleAlert, Footprints, HeartPulse, MapPinned, Route, ShoppingBasket, Sparkles, Star, Waves, CarTaxiFront, GraduationCap, BriefcaseBusiness, Utensils, Coffee } from 'lucide-react'
import type { PropertyLifeOverview as Overview } from '@/lib/nexus-property-context'
import { estimateBoltReference } from '@/public/Link/mobility-reality.mjs'
import styles from './property-life-overview.module.css'

const icons = { groceries: ShoppingBasket, coast: Waves, health: HeartPulse, movement: BusFront, school: GraduationCap, commute: BriefcaseBusiness, restaurant: Utensils, cafe: Coffee }
type RouteEvidence = { id: string; routeVerified?: boolean; walkingSeconds?: number | null; drivingSeconds?: number | null; walkingDistanceMetres?: number | null; drivingDistanceMetres?: number | null }
const distance = (value: number) => value < 1 ? `${Math.max(50, Math.round(value * 1000 / 50) * 50)} m` : `${value.toFixed(1)} km`
const minutes = (value?: number | null) => Number.isFinite(value) ? `${Math.max(1, Math.round(Number(value) / 60))} min` : null

export function PropertyLifeOverview({ overview }: { overview: Overview }) {
  const [active, setActive] = useState<Overview['categories'][number]['key']>('commute')
  const [routes, setRoutes] = useState<Record<string, RouteEvidence>>({})
  const category = overview.categories.find(item => item.key === active) || overview.categories[0]
  const Icon = icons[category.key]
  const [mode, setMode] = useState<'walk' | 'bus' | 'taxi' | 'car'>('walk')
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [observations,setObservations] = useState<any[]>([])
  useEffect(()=>{fetch('/Link/mobility-observations.json').then(r=>r.json()).then(d=>setObservations(d.observations||[])).catch(()=>{})},[])
  const taxiFare = (id:string,name:string) => {const r=routes[id]; const fare=estimateBoltReference({roadKm:Number(r?.drivingDistanceMetres)/1000,journeyMinutes:Number(r?.drivingSeconds)/60,origin:overview.area,destination:name,observations:observations as never[]});return Number.isFinite(fare.expected)?`≈ €${Number(fare.expected).toFixed(1)}`:'€ —'}
  useEffect(() => setExpanded(false), [active])
  const [chosen, setChosen] = useState('')
  const selected = category.places.find(place => place.id === chosen) || category.places[0]
  const [geometry, setGeometry] = useState<unknown>(null)
  const [bus, setBus] = useState<any>(null)
  const [journeyLoading, setJourneyLoading] = useState(false)
  const [traffic, setTraffic] = useState<any>(null)
  const [trafficLoading, setTrafficLoading] = useState(false)
  const checkTraffic = async () => {
    setTrafficLoading(true)
    try { const r = await fetch(`/api/nexus/property-routing?ref=${encodeURIComponent(overview.reference)}&traffic=1`, {cache:'no-store'}); setTraffic(r.ok ? await r.json() : {status:'UNKNOWN'}) } catch { setTraffic({status:'UNKNOWN'}) } finally {setTrafficLoading(false)}
  }
  const trafficRoute = traffic?.routes?.find((r: any) => r.id === selected?.id)
  const [days, setDays] = useState(5)
  const [budget, setBudget] = useState(20)
  const frame = useRef<HTMLIFrameElement>(null)
  const [mapReady, setMapReady] = useState(0)
  const [origin, setOrigin] = useState(overview.origin)
  const allPlaces = useMemo(() => overview.categories.flatMap(c => c.places.map(p => ({...p, connector:c.key}))), [overview])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== 'estate-area-map') return
      if (event.data.ready) setMapReady(n => n + 1)
      if (allPlaces.some(p => p.id === event.data.selected)) {
        setChosen(event.data.selected)
        const group = overview.categories.find(c => c.places.some(p => p.id === event.data.selected))
        if (group) setActive(group.key)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [allPlaces, overview])
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({channel:'estate-area-map', intelligence:{origin,precision:'AREA_ONLY',places:allPlaces},category:active,places:category.places,selected:selected?.id,geometry: selected && (mode === 'walk' ? routes[selected.id]?.walkingSeconds != null : mode !== 'bus' && routes[selected.id]?.drivingSeconds != null) ? geometry : null,mode:mode === 'taxi' ? 'car' : mode}, location.origin)
  }, [mapReady, origin, allPlaces, active, category, selected, geometry, mode, routes])
  useEffect(() => {
    setGeometry(null); setBus(null)
    if (!selected) return
    const controller = new AbortController()
    setJourneyLoading(true)
    fetch(`/api/nexus/property-routing?ref=${encodeURIComponent(overview.reference)}&place=${encodeURIComponent(selected.id)}&mode=${mode === 'taxi' ? 'car' : mode}`, {signal:controller.signal,cache:mode === 'bus' ? 'no-store' : 'default'})
      .then(r => r.ok ? r.json() : null).then(data => {
        if (controller.signal.aborted) return
        if (mode === 'bus') setBus(data)
        else { setGeometry(data?.geometry || null); if (Number.isFinite(data?.durationSeconds)) setRoutes(previous => ({...previous,[selected.id]:{...previous[selected.id],id:selected.id,[mode === 'walk' ? 'walkingSeconds' : 'drivingSeconds']:data.durationSeconds,[mode === 'walk' ? 'walkingDistanceMetres' : 'drivingDistanceMetres']:data.distanceMetres}})) }
      }).catch(() => {}).finally(() => {if (!controller.signal.aborted) setJourneyLoading(false)})
    return () => controller.abort()
  }, [overview.reference, selected?.id, mode])
  const duration = (id: string) => mode === 'bus' ? (id === selected?.id && bus?.status === 'CONNECTED' ? bus.durationMinutes * 60 : null) : mode === 'walk' ? routes[id]?.walkingSeconds : routes[id]?.drivingSeconds
  const modes = [{key:'walk',label:'Walk',Icon:Footprints},{key:'bus',label:'Bus',Icon:BusFront},{key:'taxi',label:'Taxi',Icon:CarTaxiFront},{key:'car',label:'Car',Icon:CarFront}] as const
  const selectedSeconds = selected ? duration(selected.id) : null

  useEffect(() => {
    let alive = true
    fetch(`/api/nexus/property-routing?ref=${encodeURIComponent(overview.reference)}`)
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (!alive || !payload?.places) return
        if (Array.isArray(payload.publicCoordinates)) setOrigin(payload.publicCoordinates)
        setRoutes(Object.fromEntries(payload.places.map((item: RouteEvidence) => [item.id, item])))
      }).catch(() => {})
    return () => { alive = false }
  }, [overview.reference])

  const nearest = useMemo(() => ({
    groceries: overview.categories.find(item => item.key === 'groceries')?.places.find(place => place.role === 'weekly-shop'),
    coast: overview.categories.find(item => item.key === 'coast')?.places[0],
    health: overview.categories.find(item => item.key === 'health')?.places[0],
  }), [overview.categories])
  const summaryStats = [
    { key: 'groceries' as const, label: 'Weekly shop · walk', value: nearest.groceries ? (minutes(routes[nearest.groceries.id]?.walkingSeconds) || 'Time pending') : 'Mapping', detail: nearest.groceries?.name || 'Large store pending', Icon: ShoppingBasket },
    { key: 'coast' as const, label: 'Coast · walk', value: nearest.coast ? (minutes(routes[nearest.coast.id]?.walkingSeconds) || 'Time pending') : 'Mapping', detail: nearest.coast?.name || 'Coastal option pending', Icon: Waves },
    { key: 'health' as const, label: 'Health · walk', value: nearest.health ? (minutes(routes[nearest.health.id]?.walkingSeconds) || 'Time pending') : 'Mapping', detail: nearest.health?.name || 'Health option pending', Icon: HeartPulse },
    { key: 'movement' as const, label: 'Area signals', value: String(overview.mappedCount), detail: 'mapped within 3 km', Icon: MapPinned },
  ]

  return <section className={styles.frame} aria-labelledby="life-overview-title">
    <header className={styles.heading}>
      <div className={styles.headingCopy}>
        <span>2906 SMART AREA BRIEF · {overview.area.toUpperCase()}</span>
        <h2 id="life-overview-title">See how this home fits real life.</h2>
        <p>Shopping, coast, health and movement in one clear view. Routes appear only where a mapped connection is available.</p>
      </div>
      <div className={styles.powered}><Sparkles aria-hidden="true" /><span>Intelligence by<br /><b>Nexus Link</b></span></div>
    </header>

    <div className={styles.statRail} aria-label="Property area highlights">
      {summaryStats.map(item => <button key={item.key} type="button" onClick={() => setActive(item.key)} aria-pressed={active === item.key}>
        <span className={styles.statIcon}><item.Icon aria-hidden="true" /></span>
        <span><small>{item.label}</small><b>{item.value}</b><em>{item.detail}</em></span>
        <ArrowUpRight aria-hidden="true" />
      </button>)}
    </div>

    <div className={styles.verdictGrid}>
      <article className={styles.advantages}><span>AT A GLANCE · ADVANTAGES</span><ul>{overview.categories.filter(c => ['groceries','coast','health'].includes(c.key)).flatMap(c => c.places.slice(0,1).map(p => `${p.name}: ${minutes(routes[p.id]?.walkingSeconds) ? `${minutes(routes[p.id]?.walkingSeconds)} on foot` : 'walking time not verified'} · ${distance(p.distanceKm)} straight-line.`)).map(item => <li key={item}><i><Check aria-hidden="true" /></i><span>{item}</span></li>)}</ul></article>
      <article className={styles.considerations}><span>CHECK BEFORE YOU DECIDE</span><ul>{overview.considerations.map(item => <li key={item}><CircleAlert aria-hidden="true" /><span>{item}</span></li>)}</ul></article>
    </div>

    <div className={styles.explorer}>
      <div className={styles.explorerTop}>
        <div><span>EXPLORE THE AREA</span><h3>What would your day look like here?</h3></div>
        <nav aria-label="Explore area facts">{overview.categories.map(item => { const ItemIcon = icons[item.key]; return <button key={item.key} type="button" aria-pressed={active === item.key} onClick={() => setActive(item.key)}><ItemIcon aria-hidden="true" /><span>{item.label}</span></button> })}</nav>
      </div>
      <div className={styles.categoryHeading}>
        <span className={styles.categoryIcon}><Icon aria-hidden="true" /></span>
        <div><h3>{category.label}</h3><p>{category.summary}</p></div>
        <span className={styles.areaPin}><Route aria-hidden="true" /> {overview.sourceBasis === 'property' ? 'property area' : 'locality model'}</span>
      </div>
      <a className={styles.profileLink} href={`/link-matrix#/property/${encodeURIComponent(overview.reference)}`}>Add your profile &amp; get LINKED <ArrowUpRight size={16} /></a>
      <div className={styles.searchBox}><label htmlFor={`place-search-${overview.reference}`}>Find your everyday places</label><input id={`place-search-${overview.reference}`} type="search" placeholder="Search supermarket, beach, destination…" value={query} onChange={e=>setQuery(e.target.value)} />{query.trim() && <div className={styles.searchResults}>{allPlaces.filter(p=>p.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0,8).map(p=><button key={`${p.connector}:${p.id}`} type="button" onClick={()=>{setActive(p.connector);setChosen(p.id);setQuery('')}}>{p.name}<ArrowUpRight size={14}/></button>)}{!allPlaces.some(p=>p.name.toLowerCase().includes(query.trim().toLowerCase())) && <p>No mapped match. Try another place name.</p>}</div>}</div>
      <div className={styles.modeBar} role="group" aria-label="Travel mode">{modes.map(m => <button type="button" key={m.key} aria-pressed={mode === m.key} onClick={() => setMode(m.key)}><m.Icon aria-hidden="true" />{m.label}{m.key === 'taxi' && <small>Uber / Bolt</small>}</button>)}</div>
      <iframe ref={frame} className={styles.areaMap} src="/link-marketplace/estate-area-map.html" title="Map of useful places near this property" loading="lazy" onLoad={() => setMapReady(n => n + 1)} />

      {selected && <div key={`${mode}:${selected.id}`} className={styles.journey} aria-live="polite"><div><small>YOUR JOURNEY TO</small><h4>{selected.name}</h4><strong>{journeyLoading ? 'Checking journey…' : (mode === 'taxi' ? taxiFare(selected.id,selected.name) : minutes(selectedSeconds)) || 'Time unavailable'}</strong><span>{mode === 'bus' ? 'scheduled journey' : mode === 'walk' ? 'on foot' : mode === 'taxi' ? `${minutes(selectedSeconds)||'Unknown'} drive · pickup unknown` : 'driving time'} · one way · {selected && (mode === 'walk' ? routes[selected.id]?.walkingDistanceMetres : routes[selected.id]?.drivingDistanceMetres) != null && mode !== 'bus' ? distance(Number(mode === 'walk' ? routes[selected.id]?.walkingDistanceMetres : routes[selected.id]?.drivingDistanceMetres)/1000) : mode === 'bus' && bus?.distanceMetres ? distance(bus.distanceMetres/1000) : 'distance pending'}</span><span className={styles.liveStatus}><i />{trafficLoading ? 'Checking live traffic…' : trafficRoute ? `Live traffic · ${minutes(trafficRoute.trafficSeconds)} · ${new Date(trafficRoute.observedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : 'Mapped route · live traffic on request'}</span></div><details className={styles.journeyDetails}><summary>Journey details &amp; weekly routine</summary><p className={styles.evidence}>Approximate {overview.sourceBasis === 'locality' ? 'locality' : 'property area'} origin · select a pin or a place below. Route lines use the public area pin; front-door distances can differ.</p>
        {mode === 'bus' ? <p>{bus?.status === 'CONNECTED' ? `${Number.isFinite(bus.accessWalkMinutes)?Math.round(bus.accessWalkMinutes)+' min to stop':'Walk to stop unknown'} · ${Number.isFinite(bus.scheduledWaitMinutes)?Math.round(bus.scheduledWaitMinutes)+' min scheduled wait':'Wait unknown'} · ${Number.isFinite(bus.rideMinutes)?Math.round(bus.rideMinutes)+' min ride':'Ride unknown'} · ${Number.isFinite(bus.egressWalkMinutes)?Math.round(bus.egressWalkMinutes)+' min final walk':'Final walk unknown'} · ${bus.transfers ?? 'Unknown'} transfers · ${bus.services?.map((s: any) => s.line).filter(Boolean).join(', ') || 'Line not provided'}` : 'Select a place to check its scheduled bus connection. No car-time approximation.'}</p> : <p>{selectedSeconds != null ? 'MODELLED · OpenStreetMap / OSRM · no live traffic.' : 'No verified travel time for this journey.'} {mode === 'taxi' && 'Uber / Bolt fare and pickup wait require a live quote; they are not included.'}</p>}
        {mode === 'bus' && bus?.requestedAt && <small>Google Maps · {new Date(bus.requestedAt).toLocaleString()} · schedule estimate, not live reliability</small>}
        {(mode === 'car' || mode === 'taxi') && selected.id.startsWith('malta-overview-') && <div><button type="button" className={styles.trafficCheck} disabled={trafficLoading} onClick={checkTraffic}>{trafficLoading ? 'Checking traffic…' : 'Check current traffic'}</button>{trafficRoute ? <p>Google Maps · {minutes(trafficRoute.trafficSeconds) || 'ETA unavailable'} now · {minutes(trafficRoute.noTrafficSeconds) || 'Baseline unavailable'} without traffic · {trafficRoute.distanceMetres != null ? distance(trafficRoute.distanceMetres / 1000) : ''}<br />Updated {new Date(trafficRoute.observedAt).toLocaleString()} · predicted driving time, not a completed journey.</p> : traffic?.status === 'UNKNOWN' ? <p>Traffic is unavailable. The modelled route above is unchanged.</p> : null}</div>}
        <label>My one-way time budget <select value={budget} onChange={e => setBudget(Number(e.target.value))}>{[10,15,20,30,45,60].map(n => <option key={n} value={n}>{n} min</option>)}</select></label>
        <label>Round trips per week <select value={days} onChange={e => setDays(Number(e.target.value))}>{[1,2,3,4,5,6,7].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <p>{selectedSeconds != null ? `${selectedSeconds / 60 <= budget ? 'Within' : 'Over'} your time budget · about ${Math.round(selectedSeconds / 60 * 2 * days)} min travelling per week. Return assumed equal; waiting and stops may add time.` : 'Weekly travel time appears when a route is available.'}</p>
      </details></div>}
      {category.places.length ? <div className={styles.placeGrid}>{category.places.slice(0,24).map((place, index) => {
        const route = routes[place.id]
        const ModeIcon = modes.find(m => m.key === mode)!.Icon
        const modeSeconds = duration(place.id)
        return <article key={`${place.id}:${mode}`} className={place.role === 'weekly-shop' ? styles.primaryPlace : undefined}>
          <div className={styles.placeTop}><span>{place.role === 'weekly-shop' ? 'WEEKLY SHOP' : place.role === 'top-up' ? 'QUICK ESSENTIALS' : place.kind.replaceAll('_', ' ').toUpperCase()}</span><i>0{index + 1}</i></div>
          <button type="button" className={styles.placeSelect} aria-pressed={selected?.id === place.id} onClick={() => setChosen(place.id)}>{place.name}<ArrowUpRight aria-hidden="true" /></button>
          {place.rating ? <span className={styles.rating}><Star aria-hidden="true" /> {place.rating.toFixed(1)}{place.reviews ? ` · ${place.reviews.toLocaleString()} reviews` : ''}</span> : null}
          <button type="button" className={styles.modeJourney} onClick={() => setChosen(place.id)} aria-label={`Show ${mode} journey to ${place.name}`}><ModeIcon aria-hidden="true" /><span><small>{mode === 'taxi' ? 'Taxi · Uber / Bolt' : mode}</small><b>{(mode === 'taxi' ? taxiFare(place.id,place.name) : minutes(modeSeconds)) || (mode === 'bus' ? 'Check bus journey' : 'Time unavailable')}</b><small>{mode === 'bus' ? (place.id === selected?.id && bus?.distanceMetres ? distance(bus.distanceMetres / 1000) : 'Select to load the timetable') : (mode === 'walk' ? route?.walkingDistanceMetres : route?.drivingDistanceMetres) != null ? distance(Number(mode === 'walk' ? route?.walkingDistanceMetres : route?.drivingDistanceMetres) / 1000) + ' routed' : distance(place.distanceKm) + ' straight-line'}</small></span><ArrowUpRight aria-hidden="true" /></button>
          {mode === 'taxi' && <small className={styles.evidence}>Modelled Bolt reference · not a live Uber/Bolt quote. Pickup unknown.</small>}
          <small className={styles.evidence}>{mode === 'bus' ? 'GOOGLE MAPS · scheduled journey when available' : route?.routeVerified ? 'MODELLED ROUTE · no live traffic' : 'STRAIGHT-LINE · privacy-safe area pin'}</small>
        </article>
      })}</div> : <p className={styles.empty}>This category is not sufficiently mapped yet. It stays unknown instead of becoming a made-up score.</p>}
      {false && category.places.length>6 && <button className={styles.trafficCheck} type="button" onClick={()=>setExpanded(!expanded)}>{expanded?'Show fewer':`Show all ${category.places.length} mapped options`}</button>}
    </div>

    <footer className={styles.footer}>
      <span>{overview.sourceBasis === 'property' ? 'Privacy-safe property area' : `${overview.area} locality model`} · mapped places · route evidence labelled separately</span>
      <a href={`/link-matrix#/property/${encodeURIComponent(overview.reference)}`}>Open Nexus Match Engine <ArrowUpRight aria-hidden="true" /></a>
    </footer>
  </section>
}
