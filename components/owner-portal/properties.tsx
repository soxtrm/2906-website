'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, FileText, ImagePlus, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, Chip, fmtWhen, money, Sheet } from './ui'
import type { Detail, Me } from './types'

const BASE = '/api/owner-portal'
const STATUS: Record<string, string> = { available: 'Available', rented: 'Rented', sold: 'Sold', on_hold: 'On hold', off_market: 'Off market' }
const AMENITIES = ['Air conditioning', 'Balcony', 'Terrace', 'Sea view', 'Lift', 'Parking', 'Garage', 'Pool', 'Garden', 'Washing machine', 'Dishwasher', 'Furnished', 'Pet friendly', 'Solar water']

export function Properties({ me, notify, onChanged }: { me: Me; notify: (m: string) => void; onChanged: () => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const [submit, setSubmit] = useState(false)
  if (open) return <PropertyEditor id={open} me={me} onBack={() => setOpen(null)} notify={notify} onChanged={onChanged} />
  return (
    <div>
      <div className="op-section-head">
        <div>
          <div className="op-eyebrow">Your properties</div>
          <h1 className="op-h1">{me.properties.length} {me.properties.length === 1 ? 'property' : 'properties'}</h1>
          <p className="op-lede">Update facts, photos and availability once. ARGUS reviews changes before they reach any listing.</p>
        </div>
        {me.role === 'owner' && <button className="op-btn op-btn-primary" onClick={() => setSubmit(true)}><Plus size={16} /> Add a property</button>}
      </div>
      <div className="op-prop-grid">
        {me.properties.map(p => (
          <button key={p.id} type="button" className="op-card op-prop" onClick={() => setOpen(p.id)} aria-label={`Open #${p.ref}`}>
            <div className="op-prop-photo" style={p.cover ? { backgroundImage: `url(${JSON.stringify(p.cover).slice(1, -1)})` } : undefined} />
            <div className="op-card-pad" style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <b className="op-display" style={{ fontSize: 18 }}>{p.town || 'Malta'}</b>
                <Chip tone={p.available_status === 'available' ? 'ok' : undefined}>{STATUS[p.available_status || ''] || p.available_status || '—'}</Chip>
              </div>
              <span style={{ color: 'var(--op-muted)', fontSize: 13.5 }}>#{p.ref} · {[p.property_type, p.bedrooms ? `${p.bedrooms} bed` : null].filter(Boolean).join(' · ')}</span>
              <span style={{ fontWeight: 650 }}>{p.longlet_price ? `${money(p.longlet_price)} / month` : p.sale_price ? money(p.sale_price) : ''}</span>
              {p.openRequests > 0 && <Chip tone="accent">{p.openRequests} viewing request{p.openRequests === 1 ? '' : 's'}</Chip>}
            </div>
          </button>
        ))}
      </div>
      <SubmitProperty open={submit} onClose={() => setSubmit(false)} onDone={() => { setSubmit(false); notify('Sent to ARGUS. We will contact you before anything is listed.') }} />
    </div>
  )
}

function PropertyEditor({ id, me, onBack, notify, onChanged }: { id: number; me: Me; onBack: () => void; notify: (m: string) => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState('')
  const [form, setForm] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const canEdit = me.scopes.includes('inventory')
  const load = useCallback(() => api<Detail>(BASE, `/properties/${id}`).then(x => {
    setD(x)
    const pending = x.proposals.find(p => p.review_state === 'pending')?.fields || {}
    setForm({ description: x.property.description || '', available_status: x.property.available_status || 'available', available_date: x.property.available_date ? String(x.property.available_date).slice(0, 10) : '',
      asking_rent: x.property.longlet_price || '', amenities: x.property.feature_tags || [], conditions: {}, ...pending })
  }).catch(e => setErr(e.message)), [id])
  useEffect(() => { load() }, [load])
  if (err) return <div className="op-error" role="alert">{err}</div>
  if (!d) return <div className="op-empty">Loading…</div>
  const p = d.property
  const pending = d.proposals.find(x => x.review_state === 'pending')
  const cond = (k: string) => (form.conditions || {})[k] || ''
  const setCond = (k: string, v: string) => setForm(f => ({ ...f, conditions: { ...(f.conditions || {}), [k]: v } }))

  async function save() {
    setSaving(true); setErr('')
    const fields: Record<string, any> = {}
    if (form.description !== (p.description || '')) fields.description = form.description
    if (form.available_status !== p.available_status) fields.available_status = form.available_status
    if ((form.available_date || null) !== (p.available_date ? String(p.available_date).slice(0, 10) : null)) fields.available_date = form.available_date || null
    if (form.asking_rent && Number(form.asking_rent) !== Number(p.longlet_price)) fields.asking_rent = Number(form.asking_rent)
    if (JSON.stringify([...(form.amenities || [])].sort()) !== JSON.stringify([...(p.feature_tags || [])].sort())) fields.amenities = form.amenities
    const c = Object.fromEntries(Object.entries(form.conditions || {}).filter(([, v]) => v !== '' && v !== null))
    if (Object.keys(c).length) fields.conditions = c
    if (!Object.keys(fields).length) { setSaving(false); notify('Nothing changed.'); return }
    try { await api(BASE, `/properties/${id}/proposals`, { method: 'POST', json: { fields } }); notify('Sent for review. Your agency sees the change now.'); load(); onChanged() }
    catch (e) { setErr((e as ApiError).message) } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="op-section-head">
        <div>
          <button className="op-btn op-btn-ghost op-btn-sm" onClick={onBack} style={{ marginLeft: -10 }}><ArrowLeft size={16} /> All properties</button>
          <h1 className="op-h1">{p.town || 'Malta'} <span style={{ color: 'var(--op-faint)', fontWeight: 600 }}>#{p.ref}</span></h1>
          <p className="op-lede">{[p.street, p.property_type, p.bedrooms ? `${p.bedrooms} bedrooms` : null].filter(Boolean).join(' · ')}</p>
        </div>
        {pending && <Chip tone="warn">Change waiting for review · {fmtWhen(pending.created_at)}</Chip>}
      </div>

      <section className="op-card op-card-pad" style={{ display: 'grid', gap: 14 }}>
        <div className="op-eyebrow">Facts</div>
        <div className="op-grid-2">
          <label className="op-field"><span>Status</span>
            <select className="op-input" disabled={!canEdit} value={form.available_status} onChange={e => setForm(f => ({ ...f, available_status: e.target.value }))}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="op-field"><span>Available from</span><input className="op-input" type="date" disabled={!canEdit} value={form.available_date || ''} onChange={e => setForm(f => ({ ...f, available_date: e.target.value }))} /></label>
          <label className="op-field"><span>Asking rent per month (€)</span><input className="op-input" inputMode="numeric" disabled={!canEdit} value={form.asking_rent || ''} onChange={e => setForm(f => ({ ...f, asking_rent: e.target.value.replace(/[^\d]/g, '') }))} /></label>
          <label className="op-field"><span>Pets</span><input className="op-input" placeholder="e.g. Only small dogs" disabled={!canEdit} value={cond('pets')} maxLength={200} onChange={e => setCond('pets', e.target.value)} /></label>
          <label className="op-field"><span>Smoking</span><input className="op-input" placeholder="e.g. Balcony only" disabled={!canEdit} value={cond('smoking')} maxLength={200} onChange={e => setCond('smoking', e.target.value)} /></label>
          <label className="op-field"><span>Minimum lease (months)</span><input className="op-input" inputMode="numeric" disabled={!canEdit} value={cond('min_lease_months')} onChange={e => setCond('min_lease_months', e.target.value.replace(/[^\d]/g, ''))} /></label>
        </div>
        <label className="op-field"><span>Description</span><textarea className="op-input" disabled={!canEdit} maxLength={4000} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></label>
        <div className="op-field"><span>Amenities</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{[...new Set([...AMENITIES, ...(form.amenities || [])])].map(a => <button key={a} type="button" disabled={!canEdit} className="op-toggle" aria-pressed={(form.amenities || []).includes(a)} onClick={() => setForm(f => ({ ...f, amenities: (f.amenities || []).includes(a) ? f.amenities.filter((x: string) => x !== a) : [...(f.amenities || []), a] }))}>{a}</button>)}</div>
        </div>
        <p style={{ margin: 0, color: 'var(--op-muted)', fontSize: 13 }}>Commission and agency terms stay with your agency and are not edited here.</p>
        {err && <div className="op-error" role="alert">{err}</div>}
        {canEdit && <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="op-btn op-btn-accent" disabled={saving} onClick={save}>{saving ? 'Sending…' : 'Send changes for review'}</button></div>}
      </section>

      <Media detail={d} canEdit={canEdit} notify={notify} reload={load} />
      <Distribution detail={d} canEdit={me.role === 'owner'} notify={notify} reload={load} />
    </div>
  )
}

function Media({ detail, canEdit, notify, reload }: { detail: Detail; canEdit: boolean; notify: (m: string) => void; reload: () => void }) {
  const photoInput = useRef<HTMLInputElement>(null)
  const docInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const id = detail.property.id
  const photos = detail.media.filter(m => m.kind === 'photo')
  const docs = detail.media.filter(m => m.kind === 'document')
  const listing = (Array.isArray(detail.property.images) ? detail.property.images : []).map((x: any) => typeof x === 'string' ? x : x?.url).filter(Boolean) as string[]
  async function upload(files: FileList | null, kind: 'photo' | 'document', visibility = 'agency') {
    if (!files?.length) return
    setBusy(true)
    let ok = 0
    for (const f of Array.from(files).slice(0, 20)) {
      try { await api(BASE, `/properties/${id}/media`, { method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-media-kind': kind, 'x-filename': encodeURIComponent(f.name), 'x-visibility': visibility } }); ok++ }
      catch (e: any) { notify(`${f.name}: ${e.message}`) }
    }
    setBusy(false)
    if (ok) notify(`${ok} file${ok === 1 ? '' : 's'} added. ARGUS reviews them before use.`)
    reload()
  }
  async function arrange(order: number[], remove: number[] = []) { await api(BASE, `/properties/${id}/media`, { method: 'PUT', json: { order, remove } }).catch(e => notify(e.message)); reload() }
  const move = (i: number, dir: -1 | 1) => { const ids = photos.map(p => p.id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; arrange(ids) }
  return (
    <section className="op-card op-card-pad" style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div className="op-eyebrow">Photos and documents</div>
        {canEdit && <div style={{ display: 'flex', gap: 6 }}>
          <button className="op-btn op-btn-sm" disabled={busy} onClick={() => photoInput.current?.click()}><ImagePlus size={15} /> Add photos</button>
          <button className="op-btn op-btn-sm" disabled={busy} onClick={() => docInput.current?.click()}><FileText size={15} /> Add document</button>
          <input ref={photoInput} hidden type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e => upload(e.target.files, 'photo')} />
          <input ref={docInput} hidden type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => upload(e.target.files, 'document')} />
        </div>}
      </div>
      {listing.length > 0 && <><div style={{ fontSize: 13, color: 'var(--op-muted)' }}>On the listing now</div>
        <div className="op-photos">{listing.slice(0, 12).map(u => <div key={u} className="op-photo"><img src={u} alt="" loading="lazy" /></div>)}</div></>}
      {photos.length > 0 && <><div style={{ fontSize: 13, color: 'var(--op-muted)' }}>Your uploads · first is the cover suggestion</div>
        <div className="op-photos">{photos.map((m, i) => (
          <div key={m.id} className="op-photo">
            <img src={`${BASE}/media/${m.id}`} alt={m.filename} loading="lazy" />
            <span className="op-chip" style={{ position: 'absolute', top: 6, left: 6 }} data-tone={m.review_state === 'accepted' ? 'ok' : 'warn'}>{m.review_state === 'accepted' ? 'Approved' : 'In review'}</span>
            {canEdit && <div className="op-photo-tools">
              <button aria-label="Move earlier" onClick={() => move(i, -1)}><ArrowLeft size={14} /></button>
              <button aria-label="Move later" onClick={() => move(i, 1)}><ArrowRight size={14} /></button>
              <button aria-label="Remove photo" onClick={() => arrange(photos.map(p => p.id), [m.id])}><Trash2 size={14} /></button>
            </div>}
          </div>))}</div></>}
      {docs.length > 0 && <div style={{ display: 'grid', gap: 6 }}>{docs.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
          <a href={`${BASE}/media/${m.id}`} target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 600 }}><FileText size={15} style={{ verticalAlign: -2 }} /> {m.filename}</a>
          <span style={{ display: 'flex', gap: 6 }}><Chip>{m.visibility === 'shared' ? 'Agents can see' : 'Agency only'}</Chip>{canEdit && <button className="op-btn op-btn-ghost op-btn-sm" aria-label={`Remove ${m.filename}`} onClick={() => arrange(photos.map(p => p.id), [m.id])}><Trash2 size={14} /></button>}</span>
        </div>))}</div>}
      {!listing.length && !photos.length && !docs.length && <div className="op-empty" style={{ padding: 12 }}>No photos yet.</div>}
    </section>
  )
}

