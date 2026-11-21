'use client'
// /crm/marketplace-inbox — NEXUS Marketplace conversations (2026-11-21). Visitors write about a listing; the
// listing agent (admins: everyone's) answers here. A viewing request is booked through the real booking engine:
// the time must lie inside the owner's viewing hours; the owner then confirms it in NEXUS Sync.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CrmProvider, CrmShell } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

type Row = { id: string; visitor: string; role: string; unread: number; status: string; lastAt: string; lastText: string; lastFrom: string; openRequests: number; agent: string | null }
type Group = { ref: string; propertyId: number | null; title: string; unread: number; openRequests: number; lastAt: string; conversations: Row[] }
type Msg = { id: number; from: 'visitor' | 'staff' | 'system'; kind: string; text: string; at: string }
type Req = { id: number; state: string; preferred: { date: string; part: string }[]; note: string | null; startsAt: string | null }
type Conv = { id: string; ref: string; title: string; status: string; visitor: { name: string; email: string | null; phone: string | null; role: string }; agent: { name: string } | null; messages: Msg[]; requests: Req[] }

export default function Page() { return <CrmProvider><CrmShell title="Marketplace inbox" subtitle="Visitors writing about your listings: answer and book viewings"><Inbox /></CrmShell></CrmProvider> }

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const STATE: Record<string, string> = { requested: 'Waiting for you', waiting_owner: 'Booked · waiting for the owner', confirmed: 'Confirmed by the owner', declined: 'Declined', not_possible: 'Owner declined', cancelled: 'Cancelled' }

