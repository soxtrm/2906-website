'use client'
// /crm/deal-rooms — NEXUS Deal Room (2026-11-21, Milestone 3). One workspace per qualifying Marketplace enquiry.
// LEFT the client side (the real conversation, replies go through the Marketplace inbox API), CENTRE the deal controls
// (property, stage stepper, next action, timeline, internal notes; payments explicitly not handled yet), RIGHT the
// agent / owner side (only what ARGUS knows about the owner's confirmation; never owner identity or contact).
// Phones / tablets: the three panels become tabs.
import { useCallback, useEffect, useRef, useState } from 'react'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

type Row = { id: string; stage: string; label: string; ref: string; client: string; clientRole: string; home: string; unread: number; agent: string | null; changedAt: string }
type Stage = { key: string; label: string; state: 'done' | 'now' | 'next' | 'off' }
type Ev = { id: number; kind: string; actor: string; internal: boolean; data: Record<string, unknown>; at: string; by: string | null }
type Deal = {
  id: string; stage: string; label: string; stages: Stage[]; nextAction: string; allowed: string[]; conversationId: string; createdAt: string
  property: { id?: number; ref: string; town?: string; type?: string; bedrooms?: number; bathrooms?: number; price?: number | null; status?: string; photo?: string | null }
  client: { name: string; role: string; email: string | null; phone: string | null }
  agent: { id: number; name: string } | null
  owner: { viewing: { requestId: number; startsAt: string | null; state: string }[] }
  requests: { id: number; status: string; preferred: { date: string; part: string }[]; note: string | null; startsAt: string | null }[]
  messages: { id: number; from: string; kind: string; text: string; at: string }[]
  timeline: Ev[]; payments: { status: string; note: string }
}

export default function Page() { return <CrmProvider><CrmShell title="Deal Rooms" subtitle="From a viewing request to a signed contract: one workspace per enquiry"><Deals /></CrmShell></CrmProvider> }

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const LABEL: Record<string, string> = { viewing_requested: 'Viewing requested', viewing_booked: 'Viewing booked', viewing_done: 'Viewing done', offer: 'Offer', terms_agreed: 'Terms agreed', contract: 'Contract', completed: 'Completed', cancelled: 'Cancelled' }
const OWNER: Record<string, string> = { waiting_owner: 'Waiting for the owner', confirmed: 'Confirmed by the owner', not_possible: 'The owner could not confirm' }
const evText = (e: Ev) => e.kind === 'created' ? 'Deal Room opened (viewing request)' : e.kind === 'viewing_requested' ? 'The client asked for a viewing'
  : e.kind === 'viewing_booked' ? `Viewing booked${e.data.startsAt ? ` for ${when(String(e.data.startsAt))}` : ''}` : e.kind === 'viewing_declined' ? 'Viewing days declined'
  : e.kind === 'stage' ? `${LABEL[String(e.data.from)] || e.data.from} → ${LABEL[String(e.data.to)] || e.data.to}` : e.kind === 'note' ? String(e.data.text || '') : e.kind

