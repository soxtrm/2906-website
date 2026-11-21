'use client'
// One listing: gallery, facts, availability, provider, what is nearby (Smart Intelligence), enquiry.
// The enquiry goes through the existing SmartTunnel (/api/nexus/interest) into ARGUS; nothing is promised
// that the agency has not confirmed.
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bath, BedDouble, Check, ChevronLeft, ChevronRight, MapPin, Ruler, Send } from 'lucide-react'
import { NexusStar } from '@/components/brand/logo'
import type { ListingDetail } from '@/lib/marketplace/model'

const eur = (n: number) => `€${n.toLocaleString('en-GB')}`

export function ListingView({ id }: { id: string }) {
  const [l, setL] = useState<ListingDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [i, setI] = useState(0)
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    fetch(`/api/marketplace/listings?id=${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(d => setL(d.listing)).catch(() => setMissing(true))
  }, [id])
  const go = (d: number) => { const el = strip.current; if (!el || !l) return; const n = Math.max(0, Math.min(l.allImages.length - 1, i + d)); el.scrollTo({ left: n * el.clientWidth, behavior: 'smooth' }) }
  const back = () => { if (window.history.length > 1 && document.referrer.includes(window.location.host)) window.history.back(); else window.location.href = '/marketplace' }

  return (
    <div className="mp mp-detail">
      <header className="mp-top">
        <a className="st-brand" href="/" aria-label="NEXUS STUDIOS home"><NexusStar size={18} className="st-star" />NEXUS <b>STUDIOS</b></a>
        <button className="mp-back" onClick={back}><ArrowLeft size={16} aria-hidden="true" />All homes</button>
      </header>
      {missing ? <p className="mp-empty">This home is no longer listed. <a className="mp-link" href="/marketplace">See all homes</a></p>
        : !l ? <div className="mp-card mp-skel mp-skel-big" aria-busy="true" />
        : <>
          <div className="mp-gallery">
            <div className="mp-strip" ref={strip} onScroll={e => setI(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {l.allImages.map((src, k) => <img key={src} src={src} alt={k === 0 ? l.title : ''} loading={k < 2 ? 'eager' : 'lazy'} decoding="async" />)}
            </div>
            {l.allImages.length > 1 && <>
              <button className="mp-nav l" onClick={() => go(-1)} disabled={i === 0} aria-label="Previous photo"><ChevronLeft size={20} /></button>
              <button className="mp-nav r" onClick={() => go(1)} disabled={i >= l.allImages.length - 1} aria-label="Next photo"><ChevronRight size={20} /></button>
              <span className="mp-count-badge">{i + 1} / {l.allImages.length}</span>
            </>}
          </div>
          <div className="mp-detail-grid">
            <section>
              <span className={`mp-avail k-${l.availability.kind} inline`}>{l.availability.label}</span>
              <h1>{l.title}</h1>
              <p className="mp-where"><MapPin size={16} aria-hidden="true" />{l.area} · {l.marketLabel} · Ref {l.id}</p>
              <div className="mp-price big">{l.price ? <>{eur(l.price)}<small>{l.pricePeriod ? ` / ${l.pricePeriod}` : ''}</small></> : 'Price on request'}</div>
              <p className="mp-facts big">
                {!!l.bedrooms && <span><BedDouble size={17} aria-hidden="true" />{l.bedrooms} bedrooms</span>}
                {!!l.bathrooms && <span><Bath size={17} aria-hidden="true" />{l.bathrooms} bathrooms</span>}
                {l.size && <span><Ruler size={17} aria-hidden="true" />{l.size} m²</span>}
              </p>
              {l.features.length > 0 && <p className="mp-chips">{l.features.map(x => <span key={x}><Check size={13} aria-hidden="true" />{x}</span>)}</p>}
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
              <div className="mp-provider-box">
                <span className="mp-muted">Listed by</span>
                {l.provider.kind === 'agency' ? <>
                  <b>{l.provider.agency.name}{l.provider.agency.verified && <span className="mp-badge"><Check size={12} />Verified agency</span>}</b>
                  {l.provider.agent && <span>Agent: {l.provider.agent.name}</span>}
                </> : <b>Direct from owner</b>}
              </div>
              <Enquiry l={l} />
            </aside>
          </div>
        </>}
    </div>
  )
}

function Enquiry({ l }: { l: ListingDetail }) {
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
