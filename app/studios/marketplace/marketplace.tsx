'use client'
// NEXUS Marketplace (React, 2026-11-21): listings first, compact navigation, small campaign banners,
// filters kept in the address (shareable, back button works), cards with photos, availability, freshness,
// Smart Intelligence and the real provider. A card opens as an overlay over the list (own address, back
// button closes it, the list keeps its filters and scroll position); the stand-alone page stays for shared links.
// Search understands plain language ("2 bed sliema sea view under 1500") using the live areas, types and the
// feature dictionary. "Professional" adds references, co-agency terms (only when agreed) and client shortlists.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUpRight, Bath, BedDouble, BriefcaseBusiness, Check, ChevronLeft, ChevronRight, Copy, Dumbbell, ExternalLink, GraduationCap, Heart, HeartPulse, ListChecks, MapPin, MessageCircle, MoreVertical, Plus, Ruler, Search, Share2, ShieldCheck, ShoppingBasket, SlidersHorizontal, Sparkles, Waves, X } from 'lucide-react'
import { MarketplaceLogo } from '@/components/brand/logo'
import type { Agency, ListingCard, ListingDetail, Market, SmartFact } from '@/lib/marketplace/model'
import { nrm, understand } from '@/lib/marketplace/query'
import { AgencyMark, ListingBody, MetricBadge, eur, km } from './parts'
import { initialsOf } from './chat'
import { availabilityText, cached, cardSet, loadDetail, prefetch, width } from './instant'

