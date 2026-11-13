'use client'
// One incoming property, reviewable in place: photos, extracted facts, what is
// missing, and every decision (Approve, Edit & Approve, Needs Correction, Link
// Existing, Reject Duplicate) without leaving the card. Approving confirms the
// facts only — publication stays a separate step on the property page.
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, BadgeCheck, Bath, BedDouble, Camera, CalendarClock, ChevronLeft, ChevronRight, Copy, ExternalLink, Link2, MessageSquareWarning, PencilLine, RotateCcw, Ruler, XCircle } from 'lucide-react'
import { crmJson } from '@/lib/crm/api'
import { type IntakeItem, type IntakePackage, type IntakeProperty, type Suggestion, VERIFY_LABEL, ago, maltaTime, money, thumb } from '@/lib/crm/intake'

type Done = (message: string, opts?: { advance?: boolean }) => void
const TYPES = ['apartment', 'penthouse', 'maisonette', 'house', 'villa', 'studio', 'duplex', 'commercial', 'office', 'shop', 'garage', 'room']

export function IntakeReviewCard({ item, isAdmin, onDone, onError }: { item: IntakeItem; isAdmin: boolean; onDone: Done; onError: (m: string) => void }) {
  if (item.kind === 'package') return <FailedPackageCard p={item} isAdmin={isAdmin} onDone={onDone} onError={onError} />
  return <PropertyCard p={item} onDone={onDone} onError={onError} />
}

