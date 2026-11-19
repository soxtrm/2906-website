'use client'
// The real SYNC workspace (nexussync.one): the owner's homes as ARGUS holds them,
// viewings from the ARGUS booking, viewing hours, sharing, and proposals that an
// agent approves. Big type, big buttons, few choices per screen.
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { BedDouble, Bath, CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Home, MapPin, MessageCircle, Pencil, Share2, Sparkles, UsersRound, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { liveProperties, pendingClaims, type LiveListing, type LiveViewing } from '@/lib/owner/live'

// ── helpers ─────────────────────────────────────────────────────────────────
const eur = (n: number | null | undefined) => (n == null ? '' : `€${Math.round(n).toLocaleString('en-GB')}`)
const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Malta' })
const fmtTime = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Malta' })
const typeName = (t: string | null | undefined) => (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ') : 'Home')
export const homeName = (l: LiveListing) => l.state?.nickname || `${typeName(l.facts.type)} in ${l.facts.locality || 'Malta'}`

const AVAIL: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  available: { label: 'Available', tone: 'ok' }, available_confirmed: { label: 'Available', tone: 'ok' }, upcoming: { label: 'Available soon', tone: 'ok' },
  not_available: { label: 'Not available', tone: 'muted' }, rented: { label: 'Rented', tone: 'muted' }, pending_check: { label: 'Being checked', tone: 'warn' },
  reserved: { label: 'Reserved', tone: 'warn' },
}
const UPDATE: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  pending: { label: 'Change waiting for approval', tone: 'warn' }, approved: { label: 'Change approved', tone: 'ok' },
  rejected: { label: 'Change not taken', tone: 'muted' }, superseded: { label: 'Replaced by a newer change', tone: 'muted' },
}
function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'muted' | 'accent'; children: React.ReactNode }) {
  return <span className="lv-pill" data-tone={tone}>{children}</span>
}

function useHomes() {
  const s = useOwner()
  return useMemo(() => liveProperties(s.live.owner), [s.live.owner])
}

// ── property card ───────────────────────────────────────────────────────────
export function HomeCard({ l, big = false }: { l: LiveListing; big?: boolean }) {
  const a = AVAIL[l.state?.availability || ''] || null
  const up = l.state?.update && l.state.update.state === 'pending' ? UPDATE.pending : null
  const price = l.facts.rent ? `${eur(l.facts.rent)} / month` : l.facts.sale ? eur(l.facts.sale) : ''
  return (
    <Link href={`/owner/properties/${l.sourcePropertyId}`} className="lv-card" data-big={big}>
      <span className="lv-card-photo">{l.facts.photos[0] ? <img src={l.facts.photos[0]} alt="" loading="lazy" /> : <span className="lv-nophoto"><Home size={56} /></span>}</span>
      <span className="lv-card-body">
        <span className="lv-card-top">{a && <Pill tone={a.tone}>{a.label}</Pill>}{up && <Pill tone="warn">{up.label}</Pill>}</span>
        <b className="lv-card-name">{homeName(l)}</b>
        <span className="lv-card-place"><MapPin size={16} aria-hidden="true" />{l.facts.locality || '—'}</span>
        <span className="lv-card-facts">
          {l.facts.bedrooms != null && <span><BedDouble size={16} aria-hidden="true" />{l.facts.bedrooms}</span>}
          {l.facts.bathrooms != null && <span><Bath size={16} aria-hidden="true" />{l.facts.bathrooms}</span>}
          <span className="lv-ref">Ref {l.ref}</span>
        </span>
        {price && <span className="lv-card-price">{price}</span>}
      </span>
    </Link>
  )
}