const DEST: Record<string, [string, string]> = {
  argus_agency: ['Your ARGUS agency', 'The agency that lists your property today.'],
  partner_agencies: ['Selected partner agencies', 'Partner agencies working with ARGUS. Your agency approves each one.'],
  authorized_agents: ['Authorised agents', 'Individual agents you allow, through your property link.'],
  nexus_marketplace: ['NEXUS Marketplace', 'Coming later.'],
  owner_direct: ['Owner-direct listing', 'Coming later. Separate terms apply.'],
}
const SYNC: Record<string, [string, string?]> = {
  not_connected: ['Not connected'], pending_approval: ['Pending approval', 'warn'], connected: ['Connected', 'ok'], update_pending: ['Update pending', 'warn'],
  synced: ['Synced', 'ok'], conflict: ['Conflict', 'bad'], paused: ['Paused', 'bad'],
}
function Distribution({ detail, canEdit, notify, reload }: { detail: Detail; canEdit: boolean; notify: (m: string) => void; reload: () => void }) {
  return (
    <section className="op-card op-card-pad" style={{ display: 'grid', gap: 10 }}>
      <div className="op-eyebrow">Where your updates may go</div>
      {detail.distribution.map(x => (
        <div key={x.destination} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--op-line)' }}>
          <div><b>{DEST[x.destination][0]}</b><div style={{ color: 'var(--op-muted)', fontSize: 13 }}>{DEST[x.destination][1]}</div></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Chip tone={SYNC[x.state][1]}>{SYNC[x.state][0]}</Chip>
            {canEdit && x.available && <button type="button" className="op-toggle" aria-pressed={x.allowed} aria-label={`${DEST[x.destination][0]}: ${x.allowed ? 'allowed' : 'not allowed'}`}
              onClick={async () => { try { await api(BASE, `/properties/${detail.property.id}/distribution`, { method: 'PUT', json: { destination: x.destination, allowed: !x.allowed } }); notify('Saved'); reload() } catch (e: any) { notify(e.message) } }}>{x.allowed ? 'Allowed' : 'Off'}</button>}
          </div>
        </div>
      ))}
      <p style={{ margin: 0, color: 'var(--op-muted)', fontSize: 13 }}>Allowing a destination never publishes by itself: it waits for approval. A shared property link never gives editing rights.</p>
    </section>
  )
}

