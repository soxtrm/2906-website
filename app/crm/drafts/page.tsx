'use client'
// ============================================================================
// /crm/drafts — ARGUS Property Drafts (Kev, 2026-11-21)
// Everything owners sent about their properties, already structured: review in
// the evening, fix what needs fixing inline, select the good ones and upload or
// publish them in one go. Agents see their own drafts, administrators all.
// Data: /api/crm/property-drafts (list · PATCH :no · POST actions · GET runs/:id)
// Upload = internal ARGUS listing. Publish = website, only with the owner's
// permission recorded by an agent (never read from an owner message).
// ============================================================================
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BadgeCheck, Check, ExternalLink, Globe, ImageOff, Loader2, RefreshCw, Search, ShieldCheck, Upload, X, XCircle } from 'lucide-react'
import { CrmProvider, CrmShell, useCrm, useIsMobile } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'
import '../intake.css'
import './drafts.css'

type Fact = { value: any; quote?: string; method?: string; confidence?: string; ambiguity?: string; confirmed?: boolean; history?: { value: any; quote?: string; at?: string }[]; source_message_id?: string }
type Media = { id: number; url: string | null; state: string; at: string }
type Draft = {
  id: number; draft_no: number; status: string; status_reason: string | null; session: string; agent_id: number; agent_username: string | null
  phone_last4: string; unit_label: string | null; facts: Record<string, Fact>; missing: string[]; ambiguities: { text: string; resolved?: boolean; at?: string }[]
  original_texts: { message_id: string; text: string; at: string }[]; duplicate_ref: string | null; property_id: number | null; listing_ref: string | null
  upload_attempts: number; last_error: string | null; publish_permission_at: string | null; publish_permission_note: string | null; permission_by: string | null
  published_at: string | null; publish_result: { destinations?: { website?: { ok: boolean; url: string; http: number | string } } } | null
  listing_published: boolean | null; listing_verification: string | null; owner_name: string | null; media: Media[]; public_description: string; updated_at: string; first_message_at: string
}
type Loose = { id: number; url: string; p9: string; at: string }