// ── viewing request row ─────────────────────────────────────────────────────
function ViewingRow({ v, home }: { v: LiveViewing; home?: LiveListing }) {
  const s = useOwner()
  const [busy, setBusy] = useState(false)
  const [propose, setPropose] = useState(false)
  const [when, setWhen] = useState('')
  const at = new Date(v.startsAt)
  const future = at.getTime() > Date.now()
  const who = [v.party.size ? `${v.party.size} ${v.party.size === 1 ? 'person' : 'people'}` : null, v.party.type, v.party.job].filter(Boolean).join(' · ')
  const act = async (decision: 'accept' | 'decline' | 'propose') => {
    setBusy(true)
    await s.liveDo('owner/viewings/decide', { viewingId: v.id, decision, proposeStart: decision === 'propose' ? new Date(when).toISOString() : undefined },
      decision === 'accept' ? 'Accepted. The agent sees it at once.' : decision === 'propose' ? 'Sent. The agent sees your suggested time.' : 'Declined.')
    setBusy(false); setPropose(false)
  }
  const state = v.status === 'confirmed' ? <Pill tone="ok">Confirmed</Pill> : v.status === 'pending' ? <Pill tone="warn">Waiting for you</Pill> : v.decision === 'declined' ? <Pill tone="muted">Declined</Pill> : <Pill tone="muted">{v.status}</Pill>
  return (
    <article className="lv-viewing" data-pending={v.status === 'pending' && future}>
      <div className="lv-viewing-when"><b>{fmtDay(at)}</b><span>{fmtTime(at)}</span><small>{v.durationMin} min</small></div>
      <div className="lv-viewing-main">
        <div className="lv-viewing-top">{state}<span className="lv-faint">{home ? homeName(home) : `Ref ${v.ref}`}</span></div>
        {who && <p><UsersRound size={16} aria-hidden="true" /> {who}</p>}
        {v.agent && <p className="lv-faint">Agent: {v.agent}</p>}
        {v.note && <p className="lv-faint">“{v.note}”</p>}
        {v.declineText && <p className="lv-faint">{v.declineText}</p>}
        {v.status === 'pending' && future && !propose && (
          <div className="lv-actions">
            <button className="lv-btn ok" disabled={busy} onClick={() => act('accept')}><Check size={20} />Accept</button>
            <button className="lv-btn" disabled={busy} onClick={() => setPropose(true)}><Clock size={20} />Other time</button>
            <button className="lv-btn quiet" disabled={busy} onClick={() => act('decline')}><X size={20} />Decline</button>
          </div>
        )}
        {propose && (
          <div className="lv-actions">
            <input type="datetime-local" className="lv-input" value={when} onChange={e => setWhen(e.target.value)} aria-label="Suggested time" />
            <button className="lv-btn ok" disabled={busy || !when} onClick={() => act('propose')}>Send</button>
            <button className="lv-btn quiet" onClick={() => setPropose(false)}>Back</button>
          </div>
        )}
      </div>
    </article>
  )
}

function Waiting() {
  const s = useOwner()
  const claims = pendingClaims(s.live.owner)
  if (!claims.length) return null
  return (
    <section className="lv-note">
      <Sparkles size={22} aria-hidden="true" />
      <div><b>An agent is confirming your homes</b><p>ARGUS found {claims.flatMap(c => c.proposed || []).length} home(s) under your number. They appear here once an agent has confirmed you are the owner.</p></div>
    </section>
  )
}