function Deals() {
  const { me } = useCrm()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [scope, setScope] = useState<'open' | 'closed'>('open')
  const [sel, setSel] = useState<string | null>(null)
  const [deal, setDeal] = useState<Deal | null>(null)
  const [tab, setTab] = useState<'client' | 'deal' | 'agent'>('deal')
  const [text, setText] = useState(''), [note, setNote] = useState(''), [stageNote, setStageNote] = useState('')
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const load = useCallback(async () => { try { setRows((await crmFetch(`deal-rooms/?stage=${scope}`)).deals); setErr(null) } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.') } }, [scope])
  const open = useCallback(async (id: string) => { setSel(id); try { setDeal((await crmFetch(`deal-rooms/${id}`)).deal) } catch (e) { setErr(e instanceof Error ? e.message : 'Could not open.') } }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('id'); if (id) open(id) }, [open])
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible') { load(); if (sel) open(sel) } }, 15000); return () => clearInterval(t) }, [load, open, sel])
  const run = async (fn: () => Promise<{ deal?: Deal }>) => { setBusy(true); try { const r = await fn(); if (r.deal) setDeal(r.deal); setErr(null); await load() } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') } setBusy(false) }
  const send = () => deal && text.trim() && run(async () => { await crmJson(`marketplace-inbox/${deal.conversationId}/messages`, 'POST', { body: text }); setText(''); return crmFetch(`deal-rooms/${deal.id}`) })
  const card: React.CSSProperties = { background: 'var(--crm-card)', border: '1px solid var(--crm-border)', borderRadius: 16, padding: 14, minWidth: 0 }
  const btn = (primary = false): React.CSSProperties => ({ padding: '8px 13px', borderRadius: 10, border: primary ? 0 : '1px solid var(--crm-border)', background: primary ? 'var(--crm-text, #111)' : 'transparent', color: primary ? 'var(--crm-bg, #fff)' : 'inherit', fontWeight: 650, cursor: 'pointer' })
  const muted: React.CSSProperties = { opacity: .7, fontSize: 13, margin: 0 }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {(['open', 'closed'] as const).map(s => <button key={s} style={btn(scope === s)} onClick={() => setScope(s)}>{s === 'open' ? 'Open deals' : 'Completed / cancelled'}</button>)}
        <span style={muted}>A Deal Room opens when a client asks for a viewing. Messages stay in one conversation with the Marketplace inbox.</span>
      </div>
      {err && <p style={{ color: '#d93f5c', margin: 0 }}>{err}</p>}
      <div className="dr-layout">
        <div style={{ ...card, padding: 8, display: 'grid', gap: 6, alignContent: 'start' }}>
          {!rows ? <p style={{ padding: 10, opacity: .6 }}>Loading…</p> : !rows.length ? <p style={{ padding: 10, opacity: .6 }}>No Deal Rooms {scope === 'open' ? 'open' : 'closed'} yet.</p> : rows.map(r => (
            <button key={r.id} onClick={() => open(r.id)} style={{ textAlign: 'left', display: 'grid', gap: 3, padding: '10px 11px', borderRadius: 12, border: '1px solid var(--crm-border)', background: sel === r.id ? 'rgba(127,127,127,.14)' : 'transparent', color: 'inherit', cursor: 'pointer' }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{r.client}{r.clientRole === 'agent' ? ' · agent' : ''}</b>{r.unread > 0 && <small style={{ background: '#e0453a', color: '#fff', borderRadius: 999, padding: '0 7px', fontWeight: 800 }}>{r.unread}</small>}</span>
              <span style={{ fontSize: 13, opacity: .8 }}>{r.home} · Ref {r.ref}</span>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{r.label} <span style={{ opacity: .55, fontWeight: 500 }}>· {when(r.changedAt)}{r.agent ? ` · ${r.agent}` : ''}</span></span>
            </button>))}
        </div>
        {!deal ? <div style={card}><p style={{ opacity: .6 }}>Choose a Deal Room.</p></div> : <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <div className="dr-tabs" role="tablist">{(['client', 'deal', 'agent'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} style={btn(tab === t)} onClick={() => setTab(t)}>{t === 'client' ? 'Client' : t === 'deal' ? 'Deal' : 'Agent & owner'}</button>)}</div>
          <div className="dr-panels" data-tab={tab}>
            {/* LEFT: client side */}
            <section style={card} className="dr-p dr-client">
              <b style={{ fontSize: 16 }}>{deal.client.name}</b><p style={muted}>{deal.client.role === 'agent' ? 'Agent for a client' : 'Home seeker'} · {[deal.client.email, deal.client.phone].filter(Boolean).join(' · ') || 'no contact given'}</p>
              <div style={{ display: 'grid', gap: 6, margin: '10px 0', maxHeight: '52vh', overflow: 'auto' }}>
                {deal.messages.map(m => m.from === 'system'
                  ? <p key={m.id} style={{ justifySelf: 'center', margin: 0, fontSize: 12, padding: '5px 9px', borderRadius: 10, background: 'rgba(127,127,127,.12)' }}>{m.text}</p>
                  : <div key={m.id} style={{ justifySelf: m.from === 'staff' ? 'end' : 'start', maxWidth: '85%', padding: '7px 10px', borderRadius: 13, background: m.from === 'staff' ? 'var(--crm-text, #111)' : 'rgba(127,127,127,.12)', color: m.from === 'staff' ? 'var(--crm-bg, #fff)' : 'inherit' }}>
                    {m.kind === 'viewing_request' && <div style={{ fontSize: 10.5, fontWeight: 800, opacity: .8 }}>VIEWING REQUEST</div>}
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{m.text}</div><div style={{ fontSize: 10, opacity: .6, textAlign: 'right' }}>{when(m.at)}</div></div>)}
              </div>
              <form onSubmit={e => { e.preventDefault(); send() }} style={{ display: 'flex', gap: 8 }}>
                <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="Reply to the client" style={{ flex: 1, minWidth: 0, padding: 9, borderRadius: 12, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit', font: 'inherit' }} />
                <button style={btn(true)} disabled={busy || !text.trim()}>Send</button>
              </form>
              <p style={{ ...muted, marginTop: 6 }}>Book or decline viewing days in the <a href={`/crm/marketplace-inbox`} style={{ color: 'inherit', fontWeight: 700 }}>Marketplace inbox</a> (inside the owner&apos;s hours).</p>
            </section>
            {/* CENTRE: deal controls */}
            <section style={card} className="dr-p dr-centre">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {deal.property.photo && /* eslint-disable-next-line @next/next/no-img-element */ <img src={deal.property.photo.replace('/image/upload/', '/image/upload/w_200,q_auto,f_auto,c_fill,h_140/')} alt="" style={{ width: 92, height: 64, objectFit: 'cover', borderRadius: 10 }} />}
                <div style={{ minWidth: 0 }}><b>{deal.property.bedrooms ? `${deal.property.bedrooms}-Bedroom ` : ''}{deal.property.type ? deal.property.type[0].toUpperCase() + deal.property.type.slice(1) : 'Home'}{deal.property.town ? ` in ${deal.property.town}` : ''}</b>
                  <p style={muted}>Ref {deal.property.ref}{deal.property.price ? ` · €${deal.property.price.toLocaleString('en-GB')}/month` : ''}{deal.property.status ? ` · ${deal.property.status.replace(/_/g, ' ')}` : ''}</p></div>
              </div>
              <ol style={{ listStyle: 'none', padding: 0, margin: '14px 0', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {deal.stages.map(s => <li key={s.key} style={{ padding: '4px 9px', borderRadius: 999, fontSize: 12, fontWeight: 700, border: '1px solid var(--crm-border)', background: s.state === 'now' ? 'var(--crm-text, #111)' : s.state === 'done' ? 'rgba(34,168,90,.14)' : 'transparent', color: s.state === 'now' ? 'var(--crm-bg, #fff)' : 'inherit', opacity: s.state === 'next' || s.state === 'off' ? .55 : 1 }}>{s.state === 'done' ? '✓ ' : ''}{s.label}</li>)}
              </ol>
              {deal.stage === 'cancelled' && <p style={{ margin: '0 0 10px', fontWeight: 700 }}>Cancelled</p>}
              <div style={{ padding: 12, borderRadius: 12, background: 'rgba(127,127,127,.08)', display: 'grid', gap: 8 }}>
                <b style={{ fontSize: 13 }}>Next step</b><span style={{ fontSize: 14 }}>{deal.nextAction}</span>
                {deal.allowed.length > 0 && <>
                  <input value={stageNote} onChange={e => setStageNote(e.target.value)} placeholder="Internal reason (optional, never shown to the client)" style={{ padding: 8, borderRadius: 10, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit' }} />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{deal.allowed.map(s => <button key={s} style={btn(s !== 'cancelled')} disabled={busy} onClick={() => run(async () => { const r = await crmJson(`deal-rooms/${deal.id}/stage`, 'POST', { stage: s, note: stageNote }); setStageNote(''); return r })}>{s === 'cancelled' ? 'Cancel deal' : `Mark: ${LABEL[s]}`}</button>)}</div>
                </>}
              </div>
              <DealWork deal={deal} isAdmin={me?.role === 'admin'} busy={busy} run={run} />
              <h4 style={{ margin: '14px 0 6px' }}>Timeline</h4>
              <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                {deal.timeline.map(e => <li key={e.id} style={{ display: 'grid', gap: 1, padding: '6px 9px', borderRadius: 10, border: e.internal ? '1px dashed var(--crm-border)' : '1px solid var(--crm-border)' }}>
                  <span style={{ fontSize: 13.5 }}>{e.internal ? '🔒 ' : ''}{evText(e)}</span><small style={{ opacity: .6 }}>{when(e.at)}{e.by ? ` · ${e.by}` : e.actor === 'visitor' ? ' · client' : ''}{e.internal ? ' · internal' : ''}</small></li>)}
              </ol>
              <form onSubmit={e => { e.preventDefault(); if (note.trim()) run(async () => { const r = await crmJson(`deal-rooms/${deal.id}/notes`, 'POST', { text: note }); setNote(''); return r }) }} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="Internal note" style={{ flex: 1, minWidth: 0, padding: 8, borderRadius: 10, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit' }} />
                <button style={btn()} disabled={busy || !note.trim()}>Add</button>
              </form>
            </section>
            {/* RIGHT: agent / owner side */}
            <section style={card} className="dr-p dr-agent">
              <b>Listing agent</b><p style={muted}>{deal.agent ? deal.agent.name : 'Not assigned yet: the first reply takes it.'}</p>
              <b style={{ display: 'block', marginTop: 14 }}>Owner</b>
              {!deal.owner.viewing.length ? <p style={muted}>No viewing booked yet. The owner sees booked viewings in NEXUS Sync and confirms them there.</p>
                : deal.owner.viewing.map(v => <p key={v.requestId} style={{ margin: '6px 0', fontSize: 14 }}><b>{OWNER[v.state] || v.state}</b>{v.startsAt ? ` · ${when(v.startsAt)}` : ''}</p>)}
              <p style={{ ...muted, marginTop: 14 }}>Owner identity and contact details are not part of the Deal Room. Contact exchange comes later, only with both sides&apos; consent.</p>
            </section>
          </div>
        </div>}
      </div>
      <style>{`
        .dr-layout { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 14px; align-items: start; }
        .dr-tabs { display: none; gap: 6px; }
        .dr-panels { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) minmax(220px, .7fr); gap: 12px; align-items: start; }
        @media (max-width: 1280px) { .dr-panels { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .dr-agent { grid-column: 1 / -1; } }
        @media (max-width: 1000px) {
          .dr-layout { grid-template-columns: 1fr; }
          .dr-tabs { display: flex; }
          .dr-panels { grid-template-columns: 1fr; }
          .dr-panels .dr-p { display: none; }
          .dr-panels[data-tab=client] .dr-client, .dr-panels[data-tab=deal] .dr-centre, .dr-panels[data-tab=agent] .dr-agent { display: block; }
        }`}</style>
    </div>
  )
}

// ── M5: viewing booking, documents & evidence, drafts, payment requests (centre panel) ──────────────────────
type Doc = { id: number; kind: string; title: string; mime: string | null; size: number | null; version: number; from: string; internal: boolean; scan: string; at: string; sha256?: string; downloads?: number }
type Pay = { id: number; kind: string; label: string; amount: number; status: string; statusLabel: string; reference: string | null; verifiedVia: string | null; next: string[] }
const KIND: Record<string, string> = { photo: 'Photo', video: 'Video', document: 'Document', condition_evidence: 'Condition evidence', contract_draft: 'Contract draft', invoice_draft: 'Invoice draft', signed_document: 'Signed document' }
const PAYNEXT: Record<string, string> = { initiated: 'Mark initiated', pending: 'Mark pending', verified: 'Verify (admin)', failed: 'Mark failed', refunded: 'Mark refunded', cancelled: 'Cancel', requested: 'Request again' }
function DealWork({ deal, isAdmin, busy, run }: { deal: Deal & { documents?: Doc[]; paymentRequests?: Pay[] }; isAdmin: boolean; busy: boolean; run: (fn: () => Promise<{ deal?: Deal }>) => void }) {
  const [bookAt, setBookAt] = useState<Record<number, string>>({}), [dur, setDur] = useState(20)
  const [up, setUp] = useState<{ kind: string; internal: boolean }>({ kind: 'document', internal: false })
  const [c, setC] = useState({ monthlyRent: '', deposit: '', startDate: '', months: '12', notes: '' })
  const [inv, setInv] = useState([{ label: 'Security deposit', amount: '' }, { label: 'First month', amount: '' }])
  const [pay, setPay] = useState({ kind: 'deposit', label: 'Security deposit', amount: '' })
  const [ref, setRef] = useState<Record<number, string>>({})
  const [err, setErr] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const sec: React.CSSProperties = { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--crm-border)', display: 'grid', gap: 8 }
  const inp: React.CSSProperties = { padding: 7, borderRadius: 9, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit', minWidth: 0 }
  const b = (primary = false): React.CSSProperties => ({ padding: '7px 11px', borderRadius: 9, border: primary ? 0 : '1px solid var(--crm-border)', background: primary ? 'var(--crm-text, #111)' : 'transparent', color: primary ? 'var(--crm-bg, #fff)' : 'inherit', fontWeight: 650, cursor: 'pointer', fontSize: 13 })
  const minAt = new Date(Date.now() + 3600e3).toISOString().slice(0, 16)
  const docs = deal.documents || [], pays = deal.paymentRequests || []
  const upload = (f: File) => {
    setErr(''); if (f.size > 3 * 1024 * 1024) { setErr('Up to 3 MB per file here.'); return }
    run(async () => {
      const dataBase64 = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(new Error('read')); r.readAsDataURL(f) })
      const r = await crmJson(`deal-rooms/${deal.id}/documents`, 'POST', { kind: up.kind, title: f.name.replace(/\.[^.]+$/, ''), filename: f.name, dataBase64, visibility: up.internal ? 'staff' : 'parties' })
      if (file.current) file.current.value = ''; return r
    })
  }
  const download = async (d: Doc) => {
    setErr('')
    const r = await fetch(`/api/crm/deal-rooms/${deal.id}/documents/${d.id}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.message || 'Not available.'); return }
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url
    a.download = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || d.title; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  const open = !['completed', 'cancelled'].includes(deal.stage)
  return (
    <>
      {deal.requests.some(r => r.status === 'requested') && <div style={sec}><b>Viewing</b>
        {deal.requests.filter(r => r.status === 'requested').map(r => <div key={r.id} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 13, width: '100%' }}>Requested: {r.preferred.map(p => `${new Date(`${p.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}${p.part !== 'any' ? ` (${p.part})` : ''}`).join(', ')}{r.note ? ` · “${r.note}”` : ''}</span>
          <input type="datetime-local" min={minAt} value={bookAt[r.id] || ''} onChange={e => setBookAt(x => ({ ...x, [r.id]: e.target.value }))} style={inp} />
          <select value={dur} onChange={e => setDur(Number(e.target.value))} style={inp}><option value={20}>20 min</option><option value={10}>10 min</option></select>
          <button style={b(true)} disabled={busy || !bookAt[r.id]} onClick={() => run(async () => { await crmJson(`marketplace-inbox/${deal.conversationId}/requests/${r.id}/book`, 'POST', { startsAt: new Date(bookAt[r.id]).toISOString(), durationMin: dur }); return crmFetch(`deal-rooms/${deal.id}`) })}>Book in owner&apos;s hours</button>
        </div>)}
        <small style={{ opacity: .65 }}>The time must lie inside the owner&apos;s viewing hours; the owner confirms it in NEXUS Sync and the client sees each step.</small></div>}

      <div style={sec}><b>Documents &amp; evidence</b>
        {!docs.length ? <small style={{ opacity: .6 }}>None yet. The client can add photos and documents from the Marketplace chat.</small> : docs.map(d => (
          <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', borderRadius: 10, border: d.internal ? '1px dashed var(--crm-border)' : '1px solid var(--crm-border)' }}>
            <span style={{ flex: 1, minWidth: 0, display: 'grid' }}><span style={{ fontSize: 13.5, fontWeight: 650 }}>{d.internal ? '🔒 ' : ''}{d.title}{d.version > 1 ? ` · v${d.version}` : ''}</span>
              <small style={{ opacity: .65 }}>{KIND[d.kind] || d.kind} · {d.from} · {when(d.at)}{d.scan === 'pending' ? ' · virus check pending' : ''}{d.downloads ? ` · ${d.downloads} download${d.downloads === 1 ? '' : 's'}` : ''}{d.sha256 ? ` · sha256 ${d.sha256.slice(0, 10)}…` : ''}</small></span>
            <button style={b()} disabled={d.scan === 'pending'} onClick={() => download(d)}>Download</button>
          </div>))}
        {open && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={up.kind} onChange={e => setUp(u => ({ ...u, kind: e.target.value }))} style={inp}>{['document', 'photo', 'condition_evidence', 'signed_document', 'video'].map(k => <option key={k} value={k}>{KIND[k]}</option>)}</select>
          <label style={{ fontSize: 13, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={up.internal} onChange={e => setUp(u => ({ ...u, internal: e.target.checked }))} />Internal only</label>
          <input ref={file} type="file" hidden accept="image/jpeg,image/png,image/webp,image/heic,application/pdf,video/mp4,video/quicktime" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} />
          <button style={b(true)} disabled={busy} onClick={() => file.current?.click()}>Upload</button>
        </div>}</div>

      {open && <div style={sec}><b>Contract draft</b>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 }}>
          <input style={inp} placeholder="Monthly rent €" inputMode="decimal" value={c.monthlyRent} onChange={e => setC({ ...c, monthlyRent: e.target.value })} />
          <input style={inp} placeholder="Deposit €" inputMode="decimal" value={c.deposit} onChange={e => setC({ ...c, deposit: e.target.value })} />
          <input style={inp} type="date" value={c.startDate} onChange={e => setC({ ...c, startDate: e.target.value })} aria-label="Start date" />
          <input style={inp} placeholder="Months" inputMode="numeric" value={c.months} onChange={e => setC({ ...c, months: e.target.value })} />
        </div>
        <input style={inp} placeholder="Further terms (optional)" value={c.notes} onChange={e => setC({ ...c, notes: e.target.value })} />
        <button style={b(true)} disabled={busy || !c.monthlyRent || !c.startDate} onClick={() => run(() => crmJson(`deal-rooms/${deal.id}/drafts/contract`, 'POST', c))}>Generate contract draft</button></div>}

      {open && <div style={sec}><b>Invoice draft</b>
        {inv.map((it, i) => <div key={i} style={{ display: 'flex', gap: 6 }}><input style={{ ...inp, flex: 2 }} value={it.label} onChange={e => setInv(v => v.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} /><input style={{ ...inp, flex: 1 }} placeholder="€" inputMode="decimal" value={it.amount} onChange={e => setInv(v => v.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} /></div>)}
        <div style={{ display: 'flex', gap: 6 }}><button style={b()} onClick={() => setInv(v => [...v, { label: '', amount: '' }].slice(0, 10))}>Add line</button>
          <button style={b(true)} disabled={busy || !inv.some(i => i.label && i.amount)} onClick={() => run(() => crmJson(`deal-rooms/${deal.id}/drafts/invoice`, 'POST', { items: inv }))}>Generate invoice draft</button></div></div>}

      <div style={sec}><b>Payment requests</b>
        {pays.map(p => <div key={p.id} style={{ display: 'grid', gap: 6, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--crm-border)' }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5 }}><b>{p.label}</b><span>€{p.amount.toLocaleString('en-GB')}</span></span>
          <small style={{ fontWeight: 700, color: p.status === 'verified' ? '#1d7a4a' : 'inherit' }}>{p.statusLabel}{p.reference ? ` · ref ${p.reference}` : ''}{p.verifiedVia ? ` · ${p.verifiedVia.replace('_', ' ')}` : ''}</small>
          {p.next.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {p.next.includes('verified') && isAdmin && <input style={inp} placeholder="Bank / provider reference" value={ref[p.id] || ''} onChange={e => setRef(r => ({ ...r, [p.id]: e.target.value }))} />}
            {p.next.filter(s => s !== 'verified' || isAdmin).map(s => <button key={s} style={b(s === 'verified')} disabled={busy || (s === 'verified' && !ref[p.id])} onClick={() => run(() => crmJson(`deal-rooms/${deal.id}/payments/${p.id}/status`, 'POST', { status: s, reference: ref[p.id] }))}>{PAYNEXT[s] || s}</button>)}
          </div>}
        </div>)}
        {open && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select style={inp} value={pay.kind} onChange={e => setPay({ ...pay, kind: e.target.value, label: ({ deposit: 'Security deposit', first_rent: 'First month', agency_fee: 'Agency fee', other: '' } as Record<string, string>)[e.target.value] })}><option value="deposit">Deposit</option><option value="first_rent">First rent</option><option value="agency_fee">Agency fee</option><option value="other">Other</option></select>
          <input style={{ ...inp, flex: 1, minWidth: 150 }} value={pay.label} onChange={e => setPay({ ...pay, label: e.target.value })} placeholder="Label" />
          <input style={{ ...inp, width: 100 }} placeholder="€" inputMode="decimal" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} />
          <button style={b(true)} disabled={busy || !pay.amount} onClick={() => run(async () => { const r = await crmJson(`deal-rooms/${deal.id}/payments`, 'POST', pay); setPay(x => ({ ...x, amount: '' })); return r })}>Request payment</button>
        </div>}
        <small style={{ opacity: .65 }}>NEXUS holds no money. A request is not a receipt; only an administrator can mark a payment verified, after reconciling it with a bank or provider reference.</small></div>
      {err && <p style={{ color: '#d93f5c', margin: '8px 0 0' }}>{err}</p>}
    </>
  )
}