function Inbox() {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [totals, setTotals] = useState({ conversations: 0, unread: 0, openRequests: 0 })
  const [filter, setFilter] = useState<'all' | 'unread' | 'requests' | 'closed'>('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [conv, setConv] = useState<Conv | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bookAt, setBookAt] = useState<Record<number, string>>({})
  const [dur, setDur] = useState(20)
  const load = useCallback(async () => {
    try { const d = await crmFetch(`marketplace-inbox/?filter=${filter}&q=${encodeURIComponent(q)}`); setGroups(d.groups); setTotals(d.totals); setErr(null) } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.') }
  }, [filter, q])
  const open = useCallback(async (id: string) => { setSel(id); try { setConv((await crmFetch(`marketplace-inbox/${id}`)).conversation) } catch (e) { setErr(e instanceof Error ? e.message : 'Could not open.') } }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible') { load(); if (sel) open(sel) } }, 15000); return () => clearInterval(t) }, [load, open, sel])
  const act = async (path: string, body: unknown) => {
    if (!conv) return
    setBusy(true)
    try { setConv((await crmJson(`marketplace-inbox/${conv.id}/${path}`, 'POST', body)).conversation); setErr(null); await load() } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
    setBusy(false)
  }
  const card: React.CSSProperties = { background: 'var(--crm-card)', border: '1px solid var(--crm-border)', borderRadius: 16 }
  const pill = (on: boolean): React.CSSProperties => ({ padding: '6px 11px', borderRadius: 999, border: '1px solid var(--crm-border)', background: on ? 'var(--crm-text, #071449)' : 'transparent', color: on ? 'var(--crm-bg, #fff)' : 'inherit', fontWeight: 650, fontSize: 13, cursor: 'pointer' })
  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ padding: '8px 13px', borderRadius: 10, border: bg === 'transparent' ? '1px solid var(--crm-border)' : 0, background: bg, color: fg, fontWeight: 650, cursor: 'pointer' })
  const minAt = useMemo(() => new Date(Date.now() + 3600e3).toISOString().slice(0, 16), [])

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12, justifyContent: 'space-between' }}>
        <div>
          <p style={{ margin: 0, opacity: .75 }}>Messages from the NEXUS Marketplace about your listings. {totals.unread} unread · {totals.openRequests} viewing request{totals.openRequests === 1 ? '' : 's'} waiting.</p></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['all', 'unread', 'requests', 'closed'] as const).map(f => <button key={f} style={pill(filter === f)} onClick={() => setFilter(f)}>{f === 'all' ? 'Open' : f === 'requests' ? 'Viewing requests' : f[0].toUpperCase() + f.slice(1)}</button>)}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, ref, town" style={{ padding: '7px 11px', borderRadius: 999, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit' }} />
        </div>
      </header>
      {err && <p style={{ color: '#d93f5c', margin: 0 }}>{err}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) minmax(0, 1fr)', gap: 14, alignItems: 'start' }} className="mpi-split">
        <div style={{ ...card, padding: 8, display: 'grid', gap: 6, maxHeight: '75vh', overflow: 'auto' }}>
          {!groups ? <p style={{ padding: 12, opacity: .6 }}>Loading…</p> : !groups.length ? <p style={{ padding: 12, opacity: .6 }}>No conversations here yet. Messages from the Marketplace appear as soon as a visitor writes.</p> :
            groups.map(g => (
              <div key={g.ref} style={{ display: 'grid', gap: 4, padding: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}><b style={{ fontSize: 14 }}>{g.title}</b><small style={{ opacity: .6 }}>Ref {g.ref}</small></div>
                {g.conversations.map(c => (
                  <button key={c.id} onClick={() => open(c.id)} style={{ textAlign: 'left', display: 'grid', gap: 2, padding: '9px 10px', borderRadius: 12, border: '1px solid var(--crm-border)', background: sel === c.id ? 'rgba(79,107,255,.12)' : 'transparent', color: 'inherit', cursor: 'pointer' }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{c.visitor}{c.role === 'agent' ? ' · agent' : ''}</b><small style={{ opacity: .6 }}>{when(c.lastAt)}</small></span>
                    <span style={{ fontSize: 13, opacity: .75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.lastFrom === 'staff' ? 'You: ' : ''}{c.lastText}</span>
                    <span style={{ display: 'flex', gap: 6, fontSize: 11.5, fontWeight: 700 }}>
                      {c.unread > 0 && <span style={{ background: '#ef6046', color: '#fff', borderRadius: 999, padding: '1px 7px' }}>{c.unread} new</span>}
                      {c.openRequests > 0 && <span style={{ border: '1.5px dashed #e8a33a', borderRadius: 999, padding: '0 7px' }}>Viewing request</span>}
                      {c.agent && <span style={{ opacity: .6 }}>{c.agent}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
        </div>
        <div style={{ ...card, padding: 14, minHeight: 360 }}>
          {!conv ? <p style={{ opacity: .6 }}>Choose a conversation.</p> : <>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--crm-border)', paddingBottom: 10 }}>
              <div><b style={{ fontSize: 17 }}>{conv.visitor.name}</b> <small style={{ opacity: .7 }}>{conv.visitor.role === 'agent' ? 'Agent for a client' : 'Home seeker'}</small>
                <div style={{ fontSize: 13, opacity: .8 }}>{[conv.visitor.email, conv.visitor.phone].filter(Boolean).join(' · ')}</div>
                <div style={{ fontSize: 13, opacity: .7 }}>{conv.title} · Ref {conv.ref}</div></div>
              <button style={btn('transparent', 'inherit')} disabled={busy} onClick={() => act('close', { closed: conv.status === 'open' })}>{conv.status === 'open' ? 'Close' : 'Reopen'}</button>
            </div>
            <div style={{ display: 'grid', gap: 6, margin: '12px 0', maxHeight: '45vh', overflow: 'auto' }}>
              {conv.messages.map(m => m.from === 'system'
                ? <p key={m.id} style={{ justifySelf: 'center', margin: 0, fontSize: 12.5, padding: '6px 10px', borderRadius: 10, background: 'rgba(239,96,70,.1)' }}>{m.text}</p>
                : <div key={m.id} style={{ justifySelf: m.from === 'staff' ? 'end' : 'start', maxWidth: '78%', padding: '8px 11px', borderRadius: 14, background: m.from === 'staff' ? '#071449' : 'rgba(127,127,127,.12)', color: m.from === 'staff' ? '#fff' : 'inherit' }}>
                  {m.kind === 'viewing_request' && <div style={{ fontSize: 11, fontWeight: 800, opacity: .8 }}>VIEWING REQUEST</div>}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div><div style={{ fontSize: 10.5, opacity: .6, textAlign: 'right' }}>{when(m.at)}</div></div>)}
            </div>
            {conv.requests.map(r => (
              <div key={r.id} style={{ ...card, padding: 12, marginBottom: 10, display: 'grid', gap: 8 }}>
                <b>{STATE[r.state] || r.state}{r.startsAt ? ` · ${when(r.startsAt)}` : ''}</b>
                <span style={{ fontSize: 13 }}>Preferred: {r.preferred.map(p => `${dayLabel(p.date)}${p.part !== 'any' ? ` (${p.part})` : ''}`).join(', ')}{r.note ? ` · “${r.note}”` : ''}</span>
                {r.state === 'requested' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="datetime-local" min={minAt} value={bookAt[r.id] || ''} onChange={e => setBookAt(b => ({ ...b, [r.id]: e.target.value }))} style={{ padding: 7, borderRadius: 8, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit' }} />
                  <select value={dur} onChange={e => setDur(Number(e.target.value))} style={{ padding: 7, borderRadius: 8, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit' }}><option value={20}>20 min</option><option value={10}>10 min</option></select>
                  <button style={btn('#22a85a')} disabled={busy || !bookAt[r.id]} onClick={() => act(`requests/${r.id}/book`, { startsAt: new Date(bookAt[r.id]).toISOString(), durationMin: dur })}>Book in owner&apos;s hours</button>
                  <button style={btn('transparent', 'inherit')} disabled={busy} onClick={() => act(`requests/${r.id}/decline`, {})}>Decline</button>
                  <small style={{ opacity: .65, width: '100%' }}>Times are Malta time. The owner confirms the booked time in NEXUS Sync; the visitor sees each step here.</small>
                </div>}
              </div>
            ))}
            {conv.status === 'open' && <form onSubmit={e => { e.preventDefault(); if (text.trim()) { act('messages', { body: text }); setText('') } }} style={{ display: 'flex', gap: 8 }}>
              <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="Reply to the visitor" style={{ flex: 1, padding: 10, borderRadius: 12, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit', font: 'inherit' }} />
              <button style={btn('#ef6046')} disabled={busy || !text.trim()}>Send</button>
            </form>}
          </>}
        </div>
      </div>
      <style>{`@media (max-width: 860px) { .mpi-split { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  )
}
