'use client'
// Viewing feedback on the Bookings page (Kev, 2026-11-21): every booking
// request with its agent, property, time, state and feedback due date. The
// requesting agent answers here: Completed · Didn't happen · Rescheduled ·
// Awaiting confirmation. ARGUS asks once, the day after, in the agent's
// workspace group.
import { useCallback, useEffect, useState } from 'react'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { OwnerInfoButton } from './owner-info-button'

type Followup = {
  id: number; viewingId: number; propertyId: number; ref: string; town: string | null
  agent: { id: number; name: string | null }; slotAt: string; state: string; feedback: string; dueDate: string
  askedAt: string | null; outcome: string | null; nextStep: string | null; note: string | null; answeredAt: string | null; bookingStatus: string | null
}
const STATE: Record<string, { label: string; c: string }> = {
  requested: { label: 'Requested', c: '#BEB8FF' }, confirmed: { label: 'Confirmed', c: '#4ADE80' }, rescheduled: { label: 'Rescheduled', c: '#7DD3FC' },
  cancelled: { label: 'Cancelled', c: '#687288' }, completed: { label: 'Completed', c: '#4ADE80' }, no_show: { label: "Didn't happen", c: '#F87171' }, unverified: { label: 'Unverified', c: '#FBBF24' },
}
const FEEDBACK: Record<string, string> = { scheduled: 'Upcoming', due: 'Feedback due', asked: 'Feedback due · asked', answered: 'Answered', cancelled: 'No feedback (cancelled)' }
const KIND: Record<string, string> = { created: 'Request tracked', confirmed: 'Owner confirmed', rescheduled: 'Moved', cancelled: 'Cancelled', reinstated: 'Back on', due: 'Feedback due',
  asked: 'Agent asked', ask_failed: 'Question not delivered, retrying', answered: 'Answered', owner_info_viewed: 'Owner contact opened' }