function Gallery({ images, total, expected, verified }: { images: string[]; total: number; expected: number | null; verified: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [i, setI] = useState(0)
  useEffect(() => { setI(0); ref.current?.scrollTo({ left: 0 }) }, [images[0], images.length])
  const go = (d: number) => { const el = ref.current; if (!el) return; el.scrollBy({ left: d * el.clientWidth, behavior: 'smooth' }) }
  return (
    <div className="ib-gallery">
      {images.length ? (
        <div className="ib-gallery-track" ref={ref} onScroll={e => { const el = e.currentTarget; setI(Math.round(el.scrollLeft / Math.max(1, el.clientWidth))) }}>
          {images.map((u, k) => <img key={u + k} src={thumb(u, 960)} alt={`Photo ${k + 1} of ${total}`} loading={k < 2 ? 'eager' : 'lazy'} draggable={false} />)}
        </div>
      ) : <div className="ib-gallery-empty"><Camera size={28} aria-hidden /><span>No photos received</span></div>}
      <span className={`ib-verify-badge ${verified ? 'is-verified' : ''}`}>
        {verified ? <BadgeCheck size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}{verified ? 'Verified' : 'Verification required'}
      </span>
      {images.length > 0 && <span className="ib-photo-count"><Camera size={13} aria-hidden /> {Math.min(i + 1, images.length)} / {total}{expected != null && expected > total ? ` · ${expected - total} not received` : ''}</span>}
      {images.length > 1 && <>
        <button type="button" className="ib-gallery-nav left" onClick={() => go(-1)} aria-label="Previous photo"><ChevronLeft size={18} /></button>
        <button type="button" className="ib-gallery-nav right" onClick={() => go(1)} aria-label="Next photo"><ChevronRight size={18} /></button>
      </>}
    </div>
  )
}

function PropertyCard({ p, onDone, onError }: { p: IntakeProperty; onDone: Done; onError: (m: string) => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'correct' | 'link' | 'reject'>('view')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(() => toForm(p))
  const [note, setNote] = useState('')
  const [target, setTarget] = useState('')
  const [copyPhotos, setCopyPhotos] = useState(true)
  const [showFull, setShowFull] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  useEffect(() => { setMode('view'); setForm(toForm(p)); setNote(''); setTarget(''); setShowFull(false); setFormError(null) }, [p.id])

  const verified = p.verification.status === 'verified'
  const critical = p.missing.filter(m => m.critical), warnings = p.missing.filter(m => !m.critical)
  const canAct = p.canReview !== false && !p.archived

  async function run(path: string, body: any, success: string, advance = true) {
    setBusy(true); setFormError(null)
    try { await crmJson(`intake/items/${p.id}/${path}`, 'POST', body); onDone(success, { advance }) }
    catch (e: any) {
      const msg = e?.data?.error || e?.message || 'Action failed'
      if (e?.status === 422 && e?.data?.missing) { setMode('edit'); setFormError(msg) } else onError(msg)
    } finally { setBusy(false) }
  }
  const edits = () => diffForm(p, form)
  const approve = () => critical.length ? (setMode('edit'), setFormError(`Add ${critical.map(m => m.label.toLowerCase()).join(', ')} to approve`)) : run('verify', {}, `#${p.ref} verified`)

  return (
    <article className="ib-card" aria-label={`Incoming property ${p.ref}`}>
      <Gallery images={p.images} total={p.imageCount} expected={p.mediaExpected} verified={verified} />
      <div className="ib-body">
        <div className="ib-headline">
          <div>
            <div className="ib-ref">#{p.ref}<span>· {p.type || 'type unknown'}</span></div>
            <h2>{p.town || <em>Location missing</em>}</h2>
          </div>
          <div className={`ib-price ${p.rent == null && p.sale == null ? 'is-missing' : ''}`}>{money(p.rent, p.sale)}</div>
        </div>
        <div className="ib-facts">
          <span><BedDouble size={15} aria-hidden />{p.beds ?? '—'} bed</span>
          <span><Bath size={15} aria-hidden />{p.baths ?? '—'} bath</span>
          {p.sizeSqm != null && <span><Ruler size={15} aria-hidden />{p.sizeSqm} m²</span>}
          <span><CalendarClock size={15} aria-hidden />{p.availableDate ? `from ${new Date(p.availableDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'date not given'}</span>
        </div>
        <div className="ib-source">
          Uploaded by <strong>{p.uploader.name || 'unknown agent'}</strong> · WhatsApp {maltaTime(p.uploadedAt)} <span>({ago(p.uploadedAt)})</span>
          {p.package && <> · package {p.package.id}</>}
        </div>

        {!verified && !p.archived && (
          <div className="ib-warning" role="status">
            <AlertTriangle size={18} aria-hidden />
            <div>
              <strong>{VERIFY_LABEL[p.verification.status]}</strong>
              <p>{p.verification.status === 'needs_correction' && p.verification.note
                ? <>Correction requested: “{p.verification.note}”</>
                : critical.length ? <>Read automatically from the WhatsApp text. Missing before it can be approved: {critical.map(m => m.label.toLowerCase()).join(', ')}.</>
                : <>Read automatically from the WhatsApp text. Check the facts and photos, then approve.</>}</p>
            </div>
          </div>
        )}
        {verified && <div className="ib-ok"><BadgeCheck size={16} aria-hidden /> Verified by {p.verification.by || '—'} · {maltaTime(p.verification.at)}</div>}
        {p.archived && <div className="ib-ok is-muted"><Link2 size={16} aria-hidden /> Archived as duplicate{p.linkedTo ? <> of <Link href={`/property/${p.linkedTo.id}`}>#{p.linkedTo.ref}</Link></> : ''}</div>}

        {(critical.length > 0 || warnings.length > 0) && (
          <div className="ib-missing" aria-label="Missing information">
            {critical.map(m => <span key={m.field} className="is-critical">{m.label} missing</span>)}
            {warnings.map(m => <span key={m.field}>{m.label} missing</span>)}
          </div>
        )}

        <dl className="ib-states">
          <div><dt>Upload</dt><dd>{p.package?.state === 'REVIEW_REQUIRED' || p.package?.state === 'IMPORTED' ? 'Imported' : p.package?.state ? cap(p.package.state) : 'Imported'}</dd></div>
          <div><dt>Verification</dt><dd className={verified ? 'ok' : 'warn'}>{VERIFY_LABEL[p.verification.status]}</dd></div>
          <div><dt>Market</dt><dd>{marketLabel(p.marketStatus)}</dd></div>
          <div><dt>Publication</dt><dd>{p.archived ? 'Archived' : p.published ? 'Published' : 'Internal draft'}</dd></div>
        </dl>

        {p.summary && mode === 'view' && (
          <div className="ib-desc">
            <p>{showFull ? p.description : p.summary}</p>
            {p.description && p.description.length > p.summary.length && <button type="button" onClick={() => setShowFull(v => !v)}>{showFull ? 'Show less' : 'Full description'}</button>}
          </div>
        )}

        {mode === 'edit' && (
          <form className="ib-form" onSubmit={e => { e.preventDefault(); run('verify', { edits: edits(), note: note || null }, `#${p.ref} corrected and verified`) }}>
            {formError && <div className="ib-form-error" role="alert">{formError}</div>}
            <div className="ib-grid">
              <label>Location<input value={form.town} onChange={e => setForm({ ...form, town: e.target.value })} placeholder="e.g. Rabat" /></label>
              <label>Type<select value={form.property_type} onChange={e => setForm({ ...form, property_type: e.target.value })}><option value="">—</option>{TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
              <label>Rent / month (€)<input inputMode="numeric" value={form.longlet_price} onChange={e => setForm({ ...form, longlet_price: e.target.value })} placeholder="e.g. 2200" /></label>
              <label>Sale price (€)<input inputMode="numeric" value={form.sale_price} onChange={e => setForm({ ...form, sale_price: e.target.value })} /></label>
              <label>Bedrooms<input inputMode="numeric" value={form.bedrooms} onChange={e => setForm({ ...form, bedrooms: e.target.value })} /></label>
              <label>Bathrooms<input inputMode="numeric" value={form.bathrooms} onChange={e => setForm({ ...form, bathrooms: e.target.value })} /></label>
              <label>Available from<input type="date" value={form.available_date} onChange={e => setForm({ ...form, available_date: e.target.value })} /></label>
              <label>Size (m²)<input inputMode="numeric" value={form.size_sqm} onChange={e => setForm({ ...form, size_sqm: e.target.value })} /></label>
            </div>
            <label className="ib-wide">Description<textarea rows={5} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
            <label className="ib-wide">Note (optional)<input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. price confirmed with Olga" /></label>
            <p className="ib-hint">Photos: add or replace them on the <Link href={`/property/${p.id}`}>property page</Link> or with <code>!picup {p.ref}</code> in WhatsApp.</p>
            <div className="ib-actions">
              <button type="submit" className="ib-btn primary" disabled={busy}><BadgeCheck size={16} aria-hidden />Save & approve</button>
              <button type="button" className="ib-btn" disabled={busy} onClick={() => run('save', { edits: edits() }, `#${p.ref} saved — still waiting for approval`, false)}>Save only</button>
              <button type="button" className="ib-btn ghost" onClick={() => { setMode('view'); setFormError(null) }}>Cancel</button>
            </div>
          </form>
        )}

        {mode === 'correct' && (
          <form className="ib-form" onSubmit={e => { e.preventDefault(); run('needs-correction', { note }, `Correction requested on #${p.ref}`) }}>
            <label className="ib-wide">What needs to be corrected?<textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. the price is the sale price, not the rent" autoFocus /></label>
            <p className="ib-hint">{p.uploader.name || 'The uploader'} sees this note on the card. No WhatsApp message is sent.</p>
            <div className="ib-actions">
              <button type="submit" className="ib-btn warn" disabled={busy || note.trim().length < 3}><MessageSquareWarning size={16} aria-hidden />Request correction</button>
              <button type="button" className="ib-btn ghost" onClick={() => setMode('view')}>Cancel</button>
            </div>
          </form>
        )}

        {(mode === 'link' || mode === 'reject') && (
          <form className="ib-form" onSubmit={e => {
            e.preventDefault()
            if (mode === 'link') run('link', { target, copyPhotos }, `#${p.ref} linked to ${target.startsWith('2906') ? '#' + target : 'the existing property'}`)
            else run('reject-duplicate', { target: target || null, note: note || null }, `#${p.ref} rejected as duplicate`)
          }}>
            <SuggestionList items={p.suggestions || []} selected={target} onSelect={setTarget} />
            <label className="ib-wide">{mode === 'link' ? 'Existing property (ref or ID)' : 'Duplicate of (optional)'}<input value={target} onChange={e => setTarget(e.target.value.trim())} placeholder="e.g. 2906-9150" /></label>
            {mode === 'link' && <label className="ib-check"><input type="checkbox" checked={copyPhotos} onChange={e => setCopyPhotos(e.target.checked)} /> Add this upload’s photos the existing record does not have (only if that record is not published)</label>}
            {mode === 'reject' && <label className="ib-wide">Note (optional)<input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. sent twice" /></label>}
            <p className="ib-hint">This draft is archived, never deleted. Its history stays on the property timeline.</p>
            <div className="ib-actions">
              <button type="submit" className={`ib-btn ${mode === 'link' ? 'primary' : 'danger'}`} disabled={busy || (mode === 'link' && !target)}>{mode === 'link' ? <><Link2 size={16} aria-hidden />Link existing</> : <><XCircle size={16} aria-hidden />Reject duplicate</>}</button>
              <button type="button" className="ib-btn ghost" onClick={() => setMode('view')}>Cancel</button>
            </div>
          </form>
        )}

        {mode === 'view' && canAct && !verified && (
          <div className="ib-actions ib-main-actions">
            <button type="button" className="ib-btn primary" disabled={busy} onClick={approve}><BadgeCheck size={16} aria-hidden />Approve</button>
            <button type="button" className="ib-btn" disabled={busy} onClick={() => setMode('edit')}><PencilLine size={16} aria-hidden />Edit & approve</button>
            <button type="button" className="ib-btn" disabled={busy} onClick={() => setMode('correct')}><MessageSquareWarning size={16} aria-hidden />Needs correction</button>
            <button type="button" className="ib-btn" disabled={busy} onClick={() => { setMode('link'); setTarget(p.suggestions?.[0]?.ref || '') }}><Link2 size={16} aria-hidden />Link existing{p.suggestions?.length ? <small>{p.suggestions.length}</small> : null}</button>
            <button type="button" className="ib-btn danger" disabled={busy} onClick={() => { setMode('reject'); setTarget('') }}><Copy size={16} aria-hidden />Reject duplicate</button>
          </div>
        )}
        {p.canReview === false && <p className="ib-hint">Only {p.uploader.name || 'the uploader'} or an administrator can review this property.</p>}
        <div className="ib-footer"><Link href={`/property/${p.id}`}><ExternalLink size={14} aria-hidden />Open full property record</Link><span>Approving confirms the facts. It does not publish.</span></div>
      </div>
    </article>
  )
}

function SuggestionList({ items, selected, onSelect }: { items: Suggestion[]; selected: string; onSelect: (ref: string) => void }) {
  if (!items.length) return <p className="ib-hint">No similar property found automatically (same locality, bedrooms and price). Enter a reference if you know it.</p>
  return (
    <div className="ib-suggestions" role="radiogroup" aria-label="Possible existing properties">
      {items.map(s => (
        <button type="button" role="radio" aria-checked={selected === s.ref} key={s.id} className={selected === s.ref ? 'is-selected' : ''} onClick={() => onSelect(s.ref)}>
          {s.cover ? <img src={thumb(s.cover, 200)} alt="" loading="lazy" /> : <span className="ib-suggestion-empty"><Camera size={16} aria-hidden /></span>}
          <span><strong>#{s.ref}</strong> {s.town} · {s.beds ?? '—'} bed · {s.price != null ? `€${s.price.toLocaleString('en-GB')}` : 'no price'}<small>{s.reason}{s.published ? ' · published' : ''} · {s.imageCount} photos</small></span>
        </button>
      ))}
    </div>
  )
}

function FailedPackageCard({ p, isAdmin, onDone, onError }: { p: IntakePackage; isAdmin: boolean; onDone: Done; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false)
  const act = async (path: string, ok: string) => {
    setBusy(true)
    try { const r = await crmJson(`intake/packages/${p.packageId}/${path}`, 'POST', {}); onDone(r?.created?.length ? `${ok}: ${r.created.map((c: any) => '#' + c.ref).join(', ')}` : r?.state ? `${ok} — result: ${String(r.state).replace(/_/g, ' ').toLowerCase()}` : ok) }
    catch (e: any) { onError(e?.data?.error || e?.message || 'Action failed') } finally { setBusy(false) }
  }
  const failed = p.state === 'FAILED'
  return (
    <article className={`ib-card ib-package ${failed ? 'is-failed' : ''}`}>
      <div className="ib-body">
        <div className="ib-ref">Upload package {p.packageId}<span>· {p.mediaExpected} photos/videos</span></div>
        <h2>{p.summary || 'Upload without description'}</h2>
        <div className="ib-source">Uploaded by <strong>{p.uploader.name || 'unknown'}</strong> · WhatsApp {maltaTime(p.uploadedAt)} <span>({ago(p.uploadedAt)})</span></div>
        <div className={`ib-warning ${failed ? '' : 'is-neutral'}`}>
          {failed ? <XCircle size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
          <div><strong>{failed ? 'Upload failed — nothing was created' : 'Duplicate — nothing created'}</strong><p>{p.reason || 'No reason recorded'}{failed && p.attempts > 0 ? ` · ${p.attempts} attempt${p.attempts === 1 ? '' : 's'}` : ''}</p></div>
        </div>
        {failed && (
          <div className="ib-actions ib-main-actions">
            <button type="button" className="ib-btn primary" disabled={busy} onClick={() => act('retry', 'Retried')}><RotateCcw size={16} aria-hidden />{busy ? 'Retrying… (can take a minute)' : 'Retry upload'}</button>
            {isAdmin && <button type="button" className="ib-btn ghost" disabled={busy} onClick={() => { if (window.confirm('Close this failed upload without importing it?')) act('dismiss', 'Upload closed') }}>Dismiss</button>}
          </div>
        )}
        {!failed && p.duplicateOf && <div className="ib-footer"><span>Existing listing: #{p.duplicateOf}</span></div>}
        <p className="ib-hint">A retry runs the same WhatsApp package through the importer again. The result is posted in the upload group and shown here.</p>
      </div>
    </article>
  )
}

const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')
function marketLabel(s: string | null) {
  if (!s) return 'Unknown'
  if (['available', 'available_confirmed', 'soon_available'].includes(s)) return 'On market'
  if (['rented', 'recently_rented'].includes(s)) return 'Rented'
  if (['reserved', 'hold', 'pending_check'].includes(s)) return 'Hold'
  if (['not_available', 'archived', 'withdrawn'].includes(s)) return 'Off market'
  return cap(s)
}
function toForm(p: IntakeProperty) {
  const s = (v: any) => (v == null ? '' : String(v))
  return { town: s(p.town), property_type: s(p.type), longlet_price: s(p.rent), sale_price: s(p.sale), bedrooms: s(p.beds), bathrooms: s(p.baths),
    available_date: p.availableDate ? String(p.availableDate).slice(0, 10) : '', size_sqm: s(p.sizeSqm), description: s(p.description) }
}
function diffForm(p: IntakeProperty, f: ReturnType<typeof toForm>) {
  const before = toForm(p), out: Record<string, string | null> = {}
  for (const k of Object.keys(f) as (keyof typeof f)[]) if (f[k] !== before[k]) out[k] = f[k] === '' ? null : f[k]
  return out
}
export { marketLabel }