type Filters = { market: Market; type: string; area: string; min: string; max: string; beds: string; now: boolean; soon: boolean; q: string; sort: 'fresh' | 'price-asc' | 'price-desc'; feature: string; feat: string; agency: string; ids: string; view: string }
type FeatureOpt = { key: string; label: string; group: string; aliases: string[]; count: number }
const matchFeatures = (opts: FeatureOpt[], q: string, limit = 6) => { const t = nrm(q.trim()); if (t.length < 2) return []; return opts.filter(o => nrm(o.label).includes(t) || o.aliases.some(a => nrm(a).includes(t))).sort((a, b) => b.count - a.count).slice(0, limit) }
const DEFAULT: Filters = { market: 'longlets', type: '', area: '', min: '', max: '', beds: '', now: false, soon: false, q: '', sort: 'fresh', feature: '', feat: '', agency: '', ids: '', view: '' }
const PAGE = 24
const GROUPS: [string, string][] = [['view', 'View & sea'], ['outdoor', 'Outdoor'], ['comfort', 'Comfort'], ['building', 'Building'], ['parking', 'Parking'], ['kitchen', 'Kitchen & laundry'], ['rooms', 'Rooms'], ['bathroom', 'Bathroom'], ['energy', 'Energy'], ['security', 'Security'], ['accessibility', 'Accessibility']]
const ago = (iso: string | null) => {
  if (!iso) return null
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3)
  return d <= 0 ? 'Updated today' : d === 1 ? 'Updated yesterday' : d < 31 ? `Updated ${d} days ago` : d < 365 ? `Updated ${Math.round(d / 30)} mo ago` : 'Updated over a year ago'
}
const SMART_ICON: Record<SmartFact['key'], typeof Waves> = { shop: ShoppingBasket, coast: Waves, health: HeartPulse, gym: Dumbbell, school: GraduationCap }
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
  const [morphId, setMorphId] = useState<string | null>(null)   // the card the overlay grew out of (shared photo)
  const [shortlist, setShortlist] = useState<string[]>([])
  const [saved, setSaved] = useState<string[]>([])
  const [openSection, setOpenSection] = useState<string | null>(null)
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
    try { setSaved(JSON.parse(store.get('nx-mp-saved') || '[]').filter((x: unknown) => typeof x === 'string').slice(0, 100)) } catch { /* */ }
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
  const understoodParts = [u.beds && `${u.beds}+ Bedrooms`, u.area, u.type && u.type[0].toUpperCase() + u.type.slice(1), ...u.feat.map(k => featureOpts.find(o => o.key === k)?.label || k), u.min && `from ${eur(Number(u.min))}`, u.max && `up to ${eur(Number(u.max))}`, u.now && 'available now'].filter(Boolean) as string[]
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
    f.beds && { key: 'beds', label: `${f.beds}+ Bedrooms`, clear: () => set({ beds: '' }) },
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
  const openListing = (id: string, section?: string) => { prefetch(id, undefined, true); lastFocus.current = document.activeElement as HTMLElement; scrollY0.current = window.scrollY; setOpenSection(section || null); setMorphId(id); window.history.pushState({ mp: id }, '', href(id)); setOpenId(id) }
  const closeListing = () => { if (window.history.state && window.history.state.mp) window.history.back(); else { window.history.replaceState(null, '', `${base.current}${filterQuery(f)}`); setOpenId(null) }; setTimeout(() => lastFocus.current?.focus?.({ preventScroll: true }), 30) }
  const step = (d: number) => { const k = list.findIndex(l => l.id === openId); const next = list[k + d]; if (!next) return; prefetch(next.id, next.images[0], true); const after = list[k + 2 * d]; if (after) prefetch(after.id, after.images[0]); setMorphId(null); setOpenSection(null); window.history.replaceState({ mp: next.id }, '', href(next.id)); setOpenId(next.id) }
  const openCard = (all || []).find(l => l.id === openId) || null
  const openIndex = list.findIndex(l => l.id === openId)

  // saved homes: kept in this browser only (no account needed)
  const toggleSaved = (id: string) => setSaved(s => { const n = s.includes(id) ? s.filter(x => x !== id) : [...s, id].slice(-100); store.set('nx-mp-saved', JSON.stringify(n)); return n })
  const toggleShort = (id: string) => setShortlist(s => { const n = s.includes(id) ? s.filter(x => x !== id) : [...s, id].slice(-30); store.set('nx-mp-shortlist', JSON.stringify(n)); return n })
  const copyShortlist = async () => { try { await navigator.clipboard.writeText(`${window.location.origin}${base.current}?ids=${shortlist.map(encodeURIComponent).join(',')}`); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* */ } }
  const exchangeHref = `${base.current.replace(/\/marketplace$/, '')}/exchange`

  return (
    <div className="mp">
      <header className="mp-top">
        <a className="mp-brand" href={base.current} aria-label="Marketplace home"><MarketplaceLogo height={13} /></a>
        <nav className="mp-tabs" aria-label="Marketplace sections">
          <a aria-current="page" href={base.current}>Homes</a>
          <a href={`${base.current}/rooms`} className="mp-tab-quiet">Rooms</a>
          <a href="/marketplace/classic#places" className="mp-tab-quiet">Places</a>
          <a href={exchangeHref} className="mp-tab-quiet">Exchange</a>
          <span className="mp-tab-soon" title="Coming to NEXUS STUDIOS">Workers <small>soon</small></span>
        </nav>
        <a className="mp-saved" href={`${base.current}?view=saved&ids=${saved.join(',')}`} aria-label={`Saved homes: ${saved.length}`} onClick={e => { if (!saved.length) e.preventDefault() }} aria-disabled={!saved.length}>
          <Heart size={16} fill={saved.length ? 'currentColor' : 'none'} aria-hidden="true" /><span>Saved</span>{saved.length > 0 && <b>{saved.length}</b>}
        </a>
        <button className={`mp-pro${pro ? ' on' : ''}`} aria-pressed={pro} onClick={() => { const v = !pro; setPro(v); store.set('nx-mp-pro', v ? '1' : '0') }}>
          <BriefcaseBusiness size={16} aria-hidden="true" />Professional
        </button>
      </header>

      {ids.length > 0 ? (
        <div className="mp-selection"><ListChecks size={18} aria-hidden="true" />{f.view === 'saved'
          ? <span><b>Your saved homes ({list.length})</b>kept in this browser</span>
          : <span><b>A selection of {list.length} {list.length === 1 ? 'home' : 'homes'}</b>shared with you</span>}<button className="mp-link" onClick={() => set({ ids: '', view: '' })}>See all homes</button></div>
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
        {!all && !ids.length && !chips.length && !f.q && <div className="mp-banners mp-banners-skel" aria-hidden="true"><i /><i /><i /></div>}
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
          : !all ? <><p className="mp-count" aria-hidden="true">&nbsp;</p><div className="mp-grid" aria-busy="true">{Array.from({ length: 10 }, (_, i) => <div key={i} className="mp-card mp-skel" />)}</div></>
          : !list.length ? <p className="mp-empty">No homes match these filters. <button className="mp-link" onClick={() => set({ ...DEFAULT, market: f.market })}>Clear filters</button></p>
          : <>
            {!ids.length && <p className="mp-count">{list.length} {list.length === 1 ? 'home' : 'homes'}{(f.area || u.area) ? ` in ${f.area || u.area}` : ''}</p>}
            <motion.div className="mp-grid">
              <AnimatePresence initial={false}>
                {list.slice(0, ids.length ? 30 : shown).map((l, n) => <Card key={l.id} l={l} index={n} pro={pro} reduce={!!reduce} href={href(l.id)} hidePhoto={!!openId && morphId === l.id && openId === l.id} onOpen={s => openListing(l.id, s)} listed={shortlist.includes(l.id)} onList={() => toggleShort(l.id)} saved={saved.includes(l.id)} onSave={() => toggleSaved(l.id)} />)}
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
        {openCard && <ListingOverlay key="ov" card={openCard} section={openSection} morph={morphId === openCard.id ? `mp-photo-${openCard.id}` : null} pro={pro} reduce={!!reduce} onClose={closeListing} pageHref={href(openCard.id)}
          prev={openIndex > 0 ? () => step(-1) : null} next={openIndex >= 0 && openIndex < list.length - 1 ? () => step(1) : null} position={openIndex >= 0 ? `${openIndex + 1} / ${list.length}` : null} />}
      </AnimatePresence>
    </div>
  )
}

function ListingOverlay({ card, section, morph, pro, reduce, onClose, pageHref, prev, next, position }: { card: ListingCard; section: string | null; morph: string | null; pro: boolean; reduce: boolean; onClose: () => void; pageHref: string; prev: (() => void) | null; next: (() => void) | null; position: string | null }) {
  // details from the prefetch cache when the visitor hovered / saw the card; otherwise fetched now while the
  // prepared container already shows everything the card knows
  const [detail, setDetail] = useState<ListingDetail | null>(() => cached(card.id))
  const [chatFocus, setChatFocus] = useState(0)
  const box = useRef<HTMLDivElement>(null)     // the overlay itself is the one scroll container (wheel works anywhere)
  const sheet = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    const hit = cached(card.id); setDetail(hit)
    if (!hit) loadDetail(card.id).then(d => { if (alive && d) setDetail(d) })
    box.current?.scrollTo({ top: 0 })
    return () => { alive = false }
  }, [card.id])
  // "Message" on a card opens the conversation; "+N More" opens at the matching section once the details are there
  useEffect(() => { if (section === 'chat') setChatFocus(k => k + 1) }, [section, card.id])
  useEffect(() => {
    if (!section || section === 'chat' || !detail || detail.id !== card.id) return
    const t = setTimeout(() => { const el = box.current?.querySelector<HTMLElement>(`#mp-sec-${section}`); if (el && box.current) box.current.scrollTo({ top: el.getBoundingClientRect().top - box.current.getBoundingClientRect().top + box.current.scrollTop - 72, behavior: reduce ? 'auto' : 'smooth' }) }, 120)
    return () => clearTimeout(t)
  }, [section, detail, card.id, reduce])
  useEffect(() => {
    const html = document.documentElement, prevOverflow = html.style.overflow
    html.style.overflow = 'hidden'
    sheet.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && sheet.current) { // keep focus inside the dialog
        const els = sheet.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])')
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
    <motion.div ref={box} className="mp-overlay" layoutScroll initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.18 } }}
      transition={{ duration: 0.16 }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <motion.div ref={sheet} className="mp-sheet" role="dialog" aria-modal="true" aria-labelledby="mp-sheet-title" tabIndex={-1}
        initial={reduce ? false : morph ? { opacity: 0.4 } : { y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={reduce ? undefined : { opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }}
        onClick={e => { if (e.target === e.currentTarget) e.stopPropagation() }}>
        <div className="mp-sheet-bar">
          <button onClick={onClose} className="mp-sheet-close" aria-label="Close"><X size={18} /></button>
          {position && <span className="mp-muted small">{position}</span>}
          <span className="mp-sheet-spacer" />
          <button onClick={prev || undefined} disabled={!prev} aria-label="Previous home"><ChevronLeft size={18} /></button>
          <button onClick={next || undefined} disabled={!next} aria-label="Next home"><ChevronRight size={18} /></button>
          <a href={pageHref} className="mp-sheet-page" target="_blank" rel="noopener">Own page<ExternalLink size={13} aria-hidden="true" /></a>
        </div>
        <ListingBody key={card.id} l={l} pro={pro} loading={!detail || detail.id !== card.id} headingId="mp-sheet-title" morph={morph || undefined} chatFocus={chatFocus} />
      </motion.div>
    </motion.div>
  )
}

// ---- the listing card (Kev's reference, 21 Nov 2026; compact NEXUS refinement the same evening) ----------
// Photo first with one honest status pill ("Available · Confirmed Today" only from a real confirmation); one info
// row (price · location · beds · baths, "?" when unknown); compact feature tags with a real "+N More"; the real
// description; nearby facts; one provider identity (logo, verified, agent) and the NEXUS conversation as the action.
// Instant: hovering / focusing / touching a card prefetches its details and warms the hero photo; cards that stay
// on screen prefetch quietly (two at a time). Only the first photo loads until the visitor touches the strip.
// One chip row that shows as many chips as really fit and a "+N More" with the exact number of hidden ones.
// Widths are measured from an invisible copy, so the count is right at every card size.
function FitRow({ items, className, chip, more, href, onClick, label, title }: { items: { key: string; node: React.ReactNode }[]; className: string; chip?: string; more: (n: number) => React.ReactNode; href: string; onClick: (e: React.MouseEvent) => void; label?: string; title?: string }) {
  const row = useRef<HTMLAnchorElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [n, setN] = useState(items.length)
  useLayoutEffect(() => {
    const el = row.current, pr = probe.current
    if (!el || !pr) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const gap = parseFloat(cs.columnGap) || 0
      const widths = Array.from(pr.children).map(c => (c as HTMLElement).offsetWidth)
      const moreW = widths.pop() || 0
      let used = 0, fit = 0
      for (let i = 0; i < widths.length; i++) {
        const next = used + (fit ? gap : 0) + widths[i]
        const reserve = i < widths.length - 1 ? gap + moreW : 0
        if (next + reserve <= avail) { used = next; fit++ } else break
      }
      setN(Math.max(1, fit))
    }
    measure()
    const ro = new ResizeObserver(measure); ro.observe(el)
    return () => ro.disconnect()
  }, [items.length])
  return (
    <a ref={row} className={className} href={href} onClick={onClick} aria-label={label} title={title}>
      {items.slice(0, n).map(i => <span key={i.key} className={chip}>{i.node}</span>)}
      {n < items.length && more(items.length - n)}
      <span ref={probe} className="mc-probe" aria-hidden="true">{items.map(i => <span key={i.key} className={chip}>{i.node}</span>)}{more(99)}</span>
    </a>
  )
}

