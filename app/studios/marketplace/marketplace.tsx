'use client'
// NEXUS Marketplace (React, 2026-11-21): listings first, compact navigation, small campaign banners,
// filters kept in the address (shareable, back button works), cards with photos, availability, freshness,
// Smart Intelligence and the real provider. A card opens as an overlay over the list (own address, back
// button closes it, the list keeps its filters and scroll position); the stand-alone page stays for shared links.
// Search understands plain language ("2 bed sliema sea view under 1500") using the live areas, types and the
// feature dictionary. "Professional" adds references, co-agency terms (only when agreed) and client shortlists.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUpRight, Bath, BedDouble, BriefcaseBusiness, Check, ChevronLeft, ChevronRight, Copy, Dumbbell, ExternalLink, HeartPulse, ListChecks, Plus, Ruler, Search, ShoppingBasket, SlidersHorizontal, Sparkles, Waves, X } from 'lucide-react'
import { NexusStar } from '@/components/brand/logo'
import type { Agency, ListingCard, ListingDetail, Market, SmartFact } from '@/lib/marketplace/model'
import { nrm, understand } from '@/lib/marketplace/query'
import { AgencyMark, ListingBody, eur } from './parts'

type Filters = { market: Market; type: string; area: string; min: string; max: string; beds: string; now: boolean; soon: boolean; q: string; sort: 'fresh' | 'price-asc' | 'price-desc'; feature: string; feat: string; agency: string; ids: string }
type FeatureOpt = { key: string; label: string; group: string; aliases: string[]; count: number }
const matchFeatures = (opts: FeatureOpt[], q: string, limit = 6) => { const t = nrm(q.trim()); if (t.length < 2) return []; return opts.filter(o => nrm(o.label).includes(t) || o.aliases.some(a => nrm(a).includes(t))).sort((a, b) => b.count - a.count).slice(0, limit) }
const DEFAULT: Filters = { market: 'longlets', type: '', area: '', min: '', max: '', beds: '', now: false, soon: false, q: '', sort: 'fresh', feature: '', feat: '', agency: '', ids: '' }
const PAGE = 24
const GROUPS: [string, string][] = [['view', 'View & sea'], ['outdoor', 'Outdoor'], ['comfort', 'Comfort'], ['building', 'Building'], ['parking', 'Parking'], ['kitchen', 'Kitchen & laundry'], ['rooms', 'Rooms'], ['bathroom', 'Bathroom'], ['energy', 'Energy'], ['security', 'Security'], ['accessibility', 'Accessibility']]
const ago = (iso: string | null) => {
  if (!iso) return null
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3)
  return d <= 0 ? 'Updated today' : d === 1 ? 'Updated yesterday' : d < 31 ? `Updated ${d} days ago` : d < 365 ? `Updated ${Math.round(d / 30)} mo ago` : 'Updated over a year ago'
}
const SMART_ICON: Record<SmartFact['key'], typeof Waves> = { shop: ShoppingBasket, coast: Waves, health: HeartPulse, gym: Dumbbell }
const store = { get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } } }

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
function filterQuery(f: Filters) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== (DEFAULT as Record<string, unknown>)[k]) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function Marketplace() {
  const reduce = useReducedMotion()
  const [all, setAll] = useState<ListingCard[] | null>(null)
  const [featureOpts, setFeatureOpts] = useState<FeatureOpt[]>([])
  const [fq, setFq] = useState('')
  const [failed, setFailed] = useState(false)
  const [f, setF] = useState<Filters>(DEFAULT)
  const [shown, setShown] = useState(PAGE)
  const [pro, setPro] = useState(false)
  const [open, setOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [shortlist, setShortlist] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [typing, setTyping] = useState(false)
  const ready = useRef(false)
  const base = useRef('/marketplace')
  const lastFocus = useRef<HTMLElement | null>(null)
  const scrollY0 = useRef<number | null>(null)

  useEffect(() => {
    base.current = window.location.pathname.replace(/\/home\/[^/]+\/?$/, '').replace(/\/$/, '') || '/marketplace'
    setF(readFilters())
    setPro(store.get('nx-mp-pro') === '1')
    try { setShortlist(JSON.parse(store.get('nx-mp-shortlist') || '[]').filter((x: unknown) => typeof x === 'string').slice(0, 30)) } catch { /* */ }
    ready.current = true
    fetch('/api/marketplace/listings').then(r => (r.ok ? r.json() : Promise.reject())).then(d => { setAll(d.listings); setFeatureOpts(d.features || []) }).catch(() => setFailed(true))
    const onPop = () => setOpenId((window.history.state && window.history.state.mp) || null)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // filters change -> address + first page; closing the overlay only restores the address (keeps "show more" and scroll)
  useEffect(() => { if (ready.current) setShown(PAGE) }, [f])
  useEffect(() => {
    if (!ready.current || openId) return
    window.history.replaceState(window.history.state, '', `${base.current}${filterQuery(f)}`)
    const y = scrollY0.current
    if (y !== null) {
      // Next.js handles the history entry too and may scroll after us: put the list back where it was, a few times
      scrollY0.current = null
      const put = () => { if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y) }
      requestAnimationFrame(put); for (const ms of [60, 160, 320]) setTimeout(put, ms)
    }
  }, [f, openId])
  const set = (patch: Partial<Filters>) => setF(x => ({ ...x, ...patch }))
  const featSet = useMemo(() => new Set(f.feat.split(',').filter(Boolean)), [f.feat])
  const toggleFeat = (k: string) => { const s = new Set(featSet); if (s.has(k)) s.delete(k); else s.add(k); set({ feat: [...s].join(',') }) }

  const agencies = useMemo(() => { const m = new Map<string, Agency>(); for (const l of all || []) if (l.provider.kind === 'agency') m.set(l.provider.agency.key, l.provider.agency); return m }, [all])
  const inMarket = useMemo(() => (all || []).filter(l => l.market === f.market), [all, f.market])
  const areas = useMemo(() => [...new Set(inMarket.map(l => l.area))].sort((a, b) => a.localeCompare(b)), [inMarket])
  const types = useMemo(() => [...new Set(inMarket.map(l => l.propertyType).filter(Boolean) as string[])].sort(), [inMarket])
  const featCounts = useMemo(() => { const c: Record<string, number> = {}; for (const l of inMarket) for (const k of l.featureKeys) c[k] = (c[k] || 0) + 1; return c }, [inMarket])
  // what the search box understands right now (applied live; Enter turns it into removable filters)
  const u = useMemo(() => understand(f.q, { areas, types, features: featureOpts, agencyKeys: [...agencies.keys()] }), [f.q, areas, types, featureOpts, agencies])
  const understoodParts = [u.beds && `${u.beds}+ bedrooms`, u.area, u.type && u.type[0].toUpperCase() + u.type.slice(1), ...u.feat.map(k => featureOpts.find(o => o.key === k)?.label || k), u.min && `from ${eur(Number(u.min))}`, u.max && `up to ${eur(Number(u.max))}`, u.now && 'available now'].filter(Boolean) as string[]
  const commitSearch = () => { if (!understoodParts.length) return; set({ q: u.rest, beds: u.beds || f.beds, area: u.area || f.area, type: u.type || f.type, min: u.min || f.min, max: u.max || f.max, now: u.now || f.now, feat: [...new Set([...featSet, ...u.feat])].join(',') }) }

  const ids = useMemo(() => f.ids.split(',').filter(Boolean), [f.ids])
  const list = useMemo(() => {
    if (ids.length) return ids.map(id => (all || []).find(l => l.id === id)).filter(Boolean) as ListingCard[]
    const words = u.rest ? u.rest.split(' ') : []
    const beds = Math.max(Number(f.beds) || 0, Number(u.beds) || 0)
    const min = Math.max(Number(f.min) || 0, Number(u.min) || 0), max = Math.min(Number(f.max) || Infinity, Number(u.max) || Infinity)
    const area = f.area || u.area, type = f.type || u.type, feats = [...new Set([...featSet, ...u.feat])]
    const out = inMarket.filter(l =>
      (!type || l.propertyType === type) && (!area || l.area === area) && (!f.agency || (l.provider.kind === 'agency' && l.provider.agency.key === f.agency)) &&
      (!min || (l.price ?? 0) >= min) && (max === Infinity || (l.price ?? Infinity) <= max) &&
      (!beds || (l.bedrooms ?? 0) >= beds) && (!(f.now || u.now) || l.availability.kind !== 'from') && (!f.soon || l.availability.kind === 'from') &&
      (!f.feature || l.features.includes(f.feature)) && feats.every(k => l.featureKeys.includes(k)) &&
      (!words.length || words.every(w => nrm(`${l.title} ${l.area} ${l.id} ${l.features.join(' ')} ${l.provider.kind === 'agency' ? `${l.provider.agency.name} ${l.provider.agent?.name || ''}` : ''}`).includes(w))))
    const byFresh = (a: ListingCard, b: ListingCard) => (b.updatedAt || '').localeCompare(a.updatedAt || '')
    return out.sort(f.sort === 'price-asc' ? (a, b) => (a.price ?? 9e9) - (b.price ?? 9e9) : f.sort === 'price-desc' ? (a, b) => (b.price ?? 0) - (a.price ?? 0) : byFresh)
  }, [all, ids, inMarket, f, u, featSet])

  const counts = useMemo(() => ({
    longlets: (all || []).filter(l => l.market === 'longlets').length, stays: (all || []).filter(l => l.market === 'stays').length, sales: (all || []).filter(l => l.market === 'sales').length,
    upcoming: inMarket.filter(l => l.availability.kind === 'from').length, sea: inMarket.filter(l => l.featureKeys.includes('sea_view')).length,
    confirmed: inMarket.filter(l => l.availability.kind === 'confirmed').length,
  }), [all, inMarket])

  // active filters as removable chips (what is applied is always visible)
  const chips: { key: string; label: string; clear: () => void }[] = [
    f.area && { key: 'area', label: f.area, clear: () => set({ area: '' }) },
    f.type && { key: 'type', label: f.type[0].toUpperCase() + f.type.slice(1), clear: () => set({ type: '' }) },
    f.beds && { key: 'beds', label: `${f.beds}+ bedrooms`, clear: () => set({ beds: '' }) },
    f.min && { key: 'min', label: `from ${eur(Number(f.min))}`, clear: () => set({ min: '' }) },
    f.max && { key: 'max', label: `up to ${eur(Number(f.max))}`, clear: () => set({ max: '' }) },
    f.now && { key: 'now', label: 'Available now', clear: () => set({ now: false }) },
    f.soon && { key: 'soon', label: 'Coming soon', clear: () => set({ soon: false }) },
    f.feature && { key: 'feature', label: f.feature, clear: () => set({ feature: '' }) },
    f.agency && { key: 'agency', label: agencies.get(f.agency)?.name || f.agency, clear: () => set({ agency: '' }) },
    ...[...featSet].map(k => ({ key: `f-${k}`, label: featureOpts.find(o => o.key === k)?.label || k.replace(/_/g, ' '), clear: () => toggleFeat(k) })),
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[]

  // ---- overlay: own address, back button closes it ----
  const href = useCallback((id: string) => `${base.current}/home/${encodeURIComponent(id)}`, [])
  const openListing = (id: string) => { lastFocus.current = document.activeElement as HTMLElement; scrollY0.current = window.scrollY; window.history.pushState({ mp: id }, '', href(id)); setOpenId(id) }
  const closeListing = () => { if (window.history.state && window.history.state.mp) window.history.back(); else { window.history.replaceState(null, '', `${base.current}${filterQuery(f)}`); setOpenId(null) }; setTimeout(() => lastFocus.current?.focus?.({ preventScroll: true }), 30) }
  const step = (d: number) => { const k = list.findIndex(l => l.id === openId); const next = list[k + d]; if (!next) return; window.history.replaceState({ mp: next.id }, '', href(next.id)); setOpenId(next.id) }
  const openCard = (all || []).find(l => l.id === openId) || null
  const openIndex = list.findIndex(l => l.id === openId)

  const toggleShort = (id: string) => setShortlist(s => { const n = s.includes(id) ? s.filter(x => x !== id) : [...s, id].slice(-30); store.set('nx-mp-shortlist', JSON.stringify(n)); return n })
  const copyShortlist = async () => { try { await navigator.clipboard.writeText(`${window.location.origin}${base.current}?ids=${shortlist.map(encodeURIComponent).join(',')}`); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* */ } }
  const exchangeHref = `${base.current.replace(/\/marketplace$/, '')}/exchange`

  return (
    <div className="mp">
      <header className="mp-top">
        <a className="st-brand" href="/" aria-label="NEXUS STUDIOS home"><NexusStar size={18} className="st-star" />NEXUS <b>STUDIOS</b></a>
        <nav className="mp-tabs" aria-label="Marketplace sections">
          <a aria-current="page" href={base.current}>Homes</a>
          <a href="/marketplace/classic#places" className="mp-tab-quiet">Places</a>
          <a href={exchangeHref} className="mp-tab-quiet">Exchange</a>
          <span className="mp-tab-soon" title="Coming to NEXUS STUDIOS">Workers <small>soon</small></span>
        </nav>
        <button className={`mp-pro${pro ? ' on' : ''}`} aria-pressed={pro} onClick={() => { const v = !pro; setPro(v); store.set('nx-mp-pro', v ? '1' : '0') }}>
          <BriefcaseBusiness size={16} aria-hidden="true" />Professional
        </button>
      </header>

      {ids.length > 0 ? (
        <div className="mp-selection"><ListChecks size={18} aria-hidden="true" /><span><b>A selection of {list.length} {list.length === 1 ? 'home' : 'homes'}</b>shared with you</span><button className="mp-link" onClick={() => set({ ids: '' })}>See all homes</button></div>
      ) : <>
        <div className="mp-bar">
          <div className="mp-seg" role="group" aria-label="Market">
            {([['longlets', 'Long let'], ['stays', 'Short let'], ['sales', 'Sales']] as const).map(([m, label]) => (
              <button key={m} aria-pressed={f.market === m} disabled={m === 'sales' && !counts.sales} onClick={() => set({ ...DEFAULT, market: m, sort: f.sort, agency: f.agency })}>
                {label}{all && <small>{m === 'sales' && !counts.sales ? 'soon' : counts[m]}</small>}
              </button>
            ))}
          </div>
          <div className="mp-seg mp-seg-quiet" role="group" aria-label="Category">
            <button aria-pressed>Residential</button>
            <button disabled title="Not listed yet">Commercial <small>soon</small></button>
            <button disabled title="Not listed yet">Land <small>soon</small></button>
          </div>
          <div className="mp-search-wrap">
            <label className="mp-search"><Search size={16} aria-hidden="true" />
              <input value={f.q} onChange={e => set({ q: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') { commitSearch(); setTyping(false) } if (e.key === 'Escape') setTyping(false) }}
                onFocus={() => setTyping(true)} onBlur={() => setTimeout(() => setTyping(false), 180)} placeholder="Try “2 bed Sliema sea view under 1500”" aria-label="Search listings" aria-describedby="mp-understood" />
            </label>
            {!typing ? null : understoodParts.length > 0 ? (
              <button id="mp-understood" className="mp-understood" onClick={commitSearch}><Sparkles size={14} aria-hidden="true" /><span>{understoodParts.join(' · ')}</span><small>Enter to keep</small></button>
            ) : matchFeatures(featureOpts, f.q, 4).length > 0 && (
              <div className="mp-suggest" role="listbox" aria-label="Features">{matchFeatures(featureOpts, f.q, 4).map(o => (
                <button key={o.key} role="option" aria-selected="false" onClick={() => set({ q: '', feat: [...new Set([...featSet, o.key])].join(',') })}><span>Filter: <b>{o.label}</b></span><small>{featCounts[o.key] || 0}</small></button>))}</div>
            )}
          </div>
          <button className="mp-filter-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}><SlidersHorizontal size={16} aria-hidden="true" />Filters{chips.length ? <b>{chips.length}</b> : null}</button>
        </div>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div className="mp-filters" initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }}>
              <div className="mp-filter-row">
                <label>Area<select value={f.area} onChange={e => set({ area: e.target.value })}><option value="">All areas</option>{areas.map(a => <option key={a}>{a}</option>)}</select></label>
                <label>Type<select value={f.type} onChange={e => set({ type: e.target.value })}><option value="">All types</option>{types.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select></label>
                <label>Min €<input inputMode="numeric" value={f.min} onChange={e => set({ min: e.target.value.replace(/\D/g, '') })} placeholder="Any" /></label>
                <label>Max €<input inputMode="numeric" value={f.max} onChange={e => set({ max: e.target.value.replace(/\D/g, '') })} placeholder="Any" /></label>
                <label>Bedrooms<select value={f.beds} onChange={e => set({ beds: e.target.value })}><option value="">Any</option>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}+</option>)}</select></label>
                <label>Sort<select value={f.sort} onChange={e => set({ sort: e.target.value as Filters['sort'] })}><option value="fresh">Recently updated</option><option value="price-asc">Price, low to high</option><option value="price-desc">Price, high to low</option></select></label>
                {agencies.size > 1 && <label>Agency<select value={f.agency} onChange={e => set({ agency: e.target.value })}><option value="">All agencies</option>{[...agencies.values()].map(a => <option key={a.key} value={a.key}>{a.name}</option>)}</select></label>}
                <label className="mp-check"><input type="checkbox" checked={f.now} onChange={e => set({ now: e.target.checked })} />Available now</label>
              </div>
              <div className="mp-catalog" aria-label="Features">
                <div className="mp-catalog-head"><b>Features</b><span className="mp-muted small">Only features that homes in this market really have. Confirmed by the agency or read from the listing.</span>
                  <label className="mp-catalog-find"><Search size={14} aria-hidden="true" /><input value={fq} onChange={e => setFq(e.target.value)} placeholder="Find: Balkon, aircon, lift…" aria-label="Find a feature" /></label></div>
                {GROUPS.map(([g, label]) => {
                  const opts = featureOpts.filter(o => o.group === g && (featCounts[o.key] || 0) > 0 && (!fq.trim() || matchFeatures([o], fq, 1).length > 0))
                  if (!opts.length) return null
                  return <div key={g} className="mp-catalog-group"><span>{label}</span><div>{opts.map(o => (
                    <button key={o.key} aria-pressed={featSet.has(o.key)} onClick={() => toggleFeat(o.key)}>{featSet.has(o.key) ? <Check size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}{o.label}<small>{featCounts[o.key]}</small></button>))}</div></div>
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {chips.length > 0 && <div className="mp-featchips" aria-label="Active filters">{chips.map(c => <button key={c.key} onClick={c.clear} aria-label={`Remove filter ${c.label}`}>{c.label}<X size={13} aria-hidden="true" /></button>)}
          <button className="mp-clear" onClick={() => set({ ...DEFAULT, market: f.market, sort: f.sort })}>Clear all</button></div>}
        {f.agency && agencies.get(f.agency) && <div className="mp-agency-strip"><AgencyMark agency={agencies.get(f.agency)!} size="md" /><span className="mp-muted small">{agencies.get(f.agency)!.verifiedBasis}</span></div>}
        {all && !chips.length && !f.q && (
          <div className="mp-banners" aria-label="Highlights">
            {counts.confirmed > 0 && <button className="mp-banner b1" onClick={() => set({ now: true, soon: false })}><Check size={16} aria-hidden="true" /><span><b>{counts.confirmed} confirmed available</b>checked with the owner</span></button>}
            {counts.sea > 0 && <button className="mp-banner b2" onClick={() => toggleFeat('sea_view')}><Waves size={16} aria-hidden="true" /><span><b>{counts.sea} with sea view</b>from the listing details</span></button>}
            {counts.upcoming > 0 && <button className="mp-banner b3" onClick={() => set({ soon: true, now: false })}><Sparkles size={16} aria-hidden="true" /><span><b>{counts.upcoming} coming soon</b>enquire before they go live</span></button>}
          </div>
        )}
      </>}

      <main>
        {failed ? <p className="mp-empty">Listings are not available right now. Please try again in a moment.</p>
          : !all ? <div className="mp-grid" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="mp-card mp-skel" />)}</div>
          : !list.length ? <p className="mp-empty">No homes match these filters. <button className="mp-link" onClick={() => set({ ...DEFAULT, market: f.market })}>Clear filters</button></p>
          : <>
            {!ids.length && <p className="mp-count">{list.length} {list.length === 1 ? 'home' : 'homes'}{(f.area || u.area) ? ` in ${f.area || u.area}` : ''}</p>}
            <motion.div className="mp-grid" layout={!reduce}>
              <AnimatePresence initial={false}>
                {list.slice(0, ids.length ? 30 : shown).map(l => <Card key={l.id} l={l} pro={pro} reduce={!!reduce} href={href(l.id)} onOpen={() => openListing(l.id)} listed={shortlist.includes(l.id)} onList={() => toggleShort(l.id)} />)}
              </AnimatePresence>
            </motion.div>
            {!ids.length && shown < list.length && <button className="mp-more" onClick={() => setShown(n => n + PAGE)}>Show more ({list.length - shown})</button>}
          </>}
      </main>

      {pro && shortlist.length > 0 && !ids.length && (
        <div className="mp-shortbar" role="region" aria-label="Client shortlist">
          <ListChecks size={18} aria-hidden="true" /><b>{shortlist.length} in shortlist</b>
          <button onClick={copyShortlist}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Link copied' : 'Copy client link'}</button>
          <a href={`${base.current}?ids=${shortlist.join(',')}`}>View<ArrowUpRight size={14} aria-hidden="true" /></a>
          <button className="mp-shortbar-clear" onClick={() => { setShortlist([]); store.set('nx-mp-shortlist', '[]') }} aria-label="Clear shortlist"><X size={14} /></button>
        </div>
      )}
      <footer className="mp-foot">Listings from ARGUS, updated live. Locations are shown at area level until a viewing. <a href="/marketplace/classic">Classic view</a></footer>

      <AnimatePresence>
        {openCard && <ListingOverlay key="ov" card={openCard} pro={pro} reduce={!!reduce} onClose={closeListing} pageHref={href(openCard.id)}
          prev={openIndex > 0 ? () => step(-1) : null} next={openIndex >= 0 && openIndex < list.length - 1 ? () => step(1) : null} position={openIndex >= 0 ? `${openIndex + 1} / ${list.length}` : null} />}
      </AnimatePresence>
    </div>
  )
}

function ListingOverlay({ card, pro, reduce, onClose, pageHref, prev, next, position }: { card: ListingCard; pro: boolean; reduce: boolean; onClose: () => void; pageHref: string; prev: (() => void) | null; next: (() => void) | null; position: string | null }) {
  const [detail, setDetail] = useState<ListingDetail | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    setDetail(null)
    fetch(`/api/marketplace/listings?id=${encodeURIComponent(card.id)}`).then(r => (r.ok ? r.json() : null)).then(d => { if (alive && d?.listing) setDetail(d.listing) }).catch(() => {})
    box.current?.scrollTo({ top: 0 })
    return () => { alive = false }
  }, [card.id])
  useEffect(() => {
    const html = document.documentElement, prevOverflow = html.style.overflow
    html.style.overflow = 'hidden'
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && box.current) { // keep focus inside the dialog
        const els = box.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])')
        if (!els.length) return
        const first = els[0], last = els[els.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { html.style.overflow = prevOverflow; window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const l = detail && detail.id === card.id ? detail : card
  return (
    <motion.div className="mp-overlay" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={reduce ? undefined : { opacity: 0 }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <motion.div ref={box} className="mp-sheet" role="dialog" aria-modal="true" aria-labelledby="mp-sheet-title" tabIndex={-1}
        initial={reduce ? false : { y: 28, opacity: 0.6 }} animate={{ y: 0, opacity: 1 }} exit={reduce ? undefined : { y: 28, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 34 }}>
        <div className="mp-sheet-bar">
          <button onClick={onClose} className="mp-sheet-close" aria-label="Close"><X size={18} /></button>
          {position && <span className="mp-muted small">{position}</span>}
          <span className="mp-sheet-spacer" />
          <button onClick={prev || undefined} disabled={!prev} aria-label="Previous home"><ChevronLeft size={18} /></button>
          <button onClick={next || undefined} disabled={!next} aria-label="Next home"><ChevronRight size={18} /></button>
          <a href={pageHref} className="mp-sheet-page" target="_blank" rel="noopener">Own page<ExternalLink size={13} aria-hidden="true" /></a>
        </div>
        <ListingBody l={l} pro={pro} loading={!detail || detail.id !== card.id} headingId="mp-sheet-title" />
      </motion.div>
    </motion.div>
  )
}

function Card({ l, pro, reduce, href, onOpen, listed, onList }: { l: ListingCard; pro: boolean; reduce: boolean; href: string; onOpen: () => void; listed: boolean; onList: () => void }) {
  const [i, setI] = useState(0)
  const strip = useRef<HTMLDivElement>(null)
  const go = (d: number) => { const el = strip.current; if (!el) return; const n = Math.max(0, Math.min(l.images.length - 1, i + d)); el.scrollTo({ left: n * el.clientWidth, behavior: reduce ? 'auto' : 'smooth' }) }
  const [copied, setCopied] = useState(false)
  // plain click opens the overlay; ctrl/cmd/middle click keeps the normal link behaviour (new tab)
  const click = (e: React.MouseEvent) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onOpen() }
  return (
    <motion.article className="mp-card" layout={!reduce} initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0 }} transition={{ duration: 0.25 }}>
      <div className="mp-photos">
        <div className="mp-strip" ref={strip} onScroll={e => setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}>
          {l.images.map((src, k) => (
            <a key={src} href={href} onClick={click} tabIndex={k === 0 ? 0 : -1} aria-label={k === 0 ? l.title : undefined}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" loading="lazy" decoding="async" />
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
      <a className="mp-body" href={href} onClick={click}>
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
          {l.provider.kind === 'agency' ? <><AgencyMark agency={l.provider.agency} />{l.provider.agent ? <span className="mp-agent-name">· {l.provider.agent.name}</span> : null}</> : l.provider.kind === 'owner_direct' ? 'Direct from owner' : <span className="mp-agent-name">Provider being confirmed</span>}
          <span className="mp-fresh">{ago(l.updatedAt)}</span>
        </p>
      </a>
      {pro && (
        <div className="mp-probar">
          <span>Ref {l.id}</span>
          <span title={l.cooperation.status === 'not_published' ? l.cooperation.note : l.cooperation.basis}>{l.cooperation.status === 'confirmed' ? `Co-agency: ${l.cooperation.headline}` : 'Co-agency: not published'}</span>
          <button aria-pressed={listed} onClick={onList}>{listed ? <Check size={14} /> : <Plus size={14} />}{listed ? 'Shortlisted' : 'Shortlist'}</button>
          <button onClick={async () => { try { await navigator.clipboard.writeText(`${window.location.origin}${href}`); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* */ } }}>
            {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Link'}
          </button>
        </div>
      )}
    </motion.article>
  )
}