const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
const dayOnly = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00Z`))

export function ViewingFeedback() {
  const [rows, setRows] = useState<Followup[] | null>(null)
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [canContact, setCanContact] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [resched, setResched] = useState<{ id: number; at: string } | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [history, setHistory] = useState<{ id: number; items: { kind: string; at: string; by: string | null; detail: Record<string, unknown> }[] } | null>(null)
  async function showHistory(id: number) {
    if (history?.id === id) { setHistory(null); return }
    try { const d = await crmFetch(`viewing-followups/${id}`); setHistory({ id, items: d.timeline || [] }) } catch { setErr('The history could not be loaded.') }
  }

  const load = useCallback(() => {
    crmFetch('viewing-followups').then(d => { setRows(d.followups || []); setScope(d.scope); setCanContact(!!d.canViewOwnerContact); setErr(null) })
      .catch(e => setErr(e instanceof Error ? e.message : 'Could not load viewing feedback.'))
  }, [])
  useEffect(() => {
    load()
    const id = Number(new URLSearchParams(location.search).get('feedback'))
    if (id) setFocus(id)
    const iv = setInterval(load, 60000); return () => clearInterval(iv)
  }, [load])
  useEffect(() => { if (focus && rows) document.getElementById(`fu-${focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, [focus, rows])

  async function answer(f: Followup, outcome: string, extra: Record<string, unknown> = {}) {
    setBusy(f.id)
    try { await crmJson(`viewing-followups/${f.id}/answer`, 'POST', { outcome, ...extra }); setResched(null); load() }
    catch (e) { setErr(e instanceof Error ? e.message : 'The answer was not saved.') }
    finally { setBusy(null) }
  }

  if (!rows) return null
  const due = rows.filter(r => r.feedback === 'due' || r.feedback === 'asked')
  const rest = rows.filter(r => !(r.feedback === 'due' || r.feedback === 'asked'))
  const btn = (bg: string): React.CSSProperties => ({ padding: '7px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,.12)', background: bg, color: '#F4F1E9', fontSize: 12, fontWeight: 600, cursor: 'pointer' })

  const row = (f: Followup) => {
    const st = STATE[f.state] || { label: f.state, c: '#9AA4B8' }
    const open = f.feedback === 'due' || f.feedback === 'asked'
    return (
      <div key={f.id} id={`fu-${f.id}`} style={{ display: 'grid', gap: 8, padding: 14, borderRadius: 14, border: `1px solid ${focus === f.id ? '#7770FF' : 'rgba(255,255,255,.08)'}`, background: open ? 'rgba(251,191,36,.06)' : 'rgba(255,255,255,.02)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'grid', gap: 2 }}>
            <b>#{f.ref}{f.town ? ` · ${f.town}` : ''}</b>
            <span style={{ color: '#9AA4B8', fontSize: 13 }}>{when(f.slotAt)} · {f.agent.name || 'Agent'}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: st.c, border: `1px solid ${st.c}55`, borderRadius: 99, padding: '3px 10px' }}>{st.label}</span>
            <span style={{ fontSize: 12, color: open ? '#FBBF24' : '#9AA4B8' }}>{FEEDBACK[f.feedback] || f.feedback}{f.feedback !== 'answered' && f.feedback !== 'cancelled' ? ` · ${dayOnly(f.slotAt.slice(0, 10))}–${dayOnly(f.dueDate)}` : ''}</span>
          </div>
        </div>
        {f.outcome && <div style={{ fontSize: 13, color: '#9AA4B8' }}>Answer: {f.outcome.replace('_', ' ')}{f.nextStep ? ` · next: ${f.nextStep.replace('_', ' ')}` : ''}{f.note ? ` · “${f.note}”` : ''}</div>}
        {open && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 14 }}>{f.state === 'confirmed' ? 'The viewing was planned. Did it take place?' : 'The owner had not confirmed this request. Did the viewing take place?'}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button disabled={busy === f.id} onClick={() => answer(f, 'completed')} style={btn('rgba(74,222,128,.18)')}>Completed</button>
              <button disabled={busy === f.id} onClick={() => answer(f, 'didnt_happen')} style={btn('rgba(248,113,113,.14)')}>Didn&apos;t happen</button>
              <button disabled={busy === f.id} onClick={() => setResched({ id: f.id, at: '' })} style={btn('rgba(125,211,252,.12)')}>Rescheduled</button>
              <button disabled={busy === f.id} onClick={() => answer(f, 'awaiting')} style={btn('transparent')}>Awaiting confirmation</button>
            </div>
            {resched?.id === f.id && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input type="datetime-local" value={resched.at} onChange={e => setResched({ id: f.id, at: e.target.value })} aria-label="New date and time"
                  style={{ padding: '7px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,.15)', background: 'transparent', color: '#F4F1E9' }} />
                <button disabled={!resched.at || busy === f.id} onClick={() => answer(f, 'rescheduled', { newStartsAt: new Date(resched.at).toISOString() })} style={btn('#7770FF')}>Save new time</button>
              </div>
            )}
          </div>
        )}
        {f.outcome === 'completed' && !f.nextStep && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#9AA4B8' }}>Next step:</span>
            {(['interested', 'follow_up', 'offer', 'declined'] as const).map(n => (
              <button key={n} disabled={busy === f.id} onClick={() => answer(f, 'completed', { nextStep: n })} style={btn('transparent')}>{n.replace('_', ' ')}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {canContact && f.state !== 'cancelled' && <OwnerInfoButton viewingId={f.viewingId} style={btn('transparent')} />}
          <button type="button" onClick={() => showHistory(f.id)} aria-expanded={history?.id === f.id} style={btn('transparent')}>{history?.id === f.id ? 'Hide history' : 'History'}</button>
        </div>
        {history?.id === f.id && (
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: 12, color: '#9AA4B8' }}>
            {history.items.map((e, i) => (
              <li key={i}>{when(e.at)} · {KIND[e.kind] || e.kind}{e.by ? ` · ${e.by}` : ''}{typeof e.detail?.outcome === 'string' ? ` · ${String(e.detail.outcome).replace('_', ' ')}` : ''}{typeof e.detail?.note === 'string' && e.detail.note ? ` · “${e.detail.note}”` : ''}</li>
            ))}
          </ol>
        )}
      </div>
    )
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-[#121A29] p-4 sm:p-5" data-viewing-feedback>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Viewing feedback {due.length > 0 && <span style={{ marginLeft: 6, fontSize: 12, background: '#FBBF24', color: '#121A29', borderRadius: 99, padding: '2px 8px' }}>{due.length} due</span>}</h3>
        <span style={{ color: '#9AA4B8', fontSize: 12 }}>{scope === 'all' ? 'All agents' : 'Your requests'} · asked the day after the viewing</span>
      </div>
      {err && <p style={{ color: '#F87171' }}>{err}</p>}
      {!rows.length && <p style={{ color: '#9AA4B8', fontSize: 14 }}>No booking requests yet. Every request you make shows up here.</p>}
      <div style={{ display: 'grid', gap: 8 }}>{due.map(row)}{rest.map(row)}</div>
    </section>
  )
}