function Card({ l, index, pro, reduce, href, hidePhoto, onOpen, listed, onList, saved, onSave }: { l: ListingCard; index: number; pro: boolean; reduce: boolean; href: string; hidePhoto: boolean; onOpen: (section?: string) => void; listed: boolean; onList: () => void; saved: boolean; onSave: () => void }) {
  const [i, setI] = useState(0)
  const [armed, setArmed] = useState(false)   // further photos only once the visitor shows interest
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const strip = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLElement>(null)
  const go = (d: number) => { setArmed(true); const el = strip.current; if (!el) return; const n = Math.max(0, Math.min(l.images.length - 1, i + d)); el.scrollTo({ left: n * el.clientWidth, behavior: reduce ? 'auto' : 'smooth' }) }
  // plain click opens the overlay; ctrl/cmd/middle click keeps the normal link behaviour (new tab)
  const click = (section?: string) => (e: React.MouseEvent) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onOpen(section) }
  const intent = () => { setArmed(true); prefetch(l.id, l.images[0], true) }
  useEffect(() => { // on screen for a moment -> prepare the details quietly
    const el = root.current; if (!el) return
    let t: ReturnType<typeof setTimeout> | undefined
    const io = new IntersectionObserver(([e]) => { clearTimeout(t); if (e.isIntersecting) t = setTimeout(() => prefetch(l.id), 650) })
    io.observe(el); return () => { clearTimeout(t); io.disconnect() }
  }, [l.id])
  const tagsAll = [...(l.typeLabel ? [l.typeLabel] : []), ...l.features]
  const agency = l.provider.kind === 'agency' ? l.provider.agency : null
  const agent = l.provider.kind === 'agency' ? l.provider.agent : null
  const badge = pro && l.cooperation.status === 'confirmed' ? l.cooperation.badge : undefined
  const av = availabilityText(l.availability, l.updatedAt)
  const share = async () => { const url = `${window.location.origin}${href}`; try { if (navigator.share) await navigator.share({ title: l.title, url }); else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600) } } catch { /* cancelled */ } setMenu(false) }
  const eager = index < 5
  return (
    <motion.article ref={root} className="mc" initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34, delay: reduce ? 0 : Math.min(index % 24, 10) * 0.03 }} whileHover={reduce ? undefined : { y: -3 }}
      onPointerEnter={intent} onFocus={intent} onTouchStart={intent}>
      <motion.div className="mc-photo" layoutId={reduce ? undefined : `mp-photo-${l.id}`} style={hidePhoto ? { visibility: 'hidden' } : undefined}>
        <div className="mp-strip" ref={strip} onScroll={e => { setArmed(true); setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth))) }}>
          {l.images.length ? l.images.map((src, k) => (
            <a key={src} href={href} onClick={click()} tabIndex={k === 0 ? 0 : -1} aria-label={k === 0 ? `${l.title}, ${l.price ? eur(l.price) : 'price on request'}` : undefined}>
              {(k === 0 || armed) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={width(src, 720)} srcSet={cardSet(src)} sizes="(max-width: 640px) 100vw, (max-width: 1180px) 50vw, 380px" alt="" loading={k === 0 && eager ? 'eager' : 'lazy'} fetchPriority={k === 0 && index < 2 ? 'high' : undefined} decoding="async" />
              )}
            </a>
          )) : <a href={href} onClick={click()} className="mc-nophoto">No photos yet</a>}
        </div>
        <span className={`mc-pill mc-avail k-${av.tone}`} title={av.title}>{av.text}</span>
        {badge && <span className="mc-tr"><MetricBadge value={badge.value} measures={badge.measures} /></span>}
        {l.images.length > 1 && <>
          <button className="mp-nav l" onClick={() => go(-1)} disabled={i === 0} aria-label="Previous photo"><ChevronLeft size={18} /></button>
          <button className="mp-nav r" onClick={() => go(1)} disabled={i >= l.images.length - 1} aria-label="Next photo"><ChevronRight size={18} /></button>
          <span className="mc-dots" aria-hidden="true">{l.images.map((_, k) => <i key={k} data-on={k === i || undefined} />)}</span>
        </>}
      </motion.div>

      <a className="mc-main" href={href} onClick={click()}>
        <span className="mc-price">{l.price ? <>{eur(l.price)}<small>{l.pricePeriod ? ` / ${l.pricePeriod === 'month' ? 'mo' : l.pricePeriod}` : ''}</small></> : 'Price on request'}</span>
        <span className="mc-rooms">
          {l.bedrooms != null && l.bedrooms > 0 && <span title={`${l.bedrooms} ${l.bedrooms === 1 ? 'Bedroom' : 'Bedrooms'}`}><BedDouble size={15} aria-hidden="true" />{l.bedrooms}<i className="sr"> {l.bedrooms === 1 ? 'Bedroom' : 'Bedrooms'}</i></span>}
          {l.bedrooms === 0 && <span title="Studio"><BedDouble size={15} aria-hidden="true" />Studio</span>}
          <span title={l.bathrooms ? `${l.bathrooms} ${l.bathrooms === 1 ? 'Bathroom' : 'Bathrooms'}` : 'Bathrooms not recorded yet'} data-unknown={!l.bathrooms || undefined}><Bath size={15} aria-hidden="true" />{l.bathrooms || '?'}<i className="sr"> {l.bathrooms ? (l.bathrooms === 1 ? 'Bathroom' : 'Bathrooms') : 'bathrooms unknown'}</i></span>
          {l.size && <span title={`${l.size} m²`}><Ruler size={14} aria-hidden="true" />{l.size}<small>m²</small></span>}
        </span>
        <span className="mc-loc"><MapPin size={13} aria-hidden="true" />{l.area}</span>
      </a>

      {tagsAll.length > 0 && (
        <FitRow className="mc-tags" chip="mc-chip" href={href} onClick={click('features')} label={`Features: ${tagsAll.join(', ')}`}
          items={tagsAll.map(t => ({ key: t, node: t }))} more={n => <span className="mc-more">+{n} More</span>} />
      )}
      {l.teaser && <p className="mc-desc">{l.teaser}</p>}
      {l.smart.length > 0 && (
        <FitRow className="mc-smart" chip="mc-near" href={href} onClick={click('area')} title={l.smartFromCentre ? `Straight-line distances from the ${l.area} centre, not from the building — not road or walking distance` : 'Straight-line distances from the property — not road or walking distance'}
          items={l.smart.map(s => { const I = SMART_ICON[s.key]; return { key: s.key, node: <><I size={11} aria-hidden="true" />{s.label} {km(s.km, l.smartFromCentre)}</> } })}
          more={n => <span className="mc-more">+{n} More</span>} />
      )}

      <span className="mc-fill" aria-hidden="true" />
      <div className="mc-foot">
        <span className="mc-by">
          {agency ? <>
            {agency.logo
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={agency.logo} alt={agency.name} title={agency.name} />
              : <b>{agency.name}</b>}
            {agency.verified && <ShieldCheck size={12} className="mc-ver" aria-label="verified agency" />}
            {l.otherAgencies.length > 0 && <small className="mc-more-ag">+{l.otherAgencies.length}</small>}
            {agent && <><i className="mc-sep" aria-hidden="true" /><span className="mc-av" aria-hidden="true">{initialsOf(agent.name)}</span><span className="mc-agent">{agent.name}</span></>}
          </> : <small>Provider being confirmed</small>}
        </span>
        <span className="mc-actions">
          {agency ? <a href={href} onClick={click('chat')} title={`Private NEXUS chat with ${agent?.name || agency.name} about Ref ${l.id}`}><MessageCircle size={13} aria-hidden="true" />Message</a>
            : <a href={href} onClick={click()}>Details</a>}
          <motion.button className="mc-icon" aria-pressed={saved} aria-label={saved ? 'Remove from saved' : 'Save'} onClick={onSave} whileTap={reduce ? undefined : { scale: 0.8 }}>
            <Heart size={16} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
          </motion.button>
          <span className="mc-menu-wrap">
            <button className="mc-icon" aria-label="More options" aria-expanded={menu} onClick={() => setMenu(m => !m)} onBlur={() => setTimeout(() => setMenu(false), 160)}><MoreVertical size={16} aria-hidden="true" /></button>
            <AnimatePresence>{menu && <motion.span className="mc-menu" role="menu" initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.97 }} transition={{ duration: 0.14 }}>
              <button role="menuitem" onClick={share}><Share2 size={14} aria-hidden="true" />{copied ? 'Link copied' : 'Share'}</button>
              <a role="menuitem" href={href} target="_blank" rel="noopener"><ExternalLink size={14} aria-hidden="true" />Open in new tab</a>
              {pro && <button role="menuitem" onClick={() => { onList(); setMenu(false) }}>{listed ? <Check size={14} /> : <Plus size={14} />}{listed ? 'In shortlist' : 'Add to shortlist'}</button>}
            </motion.span>}</AnimatePresence>
          </span>
        </span>
      </div>
      {pro && (
        <div className="mp-probar">
          <span>Ref {l.id}</span>
          <span title={l.cooperation.status === 'not_published' ? l.cooperation.note : l.cooperation.basis}>{l.cooperation.status === 'confirmed' ? `Co-agency: ${l.cooperation.headline}` : 'Co-agency: not published'}</span>
          <button aria-pressed={listed} onClick={onList}>{listed ? <Check size={14} /> : <Plus size={14} />}{listed ? 'Shortlisted' : 'Shortlist'}</button>
        </div>
      )}
    </motion.article>
  )
}