const STATUS: Record<string, { label: string; tone: string }> = {
  collecting: { label: 'Collecting', tone: 'info' }, ready: { label: 'Ready', tone: 'ok' }, needs_review: { label: 'Needs review', tone: 'warn' },
  duplicate_candidate: { label: 'Possible duplicate', tone: 'warn' }, uploading: { label: 'Uploading', tone: 'info' }, uploaded: { label: 'Internal listing', tone: 'ok' },
  publishing: { label: 'Publishing', tone: 'info' }, published: { label: 'Published', tone: 'live' }, failed: { label: 'Failed · retry', tone: 'error' }, withdrawn: { label: 'Withdrawn', tone: 'muted' },
}
const FILTERS: { key: string; label: string; match: (d: Draft) => boolean }[] = [
  { key: 'open', label: 'To review', match: d => ['collecting', 'ready', 'needs_review', 'duplicate_candidate', 'failed'].includes(d.status) },
  { key: 'ready', label: 'Ready', match: d => d.status === 'ready' },
  { key: 'needs', label: 'Needs attention', match: d => ['needs_review', 'duplicate_candidate', 'failed'].includes(d.status) },
  { key: 'collecting', label: 'Collecting', match: d => d.status === 'collecting' },
  { key: 'uploaded', label: 'Internal listings', match: d => d.status === 'uploaded' },
  { key: 'published', label: 'Published', match: d => d.status === 'published' },
  { key: 'withdrawn', label: 'Withdrawn', match: d => d.status === 'withdrawn' },
  { key: 'all', label: 'All', match: () => true },
]
const MISSING: Record<string, string> = { identity: 'type / bedrooms', locality: 'locality', price: 'price', availability: 'availability', photos: 'photos' }
const TYPES = ['apartment', 'penthouse', 'maisonette', 'townhouse', 'house', 'villa', 'studio', 'duplex', 'bungalow', 'house of character', 'room', 'office', 'commercial', 'garage']
const FEATURES = ['furnished', 'unfurnished', 'air_conditioning', 'balcony', 'terrace', 'garden', 'pool', 'lift', 'sea_view', 'parking', 'garage', 'washing_machine', 'dishwasher', 'storage_room', 'study', 'internet']
const title = (s: string) => String(s || '').replace(/_/g, ' ').replace(/\b([a-z])/g, c => c.toUpperCase())
const euro = (n: number) => `€${Number(n).toLocaleString('en-GB')}`
const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }
function headline(d: Draft) {
  const b = d.facts.bedrooms?.value
  return [b != null ? (b === 0 ? 'Studio' : `${b}-Bedroom`) : null, d.facts.property_type ? title(d.facts.property_type.value) : 'Property'].filter(Boolean).join(' ')
}
function availability(f?: Fact) {
  const a = f?.value
  if (!a) return null
  if (a.kind === 'now') return 'Available now'
  if (a.kind === 'date') return `From ${new Date(`${a.date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  if (a.kind === 'month') return `From ${a.label} (month only)`
  return `${a.text} (approx.)`
}
const openQuestions = (d: Draft) => d.ambiguities.filter(a => !a.resolved).length + Object.values(d.facts).filter(f => f?.ambiguity && !f.confirmed).length
const lowFacts = (d: Draft) => Object.entries(d.facts).filter(([k, f]) => k !== 'duplicate_override' && f && (f.confidence === 'low' || f.confidence === 'medium') && f.method !== 'llm').map(([k]) => k)

export default function DraftsPage() {
  return <CrmProvider><Suspense fallback={null}><Drafts /></Suspense></CrmProvider>
}

function Drafts() {
  const { me } = useCrm()
  const isMobile = useIsMobile()
  const [data, setData] = useState<{ drafts: Draft[]; unassignedMedia: Loose[] } | null>(null)
  const [filter, setFilter] = useState('open')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [runText, setRunText] = useState<string | null>(null)
  const loadRef = useRef(0)

  const load = useCallback(async () => {
    const my = ++loadRef.current
    try { const d = await crmFetch('property-drafts'); if (my === loadRef.current) setData(d) }
    catch (e: any) { if (my === loadRef.current) { setData({ drafts: [], unassignedMedia: [] }); setToast({ text: e?.message || 'Could not load drafts', tone: 'error' }) } }
  }, [])
  useEffect(() => { load(); const t = window.setInterval(() => { if (document.visibilityState === 'visible' && !busy) load() }, 30_000); return () => window.clearInterval(t) }, [load, busy])
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 6000); return () => window.clearTimeout(t) }, [toast])

  const all = data?.drafts || []
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.key, all.filter(f.match).length])), [all])
  const shown = useMemo(() => {
    const f = FILTERS.find(x => x.key === filter) || FILTERS[0]
    const needle = q.trim().toLowerCase()
    return all.filter(f.match).filter(d => !needle || `#${d.draft_no} ${d.facts.locality?.value || ''} ${d.owner_name || ''} ${d.phone_last4} ${d.listing_ref || ''} ${headline(d)}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.status === 'ready' ? -1 : 0) - (b.status === 'ready' ? -1 : 0) || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  }, [all, filter, q])
  const selected = shown.filter(d => picked.has(d.draft_no))
  const current = all.find(d => d.draft_no === open) || (!isMobile ? shown[0] : null) || null

  const toggle = (no: number) => setPicked(s => { const n = new Set(s); n.has(no) ? n.delete(no) : n.add(no); return n })
  const pickAll = () => setPicked(s => (shown.every(d => s.has(d.draft_no)) ? new Set() : new Set(shown.map(d => d.draft_no))))

  async function runAction(action: 'upload' | 'publish', nos: number[]) {
    if (!nos.length) return
    setBusy(action); setRunText(null)
    try {
      const r = await crmJson('property-drafts/actions', 'POST', { action, drafts: nos })
      for (let i = 0; i < 180; i++) {
        await new Promise(res => setTimeout(res, 2000))
        const s = await crmFetch(`property-drafts/runs/${r.runId}`)
        const doneN = s.items.filter((x: any) => !['pending', 'processing'].includes(x.state)).length
        setRunText(`${action === 'publish' ? 'Publishing' : 'Uploading'} ${doneN} of ${s.items.length}…`)
        if (s.state === 'done') { setRunText(s.summary); break }
      }
      setPicked(new Set()); await load()
    } catch (e: any) { setToast({ text: e?.message || 'Action failed', tone: 'error' }) }
    finally { setBusy(null) }
  }
  async function simpleAction(action: 'permission' | 'revoke_permission' | 'withdraw', nos: number[]) {
    if (!nos.length) return
    if (action === 'permission' && !window.confirm(`Confirm that the owner${nos.length > 1 ? 's' : ''} of ${nos.length} draft${nos.length > 1 ? 's' : ''} agreed that the propert${nos.length > 1 ? 'ies are' : 'y is'} advertised publicly. This is recorded with your name.`)) return
    setBusy(action)
    try {
      const r = await crmJson('property-drafts/actions', 'POST', { action, drafts: nos })
      setToast({ text: `${r.done.length} updated${r.errors.length ? ` · ${r.errors.length} not changed` : ''}`, tone: r.errors.length ? 'error' : 'ok' })
      await load()
    } catch (e: any) { setToast({ text: e?.message || 'Action failed', tone: 'error' }) }
    finally { setBusy(null) }
  }

  const chips = (
    <div className="ib-filters" role="tablist" aria-label="Draft filter">
      {FILTERS.map(f => <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'is-active' : ''} onClick={() => { setFilter(f.key); setPicked(new Set()) }}>{f.label}<span>{counts[f.key] ?? 0}</span></button>)}
      <label className="dr-search"><Search size={14} aria-hidden /><input value={q} onChange={e => setQ(e.target.value)} placeholder="#, locality, owner" aria-label="Search drafts" /></label>
      <button type="button" className="ib-refresh" onClick={() => load()} aria-label="Refresh"><RefreshCw size={14} /></button>
    </div>
  )
  const ready = all.filter(d => d.status === 'ready').length
  const subtitle = data ? `${ready} ready · ${counts.needs || 0} need attention · ${counts.collecting || 0} collecting · ${counts.published || 0} published` : 'Loading…'

  return (
    <CrmShell title="Property Drafts" subtitle={subtitle} filterBar={chips} dark>
      <div className="ib-page dr-page">
        {selected.length > 0 && (
          <div className="dr-bulk" role="region" aria-label="Selected drafts">
            <strong>{selected.length} selected</strong>
            <button type="button" className="ib-btn" disabled={!!busy} onClick={() => simpleAction('permission', selected.map(d => d.draft_no))}><ShieldCheck size={15} />Owner agreed to advertise</button>
            <button type="button" className="ib-btn" disabled={!!busy} onClick={() => runAction('upload', selected.map(d => d.draft_no))}>{busy === 'upload' ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}Upload to ARGUS</button>
            <button type="button" className="ib-btn primary" disabled={!!busy} onClick={() => runAction('publish', selected.map(d => d.draft_no))}>{busy === 'publish' ? <Loader2 size={15} className="spin" /> : <Globe size={15} />}Publish {selected.filter(d => d.publish_permission_at).length}/{selected.length}</button>
            <button type="button" className="ib-btn ghost danger" disabled={!!busy} onClick={() => simpleAction('withdraw', selected.map(d => d.draft_no))}>Withdraw</button>
            <button type="button" className="ib-btn ghost" onClick={() => setPicked(new Set())} aria-label="Clear selection"><X size={15} /></button>
            <small>Publish only takes drafts whose owner permission is recorded; incomplete ones are skipped with the reason.</small>
          </div>
        )}
        {runText && <pre className="dr-run" role="status">{runText}<button type="button" onClick={() => setRunText(null)} aria-label="Close"><X size={14} /></button></pre>}
        {data === null && <div className="ib-empty">Loading drafts…</div>}
        {data !== null && !shown.length && <div className="ib-empty"><BadgeCheck size={32} aria-hidden /><p>{filter === 'open' ? 'Nothing to review.' : 'No draft here.'}</p><small>Owners’ WhatsApp messages with property details become drafts automatically: type, rooms, locality, price, availability, photos.</small></div>}
        {shown.length > 0 && (
          <div className={isMobile ? 'dr-mobile' : 'dr-split'}>
            <div className="dr-list">
              <div className="dr-list-head"><label><input type="checkbox" checked={shown.length > 0 && shown.every(d => picked.has(d.draft_no))} onChange={pickAll} /> Select all {shown.length}</label></div>
              <ol>
                {shown.map(d => <Row key={d.id} d={d} picked={picked.has(d.draft_no)} active={current?.draft_no === d.draft_no} onPick={() => toggle(d.draft_no)} onOpen={() => setOpen(d.draft_no)} />)}
              </ol>
            </div>
            {current && (!isMobile || open) && (
              <Detail key={current.id} d={current} loose={(data?.unassignedMedia || [])} isAdmin={me?.role === 'admin'} busy={!!busy}
                onClose={isMobile ? () => setOpen(null) : undefined}
                onSaved={async (msg) => { setToast({ text: msg, tone: 'ok' }); await load() }} onError={t => setToast({ text: t, tone: 'error' })}
                onRun={(a) => runAction(a, [current.draft_no])} onSimple={(a) => simpleAction(a, [current.draft_no])} />
            )}
          </div>
        )}
      </div>
      {toast && <div className={`ib-toast ${toast.tone}`} role="status">{toast.tone === 'ok' ? <BadgeCheck size={16} /> : <XCircle size={16} />}{toast.text}</div>}
    </CrmShell>
  )
}

function Row({ d, picked, active, onPick, onOpen }: { d: Draft; picked: boolean; active: boolean; onPick: () => void; onOpen: () => void }) {
  const st = STATUS[d.status] || { label: d.status, tone: 'muted' }
  const cover = d.media.find(m => m.url)?.url
  const q = openQuestions(d)
  return (
    <li className={`dr-row ${active ? 'is-active' : ''}`}>
      <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Select draft ${d.draft_no}`} />
      <button type="button" className="dr-row-main" onClick={onOpen} aria-current={active || undefined}>
        <span className="ib-row-thumb">{cover ? <img src={cover} alt="" loading="lazy" /> : <ImageOff size={18} aria-hidden />}<b>{d.media.filter(m => m.url).length}</b></span>
        <span className="dr-row-copy">
          <span className="dr-row-top"><em>#{d.draft_no}</em><i className={`dr-pill ${st.tone}`}>{st.label}</i>{d.publish_permission_at && d.status !== 'published' && <i className="dr-pill ok" title="Owner permission recorded"><ShieldCheck size={11} />permission</i>}</span>
          <strong>{headline(d)}{d.unit_label ? ` · ${/^\d/.test(d.unit_label) ? `Flat ${d.unit_label}` : d.unit_label}` : ''} · {d.facts.locality?.value || 'locality?'}</strong>
          <small>{d.facts.price ? `${euro(d.facts.price.value.amount)}${d.facts.price.value.period === 'sale' ? '' : ' / month'}` : 'no price'} · {availability(d.facts.availability) || 'availability?'}</small>
          <small className="dr-row-meta">{d.owner_name || 'Owner'} ·{d.phone_last4} · {d.session}{d.agent_username ? ` · ${d.agent_username}` : ''} · {ago(d.updated_at)}</small>
          {(d.missing.length > 0 || q > 0 || d.duplicate_ref) && <span className="dr-row-warn">
            {d.missing.map(m => <i key={m}>{MISSING[m] || m}</i>)}
            {q > 0 && <i className="warn">{q} open question{q > 1 ? 's' : ''}</i>}
            {d.duplicate_ref && d.status === 'duplicate_candidate' && <i className="warn">like #{d.duplicate_ref}</i>}
          </span>}
        </span>
      </button>
    </li>
  )
}

type Form = { property_type: string; bedrooms: string; bathrooms: string; locality: string; address: string; unit_label: string; price: string; period: string; avail_kind: string; avail_date: string; avail_month: string; features: string[] }
function formOf(d: Draft): Form {
  const f = d.facts, a = f.availability?.value
  return {
    property_type: f.property_type?.value || '', bedrooms: f.bedrooms?.value != null ? String(f.bedrooms.value) : '', bathrooms: f.bathrooms?.value != null ? String(f.bathrooms.value) : '',
    locality: f.locality?.value || '', address: f.address?.value || '', unit_label: d.unit_label || '',
    price: f.price ? String(f.price.value.amount) : '', period: f.price?.value?.period || 'month',
    avail_kind: a?.kind && a.kind !== 'approximate' ? a.kind : '', avail_date: a?.kind === 'date' ? a.date : '', avail_month: a?.kind === 'month' ? a.month : '',
    features: Array.isArray(f.features?.value) ? f.features.value : [],
  }
}
function changes(d: Draft, f: Form) {
  const o = formOf(d), out: Record<string, any> = {}
  for (const k of ['property_type', 'locality', 'address', 'unit_label'] as const) if (f[k] !== o[k]) out[k] = f[k] || null
  for (const k of ['bedrooms', 'bathrooms'] as const) if (f[k] !== o[k]) out[k] = f[k] === '' ? null : Number(f[k])
  if (f.price !== o.price || f.period !== o.period) out.price = f.price ? { amount: Number(f.price), period: f.period } : null
  if (f.avail_kind !== o.avail_kind || f.avail_date !== o.avail_date || f.avail_month !== o.avail_month) {
    out.availability = !f.avail_kind ? null : f.avail_kind === 'now' ? { kind: 'now' } : f.avail_kind === 'date' ? { kind: 'date', date: f.avail_date } : { kind: 'month', month: f.avail_month }
  }
  if ([...f.features].sort().join() !== [...o.features].sort().join()) out.features = f.features
  return out
}

function Detail({ d, loose, busy, onClose, onSaved, onError, onRun, onSimple }: {
  d: Draft; loose: Loose[]; isAdmin: boolean; busy: boolean; onClose?: () => void
  onSaved: (msg: string) => void; onError: (t: string) => void; onRun: (a: 'upload' | 'publish') => void; onSimple: (a: 'permission' | 'revoke_permission' | 'withdraw') => void
}) {
  const [form, setForm] = useState<Form>(() => formOf(d))
  const [saving, setSaving] = useState(false)
  const diff = changes(d, form)
  const dirty = Object.keys(diff).length > 0
  const st = STATUS[d.status] || { label: d.status, tone: 'muted' }
  const editable = !['uploading', 'publishing'].includes(d.status)
  const q = openQuestions(d)
  const site = d.publish_result?.destinations?.website
  const mine = loose.filter(m => m.p9 && d.phone_last4 && m.p9.endsWith(d.phone_last4))
  async function patch(body: Record<string, any>, msg: string) {
    setSaving(true)
    try { await crmJson(`property-drafts/${d.draft_no}`, 'PATCH', body); onSaved(msg) }
    catch (e: any) { onError(e?.message || 'Not saved') } finally { setSaving(false) }
  }
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }))
  const prov = (k: string) => {
    const f = d.facts[k]
    if (!f) return <small className="dr-prov none">not given</small>
    const tone = f.confidence === 'verified' || f.confidence === 'high' ? 'ok' : f.confidence === 'medium' ? 'mid' : 'low'
    return <small className={`dr-prov ${tone}`} title={f.method}>{f.confidence === 'verified' ? 'checked in ARGUS' : `“${f.quote}”`} · {f.confidence}{f.history?.length ? ` · was ${typeof f.history.at(-1)!.value === 'object' ? (f.history.at(-1)!.value.amount ? euro(f.history.at(-1)!.value.amount) : '…') : f.history.at(-1)!.value}` : ''}</small>
  }
  return (
    <section className="dr-detail" aria-label={`Draft ${d.draft_no}`}>
      <header className="dr-detail-head">
        <div>
          <span className="dr-row-top"><em>Draft #{d.draft_no}</em><i className={`dr-pill ${st.tone}`}>{st.label}</i></span>
          <h2>{headline(d)}{d.unit_label ? ` · ${/^\d/.test(d.unit_label) ? `Flat ${d.unit_label}` : d.unit_label}` : ''} · {d.facts.locality?.value || 'locality missing'}</h2>
          <p>{d.owner_name || 'Owner'} ·{d.phone_last4} · wrote to {d.session} · first message {ago(d.first_message_at)}</p>
          {d.status_reason && <p className={`dr-reason ${st.tone}`}>{d.status_reason}</p>}
        </div>
        {onClose && <button type="button" className="ib-btn ghost" onClick={onClose} aria-label="Close"><X size={16} /></button>}
      </header>

      <div className="dr-state">
        <span>{d.listing_ref ? <>ARGUS listing <a href={`/incoming?id=${d.property_id}`}>#{d.listing_ref}</a>{d.listing_verification ? ` · ${d.listing_verification}` : ''}</> : 'Not uploaded yet'}</span>
        <span>{site?.ok ? <a href={site.url} target="_blank" rel="noreferrer"><Globe size={13} />Live on the website<ExternalLink size={12} /></a> : d.listing_published ? 'Live on the website' : 'Not public'}</span>
        <span>{d.publish_permission_at ? <><ShieldCheck size={13} />Owner permission: {d.permission_by || 'agent'}, {new Date(d.publish_permission_at).toLocaleDateString('en-GB')}</> : 'Owner permission not recorded'}</span>
      </div>

      {(q > 0 || (d.status === 'duplicate_candidate' && d.duplicate_ref)) && (
        <div className="dr-questions">
          {d.ambiguities.filter(a => !a.resolved).map((a, i) => <p key={i}><AlertTriangle size={14} />{a.text}</p>)}
          {Object.entries(d.facts).filter(([, f]) => f?.ambiguity && !f.confirmed).map(([k, f]) => <p key={k}><AlertTriangle size={14} />{f.ambiguity}</p>)}
          {d.status === 'duplicate_candidate' && <p><AlertTriangle size={14} />Looks like the owner’s existing listing #{d.duplicate_ref}.</p>}
          <div className="dr-actions">
            {q > 0 && <button type="button" className="ib-btn" disabled={saving} onClick={() => patch({ resolveAmbiguities: true, confirmPrice: !!d.facts.price?.ambiguity }, 'Questions resolved')}><Check size={15} />Checked — resolve</button>}
            {d.status === 'duplicate_candidate' && <button type="button" className="ib-btn" disabled={saving} onClick={() => patch({ overrideDuplicate: true }, 'Marked as a different property')}>Different property</button>}
          </div>
        </div>
      )}

      <form className="dr-form" onSubmit={e => { e.preventDefault(); if (dirty) patch({ facts: diff }, 'Draft saved') }}>
        <label>Type<select value={form.property_type} onChange={set('property_type')} disabled={!editable}><option value="">—</option>{TYPES.map(t => <option key={t} value={t}>{title(t)}</option>)}</select>{prov('property_type')}</label>
        <label>Bedrooms<input inputMode="numeric" value={form.bedrooms} onChange={set('bedrooms')} disabled={!editable} />{prov('bedrooms')}</label>
        <label>Bathrooms<input inputMode="numeric" value={form.bathrooms} onChange={set('bathrooms')} disabled={!editable} />{prov('bathrooms')}</label>
        <label>Locality<input value={form.locality} onChange={set('locality')} disabled={!editable} />{prov('locality')}</label>
        <label>Address<input value={form.address} onChange={set('address')} disabled={!editable} placeholder="not provided" />{prov('address')}</label>
        <label>Unit<input value={form.unit_label} onChange={set('unit_label')} disabled={!editable} placeholder="e.g. 4" /></label>
        <label>Price<span className="dr-inline"><input inputMode="numeric" value={form.price} onChange={set('price')} disabled={!editable} /><select value={form.period} onChange={set('period')} disabled={!editable}><option value="month">/ month</option><option value="sale">sale</option></select></span>{prov('price')}</label>
        <label>Availability<span className="dr-inline">
          <select value={form.avail_kind} onChange={set('avail_kind')} disabled={!editable}><option value="">—</option><option value="now">Now</option><option value="date">Date</option><option value="month">Month</option></select>
          {form.avail_kind === 'date' && <input type="date" value={form.avail_date} onChange={set('avail_date')} disabled={!editable} />}
          {form.avail_kind === 'month' && <input type="month" value={form.avail_month} onChange={set('avail_month')} disabled={!editable} />}
        </span>{prov('availability')}</label>
        <fieldset className="dr-features" disabled={!editable}><legend>Features {d.facts.features ? <small className="dr-prov ok">from the owner’s words</small> : null}</legend>
          {FEATURES.map(k => <label key={k} className={form.features.includes(k) ? 'is-on' : ''}><input type="checkbox" checked={form.features.includes(k)} onChange={() => setForm(f => ({ ...f, features: f.features.includes(k) ? f.features.filter(x => x !== k) : [...f.features, k] }))} />{title(k)}</label>)}
        </fieldset>
        <div className="dr-actions">
          <button type="submit" className="ib-btn primary" disabled={!dirty || saving || !editable}>{saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save changes</button>
          {dirty && <button type="button" className="ib-btn ghost" onClick={() => setForm(formOf(d))}>Undo</button>}
        </div>
      </form>

      <div className="dr-block">
        <h3>Photos · {d.media.filter(m => m.url).length}</h3>
        <div className="dr-photos">
          {d.media.map(m => <figure key={m.id}>{m.url ? <img src={m.url} alt="" loading="lazy" /> : <span>download failed</span>}{editable && <button type="button" onClick={() => patch({ removeMedia: [m.id] }, 'Photo removed')} aria-label="Remove photo"><X size={12} /></button>}</figure>)}
          {!d.media.length && <p className="dr-muted">No photos yet — they are attached automatically when the owner sends them.</p>}
        </div>
        {mine.length > 0 && editable && <><h4>Unassigned photos from this owner</h4><div className="dr-photos">{mine.map(m => <figure key={m.id}><img src={m.url} alt="" loading="lazy" /><button type="button" className="add" onClick={() => patch({ assignMedia: [m.id] }, 'Photo attached')} aria-label="Attach to this draft"><Check size={12} /></button></figure>)}</div></>}
      </div>

      <div className="dr-block">
        <h3>Public description (built from the facts, no AI)</h3>
        <pre className="dr-desc">{d.public_description}</pre>
      </div>

      <div className="dr-block">
        <h3>What the owner wrote · {d.original_texts.length}</h3>
        <ol className="dr-sources">{d.original_texts.map(t => <li key={t.message_id}><small>{new Date(t.at).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small><p>{t.text}</p></li>)}</ol>
      </div>

      <footer className="dr-detail-foot">
        {!d.publish_permission_at
          ? <button type="button" className="ib-btn" disabled={busy} onClick={() => onSimple('permission')}><ShieldCheck size={15} />Owner agreed to advertise</button>
          : d.status !== 'published' && <button type="button" className="ib-btn ghost" disabled={busy} onClick={() => onSimple('revoke_permission')}>Remove permission</button>}
        {['ready', 'failed', 'duplicate_candidate'].includes(d.status) && <button type="button" className="ib-btn" disabled={busy} onClick={() => onRun('upload')}><Upload size={15} />Upload to ARGUS</button>}
        {d.publish_permission_at && !['published', 'withdrawn'].includes(d.status) && <button type="button" className="ib-btn primary" disabled={busy} onClick={() => onRun('publish')}><Globe size={15} />Publish</button>}
        {!['withdrawn', 'published', 'uploaded'].includes(d.status) && <button type="button" className="ib-btn ghost danger" disabled={busy} onClick={() => onSimple('withdraw')}>Withdraw</button>}
        {['withdrawn', 'failed'].includes(d.status) && <button type="button" className="ib-btn ghost" disabled={saving} onClick={() => patch({ reopen: true }, 'Draft reopened')}>Reopen</button>}
        {d.last_error && <small className="dr-muted">Last error: {d.last_error}</small>}
      </footer>
    </section>
  )
}
