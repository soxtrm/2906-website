'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { ArrowUpRight, BusFront, CarFront, Check, CircleAlert, Footprints, HeartPulse, MapPinned, Route, ShoppingBasket, Sparkles, Star, Waves, CarTaxiFront, GraduationCap, BriefcaseBusiness, Utensils, Coffee, Ship, Ruler, Radio } from 'lucide-react'
import type { PropertyLifeOverview as Overview, PlaceDistance } from '@/lib/nexus-property-context'
import { estimateBoltReference } from '@/public/Link/mobility-reality.mjs'
import { motion } from 'framer-motion'
import styles from './property-life-overview.module.css'

const icons = { groceries: ShoppingBasket, coast: Waves, health: HeartPulse, movement: BusFront, school: GraduationCap, commute: BriefcaseBusiness, restaurant: Utensils, cafe: Coffee }
type RouteEvidence = { id: string; routeVerified?: boolean; walkingSeconds?: number | null; drivingSeconds?: number | null; walkingDistanceMetres?: number | null; drivingDistanceMetres?: number | null }
const distance = (value: number) => value < 1 ? `${Math.max(50, Math.round(value * 1000 / 50) * 50)} m` : `${value.toFixed(1)} km`
const minutes = (value?: number | null) => Number.isFinite(value) ? `${Math.max(1, Math.round(Number(value) / 60))} MIN` : null

type MiniPlace = PlaceDistance & { connector: Overview['categories'][number]['key'] }

function MiniAreaMap({ origin, places, active, radiusKm, onSelect }: {
  origin: [number, number]
  places: MiniPlace[]
  active: Overview['categories'][number]['key']
  radiusKm: number
  onSelect: (connector: Overview['categories'][number]['key'], id: string) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(0)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== 'estate-mini-map') return
      if (event.data.ready) setReady(value => value + 1)
      const place = places.find(item => item.id === event.data.selected)
      if (place) onSelect(place.connector, place.id)
    }
    addEventListener('message', receive)
    return () => removeEventListener('message', receive)
  }, [places, onSelect])
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ channel:'estate-mini-map', origin, places, active, radiusKm }, location.origin)
  }, [ready, origin, places, active, radiusKm])
  return <div className={styles.miniDiagram} aria-label={`Rotating street map with ${places.length} mapped places within ${radiusKm} kilometres`}>
    <iframe ref={frame} src="/link-marketplace/estate-mini-map.html?v=5" title="Rotating street map around this home" onLoad={() => setReady(value => value + 1)} />
    <span className={styles.miniRadius}>{radiusKm} KM · AREA VIEW</span>
    <span className={styles.miniNorth}>N</span>
    <span className={styles.miniLegend}><i /> Home area <b>{places.length}</b> places</span>
  </div>
}