// ── overview ────────────────────────────────────────────────────────────────
export function LiveOverview() {
  const s = useOwner()
  const homes = useHomes()
  const pending = s.live.viewings.filter(v => v.status === 'pending' && new Date(v.startsAt) > new Date())
  const next = s.live.viewings.filter(v => v.status === 'confirmed' && new Date(v.startsAt) > new Date()).slice(0, 3)
  const unread = s.threads.reduce((n, t) => n + t.unread, 0)
  const first = (s.live.account?.name || s.profile.name || '').split(' ')[0]
  if (!s.live.ready) return <p className="lv-faint">Loading…</p>
  if (!s.live.account) return (
    <section className="lv-hero">
      <h1>Your homes, in one place</h1>
      <p>Sign in with your mobile number. No password needed.</p>
      <div className="lv-actions"><Link className="lv-btn ok big" href="/owner/login">Sign in</Link><Link className="lv-btn big" href="/owner/signup">Create account</Link></div>
    </section>
  )
  return (
    <div className="lv">
      <header className="lv-hello">
        <h1>{first ? `Hello, ${first}` : 'Hello'}</h1>
        <p>{homes.length ? `${homes.length} home${homes.length === 1 ? '' : 's'} · ${pending.length ? `${pending.length} request${pending.length === 1 ? '' : 's'} waiting` : 'nothing waiting'}` : 'Add a home or confirm your mobile.'}</p>
      </header>
      <Waiting />
      <div className="lv-quick">
        <Link href="/owner/requests" className="lv-quick-tile" data-hot={pending.length > 0}><CalendarDays size={24} /><b>{pending.length}</b><span>Requests</span></Link>
        <Link href="/owner/messages" className="lv-quick-tile" data-hot={unread > 0}><MessageCircle size={24} /><b>{unread}</b><span>Messages</span></Link>
        <Link href="/owner/calendar" className="lv-quick-tile"><Clock size={24} /><b>{next.length}</b><span>Viewings</span></Link>
      </div>
      {pending.length > 0 && (
        <section className="lv-section">
          <h2>Waiting for your answer</h2>
          {pending.map(v => <ViewingRow key={v.id} v={v} home={homes.find(h => h.sourcePropertyId === v.propertyId)} />)}
        </section>
      )}
      <section className="lv-section">
        <div className="lv-section-head"><h2>My homes</h2><Link href="/owner/add" className="lv-link">+ Add home</Link></div>
        <div className="lv-cards">{homes.map(l => <HomeCard key={l.externalId} l={l} big />)}</div>
        {!homes.length && <p className="lv-faint">No confirmed homes yet.</p>}
      </section>
      {next.length > 0 && (
        <section className="lv-section">
          <h2>Coming up</h2>
          {next.map(v => <ViewingRow key={v.id} v={v} home={homes.find(h => h.sourcePropertyId === v.propertyId)} />)}
        </section>
      )}
    </div>
  )
}

export function LiveProperties() {
  const homes = useHomes()
  return (
    <div className="lv">
      <header className="lv-hello"><h1>My homes</h1><p>Tap a home to change its details, availability, price, sharing and viewing hours.</p></header>
      <Waiting />
      <div className="lv-cards">{homes.map(l => <HomeCard key={l.externalId} l={l} big />)}</div>
      <Link href="/owner/add" className="lv-btn big wide">+ Add a home</Link>
    </div>
  )
}

// ── one home ────────────────────────────────────────────────────────────────
const CHANNELS: { id: string; label: string; hint: string }[] = [
  { id: 'origin_agency', label: '2906 Real Estate', hint: 'Your agency in ARGUS' },
  { id: 'all_eligible_agencies', label: 'All approved agencies', hint: 'Every agency connected to ARGUS' },
  { id: 'nexus_direct_from_owner', label: 'NEXUS Direct', hint: 'Shown on NEXUS as from the owner' },
]
const SCOPES = ['listing_data', 'photos', 'availability', 'viewing_schedule']