function SubmitProperty({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Sheet open={open} title="Add a property" onClose={onClose} footer={<>
      <button className="op-btn op-btn-ghost" onClick={onClose}>Cancel</button>
      <button className="op-btn op-btn-accent" disabled={busy} onClick={async () => { setBusy(true); setErr(''); try { await api(BASE, '/properties', { method: 'POST', json: { ...f, bedrooms: f.bedrooms ? Number(f.bedrooms) : undefined } }); setF({}); onDone() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>Send to ARGUS</button>
    </>}>
      <p style={{ margin: 0, color: 'var(--op-muted)' }}>We check every new property with you before it is listed anywhere.</p>
      <div className="op-grid-2">
        <label className="op-field"><span>Town</span><input className="op-input" value={f.town || ''} onChange={e => setF({ ...f, town: e.target.value })} /></label>
        <label className="op-field"><span>Type</span><input className="op-input" placeholder="Apartment, maisonette…" value={f.property_type || ''} onChange={e => setF({ ...f, property_type: e.target.value })} /></label>
        <label className="op-field"><span>Bedrooms</span><input className="op-input" inputMode="numeric" value={f.bedrooms || ''} onChange={e => setF({ ...f, bedrooms: e.target.value.replace(/\D/g, '') })} /></label>
        <label className="op-field"><span>Asking rent (€ / month)</span><input className="op-input" inputMode="numeric" value={f.asking_rent || ''} onChange={e => setF({ ...f, asking_rent: e.target.value.replace(/\D/g, '') })} /></label>
        <label className="op-field"><span>Available from</span><input className="op-input" type="date" value={f.available_date || ''} onChange={e => setF({ ...f, available_date: e.target.value })} /></label>
      </div>
      <label className="op-field"><span>Description</span><textarea className="op-input" value={f.description || ''} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      {err && <div className="op-error" role="alert">{err}</div>}
    </Sheet>
  )
}
