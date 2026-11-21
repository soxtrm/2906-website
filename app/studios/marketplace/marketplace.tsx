'use client'
// NEXUS Marketplace (React, 2026-11-21): listings first, compact navigation, small campaign banners,
// filters kept in the address (shareable, back button works), cards with photos, availability, freshness,
// Smart Intelligence and the real provider. "Professional" shows what agents need, without invented terms.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bath, BedDouble, BriefcaseBusiness, Check, ChevronLeft, ChevronRight, Copy, Dumbbell, HeartPulse, Ruler, Search, ShoppingBasket, SlidersHorizontal, Sparkles, Waves, X } from 'lucide-react'
import { NexusStar } from '@/components/brand/logo'
import type { ListingCard, Market, SmartFact } from '@/lib/marketplace/model'

type Filters = { market: Market; type: string; area: string; min: string; max: string; beds: string; now: boolean; soon: boolean; q: string; sort: 'fresh' | 'price-asc' | 'price-desc'; feature: string }
const DEFAULT: Filters = { market: 'longlets', type: '', area: '', min: '', max: '', beds: '', now: false, soon: false, q: '', sort: 'fresh', feature: '' }
const PAGE = 24
const eur = (n: number) => `€${n.toLocaleString('en-GB')}`
const ago = (iso: string | null) => {
  if (!iso) return null
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3)
  return d <= 0 ? 'Updated today' : d === 1 ? 'Updated yesterday' : d < 31 ? `Updated ${d} days ago` : d < 365 ? `Updated ${Math.round(d / 30)} mo ago` : 'Updated over a year ago'
}
const SMART_ICON: Record<SmartFact['key'], typeof Waves> = { shop: ShoppingBasket, coast: Waves, health: HeartPulse, gym: Dumbbell }