export function LiveProperty({ id }: { id: number }) {
  const s = useOwner()
  const homes = useHomes()
  const l = homes.find(h => h.sourcePropertyId === id)
  const [photo, setPhoto] = useState(0)
  const [tab, setTab] = useState<'status' | 'edit' | 'share' | 'hours'>(() => {
    const t = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('tab')
    return t === 'share' || t === 'edit' || t === 'hours' ? t : 'status'
  })
  const [nick, setNick] = useState<string | null>(null)
  const [rent, setRent] = useState<string | null>(null)
  const [desc, setDesc] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [busy, setBusy] = useState(false)
  if (!s.live.ready) return <p className="lv-faint">Loading…</p>
  if (!l) return <div className="lv"><p>This home is not confirmed for your account.</p><Link className="lv-btn" href="/owner/properties">Back to my homes</Link></div>
  const photos = l.facts.photos
  const st = l.state
  const nextVersion = (st?.update?.version || 0) + 1
  const ev = async (eventType: string, data: Record<string, unknown>, ok: string) => {
    setBusy(true)
    await s.liveDo('owner/event', { eventType, data: { externalId: l.externalId, ...data } }, ok)
    setBusy(false)
  }
  const shared = (ch: string) => !!st?.sharing.some(g => g.channel === ch)
  const viewings = s.live.viewings.filter(v => v.propertyId === id)

  return (
    <div className="lv lv-detail">
      <Link href="/owner/properties" className="lv-back"><ChevronLeft size={20} />My homes</Link>
      <div className="lv-gallery">
        {photos.length ? <img src={photos[photo % photos.length]} alt="" /> : <span className="lv-nophoto"><Home size={80} /></span>}
        {photos.length > 1 && <>
          <button className="lv-gal-btn l" aria-label="Previous photo" onClick={() => setPhoto(p => (p - 1 + photos.length) % photos.length)}><ChevronLeft size={22} /></button>
          <button className="lv-gal-btn r" aria-label="Next photo" onClick={() => setPhoto(p => (p + 1) % photos.length)}><ChevronRight size={22} /></button>
          <span className="lv-gal-count">{(photo % photos.length) + 1} / {photos.length}</span>
        </>}
      </div>
      <header className="lv-detail-head">
        <h1>{homeName(l)}</h1>
        <p className="lv-detail-place"><MapPin size={18} aria-hidden="true" />{l.facts.locality} · Ref {l.ref}</p>
        <p className="lv-detail-facts">
          {typeName(l.facts.type)}{l.facts.bedrooms != null ? ` · ${l.facts.bedrooms} bedroom${l.facts.bedrooms === 1 ? '' : 's'}` : ''}{l.facts.bathrooms != null ? ` · ${l.facts.bathrooms} bath` : ''}
          {l.facts.rent ? ` · ${eur(l.facts.rent)}/month` : l.facts.sale ? ` · ${eur(l.facts.sale)}` : ''}
        </p>
        {st?.update && UPDATE[st.update.state] && <Pill tone={UPDATE[st.update.state].tone}>{UPDATE[st.update.state].label}</Pill>}
      </header>

      <div className="lv-tabs" role="tablist">
        {([['status', 'Availability'], ['edit', 'Details & price'], ['share', 'Sharing'], ['hours', 'Viewings']] as const).map(([k, t]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>

      {tab === 'status' && (
        <section className="lv-section">
          <h2>Is it free?</h2>
          <p className="lv-faint">Now: {(AVAIL[st?.availability || ''] || { label: st?.availability || 'unknown' }).label}. ARGUS updates the listing; “Rented” is checked by an agent first.</p>
          <div className="lv-big-choices">
            <button className="lv-choice ok" disabled={busy} onClick={() => ev('availability.answered', { outcome: 'available' }, 'Thank you. Marked as available.')}><Check size={22} />Available now</button>
            <div className="lv-choice-row">
              <input type="date" className="lv-input" value={from} onChange={e => setFrom(e.target.value)} aria-label="Free from" />
              <button className="lv-choice" disabled={busy || !from} onClick={() => ev('availability.answered', { outcome: 'available_from', availableFrom: from }, 'Saved: free from that day.')}>Free from this date</button>
            </div>
            <button className="lv-choice" disabled={busy} onClick={() => ev('availability.answered', { outcome: 'reserved' }, 'Marked as reserved.')}>Reserved</button>
            <button className="lv-choice" disabled={busy} onClick={() => ev('availability.answered', { outcome: 'rented' }, 'Sent. An agent confirms it is rented.')}>Rented</button>
          </div>
        </section>
      )}

      {tab === 'edit' && (
        <section className="lv-section">
          <h2>Your name for this home</h2>
          <p className="lv-faint">Only you see it.</p>
          <div className="lv-row">
            <input className="lv-input" placeholder={`${typeName(l.facts.type)} in ${l.facts.locality}`} value={nick ?? st?.nickname ?? ''} onChange={e => setNick(e.target.value)} />
            <button className="lv-btn ok" disabled={busy || nick === null} onClick={async () => { setBusy(true); await s.liveDo('prefs', { prefs: { nicknames: { [id]: nick || '' } } }, 'Name saved.'); setNick(null); setBusy(false) }}>Save</button>
          </div>
          <h2>Price and description</h2>
          <p className="lv-faint">Changes go to your agent for approval. The listing changes once approved.</p>
          {l.facts.rent != null || !l.facts.sale ? (
            <div className="lv-field"><label htmlFor="lv-rent">Rent per month (€)</label><input id="lv-rent" className="lv-input" inputMode="numeric" value={rent ?? String(l.facts.rent ?? '')} onChange={e => setRent(e.target.value.replace(/\D/g, ''))} /></div>
          ) : (
            <div className="lv-field"><label htmlFor="lv-sale">Sale price (€)</label><input id="lv-sale" className="lv-input" inputMode="numeric" value={rent ?? String(l.facts.sale ?? '')} onChange={e => setRent(e.target.value.replace(/\D/g, ''))} /></div>
          )}
          <div className="lv-field"><label htmlFor="lv-desc">Description</label><textarea id="lv-desc" className="lv-input" rows={4} maxLength={4000} placeholder="What makes it nice to live in?" value={desc ?? ''} onChange={e => setDesc(e.target.value)} /></div>
          <button className="lv-btn ok big wide" disabled={busy || (rent === null && !desc)} onClick={async () => {
            const fields: Record<string, unknown> = {}
            if (rent) fields[l.facts.rent != null || !l.facts.sale ? 'rent' : 'sale'] = Number(rent)
            if (desc) fields.description = desc
            await ev('property.owner_updated', { version: nextVersion, fields }, 'Sent to your agent for approval.'); setRent(null); setDesc(null)
          }}><Pencil size={18} />Send for approval</button>
          {st?.update && <p className="lv-faint">Last change: {Object.keys(st.update.fields).join(', ')} · {(UPDATE[st.update.state] || { label: st.update.state }).label}</p>}
        </section>
      )}

      {tab === 'share' && (
        <section className="lv-section">
          <h2>Who may offer this home?</h2>
          <p className="lv-faint">Only for this home. Switch off everything to keep it private.</p>
          <div className="lv-share">
            {CHANNELS.map(c => (
              <label key={c.id} className="lv-switch">
                <span><b>{c.label}</b><small>{c.hint}</small></span>
                <input type="checkbox" checked={shared(c.id)} disabled={busy} onChange={e => e.target.checked
                  ? ev('distribution.granted', { channel: c.id, scopes: SCOPES }, `${c.label} may now offer it.`)
                  : ev('distribution.revoked', { channel: c.id, audienceRef: '' }, `${c.label} removed.`)} />
              </label>
            ))}
          </div>
          {st && st.sharing.length > 0 && <button className="lv-btn quiet" disabled={busy} onClick={() => ev('distribution.revoked', {}, 'Private now. Nobody new can offer it.')}><Share2 size={18} />Make private</button>}
        </section>
      )}

      {tab === 'hours' && (
        <section className="lv-section">
          <HoursEditor propertyId={id} windows={st?.windows || []} />
          <h2>Viewings for this home</h2>
          {viewings.length ? viewings.map(v => <ViewingRow key={v.id} v={v} home={l} />) : <p className="lv-faint">No viewings yet.</p>}
        </section>
      )}
    </div>
  )
}

// ── viewing hours ───────────────────────────────────────────────────────────
function maltaIso(date: string, time: string) {
  // Malta is UTC+1 in winter, UTC+2 in summer; ask the browser what that day's offset is in Malta
  const guess = new Date(`${date}T${time}:00Z`)
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(guess)
  const h = Number(parts.find(p => p.type === 'hour')?.value), m = Number(parts.find(p => p.type === 'minute')?.value)
  const offsetMin = ((h * 60 + m) - guess.getUTCHours() * 60 - guess.getUTCMinutes() + 1440) % 1440
  return new Date(guess.getTime() - offsetMin * 60e3).toISOString()
}
const isoDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(d)

export function HoursEditor({ propertyId, windows }: { propertyId: number; windows: { id: number; start: string; end: string }[] }) {
  const s = useOwner()
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => new Date(Date.now() + i * 86400e3)), [])
  const [picked, setPicked] = useState<string[]>([])
  const [start, setStart] = useState('16:00')
  const [end, setEnd] = useState('19:00')
  const [busy, setBusy] = useState(false)
  const byDay = (d: string) => windows.filter(w => isoDay(new Date(w.start)) === d)
  const save = async (block: boolean) => {
    if (!picked.length) return
    setBusy(true)
    await s.liveDo('owner/hours', { propertyId, days: picked.map(d => ({ date: d, ranges: block ? [] : [{ start: maltaIso(d, start), end: maltaIso(d, end) }] })) },
      block ? 'Those days are blocked.' : 'Viewing hours saved. Agents can book inside them.')
    setPicked([]); setBusy(false)
  }
  return (
    <div className="lv-hours">
      <h2>When can people view?</h2>
      <p className="lv-faint">Tap the days, choose the hours, save. Agents book only inside your hours.</p>
      <div className="lv-days">
        {days.map(d => {
          const k = isoDay(d); const w = byDay(k)
          return (
            <button key={k} className="lv-day" aria-pressed={picked.includes(k)} data-has={w.length > 0} onClick={() => setPicked(p => (p.includes(k) ? p.filter(x => x !== k) : [...p, k]))}>
              <small>{d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/Malta' })}</small>
              <b>{d.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'Europe/Malta' })}</b>
              <span>{w.length ? w.map(x => `${fmtTime(new Date(x.start))}–${fmtTime(new Date(x.end))}`).join(', ') : '—'}</span>
            </button>
          )
        })}
      </div>
      <div className="lv-row">
        <label className="lv-time">From<input type="time" step={900} className="lv-input" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="lv-time">To<input type="time" step={900} className="lv-input" value={end} onChange={e => setEnd(e.target.value)} /></label>
      </div>
      <div className="lv-actions">
        <button className="lv-btn ok big" disabled={busy || !picked.length || end <= start} onClick={() => save(false)}><Check size={20} />Save {picked.length || ''} day{picked.length === 1 ? '' : 's'}</button>
        <button className="lv-btn quiet" disabled={busy || !picked.length} onClick={() => save(true)}>Block these days</button>
      </div>
    </div>
  )
}

