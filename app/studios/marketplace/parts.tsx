'use client'
// Shared Marketplace pieces (2026-11-21): agency identity, gallery with full-screen viewer, the listing body
// (used by the overlay on the list and by the stand-alone page), co-agency terms and the enquiry form.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bath, BedDouble, Check, ChevronLeft, ChevronRight, ExternalLink, Handshake, MapPin, Maximize2, Ruler, Send, ShieldCheck, X } from 'lucide-react'
import type { Agency, Cooperation, ListingCard, ListingDetail } from '@/lib/marketplace/model'

export const eur = (n: number) => `€${n.toLocaleString('en-GB')}`

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

// ---- listing body: shared by the overlay and the stand-alone page ---------------------------------------
type Partial_ = ListingCard & Partial<Pick<ListingDetail, 'description' | 'allImages' | 'overview' | 'locationNote'>>
export function ListingBody({ l, pro, loading, headingId }: { l: Partial_; pro: boolean; loading?: boolean; headingId?: string }) {
  const images = l.allImages?.length ? l.allImages : l.images
  const unconfirmed = l.features.filter(x => !l.evidenced.some(e => e.text === x))
  return (
    <>
      <Gallery images={images} title={l.title} />
      <div className="mp-detail-grid">
        <section>
          <span className={`mp-avail k-${l.availability.kind} inline`}>{l.availability.label}</span>
          <h1 id={headingId}>{l.title}</h1>
          <p className="mp-where"><MapPin size={16} aria-hidden="true" />{l.area} · {l.marketLabel} · Ref {l.id}</p>
          <div className="mp-price big">{l.price ? <>{eur(l.price)}<small>{l.pricePeriod ? ` / ${l.pricePeriod}` : ''}</small></> : 'Price on request'}</div>
          <p className="mp-facts big">
            {!!l.bedrooms && <span><BedDouble size={17} aria-hidden="true" />{l.bedrooms} bedrooms</span>}
            {!!l.bathrooms && <span><Bath size={17} aria-hidden="true" />{l.bathrooms} bathrooms</span>}
            {l.size && <span><Ruler size={17} aria-hidden="true" />{l.size} m²</span>}
          </p>
          {l.evidenced.length > 0 && (
            <div className="mp-evidence"><b>Confirmed features</b>{l.evidenced.map(e => <span key={e.key} data-e={e.evidence}><Check size={13} aria-hidden="true" />{e.text}<small>{e.evidenceLabel}</small></span>)}</div>
          )}
          {unconfirmed.length > 0 && <div className="mp-chips-wrap"><b className="mp-muted small">From the listing description</b><p className="mp-chips">{unconfirmed.map(x => <span key={x}>{x}</span>)}</p></div>}
          {loading && <div className="mp-lines" aria-busy="true"><i /><i /><i /></div>}
          {l.description && <div className="mp-desc">{l.description.split(/\n+/).map((p, k) => <p key={k}>{p}</p>)}</div>}
          {l.overview && (
            <section className="mp-smartbox">
              <h2>Around {l.area}</h2>
              <p className="mp-muted">{l.locationNote} Distances start from the area centre.</p>
              <ul className="mp-adv">{l.overview.advantages.map(a => <li key={a}>{a}</li>)}</ul>
              <div className="mp-cats">
                {l.overview.categories.filter(c => ['groceries', 'coast', 'health', 'movement', 'school'].includes(c.key) && c.places.length).map(c => (
                  <div key={c.key}><b>{c.label}</b>{c.places.slice(0, 3).map(p => <span key={p.id}>{p.name} <em>{p.distanceKm.toFixed(1)} km</em></span>)}</div>
                ))}
              </div>
              {l.overview.considerations.length > 0 && <ul className="mp-cons">{l.overview.considerations.map(a => <li key={a}>{a}</li>)}</ul>}
            </section>
          )}
        </section>
        <aside>
          <ProviderBox l={l} />
          {pro && l.provider.kind === 'agency' && <CooperationBox c={l.cooperation} agencyName={l.provider.agency.name} />}
          {!loading && <Enquiry l={l} />}
        </aside>
      </div>
    </>
  )
}

export function ProviderBox({ l }: { l: ListingCard }) {
  if (l.provider.kind !== 'agency') return <div className="mp-provider-box"><span className="mp-muted">Listed by</span><b>Direct from owner</b></div>
  const { agency, agent } = l.provider
  return (
    <div className="mp-provider-box">
      <span className="mp-muted">Listed by</span>
      <AgencyMark agency={agency} size="md" />
      {agent && <span className="mp-agent"><i aria-hidden="true">{initials(agent.name)}</i>{agent.name}<small>Listing agent</small></span>}
      <p className="mp-muted small">{agency.verifiedBasis}</p>
      <p className="mp-provider-links">
        <a href={`/marketplace?agency=${encodeURIComponent(agency.key)}&market=${l.market}`}>All homes from {agency.name}</a>
        {agency.website && <a href={agency.website} target="_blank" rel="noopener">Website<ExternalLink size={12} aria-hidden="true" /></a>}
      </p>
    </div>
  )
}

// ---- enquiry: the existing SmartTunnel (/api/nexus/interest) into ARGUS --------------------------------
export function Enquiry({ l }: { l: ListingCard }) {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [role, setRole] = useState<'home-seeker' | 'agent'>('home-seeker')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [err, setErr] = useState('')
  const far = l.availability.kind === 'from' && l.availability.from && new Date(l.availability.from).getTime() > Date.now() + 92 * 86400e3
  const send = async () => {
    setState('sending'); setErr('')
    try {
      const r = await fetch('/api/nexus/interest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email: email.trim(), developmentId: null, developmentName: null, market: l.market,
        criteria: { kind: 'smart_tunnel', propertyRef: l.id, propertyTitle: l.title, requesterRole: role, contactRoute: 'email', message: message.slice(0, 700), scheduling: { window: 'none', preferredDate: null } },
      }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The request could not be saved.')
      setState('sent')
    } catch (e) { setErr((e as Error).message); setState('error') }
  }
  if (state === 'sent') return <div className="mp-enquiry sent"><Check size={20} /><b>Request saved</b><p>The agency answers by e-mail. Nothing is booked yet.</p></div>
  return (
    <form className="mp-enquiry" onSubmit={e => { e.preventDefault(); send() }}>
      <b>Ask about this home</b>
      {far ? <p className="mp-muted">Enquiries open three months before it becomes available.</p> : <>
        <div className="mp-seg small" role="group" aria-label="I am">
          <button type="button" aria-pressed={role === 'home-seeker'} onClick={() => setRole('home-seeker')}>Looking for myself</button>
          <button type="button" aria-pressed={role === 'agent'} onClick={() => setRole('agent')}>Agent for a client</button>
        </div>
        <label>E-mail<input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Message<textarea rows={4} maxLength={700} value={message} onChange={e => setMessage(e.target.value)} placeholder="When would you like to move in? How many people?" /></label>
        {err && <p className="mp-err">{err}</p>}
        <button className="mp-send" disabled={state === 'sending' || !email.includes('@')}><Send size={16} />{state === 'sending' ? 'Sending…' : 'Send request'}</button>
        <p className="mp-muted small">Your e-mail goes only to the listing agency.</p>
      </>}
    </form>
  )
}
