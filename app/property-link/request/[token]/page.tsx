'use client'
// The requesting agent's own request page: follow it, reconfirm with the
// client, ask for another time or cancel. Shows nobody else's data.
import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { CalendarCheck, Check, Clock3, RotateCcw, X } from 'lucide-react'
import { api, Chip, fmtDay, fmtTime, fmtWhen, LABEL, TONE } from '@/components/owner-portal/ui'

type Status = {
  request: { id: number; state: string; durationMin: number; preferred: { start: string }[]; proposedStart: string | null; proposedEnd: string | null; expiresAt: string | null }
  property: { ref: string; town: string | null; property_type: string | null }
  history: { state: string; label: string; action: string; at: string; message: string | null }[]
}

export default function RequestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [s, setS] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [other, setOther] = useState(false)
  const [when, setWhen] = useState('')
  const base = '/api/owner-share/request/'
  const load = useCallback(() => api<Status>(base, encodeURIComponent(token)).then(setS).catch(e => setError(e.message)), [token])
  useEffect(() => { load() }, [load])
  const act = async (action: string, body: object = {}) => { setBusy(true); setError(''); try { await api(base, `${encodeURIComponent(token)}/${action}`, { method: 'POST', json: body }); setOther(false); await load() } catch (e: any) { setError(e.message) } finally { setBusy(false) } }
  const r = s?.request
  const steps = useMemo(() => ['REQUESTED', 'OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED'], [])
  const at = r ? Math.max(0, steps.indexOf(r.state === 'RESCHEDULE_REQUESTED' ? 'REQUESTED' : r.state)) : 0
  return (
    <div className="op-root">
      <header className="op-header"><div className="op-mark" aria-hidden>A</div><div className="op-brand"><small>ARGUS · Viewing request</small><b>{s ? `#${s.property.ref} · ${s.property.town || 'Malta'}` : 'Loading…'}</b></div></header>
      <main className="op-main" style={{ maxWidth: 720 }}>
        {error && <div className="op-error" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
        {!s && !error && <div className="op-empty">Loading…</div>}
        {s && r && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'grid', gap: 16 }}>
            <section className="op-card op-card-pad" style={{ display: 'grid', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Chip tone={TONE[r.state]}>{LABEL[r.state]}</Chip>
                {r.expiresAt && ['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING'].includes(r.state) && <span style={{ color: 'var(--op-warn)', fontSize: 13, fontWeight: 650 }}>Reconfirm by {fmtWhen(r.expiresAt)}</span>}
              </div>
              {r.proposedStart ? (
                <div><div className="op-eyebrow">{r.state === 'CONFIRMED' ? 'Confirmed viewing' : 'Proposed by the owner'}</div>
                  <div className="op-display" style={{ fontSize: 28, fontWeight: 700 }}>{fmtDay(r.proposedStart)} · {fmtTime(r.proposedStart)}–{fmtTime(r.proposedEnd!)}</div></div>
              ) : <p style={{ margin: 0 }}><Clock3 size={15} style={{ verticalAlign: -2 }} /> Waiting for the owner to propose a time{r.preferred.length ? ` (you asked for ${r.preferred.map(p => fmtWhen(p.start)).join(', ')})` : ''}.</p>}
              <ol style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, listStyle: 'none', padding: 0, margin: 0 }} aria-label="Progress">
                {['Requested', 'Slot proposed', 'Checking with client', 'Confirmed'].map((label, i) => (
                  <li key={label} style={{ display: 'grid', gap: 6 }}><span style={{ height: 4, borderRadius: 4, background: i <= at && !['DECLINED', 'CANCELLED', 'EXPIRED'].includes(r.state) ? 'var(--op-accent)' : 'var(--op-line-strong)' }} /><small style={{ color: i <= at ? 'var(--op-ink)' : 'var(--op-faint)', fontWeight: 650 }}>{label}</small></li>
                ))}
              </ol>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {r.state === 'OWNER_SLOT_PROPOSED' && <button className="op-btn" disabled={busy} onClick={() => act('checking')}><Clock3 size={15} /> I'm checking with my client</button>}
                {['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING'].includes(r.state) && <button className="op-btn op-btn-accent" disabled={busy} onClick={() => act('confirm')}><Check size={15} /> Client confirmed this time</button>}
                {['OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED'].includes(r.state) && <button className="op-btn op-btn-ghost" disabled={busy} onClick={() => setOther(o => !o)}><RotateCcw size={15} /> Another time</button>}
                {['REQUESTED', 'RESCHEDULE_REQUESTED', 'OWNER_SLOT_PROPOSED', 'AGENT_CLIENT_CONFIRMATION_PENDING', 'CONFIRMED'].includes(r.state) && <button className="op-btn op-btn-ghost op-btn-danger" disabled={busy} onClick={() => act('cancel')}><X size={15} /> Cancel request</button>}
              </div>
              {other && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <label className="op-field"><span>Preferred time</span><input className="op-input" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></label>
                <button className="op-btn op-btn-primary" disabled={busy} onClick={() => act('other_time', { preferred: when ? [{ start: new Date(when).toISOString() }] : [] })}>Ask the owner</button>
              </div>}
              {r.state === 'CONFIRMED' && <div className="op-note"><CalendarCheck size={15} style={{ verticalAlign: -2 }} /> Confirmed by the owner and by you. Owner contact details are not released through this page; follow your agency agreement for anything further.</div>}
            </section>
            <section className="op-card">
              {s.history.map((h, i) => (
                <div key={i} style={{ padding: '12px 18px', borderTop: i ? '1px solid var(--op-line)' : 0, display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><b>{LABEL[h.state] || h.label}</b><span style={{ color: 'var(--op-faint)', fontSize: 13 }}>{fmtWhen(h.at)}</span></div>
                  {h.message && <span style={{ color: 'var(--op-muted)', fontSize: 13.5 }}>{h.message}</span>}
                </div>
              ))}
            </section>
          </motion.div>
        )}
      </main>
    </div>
  )
}