// ── requests and calendar ───────────────────────────────────────────────────
export function LiveRequests() {
  const s = useOwner()
  const homes = useHomes()
  const now = Date.now()
  const pending = s.live.viewings.filter(v => v.status === 'pending' && new Date(v.startsAt).getTime() > now)
  const upcoming = s.live.viewings.filter(v => v.status === 'confirmed' && new Date(v.startsAt).getTime() > now)
  const past = s.live.viewings.filter(v => new Date(v.startsAt).getTime() <= now || v.status === 'cancelled').reverse().slice(0, 20)
  const h = (v: LiveViewing) => homes.find(x => x.sourcePropertyId === v.propertyId)
  return (
    <div className="lv">
      <header className="lv-hello"><h1>Requests</h1><p>Agents ask for viewings here. One tap answers them.</p></header>
      <section className="lv-section"><h2>Waiting for you</h2>{pending.length ? pending.map(v => <ViewingRow key={v.id} v={v} home={h(v)} />) : <p className="lv-faint">Nothing waiting.</p>}</section>
      <section className="lv-section"><h2>Confirmed</h2>{upcoming.length ? upcoming.map(v => <ViewingRow key={v.id} v={v} home={h(v)} />) : <p className="lv-faint">No confirmed viewings.</p>}</section>
      {past.length > 0 && <section className="lv-section"><h2>Earlier</h2>{past.map(v => <ViewingRow key={v.id} v={v} home={h(v)} />)}</section>}
    </div>
  )
}

