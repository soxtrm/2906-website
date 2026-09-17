'use client'
// ============================================================================
// /crm/base-inventory — Base Inventory Review screen (Kev, 2026-09-17).
// Reviews scraped website inventory (website_source_inventory) BEFORE it
// ever reaches the Agent Board. Real data end to end against
// /api/crm/base-inventory/*. First real dataset: 16 Seafront Malta records.
//
// Scope note: this screen must scale to WStays (~115), Malta Townhouse
// Rentals, JC Properties and future owner-portfolio imports — everything
// here is source-agnostic (filters by `source`, no Seafront-specific code).
// ============================================================================
import { useEffect, useState, useCallback, useMemo } from 'react'
import { CrmProvider, CrmShell, useCrm, DCARD, DCARD_BORDER, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER, A, AD, F } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

const DPAGE = '#0B0F17'
const DCARD2 = '#0F1521'

type ProvEntry = { value: any; source: string; confidence: string; observed_at: string; note?: string }
type Row = {
  id: number; source_domain: string; source_url: string; external_ref: string; external_title: string
  raw_source_text: string; source_images: string[]; owner_id: string | null; owner_name: string | null; owner_phone: string | null
  canonical_property_id: number | null
  import_status: string
  parsed_price: number | null; parsed_price_unit: string | null; parsed_bedrooms: number | null; parsed_bathrooms: number | null
  parsed_locality: string | null; parsed_address: string | null; parsed_availability_text: string | null; parsed_available_date: string | null
  parsed_lease_type: string | null; parsed_seafront: boolean | null; parsed_property_type: string | null; parsed_sqm: number | null
  field_provenance: Record<string, ProvEntry[]>
  price_confidence: string; review_notes: string | null
  scraped_at: string; last_checked_at: string
  display_status: string; promotion_eligible: boolean; promotion_blockers: string[]
}
type Summary = Record<string, { discovered: number; imported: number; merged: number; readyForBoard: number; baseOnly: number; needsReview: number }>

