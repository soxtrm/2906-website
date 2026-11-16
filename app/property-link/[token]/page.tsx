'use client'
// Agent-facing property link: owner-approved facts and free viewing times
// only. Never shows the owner's identity or contact, never edits anything.
import { use, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { CalendarDays, Check, ShieldCheck } from 'lucide-react'
import { api, Chip, CopyField, fmtDay, fmtTime, fmtWhen, money } from '@/components/owner-portal/ui'

type Prop = {
  id: number; ref: string; town: string | null; sub_location?: string | null; property_type: string | null; bedrooms: number | null; bathrooms?: number | null; size_sqm?: number | null
  longlet_price?: string | null; sale_price?: string | null; available_status: string | null; available_date?: string | null; description?: string | null; feature_tags?: string[] | null; images?: any[]
  viewing: { durationMin: number; approval: string; slots: { start: string; end: string }[] } | null
}
type View = { label: string | null; allowRequests: boolean; properties: Prop[]; terms: string }

export default function PropertyLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [data, setData] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [pid, setPid] = useState<number | null>(null)
  useEffect(() => { api<View>('/api/owner-share/', encodeURIComponent(token)).then(d => { setData(d); setPid(d.properties[0]?.id ?? null) }).catch(e => setError(e.message)) }, [token])
  if (error) return <Shell><div className="op-card op-card-pad" style={{ maxWidth: 460, margin: '10vh auto', textAlign: 'center' }}><h1 className="op-h1" style={{ fontSize: 24 }}>This link is not available</h1><p className="op-lede">The owner may have turned it off. Ask them or the listing agency for a new one.</p></div></Shell>
  if (!data) return <Shell><div className="op-empty">Loading…</div></Shell>
  const p = data.properties.find(x => x.id === pid) || data.properties[0]
  return (
    <Shell>
      {data.properties.length > 1 && <div className="op-day-strip" style={{ marginBottom: 14 }} role="group" aria-label="Properties">{data.properties.map(x => <button key={x.id} type="button" aria-pressed={x.id === p?.id} onClick={() => setPid(x.id)}>#{x.ref}<br /><small>{x.town}</small></button>)}</div>}
      {p ? <PropertyView key={p.id} p={p} token={token} allowRequests={data.allowRequests} /> : <div className="op-empty">No properties on this link right now.</div>}
      <p style={{ color: 'var(--op-faint)', fontSize: 12.5, marginTop: 24 }}><ShieldCheck size={13} style={{ verticalAlign: -2 }} /> {data.terms}</p>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="op-root">
      <header className="op-header"><div className="op-mark" aria-hidden>A</div><div className="op-brand"><small>ARGUS · Property link</small><b>Viewings coordinated by ARGUS</b></div></header>
      <main className="op-main" style={{ maxWidth: 980 }}>{children}</main>
    </div>
  )
}

function PropertyView({ p, token, allowRequests }: { p: Prop; token: string; allowRequests: boolean }) {
  const images = (p.images || []).map(x => typeof x === 'string' ? x : x?.url).filter(Boolean) as string[]
  const days = useMemo(() => [...new Set((p.viewing?.slots || []).map(s => fmtDay(s.start)))], [p])
  const [day, setDay] = useState(days[0])
  const [picked, setPicked] = useState<string[]>([])
  const [f, setF] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<{ url: string; state: string; message: string | null } | null>(null)
  const toggle = (s: string) => setPicked(x => x.includes(s) ? x.filter(y => y !== s) : x.length >= 3 ? x : [...x, s])
  async function send() {
    setBusy(true); setErr('')
    try {
      const r = await api<{ url: string; request: { state: string }; agentMessage: string | null }>('/api/owner-share/', `${encodeURIComponent(token)}/requests`, { method: 'POST', json: {
        propertyId: p.id, agent: { name: f.name, agency: f.agency },
        client: { people: f.people ? Number(f.people) : undefined, groupType: f.groupType || undefined, moveIn: f.moveIn || undefined, pets: f.pets || undefined, budgetNote: f.budget || undefined, notes: f.notes || undefined, clientRef: f.clientRef || undefined },
        preferred: picked.map(start => ({ start })) } })
      setDone({ url: `${window.location.origin}/property-link/request/${r.url.split('/request/')[1]}`, state: r.request.state, message: r.agentMessage })
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'grid', gap: 16 }}>
      {images[0] && <div className="op-card" style={{ overflow: 'hidden' }}><div className="op-prop-photo" style={{ aspectRatio: '16/8', backgroundImage: `url(${JSON.stringify(images[0]).slice(1, -1)})` }} /></div>}
      <section className="op-card op-card-pad" style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'start' }}>
          <div><div className="op-eyebrow">#{p.ref}</div><h1 className="op-h1">{p.town}{p.sub_location ? `, ${p.sub_location}` : ''}</h1></div>
          <div style={{ textAlign: 'right' }}><div className="op-display" style={{ fontSize: 24, fontWeight: 700 }}>{p.longlet_price ? `${money(p.longlet_price)}` : money(p.sale_price)}</div><span style={{ color: 'var(--op-muted)', fontSize: 13 }}>{p.longlet_price ? 'per month' : ''}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[p.property_type, p.bedrooms ? `${p.bedrooms} bed` : null, p.bathrooms ? `${p.bathrooms} bath` : null, p.size_sqm ? `${p.size_sqm} m²` : null].filter(Boolean).map(x => <Chip key={String(x)}>{x}</Chip>)}
          <Chip tone={p.available_status === 'available' ? 'ok' : 'warn'}>{p.available_status === 'available' ? 'Available' : p.available_status}{p.available_date ? ` from ${String(p.available_date).slice(0, 10)}` : ''}</Chip>
        </div>
        {p.description && <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{p.description}</p>}
        {!!p.feature_tags?.length && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{p.feature_tags.map(t => <Chip key={t}>{t}</Chip>)}</div>}
        {images.length > 1 && <div className="op-photos">{images.slice(1, 9).map(u => <div key={u} className="op-photo"><img src={u} alt="" loading="lazy" /></div>)}</div>}
      </section>

      {done ? (
        <section className="op-card op-card-pad" style={{ display: 'grid', gap: 12, boxShadow: 'var(--op-glow)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Check size={20} /><b className="op-display" style={{ fontSize: 20 }}>{done.state === 'OWNER_SLOT_PROPOSED' ? 'A slot was proposed straight away' : 'Request sent to the owner'}</b></div>
          {done.message && <div className="op-note">{done.message}</div>}
          <p style={{ margin: 0 }}>Keep this link. It is the only way to follow and confirm this request.</p>
          <CopyField label="Your request link" value={done.url} />
          <a className="op-btn op-btn-primary" href={done.url}>Open request</a>
        </section>
      ) : allowRequests && p.viewing ? (
        <section className="op-card op-card-pad" style={{ display: 'grid', gap: 14 }}>
          <div><div className="op-eyebrow"><CalendarDays size={13} style={{ verticalAlign: -2 }} /> Request a viewing</div><p style={{ margin: '4px 0 0', color: 'var(--op-muted)' }}>Pick up to three times that work for your client. {p.viewing.durationMin}-minute viewings. The owner proposes a slot; you then confirm with your client.</p></div>
          {days.length ? <>
            <div className="op-day-strip" role="group" aria-label="Day">{days.map(d => <button key={d} type="button" aria-pressed={d === day} onClick={() => setDay(d)}>{d}</button>)}</div>
            <div className="op-slot-list">{p.viewing.slots.filter(s => fmtDay(s.start) === day).map(s => <button key={s.start} type="button" className="op-toggle" aria-pressed={picked.includes(s.start)} onClick={() => toggle(s.start)} style={{ justifyContent: 'center' }}>{fmtTime(s.start)}</button>)}</div>
            {!!picked.length && <p style={{ margin: 0, fontSize: 13.5 }}>Chosen: {picked.map(fmtWhen).join(' · ')}</p>}
          </> : <div className="op-note">No free times are open right now. You can still send a request; the owner will propose a time.</div>}
          <div className="op-grid-2">
            <label className="op-field"><span>Your name</span><input className="op-input" autoComplete="name" value={f.name || ''} onChange={e => setF({ ...f, name: e.target.value })} /></label>
            <label className="op-field"><span>Agency</span><input className="op-input" autoComplete="organization" value={f.agency || ''} onChange={e => setF({ ...f, agency: e.target.value })} /></label>
            <label className="op-field"><span>People viewing</span><input className="op-input" inputMode="numeric" value={f.people || ''} onChange={e => setF({ ...f, people: e.target.value.replace(/\D/g, '') })} /></label>
            <label className="op-field"><span>Client type</span><select className="op-input" value={f.groupType || ''} onChange={e => setF({ ...f, groupType: e.target.value })}><option value="">—</option>{['single', 'couple', 'family', 'sharers', 'company', 'other'].map(x => <option key={x}>{x}</option>)}</select></label>
            <label className="op-field"><span>Move-in date</span><input className="op-input" type="date" value={f.moveIn || ''} onChange={e => setF({ ...f, moveIn: e.target.value })} /></label>
            <label className="op-field"><span>Pets</span><input className="op-input" maxLength={100} value={f.pets || ''} onChange={e => setF({ ...f, pets: e.target.value })} /></label>
            <label className="op-field"><span>Budget note</span><input className="op-input" maxLength={200} value={f.budget || ''} onChange={e => setF({ ...f, budget: e.target.value })} /></label>
            <label className="op-field"><span>Your client reference</span><input className="op-input" maxLength={40} value={f.clientRef || ''} onChange={e => setF({ ...f, clientRef: e.target.value })} /></label>
          </div>
          <label className="op-field"><span>Anything the owner should know</span><textarea className="op-input" maxLength={500} value={f.notes || ''} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
          {err && <div className="op-error" role="alert">{err}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="op-btn op-btn-accent" disabled={busy || !f.name || !f.agency} onClick={send}>{busy ? 'Sending…' : 'Send viewing request'}</button></div>
        </section>
      ) : <div className="op-note">Viewing requests are not open on this link.</div>}
    </motion.div>
  )
}