export function LiveCalendar() {
  const s = useOwner()
  const homes = useHomes()
  const [pid, setPid] = useState<number | null>(null)
  const sel = homes.find(h => h.sourcePropertyId === (pid ?? homes[0]?.sourcePropertyId))
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() + i * 86400e3))
  return (
    <div className="lv">
      <header className="lv-hello"><h1>Calendar</h1><p>Your viewing hours and every viewing, per home.</p></header>
      {homes.length > 1 && (
        <div className="lv-chips">{homes.map(h => <button key={h.sourcePropertyId} aria-pressed={h.sourcePropertyId === sel?.sourcePropertyId} onClick={() => setPid(h.sourcePropertyId)}>{homeName(h)}</button>)}</div>
      )}
      {sel ? (
        <>
          <section className="lv-section lv-week">
            {days.map(d => {
              const k = isoDay(d)
              const w = (sel.state?.windows || []).filter(x => isoDay(new Date(x.start)) === k)
              const v = s.live.viewings.filter(x => x.propertyId === sel.sourcePropertyId && isoDay(new Date(x.startsAt)) === k && x.status !== 'cancelled')
              return (
                <div key={k} className="lv-week-day" data-today={k === isoDay(new Date())}>
                  <b>{fmtDay(d)}</b>
                  {w.map(x => <span key={x.id} className="lv-slot">Open {fmtTime(new Date(x.start))}–{fmtTime(new Date(x.end))}</span>)}
                  {v.map(x => <span key={x.id} className="lv-slot" data-kind={x.status}>{fmtTime(new Date(x.startsAt))} viewing · {x.status === 'pending' ? 'waiting' : 'confirmed'}</span>)}
                  {!w.length && !v.length && <span className="lv-faint">—</span>}
                </div>
              )
            })}
          </section>
          <section className="lv-section"><HoursEditor propertyId={sel.sourcePropertyId} windows={sel.state?.windows || []} /></section>
        </>
      ) : <p className="lv-faint">No confirmed homes yet.</p>}
    </div>
  )
}