const STATUS_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  BASE_INVENTORY: { bg: 'rgba(79,123,242,0.14)', fg: '#7EA0FF', label: 'BASE INVENTORY' },
  READY_FOR_BOARD: { bg: 'rgba(62,207,142,0.14)', fg: '#3ECF8E', label: 'READY FOR BOARD' },
  NEEDS_REVIEW: { bg: 'rgba(242,165,61,0.14)', fg: '#F2A53D', label: 'NEEDS REVIEW' },
  MISSING_PRICE: { bg: 'rgba(242,89,122,0.14)', fg: '#F2597A', label: 'MISSING PRICE' },
  MISSING_AVAILABILITY: { bg: 'rgba(242,89,122,0.14)', fg: '#F2597A', label: 'MISSING AVAILABILITY' },
  WINTER_PERIODIC: { bg: 'rgba(157,110,242,0.14)', fg: '#B79CF7', label: 'WINTER / PERIODIC' },
  DUPLICATE_MERGED: { bg: 'rgba(255,255,255,0.06)', fg: DTEXT_FAINT, label: 'MERGED' },
  SOURCE_REMOVED: { bg: 'rgba(255,255,255,0.06)', fg: DTEXT_FAINT, label: 'SOURCE REMOVED' },
  PROMOTED: { bg: 'rgba(62,207,142,0.20)', fg: '#3ECF8E', label: 'PROMOTED' },
}
function Badge({ status }: { status: string }) {
  const b = STATUS_BADGE[status] || STATUS_BADGE.NEEDS_REVIEW
  return <span style={{ background: b.bg, color: b.fg, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>{b.label}</span>
}

function inputStyle(): React.CSSProperties {
  return { background: DCARD2, border: `1px solid ${DBORDER}`, borderRadius: 8, padding: '8px 10px', fontSize: 12, color: DTEXT, fontFamily: F, outline: 'none' }
}
function btnPrimary(): React.CSSProperties {
  return { background: A, color: '#151C2C', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 11.5, fontWeight: 700, fontFamily: F, cursor: 'pointer' }
}
function btnGhost(): React.CSSProperties {
  return { background: 'transparent', border: `1px solid ${DBORDER}`, color: DTEXT_DIM, borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 700, fontFamily: F, cursor: 'pointer' }
}

function BaseInventory() {
  const { me } = useCrm()
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary>({})
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [openId, setOpenId] = useState<number | null>(null)

  const [source, setSource] = useState('')
  const [search, setSearch] = useState('')
  const [leaseType, setLeaseType] = useState('')
  const [priceKnown, setPriceKnown] = useState('')
  const [availKnown, setAvailKnown] = useState('')
  const [seafrontOnly, setSeafrontOnly] = useState(false)
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false)
  const [eligibleOnly, setEligibleOnly] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (source) params.set('source', source)
      if (search) params.set('search', search)
      if (leaseType) params.set('lease_type', leaseType)
      if (priceKnown) params.set('price_known', priceKnown)
      if (availKnown) params.set('availability_known', availKnown)
      if (seafrontOnly) params.set('seafront', 'true')
      if (needsReviewOnly) params.set('needs_review', 'true')
      if (eligibleOnly) params.set('agent_board_eligible', 'true')
      const d = await crmFetch(`base-inventory?${params.toString()}`)
      setRows(d.rows || []); setSummary(d.summary || {})
    } catch { /* keep last good state */ }
    finally { setLoading(false) }
  }, [source, search, leaseType, priceKnown, availKnown, seafrontOnly, needsReviewOnly, eligibleOnly])

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  const sources = Object.keys(summary)
  const totals = useMemo(() => {
    const t = { discovered: 0, imported: 0, merged: 0, readyForBoard: 0, baseOnly: 0, needsReview: 0 }
    for (const s of Object.values(summary)) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += s[k]
    return t
  }, [summary])

  function toggleSelect(id: number) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function bulkAction(action: string) {
    if (!selected.size) return
    await crmJson('base-inventory/bulk', 'POST', { ids: [...selected], action })
    setSelected(new Set())
    load()
  }

  const openRow = rows.find(r => r.id === openId) || null

  return (
    <div style={{ background: DPAGE, minHeight: '100%', padding: '20px 18px 60px', color: DTEXT, fontFamily: F }}>
      {/* ── Import summary (spec §8) ─────────────────────────────────────── */}
      {sources.map(s => (
        <div key={s} style={{ background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 14, padding: '16px 20px', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.04em', marginBottom: 10, color: A }}>{s.toUpperCase()}</div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {Object.entries(summary[s]).map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{v}</div>
                <div style={{ fontSize: 10, color: DTEXT_FAINT, textTransform: 'capitalize' }}>{k.replace(/([A-Z])/g, ' $1')}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {sources.length > 1 && (
        <div style={{ fontSize: 11, color: DTEXT_FAINT, marginBottom: 16 }}>
          {totals.discovered} discovered across {sources.length} sources · {totals.readyForBoard} ready for board · {totals.needsReview} need review
        </div>
      )}

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 12, padding: 12 }}>
        <input placeholder="Search REF / title / address / URL" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle(), minWidth: 220 }} />
        <select value={source} onChange={e => setSource(e.target.value)} style={inputStyle()}>
          <option value="">All sources</option>
          {sources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={leaseType} onChange={e => setLeaseType(e.target.value)} style={inputStyle()}>
          <option value="">Any lease type</option>
          <option value="long_let">Long-let</option>
          <option value="winter_let">Winter-let</option>
          <option value="short_let">Short-let</option>
          <option value="flexible">Flexible</option>
        </select>
        <select value={priceKnown} onChange={e => setPriceKnown(e.target.value)} style={inputStyle()}>
          <option value="">Price: any</option>
          <option value="true">Price known</option>
          <option value="false">Price unknown</option>
        </select>
        <select value={availKnown} onChange={e => setAvailKnown(e.target.value)} style={inputStyle()}>
          <option value="">Availability: any</option>
          <option value="true">Availability known</option>
          <option value="false">Availability unknown</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: DTEXT_DIM }}>
          <input type="checkbox" checked={seafrontOnly} onChange={e => setSeafrontOnly(e.target.checked)} /> Seafront only
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: DTEXT_DIM }}>
          <input type="checkbox" checked={needsReviewOnly} onChange={e => setNeedsReviewOnly(e.target.checked)} /> Needs review only
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: DTEXT_DIM }}>
          <input type="checkbox" checked={eligibleOnly} onChange={e => setEligibleOnly(e.target.checked)} /> Board-eligible only
        </label>
      </div>

      {/* ── Bulk action bar ───────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: AD, border: `1px solid ${A}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{selected.size} selected</span>
          <button onClick={() => bulkAction('approve-base')} style={btnGhost()}>Approve Base Inventory</button>
          <button onClick={() => bulkAction('keep-base-only')} style={btnGhost()}>Keep Base Only</button>
          <button onClick={() => bulkAction('needs-review')} style={btnGhost()}>Mark Needs Review</button>
          <button onClick={() => setSelected(new Set())} style={{ ...btnGhost(), marginLeft: 'auto' }}>Clear</button>
        </div>
      )}

      {/* ── List (responsive card grid — dense on desktop, single column on
          mobile via CSS grid auto-fit, per spec §9) ────────────────────── */}
      {loading ? <div style={{ color: DTEXT_FAINT, fontSize: 12 }}>Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 10 }}>
          {rows.map(r => (
            <div key={r.id} onClick={() => setOpenId(r.id)} style={{
              background: DCARD, border: `1px solid ${selected.has(r.id) ? A : DCARD_BORDER}`, borderRadius: 12,
              overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ position: 'relative', height: 130, background: '#111' }}>
                {r.source_images?.[0]
                  ? <img src={r.source_images[0]} alt={r.external_title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#555', fontSize: 11 }}>no photo</div>}
                <div onClick={e => { e.stopPropagation(); toggleSelect(r.id) }} style={{
                  position: 'absolute', top: 8, left: 8, width: 20, height: 20, borderRadius: 5,
                  background: selected.has(r.id) ? A : 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.4)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#151C2C', fontWeight: 900,
                }}>{selected.has(r.id) ? '✓' : ''}</div>
                <div style={{ position: 'absolute', top: 8, right: 8 }}><Badge status={r.display_status} /></div>
              </div>
              <div style={{ padding: 12, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: DTEXT_FAINT }}>
                  <span>#{r.external_ref} · {r.source_domain}</span>
                  {r.parsed_seafront && <span title="Direct seafront">🌊</span>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{r.external_title}</div>
                <div style={{ fontSize: 11.5, color: DTEXT_DIM }}>
                  {r.parsed_locality || r.parsed_address || '—'} · {r.parsed_bedrooms != null ? `${r.parsed_bedrooms}BR` : '?BR'}{r.parsed_bathrooms != null ? `/${r.parsed_bathrooms}BA` : ''} · {r.parsed_property_type || '?'}
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: r.parsed_price ? DTEXT : DTEXT_FAINT }}>
                  {r.parsed_price ? `€${Number(r.parsed_price).toLocaleString()}/mo` : 'price unknown'}
                </div>
                <div style={{ fontSize: 10.5, color: DTEXT_FAINT }}>
                  {r.owner_name || 'no owner linked'} · {r.parsed_available_date ? new Date(r.parsed_available_date).toLocaleDateString([], { day: 'numeric', month: 'short' }) : (r.parsed_availability_text || 'availability unknown')}
                </div>
              </div>
            </div>
          ))}
          {rows.length === 0 && <div style={{ color: DTEXT_FAINT, fontSize: 12 }}>No records match these filters.</div>}
        </div>
      )}

      {openRow && <ReviewDrawer row={openRow} onClose={() => setOpenId(null)} onChange={load} isAdmin={me?.role === 'admin'} />}
    </div>
  )
}

