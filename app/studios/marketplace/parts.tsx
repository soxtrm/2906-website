'use client'
// Shared Marketplace pieces (2026-11-21): agency identity, gallery with full-screen viewer, the listing body
// (used by the overlay on the list and by the stand-alone page), co-agency terms and the enquiry form.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bath, BedDouble, CalendarDays, Check, ChevronLeft, ChevronRight, ExternalLink, Handshake, MapPin, Maximize2, MessageCircle, Ruler, ShieldCheck, X } from 'lucide-react'
import type { Agency, Cooperation, ListingCard, ListingDetail } from '@/lib/marketplace/model'
import { PropertyLifeOverview } from '@/components/property-life-overview'
import { ChatPanel } from './chat'

export const eur = (n: number) => `€${n.toLocaleString('en-GB')}`
// distances: never more precise than the data (area centre -> '~', under 100 m -> '<0.1 km')
export const km = (d: number, approx: boolean) => (d < 0.1 ? '<0.1 km' : `${approx ? '~' : ''}${d.toFixed(1)} km`)

export function AgencyMark({ agency, size = 'sm' }: { agency: Agency; size?: 'sm' | 'md' }) {
  return (
    <span className={`mp-agency ${size}`}>
      {agency.logo
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={agency.logo} alt="" aria-hidden="true" />
        : <i aria-hidden="true">{agency.name.slice(0, 1)}</i>}
      <span>{agency.name}</span>
      {agency.verified && <ShieldCheck size={size === 'md' ? 15 : 13} className="mp-verified" aria-label="verified agency" />}
    </span>
  )
}

export function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') }

// ---- gallery with a full-screen viewer (keyboard, swipe, Esc) -------------------------------------------
export function Gallery({ images, title }: { images: string[]; title: string }) {
  const strip = useRef<HTMLDivElement>(null)
  const [i, setI] = useState(0)
  const [full, setFull] = useState<number | null>(null)
  const go = (d: number) => { const el = strip.current; if (!el) return; const n = Math.max(0, Math.min(images.length - 1, i + d)); el.scrollTo({ left: n * el.clientWidth, behavior: 'smooth' }) }
  if (!images.length) return <div className="mp-gallery mp-gallery-empty">No photos yet</div>
  return (
    <div className="mp-gallery">
      <div className="mp-strip" ref={strip} onScroll={e => setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}>
        {images.map((src, k) => (
          <button key={src} className="mp-shot" onClick={() => setFull(k)} aria-label={`Open photo ${k + 1} of ${images.length} full screen`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={k === 0 ? title : ''} loading={k < 2 ? 'eager' : 'lazy'} decoding="async" />
          </button>
        ))}
      </div>
      {images.length > 1 && <>
        <button className="mp-nav l" onClick={() => go(-1)} disabled={i === 0} aria-label="Previous photo"><ChevronLeft size={20} /></button>
        <button className="mp-nav r" onClick={() => go(1)} disabled={i >= images.length - 1} aria-label="Next photo"><ChevronRight size={20} /></button>
      </>}
      <span className="mp-count-badge"><Maximize2 size={12} aria-hidden="true" />{i + 1} / {images.length}</span>
      {full !== null && <Viewer images={images} start={full} onClose={() => setFull(null)} />}
    </div>
  )
}

function Viewer({ images, start, onClose }: { images: string[]; start: number; onClose: () => void }) {
  const [k, setK] = useState(start)
  const touch = useRef<number | null>(null)
  const step = useCallback((d: number) => setK(x => Math.max(0, Math.min(images.length - 1, x + d))), [images.length])
  const closeBtn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeBtn.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1) }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, step])
  return createPortal(
    <div className="mp-viewer" role="dialog" aria-modal="true" aria-label="Photos" onClick={e => { if (e.target === e.currentTarget) onClose() }}
      onTouchStart={e => { touch.current = e.touches[0].clientX }} onTouchEnd={e => { if (touch.current === null) return; const dx = e.changedTouches[0].clientX - touch.current; if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1); touch.current = null }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={images[k]} alt={`Photo ${k + 1} of ${images.length}`} />
      <button ref={closeBtn} className="mp-viewer-close" onClick={onClose} aria-label="Close photos"><X size={22} /></button>
      {k > 0 && <button className="mp-viewer-nav l" onClick={() => step(-1)} aria-label="Previous photo"><ChevronLeft size={28} /></button>}
      {k < images.length - 1 && <button className="mp-viewer-nav r" onClick={() => step(1)} aria-label="Next photo"><ChevronRight size={28} /></button>}
      <span className="mp-viewer-count">{k + 1} / {images.length}</span>
    </div>, document.body)
}