export function LiveSharing() {
  const homes = useHomes()
  return (
    <div className="lv">
      <header className="lv-hello"><h1>Agencies & sharing</h1><p>Every home has its own setting: exclusive with one agency, shared with many, or private.</p></header>
      <div className="lv-cards">
        {homes.map(l => (
          <Link key={l.externalId} href={`/owner/properties/${l.sourcePropertyId}?tab=share`} className="lv-share-row">
            <span><b>{homeName(l)}</b><small>{l.state?.sharing.length ? l.state.sharing.map(g => CHANNELS.find(c => c.id === g.channel)?.label || g.channel).join(' · ') : 'Private: not shared yet'}</small></span>
            <ChevronRight size={20} />
          </Link>
        ))}
      </div>
    </div>
  )
}

export function LiveSettings() {
  const s = useOwner()
  const a = s.live.account
  if (!a) return <p className="lv-faint">Please sign in.</p>
  return (
    <div className="lv">
      <header className="lv-hello"><h1>Settings</h1></header>
      <section className="lv-section lv-kv">
        <p><span>Name</span><b>{a.name || '—'}</b></p>
        <p><span>Mobile</span><b>{a.phone?.e164 || '—'}{a.phone?.verified ? ' ✓' : ''}</b></p>
        <p><span>E-mail</span><b>{a.email || '—'}</b></p>
      </section>
      <section className="lv-section">
        <h2>How ARGUS reaches you</h2>
        <div className="lv-chips">
          {(['whatsapp', 'email', 'app'] as const).map(c => <button key={c} aria-pressed={a.notifyChannel === c} onClick={() => s.liveDo('account/update', { notifyChannel: c }, 'Saved.')}>{c === 'app' ? 'Only in SYNC' : c === 'email' ? 'E-mail' : 'WhatsApp'}</button>)}
        </div>
      </section>
      <button className="lv-btn big wide" onClick={() => s.signOut()}><Home size={18} />Sign out</button>
    </div>
  )
}
