'use client'
// NEXUS STUDIOS Exchange (2026-11-21): the B2B side of the Marketplace.
//  - Co-agency inventory: only listings whose agency has agreed written terms (lib/marketplace/cooperation.ts).
//  - Participating agencies: real identities from the source systems, live listing counts, terms status.
//  - Partner request: an agency asks to join; it lands in ARGUS (nexus_link_interest) for a person to answer.
// Nothing here invents a commission, a partner or a client. Client briefs come later, with their own consent rules.
import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Check, FileSignature, Handshake, Send, ShieldCheck, Users } from 'lucide-react'
import { NexusStar } from '@/components/brand/logo'
import type { Agency, ListingCard } from '@/lib/marketplace/model'
import { AgencyMark, eur } from '../marketplace/parts'

type AgencyRow = { agency: Agency; listings: number; agents: number; markets: string[]; terms: ListingCard['cooperation'] }

export function Exchange() {
  const [all, setAll] = useState<ListingCard[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [mp, setMp] = useState('/marketplace')
  useEffect(() => {
    if (window.location.pathname.startsWith('/studios')) setMp('/studios/marketplace')
    fetch('/api/marketplace/listings').then(r => (r.ok ? r.json() : Promise.reject())).then(d => setAll(d.listings)).catch(() => setFailed(true))
  }, [])
  const agencies = useMemo<AgencyRow[]>(() => {
    const m = new Map<string, { agency: Agency; ids: number; agents: Set<number>; markets: Set<string>; terms: ListingCard['cooperation'] }>()
    for (const l of all || []) {
      if (l.provider.kind !== 'agency') continue
      const k = l.provider.agency.key
      const row = m.get(k) || { agency: l.provider.agency, ids: 0, agents: new Set<number>(), markets: new Set<string>(), terms: l.cooperation }
      row.ids++; if (l.provider.agent) row.agents.add(l.provider.agent.id); row.markets.add(l.marketLabel)
      m.set(k, row)
    }
    return [...m.values()].map(r => ({ agency: r.agency, listings: r.ids, agents: r.agents.size, markets: [...r.markets], terms: r.terms })).sort((a, b) => b.listings - a.listings)
  }, [all])
  const shared = useMemo(() => (all || []).filter(l => l.cooperation.status === 'confirmed'), [all])

  return (
    <div className="mp ex">
      <header className="mp-top">
        <a className="st-brand" href="/" aria-label="NEXUS STUDIOS home"><NexusStar size={18} className="st-star" />NEXUS <b>STUDIOS</b></a>
        <nav className="mp-tabs" aria-label="Sections">
          <a href={mp}>Homes</a>
          <a aria-current="page" href="#">Exchange</a>
        </nav>
      </header>

      <section className="ex-hero">
        <p className="ex-kicker"><Handshake size={16} aria-hidden="true" />Exchange · early access</p>
        <h1>Work listings together, on terms agreed in writing.</h1>
        <p className="ex-lead">Agencies share homes with other agencies once both sides have agreed the split, what it is calculated on and when it is due. Until then NEXUS shows no figure at all.</p>
      </section>

      <section className="ex-rules" aria-label="How the Exchange works">
        <div><FileSignature size={18} aria-hidden="true" /><b>Terms first</b><p>Each agency publishes its co-agency terms once, in writing: the percentage, its basis (for example, of the agency fee excluding VAT), who pays and when.</p></div>
        <div><ShieldCheck size={18} aria-hidden="true" /><b>Real identities</b><p>Every listing names the agency and the listing agent from the agency’s own system. No anonymous re-posting, no scraped inventory.</p></div>
        <div><Users size={18} aria-hidden="true" /><b>Clients stay private</b><p>Owner and client details are never part of a shared listing. Introductions happen agency to agency.</p></div>
      </section>

      <section className="ex-block" aria-labelledby="ex-shared">
        <div className="ex-head"><h2 id="ex-shared">Open for co-agency</h2>{all && <span className="mp-muted">{shared.length} {shared.length === 1 ? 'listing' : 'listings'}</span>}</div>
        {failed ? <p className="mp-empty">The Exchange is not available right now.</p>
          : !all ? <div className="ex-skel" aria-busy="true" />
          : shared.length === 0 ? (
            <div className="ex-empty">
              <Handshake size={22} aria-hidden="true" />
              <div><b>No agency has published co-agency terms yet.</b>
                <p className="mp-muted">Listings appear here only after their agency has agreed the terms in writing. The {all.length} homes in the Marketplace can still be viewed and enquired about. Ask the listing agency directly.</p></div>
              <a className="ex-btn quiet" href={`${mp}?market=longlets`}>Browse the Marketplace<ArrowUpRight size={15} aria-hidden="true" /></a>
            </div>
          ) : (
            <ul className="ex-shared">{shared.map(l => l.cooperation.status === 'confirmed' && (
              <li key={l.id}><a href={`${mp}/home/${encodeURIComponent(l.id)}`}><b>{l.title}</b><span>{l.price ? eur(l.price) : 'Price on request'} · Ref {l.id}</span><span className="ex-terms">{l.cooperation.headline}</span></a></li>))}</ul>
          )}
      </section>

      <section className="ex-block" aria-labelledby="ex-agencies">
        <div className="ex-head"><h2 id="ex-agencies">Agencies in the Marketplace</h2></div>
        {all && agencies.length > 0 && (
          <ul className="ex-agencies">{agencies.map(r => (
            <li key={r.agency.key}>
              <AgencyMark agency={r.agency} size="md" />
              <p className="mp-muted small">{r.agency.verifiedBasis} {r.agency.island}.</p>
              <dl>
                <div><dt>Live listings</dt><dd>{r.listings}</dd></div>
                <div><dt>Listing agents</dt><dd>{r.agents}</dd></div>
                <div><dt>Markets</dt><dd>{r.markets.join(', ')}</dd></div>
                <div><dt>Co-agency terms</dt><dd>{r.terms.status === 'confirmed' ? <span className="ex-ok"><Check size={13} aria-hidden="true" />{r.terms.headline}</span> : 'Not published'}</dd></div>
              </dl>
              <p className="ex-links"><a href={`${mp}?agency=${encodeURIComponent(r.agency.key)}`}>See listings</a>{r.agency.website && <a href={r.agency.website} target="_blank" rel="noopener">Website</a>}</p>
            </li>))}</ul>
        )}
      </section>

      {/* The partner request form (below) stays off until staff can see and answer requests in the CRM. */}
      <section className="ex-block ex-join" aria-labelledby="ex-join">
        <div className="ex-head"><h2 id="ex-join">Join as an agency</h2></div>
        <p className="mp-muted">Agency access opens together with verified agency profiles. Every agency is checked before its listings appear, and nothing is shared until its terms are agreed in writing.</p>
      </section>

      <footer className="mp-foot">The Exchange bills nothing automatically. A fee is due only under written terms that both sides have accepted.</footer>
    </div>
  )
}

export function PartnerRequest() {
  const [agencyName, setAgencyName] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [licence, setLicence] = useState('')
  const [message, setMessage] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [err, setErr] = useState('')
  const send = async () => {
    setState('sending'); setErr('')
    try {
      const r = await fetch('/api/nexus/interest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email: email.trim(), developmentId: null, developmentName: null, market: 'all',
        criteria: { kind: 'agency_partner_request', requesterRole: 'agency', agencyName: agencyName.trim().slice(0, 160), website: website.trim().slice(0, 200), licence: licence.trim().slice(0, 80), message: message.slice(0, 700), source: 'studios_exchange' },
      }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The request could not be saved.')
      setState('sent')
    } catch (e) { setErr((e as Error).message); setState('error') }
  }
  if (state === 'sent') return <div className="ex-sent"><Check size={20} aria-hidden="true" /><div><b>Request received</b><p className="mp-muted">A person from NEXUS answers by e-mail. Nothing is published until your agency has confirmed its listings and terms.</p></div></div>
  return (
    <>
      <div className="ex-head"><h2 id="ex-join">Join as an agency</h2></div>
      <p className="mp-muted">For licensed estate agencies in Malta and Gozo. We check every agency before its listings appear.</p>
      <form className="ex-form" onSubmit={e => { e.preventDefault(); send() }}>
        <label>Agency name<input required value={agencyName} onChange={e => setAgencyName(e.target.value)} autoComplete="organization" /></label>
        <label>Work e-mail<input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Website<input type="url" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://" /></label>
        <label>Estate agent licence no. <small>(optional)</small><input value={licence} onChange={e => setLicence(e.target.value)} /></label>
        <label className="wide">Message<textarea rows={3} maxLength={700} value={message} onChange={e => setMessage(e.target.value)} placeholder="How many listings, which areas, how you work with other agencies today" /></label>
        {err && <p className="mp-err wide">{err}</p>}
        <button className="mp-send wide" disabled={state === 'sending' || !email.includes('@') || !agencyName.trim()}><Send size={16} aria-hidden="true" />{state === 'sending' ? 'Sending…' : 'Request access'}</button>
      </form>
    </>
  )
}