// ---- co-agency terms (only what the listing agency has agreed) -----------------------------------------
export function CooperationBox({ c, agencyName }: { c: Cooperation; agencyName: string }) {
  if (c.status === 'confirmed') return (
    <div className="mp-coop ok">
      <b><Handshake size={16} aria-hidden="true" />Co-agency terms</b>
      <p className="mp-coop-head">{c.headline}</p>
      <p className="mp-muted small">{c.basis}</p>
      {c.conditions.length > 0 && <ul>{c.conditions.map(x => <li key={x}>{x}</li>)}</ul>}
      <p className="mp-muted small">Agreed with {agencyName} on {new Date(c.agreedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ref. {c.reference}</p>
    </div>
  )
  return (
    <div className="mp-coop">
      <b><Handshake size={16} aria-hidden="true" />Co-agency terms</b>
      <p className="mp-muted small">Not published. {agencyName} has not agreed shared terms for NEXUS STUDIOS yet, so no figure is shown. Ask the agency directly.</p>
    </div>
  )
}

// ---- contact: real, working routes only ------------------------------------------------------------------
// Message / Viewing open WhatsApp with the agency's own published business number and a prefilled text that
// names the reference. Nothing is booked: a viewing exists only once the agency replies.
export type Intent = 'message' | 'viewing'
export const viewingLabel = (l: ListingCard) => (l.market === 'stays' ? 'Request' : 'Viewing')
export function waHref(l: ListingCard, intent: Intent, role: 'home-seeker' | 'agent' = 'home-seeker') {
  if (l.provider.kind !== 'agency' || !l.provider.agency.whatsapp) return null
  const what = `${l.title} (Ref ${l.id}${l.price ? `, ${eur(l.price)}${l.pricePeriod ? `/${l.pricePeriod}` : ''}` : ''})`
  const who = role === 'agent' ? 'I am an agent with a client for' : 'I am interested in'
  const text = intent === 'viewing'
    ? `Hello ${l.provider.agency.name}, ${who} ${what}. Could we arrange a viewing? ${l.availability.kind === 'from' && l.availability.from ? `I understand it is available ${l.availability.label.replace(/^./, c => c.toLowerCase())}.` : ''}`.trim()
    : `Hello ${l.provider.agency.name}, ${who} ${what}. Is it still available?`
  return `https://wa.me/${l.provider.agency.whatsapp}?text=${encodeURIComponent(text)}`
}

export function ContactBox({ l }: { l: ListingCard }) {
  const [role, setRole] = useState<'home-seeker' | 'agent'>('home-seeker')
  if (l.provider.kind !== 'agency' || !l.provider.agency.whatsapp) return (
    <div className="mp-enquiry"><b>Contact</b><p className="mp-muted small">The provider of this listing is being confirmed, so no contact route is shown yet.</p></div>
  )
  const far = l.availability.kind === 'from' && l.availability.from && new Date(l.availability.from).getTime() > Date.now() + 92 * 86400e3
  return (
    <div className="mp-enquiry" id="mp-sec-contact">
      <b>Contact {l.provider.agency.name}</b>
      <div className="mp-seg small" role="group" aria-label="I am">
        <button type="button" aria-pressed={role === 'home-seeker'} onClick={() => setRole('home-seeker')}>Looking for myself</button>
        <button type="button" aria-pressed={role === 'agent'} onClick={() => setRole('agent')}>Agent for a client</button>
      </div>
      <a className="mp-send" href={waHref(l, 'message', role)!} target="_blank" rel="noopener"><MessageCircle size={16} aria-hidden="true" />Message on WhatsApp</a>
      {!far && <a className="mp-send quiet" href={waHref(l, 'viewing', role)!} target="_blank" rel="noopener"><CalendarDays size={16} aria-hidden="true" />{l.market === 'stays' ? 'Request a Stay' : 'Request a Viewing'}</a>}
      <p className="mp-muted small">{far ? `Available ${l.availability.label.replace(/^./, c => c.toLowerCase())}: viewings open three months before. ` : ''}Opens WhatsApp with {l.provider.agency.name} ({l.provider.agency.whatsappLabel}) and the reference {l.id}. Nothing is booked until the agency confirms.</p>
    </div>
  )
}

// a short figure on a card corner, only with a defined meaning (e.g. agreed co-agency share, for professionals)
export function MetricBadge({ value, measures }: { value: string; measures: string }) {
  return <span className="mc-metric" title={measures} aria-label={`${value}: ${measures}`}>{value}</span>
}

// ---- listing body: shared by the overlay and the stand-alone page ---------------------------------------
// Wide layout (Kev, 21 Nov 2026): location-first heading, photo mosaic, chips like the card, features, the 2906
// Smart Intelligence (real places, routes and times), and the agency conversation on the right.
type Partial_ = ListingCard & Partial<Pick<ListingDetail, 'description' | 'allImages' | 'overview' | 'locationNote' | 'featureGroups' | 'coordinates'>>
const uniqueImages = (list: string[]) => { const seen = new Set<string>(); return list.filter(u => { const k = u.replace(/\/image\/upload\/[^/]*\//, '/image/upload/'); if (seen.has(k)) return false; seen.add(k); return true }) }
const resize = (u: string, w: number) => u.replace(/\/image\/upload\/w_\d+,/, `/image/upload/w_${w},`)

function Mosaic({ images, title }: { images: string[]; title: string }) {
  const [full, setFull] = useState<number | null>(null)
  if (!images.length) return <div className="pd-mosaic empty">No photos yet</div>
  const side = images.slice(1, 5)
  return (
    <div className="pd-mosaic" data-n={Math.min(5, images.length)}>
      <button className="pd-hero" onClick={() => setFull(0)} aria-label={`Open ${images.length} photos full screen`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={resize(images[0], 1600)} srcSet={`${resize(images[0], 960)} 960w, ${resize(images[0], 1600)} 1600w`} sizes="(max-width: 900px) 100vw, 60vw" alt={title} fetchPriority="high" decoding="async" />
      </button>
      {side.map((src, i) => (
        <button key={src} className="pd-thumb" onClick={() => setFull(i + 1)} aria-label={`Photo ${i + 2}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={resize(src, 720)} alt="" loading="lazy" decoding="async" />
          {i === side.length - 1 && images.length > 5 && <span>+{images.length - 5} photos</span>}
        </button>
      ))}
      <button className="pd-all" onClick={() => setFull(0)}><Maximize2 size={14} aria-hidden="true" />All {images.length} photos</button>
      {full !== null && <Viewer images={images.map(u => resize(u, 1600))} start={full} onClose={() => setFull(null)} />}
    </div>
  )
}

export function ListingBody({ l, pro, loading, headingId }: { l: Partial_; pro: boolean; loading?: boolean; headingId?: string }) {
  const images = uniqueImages(l.allImages?.length ? l.allImages : l.images)
  const groups = l.featureGroups || []
  const [more, setMore] = useState(false)
  const desc = l.description || ''
  const long = desc.length > 520
  const chips = [...(l.typeLabel ? [l.typeLabel] : []), ...l.features]
  return (
    <div className="pd">
      <header className="pd-head">
        <div className="pd-head-main">
          <p className="pd-pills"><span className={`mc-pill mc-avail k-${l.availability.kind}`}>{l.availability.label}</span><span className="pd-ref">{l.marketLabel} · Ref {l.id}</span></p>
          <h1 id={headingId}>{l.area}</h1>
          <p className="pd-sub">{l.title}</p>
        </div>
        <div className="pd-head-price">
          <span className="mc-price">{l.price ? <>{eur(l.price)}<small>{l.pricePeriod ? ` / ${l.pricePeriod}` : ''}</small></> : 'Price on request'}</span>
          <span className="pd-facts">
            {!!l.bedrooms && <span><BedDouble size={17} aria-hidden="true" />{l.bedrooms} {l.bedrooms === 1 ? 'Bedroom' : 'Bedrooms'}</span>}
            {!!l.bathrooms && <span><Bath size={17} aria-hidden="true" />{l.bathrooms} {l.bathrooms === 1 ? 'Bathroom' : 'Bathrooms'}</span>}
            {l.size && <span><Ruler size={17} aria-hidden="true" />{l.size} m²</span>}
          </span>
        </div>
      </header>
      <Mosaic images={images} title={l.title} />
      <div className="pd-grid">
        <div className="pd-main">
          {chips.length > 0 && <p className="pd-chips">{chips.map(c => <span key={c}>{c}</span>)}</p>}
          {l.smart.length > 0 && <p className="pd-near">{l.smart.map(s => <span key={s.key}>{s.label} {km(s.km, l.smartFromCentre)}</span>)}</p>}
          {loading && <div className="mp-lines" aria-busy="true"><i /><i /><i /></div>}
          {desc && (
            <section className="pd-sec">
              <h2>About this home</h2>
              <div className="mp-desc" data-clamped={long && !more ? true : undefined}>{desc.split(/\n+/).map((p, k) => <p key={k}>{p}</p>)}</div>
              {long && <button className="mp-link" onClick={() => setMore(m => !m)}>{more ? 'Show less' : 'Read more'}</button>}
            </section>
          )}
          {groups.length > 0 && (
            <section className="pd-sec" id="mp-sec-features">
              <h2>Features</h2>
              <div className="mp-fgroups">{groups.map(g => (
                <div key={g.key}><b>{g.label}</b><ul>{g.items.map(i => <li key={i.key} title={i.source}><Check size={13} aria-hidden="true" />{i.text}<small>{i.source === 'From the listing description' ? 'listing text' : i.source}</small></li>)}</ul></div>
              ))}</div>
            </section>
          )}
          <section className="pd-sec pd-si" id="mp-sec-area">
            <div className="pd-si-head"><span className="pd-kicker">NEXUS Smart Intelligence</span><h2>Life around {l.area}</h2>
              <p className="mp-muted">{l.locationNote} {l.smartFromCentre ? `Distances and routes start from the ${l.area} area point, not from the front door.` : ''}</p></div>
            {l.overview
              ? <PropertyLifeOverview overview={l.overview} description={desc} features={l.features} />
              : l.coordinates ? <AreaMap c={l.coordinates} exact={!l.smartFromCentre} area={l.area} /> : <p className="mp-muted">Area data is loading…</p>}
          </section>
        </div>
        <aside className="pd-side">
          <ProviderBox l={l} />
          {pro && l.provider.kind === 'agency' && <CooperationBox c={l.cooperation} agencyName={l.provider.agency.name} />}
          <ChatPanel l={l} />
        </aside>
      </div>
    </div>
  )
}

// OpenStreetMap view of the area. No pin unless the listing discloses its exact location.
function AreaMap({ c, exact, area }: { c: [number, number]; exact: boolean; area: string }) {
  const [lon, lat] = c
  const bbox = [lon - 0.014, lat - 0.009, lon + 0.014, lat + 0.009].map(n => n.toFixed(5)).join(',')
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${exact ? `&marker=${lat.toFixed(5)},${lon.toFixed(5)}` : ''}`
  return (
    <figure className="mp-map">
      <iframe title={`Map of ${area}`} src={src} loading="lazy" referrerPolicy="no-referrer" />
      <figcaption className="mp-muted small">{exact ? 'Exact location.' : `${area} area. No pin: the exact address follows with a viewing.`} Map © OpenStreetMap contributors.</figcaption>
    </figure>
  )
}

export function ProviderBox({ l }: { l: ListingCard }) {
  if (l.provider.kind === 'owner_direct') return <div className="mp-provider-box"><span className="mp-muted">Listed by</span><b>Direct from owner</b></div>
  if (l.provider.kind !== 'agency') return <div className="mp-provider-box"><span className="mp-muted">Listed by</span><b>Provider being confirmed</b><p className="mp-muted small">The agency behind this listing has not been confirmed yet, so none is named.</p></div>
  const { agency, agent } = l.provider
  return (
    <div className="mp-provider-box" id="mp-sec-provider">
      <span className="mp-muted">Listed by</span>
      <AgencyMark agency={agency} size="md" />
      {agent && <span className="mp-agent"><i aria-hidden="true">{initials(agent.name)}</i>{agent.name}<small>Listing agent</small></span>}
      <p className="mp-muted small">{agency.verifiedBasis}</p>
      {l.otherAgencies.length > 0 && <p className="mp-muted small">Also offered by: {l.otherAgencies.map(a => a.name).join(', ')}</p>}
      <p className="mp-provider-links">
        <a href={`/marketplace?agency=${encodeURIComponent(agency.key)}&market=${l.market}`}>All homes from {agency.name}</a>
        {agency.website && <a href={agency.website} target="_blank" rel="noopener">Website<ExternalLink size={12} aria-hidden="true" /></a>}
      </p>
    </div>
  )
}