export function PropertyLifeOverview({ overview, description = '', features = [] }: { overview: Overview; description?: string; features?: string[] }) {
  const [active, setActive] = useState<Overview['categories'][number]['key']>('commute')
  const [routes, setRoutes] = useState<Record<string, RouteEvidence>>({})
  const category = overview.categories.find(item => item.key === active) || overview.categories[0]
  const Icon = icons[category.key]
  const [mode, setMode] = useState<'walk' | 'bus' | 'taxi' | 'car'>('walk')
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [observations,setObservations] = useState<any[]>([])
  useEffect(()=>{fetch('/Link/mobility-observations.json').then(r=>r.json()).then(d=>setObservations(d.observations||[])).catch(()=>{})},[])
  const taxiFare = (id:string,name:string) => {const r=routes[id]; const fare=estimateBoltReference({roadKm:Number(r?.drivingDistanceMetres)/1000,journeyMinutes:Number(r?.drivingSeconds)/60,origin:overview.area,destination:name,observations});return Number.isFinite(fare.expected)?`≈ €${Number(fare.expected).toFixed(1)}`:'€ —'}
  useEffect(() => setExpanded(false), [active])
  const [chosen, setChosen] = useState('')
  const selected = category.places.find(place => place.id === chosen) || category.places[0]
  const [geometry, setGeometry] = useState<unknown>(null)
  const [ferry, setFerry] = useState<{ names: string[] } | null>(null)
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
  const [radiusKm, setRadiusKm] = useState(2)
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
    setGeometry(null); setBus(null); setFerry(null)
    if (!selected) return
    const controller = new AbortController()
    setJourneyLoading(true)
    fetch(`/api/nexus/property-routing?ref=${encodeURIComponent(overview.reference)}&place=${encodeURIComponent(selected.id)}&mode=${mode === 'taxi' ? 'car' : mode}`, {signal:controller.signal,cache:mode === 'bus' ? 'no-store' : 'default'})
      .then(r => r.ok ? r.json() : null).then(data => {
        if (controller.signal.aborted) return
        if (mode === 'bus') setBus(data)
        else { setFerry(data?.includesFerry ? {names: (data.ferries || []).map((item: {name: string}) => item.name)} : null); setGeometry(data?.geometry || null); if (Number.isFinite(data?.durationSeconds)) setRoutes(previous => ({...previous,[selected.id]:{...previous[selected.id],id:selected.id,[mode === 'walk' ? 'walkingSeconds' : 'drivingSeconds']:data.durationSeconds,[mode === 'walk' ? 'walkingDistanceMetres' : 'drivingDistanceMetres']:data.distanceMetres}})) }
      }).catch(() => {}).finally(() => {if (!controller.signal.aborted) setJourneyLoading(false)})
    return () => controller.abort()
  }, [overview.reference, selected?.id, mode])
  const duration = (id: string) => mode === 'bus' ? (id === selected?.id && bus?.status === 'CONNECTED' ? bus.durationMinutes * 60 : null) : mode === 'walk' ? routes[id]?.walkingSeconds : routes[id]?.drivingSeconds
  const modes = [
    {key:'walk',label:'Walk',hint:'Footpaths',Icon:Footprints},
    {key:'bus',label:'Bus',hint:'Timetable',Icon:BusFront},
    {key:'taxi',label:'Taxi',hint:'Fare estimate',Icon:CarTaxiFront},
    {key:'car',label:'Car',hint:'Road route',Icon:CarFront},
  ] as const
  const selectedSeconds = selected ? duration(selected.id) : null
  const SelectedModeIcon = modes.find(item => item.key === mode)!.Icon
  const selectedDistanceMetres = selected
    ? mode === 'bus' ? bus?.distanceMetres
      : mode === 'walk' ? routes[selected.id]?.walkingDistanceMetres
        : routes[selected.id]?.drivingDistanceMetres
    : null

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
  const copy = `${description} ${features.join(' ')}`.toLowerCase()
  const keywordScore = (terms: RegExp[], base = 66, step = 6) => Math.min(96, base + terms.filter(term => term.test(copy)).length * step)
  const mobilityPlaces = overview.categories.find(item => item.key === 'movement')?.places.length || 0
  const amenityPlaces = overview.categories.filter(item => ['groceries','health','restaurant','cafe'].includes(item.key)).reduce((sum,item)=>sum+item.places.length,0)
  const signals = [
    {label:'Quality',value:keywordScore([/designer|high.?end|premium|luxur/,/appliance|dishwasher|air.?condition|fully equipped/,/newly|renovated|finished|modern/,/furnished|furniture/]),hint:'Finish & equipment'},
    {label:'Ambience',value:keywordScore([/terrace|balcony|outdoor|garden|yard/,/sea view|views|bright|natural light/,/pool|deck|promenade/,/quiet|peaceful|luxur|designer/]),hint:'Light, comfort & outdoor'},
    {label:'Amenities',value:Math.min(96,68+amenityPlaces*2),hint:`${amenityPlaces} useful places mapped`},
    {label:'Mobility',value:Math.min(94,68+mobilityPlaces*7+(overview.mappedCount>8?5:0)),hint:mobilityPlaces?`${mobilityPlaces} nearby connections`:'Area routes available'},
  ]
  const coastScore = nearest.coast ? Math.max(62, Math.min(94, 96 - Math.round(nearest.coast.distanceKm * 8))) : 68
  const convenienceScore = Math.min(95, 66 + Math.min(overview.mappedCount, 14) * 2)
  const radarSignals = [...signals, {label:'Coast', value:coastScore}, {label:'Convenience', value:convenienceScore}]
  const quickPlaces = selected
    ? [selected, ...category.places.filter(place => place.id !== selected.id)].slice(0, 3)
    : category.places.slice(0, 3)
  const radarPoint = (index: number, value: number) => {
    const angle = (-90 + index * 60) * Math.PI / 180
    const radius = 68 * value / 100
    return `${100 + Math.cos(angle) * radius},${100 + Math.sin(angle) * radius}`
  }
  const radarRing = (value: number) => radarSignals.map((_, index) => radarPoint(index, value)).join(' ')

  return <section className={styles.frame} aria-labelledby="life-overview-title">
    <header className={styles.heading}>
      <div className={styles.headingCopy}>
        <span>2906 SMART AREA BRIEF · {overview.area.toUpperCase()}</span>
        <h2 id="life-overview-title">See how this home fits real life.</h2>
        <p>Shopping, coast, health and movement in one clear view. Routes appear only where a mapped connection is available.</p>
      </div>
      <div className={styles.powered}><Sparkles aria-hidden="true" /><span>Intelligence by<br /><b>Nexus Link</b></span></div>
    </header>

    <div className={styles.smartSnapshot} aria-label="Property and area snapshot">
      <div className={styles.signalPanel}>
        <div className={styles.signalHeading}><span>PROPERTY FIT</span><h3>One clear read.</h3><p>Six practical signals, based on the home description and mapped surroundings.</p></div>
        <div className={styles.radarLayout}>
          <svg className={styles.hexRadar} viewBox="0 0 200 200" role="img" aria-label={radarSignals.map(signal=>`${signal.label} ${signal.value} out of 100`).join(', ')}>
            {[100,70,40].map(value=><polygon key={value} points={radarRing(value)} className={styles.radarRing} />)}
            {radarSignals.map((signal,index)=><line key={signal.label} x1="100" y1="100" x2={radarPoint(index,100).split(',')[0]} y2={radarPoint(index,100).split(',')[1]} className={styles.radarAxis} />)}
            <motion.polygon points={radarSignals.map((signal,index)=>radarPoint(index,signal.value)).join(' ')} className={styles.radarShape} initial={{opacity:0,scale:.82,transformOrigin:'100px 100px'}} whileInView={{opacity:1,scale:1}} viewport={{once:true}} transition={{duration:.55,ease:[.2,.8,.2,1]}} />
            {radarSignals.map((signal,index)=>{const [cx,cy]=radarPoint(index,signal.value).split(',');return <circle key={signal.label} cx={cx} cy={cy} r="3" className={styles.radarDot} />})}
          </svg>
          <div className={styles.radarLegend}>{radarSignals.map(signal=><div key={signal.label}><span>{signal.label}</span><b>{signal.value}</b></div>)}</div>
        </div>
      </div>
      <div className={styles.miniMapPanel}>
          <div className={styles.miniMapToolbar}><nav aria-label="Mini map category">{overview.categories.filter(item=>item.places.length>0&&['restaurant','cafe','groceries','coast','movement','health','school'].includes(item.key)).map(item=>{const ItemIcon=icons[item.key];return <button key={item.key} type="button" aria-label={`${item.label}: ${item.places.length} mapped places`} aria-pressed={active===item.key} onClick={()=>setActive(item.key)} title={`${item.label}: ${item.places.length} mapped places`}><ItemIcon aria-hidden="true" /><span className={styles.srOnly}>{item.label}</span><b>{item.places.length}</b></button>})}</nav><label>Radius <select value={radiusKm} onChange={event=>setRadiusKm(Number(event.target.value))}><option value={1}>1 km</option><option value={2}>2 km</option><option value={3}>3 km</option></select></label></div>
          <MiniAreaMap origin={origin} places={allPlaces.filter(place => place.distanceKm <= radiusKm)} active={active} radiusKm={radiusKm} onSelect={(connector,id)=>{setActive(connector);setChosen(id)}} />
      </div>
      <div className={styles.quickFacts} aria-live="polite">{quickPlaces.map(p=><button type="button" key={`${category.key}:${p.id}`} onClick={()=>setChosen(p.id)} aria-pressed={selected?.id===p.id}><Check aria-hidden="true" /><b>{p.name}</b><small>{minutes(routes[p.id]?.walkingSeconds)?`${minutes(routes[p.id]?.walkingSeconds)} walk`:distance(p.distanceKm)}</small></button>)}</div>
    </div>

    <details className={styles.fullExplorer} open><summary><span>Full area explorer</span><small>Large map, routes, traffic and every mapped place</small><ArrowUpRight aria-hidden="true" /></summary>

    <div className={styles.explorer}>
      <div className={styles.explorerTop}>
        <div><span>EXPLORE THE AREA</span><h3>What would your day look like here?</h3></div>
        <nav aria-label="Explore area facts">{overview.categories.map(item => { const ItemIcon = icons[item.key]; return <button key={item.key} type="button" aria-label={item.label} title={item.label} aria-pressed={active === item.key} onClick={() => setActive(item.key)}><ItemIcon aria-hidden="true" /><span className={styles.srOnly}>{item.label}</span></button> })}</nav>
      </div>
      <div className={styles.categoryHeading}>
        <span className={styles.categoryIcon}><Icon aria-hidden="true" /></span>
        <div><h3>{category.label}</h3><p>{category.summary}</p></div>
        <span className={styles.areaPin}><Route aria-hidden="true" /> {overview.sourceBasis === 'property' ? 'property area' : 'locality model'}</span>
      </div>
      <a className={styles.profileLink} href={`/link-matrix#/property/${encodeURIComponent(overview.reference)}`}>Add your profile &amp; get LINKED <ArrowUpRight size={16} /></a>
      <div className={styles.searchBox}><label htmlFor={`place-search-${overview.reference}`}>Find your everyday places</label><input id={`place-search-${overview.reference}`} type="search" placeholder="Search supermarket, beach, destination…" value={query} onChange={e=>setQuery(e.target.value)} />{query.trim() && <div className={styles.searchResults}>{allPlaces.filter(p=>p.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0,8).map(p=><button key={`${p.connector}:${p.id}`} type="button" onClick={()=>{setActive(p.connector);setChosen(p.id);setQuery('')}}>{p.name}<ArrowUpRight size={14}/></button>)}{!allPlaces.some(p=>p.name.toLowerCase().includes(query.trim().toLowerCase())) && <p>No mapped match. Try another place name.</p>}</div>}</div>
      <div className={styles.modeBar} role="group" aria-label="Travel mode">{modes.map(m => <motion.button type="button" key={m.key} aria-pressed={mode === m.key} onClick={() => setMode(m.key)} whileHover={{y:-1}} whileTap={{scale:.94,y:1}} transition={{type:'spring',stiffness:520,damping:30}}>{mode === m.key && <motion.i className={styles.modeGlider} layoutId="travel-mode-glider" transition={{type:'spring',stiffness:430,damping:34,mass:.7}} />}<m.Icon aria-hidden="true" /><span><b>{m.label}</b><small>{m.hint}</small></span></motion.button>)}</div>
      <iframe ref={frame} className={styles.areaMap} src="/link-marketplace/estate-area-map.html" title="Map of useful places near this property" loading="lazy" onLoad={() => setMapReady(n => n + 1)} />

      {selected && <div key={`${mode}:${selected.id}`} className={styles.journey} aria-live="polite"><div><small>YOUR JOURNEY TO</small><h4>{selected.name}</h4><strong>{journeyLoading ? 'Checking journey…' : (mode === 'taxi' ? taxiFare(selected.id,selected.name) : minutes(selectedSeconds)) || 'Time unavailable'}</strong><div className={styles.journeySignals} aria-label="Journey overview">
        <span><SelectedModeIcon aria-hidden="true" />{mode === 'walk' ? 'Walk' : mode === 'bus' ? 'Bus' : mode === 'taxi' ? 'Taxi' : 'Car'}</span>
        {mode === 'walk' && ferry && <span className={styles.ferrySignal}><Ship aria-hidden="true" />Ferry</span>}
        <span><Ruler aria-hidden="true" />{Number.isFinite(selectedDistanceMetres) ? distance(Number(selectedDistanceMetres) / 1000) : 'Distance pending'}</span>
        <span><Radio aria-hidden="true" />{mode === 'bus' ? 'Scheduled' : trafficRoute ? 'Live traffic' : 'Modelled'}</span>
      </div><span className={styles.liveStatus}><i />{mode === 'bus' ? (bus?.status === 'CONNECTED' ? 'Google Maps scheduled connection' : 'Select a destination for its timetable') : trafficLoading ? 'Checking live traffic…' : trafficRoute ? `Live traffic · ${minutes(trafficRoute.trafficSeconds)} · ${new Date(trafficRoute.observedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : 'Mapped route · live traffic on request'}</span></div>{mode === 'walk' && ferry && <p className={styles.ferryNote} role="note"><Ship aria-hidden="true" /><span><b>Ferry crossing</b> · {ferry.names.join(' / ')}<small>Modelled journey; timetable, waiting time and fare are not included.</small></span></p>}<details className={styles.journeyDetails}><summary>Journey details &amp; weekly routine</summary><p className={styles.evidence}>Approximate {overview.sourceBasis === 'locality' ? 'locality' : 'property area'} origin · select a pin or a place below. Route lines use the public area pin; front-door distances can differ.</p>
        {mode === 'bus' ? <p>{bus?.status === 'CONNECTED' ? `${Number.isFinite(bus.accessWalkMinutes)?Math.round(bus.accessWalkMinutes)+' min to stop':'Walk to stop unknown'} · ${Number.isFinite(bus.scheduledWaitMinutes)?Math.round(bus.scheduledWaitMinutes)+' min scheduled wait':'Wait unknown'} · ${Number.isFinite(bus.rideMinutes)?Math.round(bus.rideMinutes)+' min ride':'Ride unknown'} · ${Number.isFinite(bus.egressWalkMinutes)?Math.round(bus.egressWalkMinutes)+' min final walk':'Final walk unknown'} · ${bus.transfers ?? 'Unknown'} transfers · ${bus.services?.map((s: any) => s.line).filter(Boolean).join(', ') || 'Line not provided'}` : 'Select a place to check its scheduled bus connection. No car-time approximation.'}</p> : <p>{selectedSeconds != null ? 'MODELLED · OpenStreetMap / OSRM · no live traffic.' : 'No verified travel time for this journey.'} {mode === 'taxi' && 'Uber / Bolt fare and pickup wait require a live quote; they are not included.'}</p>}
        {mode === 'bus' && bus?.requestedAt && <small>Google Maps · {new Date(bus.requestedAt).toLocaleString()} · schedule estimate, not live reliability</small>}
        {(mode === 'car' || mode === 'taxi') && selected.id.startsWith('malta-overview-') && <div><button type="button" className={styles.trafficCheck} disabled={trafficLoading} onClick={checkTraffic}>{trafficLoading ? 'Checking traffic…' : 'Check current traffic'}</button>{trafficRoute ? <p>Google Maps · {minutes(trafficRoute.trafficSeconds) || 'ETA unavailable'} now · {minutes(trafficRoute.noTrafficSeconds) || 'Baseline unavailable'} without traffic · {trafficRoute.distanceMetres != null ? distance(trafficRoute.distanceMetres / 1000) : ''}<br />Updated {new Date(trafficRoute.observedAt).toLocaleString()} · predicted driving time, not a completed journey.</p> : traffic?.status === 'UNKNOWN' ? <p>Traffic is unavailable. The modelled route above is unchanged.</p> : null}</div>}
        <label>My one-way time budget <select value={budget} onChange={e => setBudget(Number(e.target.value))}>{[10,15,20,30,45,60].map(n => <option key={n} value={n}>{n} min</option>)}</select></label>
        <label>Round trips per week <select value={days} onChange={e => setDays(Number(e.target.value))}>{[1,2,3,4,5,6,7].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <p>{selectedSeconds != null ? `${selectedSeconds / 60 <= budget ? 'Within' : 'Over'} your time budget · about ${Math.round(selectedSeconds / 60 * 2 * days)} min travelling per week. Return assumed equal; waiting and stops may add time.` : 'Weekly travel time appears when a route is available.'}</p>
      </details></div>}
      {category.places.length ? <div className={styles.placeGrid}>{category.places.slice(0,24).map((place, index) => {
        const route = routes[place.id]
        return <article key={`${place.id}:${mode}`} className={place.role === 'weekly-shop' ? styles.primaryPlace : undefined}>
          <div className={styles.placeTop}><span>{place.role === 'weekly-shop' ? 'WEEKLY SHOP' : place.role === 'top-up' ? 'QUICK ESSENTIALS' : place.kind.replaceAll('_', ' ').toUpperCase()}</span><i>0{index + 1}</i></div>
          <button type="button" className={styles.placeSelect} aria-pressed={selected?.id === place.id} onClick={() => setChosen(place.id)}>{place.name}<ArrowUpRight aria-hidden="true" /></button>
          {place.rating ? <span className={styles.rating}><Star aria-hidden="true" /> {place.rating.toFixed(1)}{place.reviews ? ` · ${place.reviews.toLocaleString()} reviews` : ''}</span> : null}
          <div className={styles.journeyChoices} role="group" aria-label={`Choose journey mode to ${place.name}`}>
            {modes.map(choice => {
              const ChoiceIcon = choice.Icon
              const activeChoice = mode === choice.key && selected?.id === place.id
              const value = choice.key === 'walk' ? minutes(route?.walkingSeconds)
                : choice.key === 'car' ? minutes(route?.drivingSeconds)
                  : choice.key === 'taxi' ? taxiFare(place.id, place.name)
                    : place.id === selected?.id && bus?.status === 'CONNECTED' ? minutes(bus.durationMinutes * 60) : null
              const loadingChoice = activeChoice && journeyLoading
              return <motion.button key={choice.key} type="button" aria-pressed={activeChoice} data-loading={loadingChoice || undefined}
                onClick={() => { setMode(choice.key); setChosen(place.id) }}
                whileTap={{scale:.91}} transition={{type:'spring',stiffness:560,damping:29}}
                aria-label={`${choice.label} journey to ${place.name}${value ? `, ${value}` : ''}`}>
                {activeChoice && <motion.i className={styles.choiceGlider} layoutId="journey-choice-glider" transition={{type:'spring',stiffness:480,damping:36,mass:.65}} />}
                <ChoiceIcon aria-hidden="true" /><small>{choice.label}</small><b>{loadingChoice ? '•••' : value || (choice.key === 'bus' ? 'CHECK' : '—')}</b>
              </motion.button>
            })}
          </div>
          {mode === 'taxi' && <small className={styles.evidence}>Modelled Bolt reference · not a live Uber/Bolt quote. Pickup unknown.</small>}
          <small className={styles.evidence}>{selected?.id === place.id && mode === 'bus' ? 'GOOGLE MAPS · scheduled journey when available' : route?.routeVerified ? 'WALK + CAR ROUTES MAPPED' : 'ROUTE DETAILS PENDING'}</small>
        </article>
      })}</div> : <p className={styles.empty}>This category is not sufficiently mapped yet. It stays unknown instead of becoming a made-up score.</p>}
      {false && category.places.length>6 && <button className={styles.trafficCheck} type="button" onClick={()=>setExpanded(!expanded)}>{expanded?'Show fewer':`Show all ${category.places.length} mapped options`}</button>}
    </div>
    </details>

    <footer className={styles.footer}>
      <span>{overview.sourceBasis === 'property' ? 'Privacy-safe property area' : `${overview.area} locality model`} · mapped places · route evidence labelled separately</span>
      <a href={`/link-matrix#/property/${encodeURIComponent(overview.reference)}`}>Open Nexus Match Engine <ArrowUpRight aria-hidden="true" /></a>
    </footer>
  </section>
}