function ReviewDrawer({ row, onClose, onChange, isAdmin }: { row: Row; onClose: () => void; onChange: () => void; isAdmin: boolean }) {
  const [tab, setTab] = useState<'source' | 'canonical' | 'description' | 'provenance'>('canonical')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<Partial<Row>>({})

  async function act(path: string, body?: any) {
    setBusy(true)
    try { await crmJson(`base-inventory/${row.id}/${path}`, 'POST', body || {}); onChange(); onClose() }
    catch (e: any) { alert(e?.data?.error || e?.message || 'Action failed') }
    finally { setBusy(false) }
  }
  async function promote() {
    setBusy(true)
    try {
      const d = await crmJson(`base-inventory/${row.id}/promote`, 'POST', {})
      onChange(); onClose()
      alert(`Promoted to Agent Board as property #${d.propertyId}.`)
    } catch (e: any) {
      const reasons = e?.data?.reasons
      alert(reasons ? `Cannot promote:\n${reasons.join('\n')}` : (e?.data?.error || e?.message || 'Promotion failed'))
    } finally { setBusy(false) }
  }
  async function saveEdit() {
    if (!Object.keys(edit).length) return
    setBusy(true)
    try { await crmJson(`base-inventory/${row.id}`, 'PATCH', edit); onChange(); setEdit({}) }
    catch (e: any) { alert(e?.data?.error || e?.message || 'Save failed') }
    finally { setBusy(false) }
  }

  const description = [
    row.external_title,
    row.parsed_property_type ? `${row.parsed_property_type} in ${row.parsed_locality || row.parsed_address || 'Malta'}.` : null,
    row.parsed_bedrooms != null ? `${row.parsed_bedrooms} bedroom${row.parsed_bedrooms === 1 ? '' : 's'}${row.parsed_bathrooms != null ? `, ${row.parsed_bathrooms} bathroom${row.parsed_bathrooms === 1 ? '' : 's'}` : ''}.` : null,
    row.parsed_seafront ? 'Direct seafront.' : null,
    row.parsed_sqm ? `${row.parsed_sqm} sqm.` : null,
  ].filter(Boolean).join(' ')

  const FIELD_LABEL: Record<string, string> = {
    price: 'Price', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', address: 'Address',
    lease_type: 'Lease type', seafront: 'Seafront', availability: 'Availability', available_date: 'Available date',
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 400, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(520px, 100vw)', height: '100%', background: DPAGE, borderLeft: `1px solid ${DCARD_BORDER}`,
        overflowY: 'auto', padding: 20, fontFamily: F, color: DTEXT,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{row.external_title}</div>
            <div style={{ fontSize: 11, color: DTEXT_FAINT }}>#{row.external_ref} · {row.source_domain}</div>
          </div>
          <button onClick={onClose} style={btnGhost()}>Close</button>
        </div>
        <div style={{ marginBottom: 14 }}><Badge status={row.display_status} /></div>

        {!row.promotion_eligible && row.promotion_blockers.length > 0 && row.import_status !== 'ACTIVE' && (
          <div style={{ background: 'rgba(242,89,122,0.10)', border: '1px solid rgba(242,89,122,0.35)', borderRadius: 10, padding: '10px 12px', marginBottom: 14, fontSize: 11.5 }}>
            <div style={{ fontWeight: 700, color: '#F2597A', marginBottom: 4 }}>Cannot promote to Agent Board:</div>
            {row.promotion_blockers.map((b, i) => <div key={i} style={{ color: DTEXT_DIM }}>· {b}</div>)}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {(['canonical', 'source', 'description', 'provenance'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              ...btnGhost(), background: tab === t ? A : 'transparent', color: tab === t ? '#151C2C' : DTEXT_DIM, borderColor: tab === t ? A : DBORDER,
              textTransform: 'capitalize',
            }}>{t}</button>
          ))}
        </div>

        {tab === 'canonical' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
            <Field label="Locality" value={row.parsed_locality} onChange={v => setEdit(e => ({ ...e, parsed_locality: v }))} disabled={!isAdmin} />
            <Field label="Address" value={row.parsed_address} onChange={v => setEdit(e => ({ ...e, parsed_address: v }))} disabled={!isAdmin} />
            <Field label="Type" value={row.parsed_property_type} onChange={v => setEdit(e => ({ ...e, parsed_property_type: v }))} disabled={!isAdmin} />
            <Field label="Bedrooms" value={row.parsed_bedrooms} onChange={v => setEdit(e => ({ ...e, parsed_bedrooms: Number(v) }))} disabled={!isAdmin} />
            <Field label="Bathrooms" value={row.parsed_bathrooms} onChange={v => setEdit(e => ({ ...e, parsed_bathrooms: Number(v) }))} disabled={!isAdmin} />
            <Field label="Sqm" value={row.parsed_sqm} onChange={v => setEdit(e => ({ ...e, parsed_sqm: Number(v) }))} disabled={!isAdmin} />
            <Field label="Price (€/mo)" value={row.parsed_price} onChange={v => setEdit(e => ({ ...e, parsed_price: Number(v) }))} disabled={!isAdmin} />
            <Field label="Available date" value={row.parsed_available_date?.slice(0, 10)} onChange={v => setEdit(e => ({ ...e, parsed_available_date: v }))} disabled={!isAdmin} />
            <div>
              <div style={{ fontSize: 10, color: DTEXT_FAINT, marginBottom: 3 }}>Lease type</div>
              <select defaultValue={row.parsed_lease_type || ''} onChange={e => setEdit(ed => ({ ...ed, parsed_lease_type: e.target.value }))} disabled={!isAdmin} style={{ ...inputStyle(), width: '100%' }}>
                <option value="">—</option>
                <option value="long_let">Long-let</option>
                <option value="winter_let">Winter-let</option>
                <option value="short_let">Short-let</option>
                <option value="flexible">Flexible</option>
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: DTEXT_DIM, marginTop: 18 }}>
              <input type="checkbox" defaultChecked={!!row.parsed_seafront} disabled={!isAdmin} onChange={e => setEdit(ed => ({ ...ed, parsed_seafront: e.target.checked }))} /> Direct seafront
            </label>
            <div style={{ gridColumn: 'span 2', fontSize: 11, color: DTEXT_FAINT }}>
              Owner: {row.owner_name || 'not linked'} {row.owner_phone ? `(${row.owner_phone})` : ''}
            </div>
            {isAdmin && Object.keys(edit).length > 0 && (
              <button onClick={saveEdit} disabled={busy} style={{ ...btnPrimary(), gridColumn: 'span 2' }}>{busy ? 'Saving…' : 'Save changes'}</button>
            )}
          </div>
        )}

        {tab === 'source' && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: DTEXT_FAINT, marginBottom: 4 }}>Source URL</div>
            <a href={row.source_url} target="_blank" rel="noreferrer" style={{ color: A, fontSize: 12, wordBreak: 'break-all' }}>{row.source_url}</a>
            <div style={{ fontSize: 11, color: DTEXT_FAINT, margin: '12px 0 4px' }}>Original text</div>
            <div style={{ fontSize: 11, color: DTEXT_DIM, background: DCARD2, borderRadius: 8, padding: 10, maxHeight: 160, overflowY: 'auto' }}>{row.raw_source_text}</div>
            <div style={{ fontSize: 11, color: DTEXT_FAINT, margin: '12px 0 6px' }}>Source images ({row.source_images?.length || 0})</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
              {(row.source_images || []).slice(0, 12).map((u, i) => <img key={i} src={u} style={{ width: '100%', height: 60, objectFit: 'cover', borderRadius: 4 }} />)}
            </div>
          </div>
        )}

        {tab === 'description' && (
          <div style={{ fontSize: 12.5, color: DTEXT_DIM, background: DCARD2, borderRadius: 8, padding: 12, marginBottom: 16, lineHeight: 1.5 }}>{description}</div>
        )}

        {tab === 'provenance' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {Object.entries(row.field_provenance || {}).map(([field, entries]) => (
              <div key={field} style={{ background: DCARD2, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}>{FIELD_LABEL[field] || field}</div>
                {entries.map((e, i) => (
                  <div key={i} style={{ fontSize: 10.5, color: DTEXT_DIM, display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                    <span>{String(e.value)} — {e.source}{e.note ? ` (${e.note})` : ''}</span>
                    <span style={{ color: e.confidence === 'CONFIRMED' ? '#3ECF8E' : '#F2A53D' }}>{e.confidence}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {row.import_status !== 'ACTIVE' && (
            <button onClick={promote} disabled={busy || !row.promotion_eligible} style={{ ...btnPrimary(), opacity: row.promotion_eligible ? 1 : 0.4 }}>
              {row.promotion_eligible ? 'Promote to Agent Board' : 'Promote to Agent Board (blocked)'}
            </button>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => act('approve-base')} disabled={busy} style={btnGhost()}>Approve Base Inventory</button>
            <button onClick={() => act('keep-base-only')} disabled={busy} style={btnGhost()}>Keep Base Only</button>
            <button onClick={() => act('needs-review')} disabled={busy} style={btnGhost()}>Mark Needs Review</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <a href={row.source_url} target="_blank" rel="noreferrer"><button style={btnGhost()}>Open Source</button></a>
            {row.canonical_property_id && <a href={`/property/${row.canonical_property_id}`} target="_blank" rel="noreferrer"><button style={btnGhost()}>Open Property</button></a>}
            {isAdmin && <button onClick={() => act('archive')} disabled={busy} style={{ ...btnGhost(), color: '#F2597A' }}>Delete / Archive</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, disabled }: { label: string; value: any; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: DTEXT_FAINT, marginBottom: 3 }}>{label}</div>
      <input defaultValue={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} style={{ ...inputStyle(), width: '100%', opacity: disabled ? 0.6 : 1 }} />
    </div>
  )
}

export default function Page() {
  return (
    <CrmProvider>
      <CrmShell title="Base Inventory" subtitle="Scraped website stock, reviewed before it reaches the Agent Board" dark>
        <BaseInventory />
      </CrmShell>
    </CrmProvider>
  )
}