function readFilters(): Filters {
  if (typeof window === 'undefined') return DEFAULT
  const q = new URLSearchParams(window.location.search)
  const f = { ...DEFAULT }
  for (const k of Object.keys(DEFAULT) as (keyof Filters)[]) {
    const v = q.get(k); if (v === null) continue
    if (k === 'now' || k === 'soon') f[k] = v === '1'
    else (f as Record<string, unknown>)[k] = v
  }
  if (!['longlets', 'stays', 'sales'].includes(f.market)) f.market = 'longlets'
  return f
}
function writeFilters(f: Filters) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== (DEFAULT as Record<string, unknown>)[k]) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  const s = q.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}`)
}

export function Marketplace() {
  const reduce = useReducedMotion()
  const [all, setAll] = useState<ListingCard[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [f, setF] = useState<Filters>(DEFAULT)
  const [shown, setShown] = useState(PAGE)
  const [pro, setPro] = useState(false)
  const [open, setOpen] = useState(false)
  const ready = useRef(false)

  useEffect(() => {
    setF(readFilters())
    try { setPro(localStorage.getItem('nx-mp-pro') === '1') } catch { /* private mode */ }
    ready.current = true
    fetch('/api/marketplace/listings').then(r => (r.ok ? r.json() : Promise.reject())).then(d => setAll(d.listings)).catch(() => setFailed(true))
  }, [])
  useEffect(() => { if (ready.current) { writeFilters(f); setShown(PAGE) } }, [f])
  const set = (patch: Partial<Filters>) => setF(x => ({ ...x, ...patch }))

  const inMarket = useMemo(() => (all || []).filter(l => l.market === f.market), [all, f.market])
  const areas = useMemo(() => [...new Set(inMarket.map(l => l.area))].sort((a, b) => a.localeCompare(b)), [inMarket])
  const types = useMemo(() => [...new Set(inMarket.map(l => l.propertyType).filter(Boolean) as string[])].sort(), [inMarket])
  const list = useMemo(() => {
    const q = f.q.trim().toLowerCase()
    const out = inMarket.filter(l =>
      (!f.type || l.propertyType === f.type) && (!f.area || l.area === f.area) &&
      (!f.min || (l.price ?? 0) >= Number(f.min)) && (!f.max || (l.price ?? Infinity) <= Number(f.max)) &&
      (!f.beds || (l.bedrooms ?? 0) >= Number(f.beds)) && (!f.now || l.availability.kind !== 'from') && (!f.soon || l.availability.kind === 'from') &&
      (!f.feature || l.features.includes(f.feature)) &&
      (!q || `${l.title} ${l.area} ${l.id} ${l.features.join(' ')}`.toLowerCase().includes(q)))
    const byFresh = (a: ListingCard, b: ListingCard) => (b.updatedAt || '').localeCompare(a.updatedAt || '')
    return out.sort(f.sort === 'price-asc' ? (a, b) => (a.price ?? 9e9) - (b.price ?? 9e9) : f.sort === 'price-desc' ? (a, b) => (b.price ?? 0) - (a.price ?? 0) : byFresh)
  }, [inMarket, f])

  const counts = useMemo(() => ({
    longlets: (all || []).filter(l => l.market === 'longlets').length, stays: (all || []).filter(l => l.market === 'stays').length, sales: (all || []).filter(l => l.market === 'sales').length,
    upcoming: inMarket.filter(l => l.availability.kind === 'from').length, sea: inMarket.filter(l => l.features.includes('Sea view')).length,
    confirmed: inMarket.filter(l => l.availability.kind === 'confirmed').length,
  }), [all, inMarket])
  const active = [f.type, f.area, f.min, f.max, f.beds, f.now ? '1' : '', f.soon ? '1' : '', f.feature, f.q].filter(Boolean).length

  return (
    <div className="mp">
      <header className="mp-top">
        <a className="st-brand" href="/" aria-label="NEXUS STUDIOS home"><NexusStar size={18} className="st-star" />NEXUS <b>STUDIOS</b></a>
        <nav className="mp-tabs" aria-label="Marketplace sections">
          <a aria-current="page" href="/marketplace">Homes</a>
          <a href="/marketplace/classic#places" className="mp-tab-quiet">Places</a>
          <span className="mp-tab-soon" title="Coming to NEXUS STUDIOS">Workers <small>soon</small></span>
        </nav>
        <button className={`mp-pro${pro ? ' on' : ''}`} aria-pressed={pro} onClick={() => { const v = !pro; setPro(v); try { localStorage.setItem('nx-mp-pro', v ? '1' : '0') } catch { /* */ } }}>
          <BriefcaseBusiness size={16} aria-hidden="true" />Professional
        </button>
      </header>

      <div className="mp-bar">
        <div className="mp-seg" role="group" aria-label="Market">
          {([['longlets', 'Long let'], ['stays', 'Short let'], ['sales', 'Sales']] as const).map(([m, label]) => (
            <button key={m} aria-pressed={f.market === m} disabled={m === 'sales' && !counts.sales} onClick={() => set({ ...DEFAULT, market: m, sort: f.sort })}>
              {label}{all && <small>{m === 'sales' && !counts.sales ? 'soon' : counts[m]}</small>}
            </button>
          ))}
        </div>
        <div className="mp-seg mp-seg-quiet" role="group" aria-label="Category">
          <button aria-pressed>Residential</button>
          <button disabled title="Not listed yet">Commercial <small>soon</small></button>
          <button disabled title="Not listed yet">Land <small>soon</small></button>
        </div>
        <label className="mp-search"><Search size={16} aria-hidden="true" /><input value={f.q} onChange={e => set({ q: e.target.value })} placeholder="Area, feature or reference" aria-label="Search listings" /></label>
        <button className="mp-filter-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}><SlidersHorizontal size={16} aria-hidden="true" />Filters{active ? <b>{active}</b> : null}</button>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="mp-filters" initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }}>
            <label>Area<select value={f.area} onChange={e => set({ area: e.target.value })}><option value="">All areas</option>{areas.map(a => <option key={a}>{a}</option>)}</select></label>
            <label>Type<select value={f.type} onChange={e => set({ type: e.target.value })}><option value="">All types</option>{types.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select></label>
            <label>Min €<input inputMode="numeric" value={f.min} onChange={e => set({ min: e.target.value.replace(/\D/g, '') })} placeholder="Any" /></label>
            <label>Max €<input inputMode="numeric" value={f.max} onChange={e => set({ max: e.target.value.replace(/\D/g, '') })} placeholder="Any" /></label>
            <label>Bedrooms<select value={f.beds} onChange={e => set({ beds: e.target.value })}><option value="">Any</option>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}+</option>)}</select></label>
            <label>Sort<select value={f.sort} onChange={e => set({ sort: e.target.value as Filters['sort'] })}><option value="fresh">Recently updated</option><option value="price-asc">Price, low to high</option><option value="price-desc">Price, high to low</option></select></label>
            <label className="mp-check"><input type="checkbox" checked={f.now} onChange={e => set({ now: e.target.checked })} />Available now</label>
            {active > 0 && <button className="mp-clear" onClick={() => set({ ...DEFAULT, market: f.market, sort: f.sort })}><X size={14} />Clear</button>}
          </motion.div>
        )}
      </AnimatePresence>

      {all && (
        <div className="mp-banners" aria-label="Highlights">
          {counts.confirmed > 0 && <button className="mp-banner b1" onClick={() => set({ now: true, soon: false })}><Check size={16} aria-hidden="true" /><span><b>{counts.confirmed} confirmed available</b>checked with the owner</span></button>}
          {counts.sea > 0 && <button className="mp-banner b2" onClick={() => set({ feature: 'Sea view' })}><Waves size={16} aria-hidden="true" /><span><b>{counts.sea} with sea view</b>from the listing details</span></button>}
          {counts.upcoming > 0 && <button className="mp-banner b3" onClick={() => set({ soon: true, now: false })}><Sparkles size={16} aria-hidden="true" /><span><b>{counts.upcoming} coming soon</b>enquire before they go live</span></button>}
        </div>
      )}

      <main>
        {failed ? <p className="mp-empty">Listings are not available right now. Please try again in a moment.</p>
          : !all ? <div className="mp-grid" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="mp-card mp-skel" />)}</div>
          : !list.length ? <p className="mp-empty">No homes match these filters. <button className="mp-link" onClick={() => set({ ...DEFAULT, market: f.market })}>Clear filters</button></p>
          : <>
            <p className="mp-count">{list.length} {list.length === 1 ? 'home' : 'homes'}{f.area ? ` in ${f.area}` : ''}</p>
            <motion.div className="mp-grid" layout={!reduce}>
              <AnimatePresence initial={false}>
                {list.slice(0, shown).map(l => <Card key={l.id} l={l} pro={pro} reduce={!!reduce} />)}
              </AnimatePresence>
            </motion.div>
            {shown < list.length && <button className="mp-more" onClick={() => setShown(n => n + PAGE)}>Show more ({list.length - shown})</button>}
          </>}
      </main>
      <footer className="mp-foot">Listings from ARGUS, updated live. Locations are shown at area level until a viewing. <a href="/marketplace/classic">Classic view</a></footer>
    </div>
  )
}

function Card({ l, pro, reduce }: { l: ListingCard; pro: boolean; reduce: boolean }) {
  const [i, setI] = useState(0)
  const strip = useRef<HTMLDivElement>(null)
  const go = (d: number) => { const el = strip.current; if (!el) return; const n = Math.max(0, Math.min(l.images.length - 1, i + d)); el.scrollTo({ left: n * el.clientWidth, behavior: reduce ? 'auto' : 'smooth' }) }
  const href = `/marketplace/home/${encodeURIComponent(l.id)}`
  const [copied, setCopied] = useState(false)
  return (
    <motion.article className="mp-card" layout={!reduce} initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0 }} transition={{ duration: 0.25 }}>
      <div className="mp-photos">
        <div className="mp-strip" ref={strip} onScroll={e => setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}>
          {l.images.map((src, k) => (
            <a key={src} href={href} tabIndex={k === 0 ? 0 : -1} aria-label={k === 0 ? l.title : undefined}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" loading={k === 0 ? 'lazy' : 'lazy'} decoding="async" />
            </a>
          ))}
        </div>
        {l.images.length > 1 && <>
          <button className="mp-nav l" onClick={() => go(-1)} disabled={i === 0} aria-label="Previous photo"><ChevronLeft size={18} /></button>
          <button className="mp-nav r" onClick={() => go(1)} disabled={i >= l.images.length - 1} aria-label="Next photo"><ChevronRight size={18} /></button>
          <span className="mp-dots" aria-hidden="true">{l.images.map((_, k) => <i key={k} data-on={k === i || undefined} />)}</span>
        </>}
        <span className={`mp-avail k-${l.availability.kind}`}>{l.availability.label}</span>
      </div>
      <a className="mp-body" href={href}>
        <div className="mp-price">{l.price ? <>{eur(l.price)}<small>{l.pricePeriod ? ` / ${l.pricePeriod}` : ''}</small></> : 'Price on request'}</div>
        <h3>{l.title}</h3>
        <p className="mp-facts">
          {!!l.bedrooms && <span><BedDouble size={15} aria-hidden="true" />{l.bedrooms}</span>}
          {!!l.bathrooms && <span><Bath size={15} aria-hidden="true" />{l.bathrooms}</span>}
          {l.size && <span><Ruler size={15} aria-hidden="true" />{l.size} m²</span>}
          {l.features.slice(0, 2).map(x => <span key={x} className="mp-feat">{x}</span>)}
        </p>
        {l.smart.length > 0 && (
          <p className="mp-smart" aria-label="Nearby, from the area centre">
            {l.smart.slice(0, 3).map(s => { const I = SMART_ICON[s.key]; return <span key={s.key} title={`${s.name}, about ${s.km} km from the area centre`}><I size={14} aria-hidden="true" />{s.label} {s.km} km</span> })}
          </p>
        )}
        <p className="mp-provider">
          {l.provider.kind === 'agency' ? <>{l.provider.agency.name}{l.provider.agency.verified && <Check size={13} aria-label="verified agency" className="mp-verified" />}{l.provider.agent ? ` · ${l.provider.agent.name}` : ''}</> : 'Direct from owner'}
          <span className="mp-fresh">{ago(l.updatedAt)}</span>
        </p>
      </a>
      {pro && (
        <div className="mp-probar">
          <span>Ref {l.id}</span>
          <span title={l.cooperation.note}>Co-agency terms: not published</span>
          <button onClick={async () => { try { await navigator.clipboard.writeText(`${window.location.origin}${href}`); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* */ } }}>
            {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Client link'}
          </button>
        </div>
      )}
    </motion.article>
  )
}
