'use client'
// ============================================================================
// /crm/property-sources — ARGUS Integrations → Property Sources (Claude, 2026-11-09)
// Authorised provider collections (My Next Home Long Let / For Sale first),
// scan history, change proposals and the Accept / Reject / Link review flow.
// Real data only, from /api/crm/property-sources/* (admin-only backend).
// Accepting a NEW listing creates a STAGED, unpublished ARGUS draft — never a
// public listing, never a repost, never a WhatsApp message.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CrmProvider, CrmShell, useCrm, useIsMobile, DCARD, DCARD_BORDER, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER, A, F } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

type Source = {
  id: number; label: string; provider_name: string; category: 'long_let' | 'sale'; url: string; adapter: string
  read_permission: 'NOT_RECORDED' | 'GRANTED' | 'REVOKED'; permission_reference: string | null; permission_recorded_at: string | null
  media_use: 'LINK_ONLY' | 'LICENSED'; text_use: 'METADATA_ONLY' | 'LICENSED'; import_mode: string
  sync_enabled: boolean; interval_hours: number; next_check_at: string | null; last_check_at: string | null; last_success_at: string | null
  last_error: string | null; consecutive_failures: number; complete_scan_count: number; version: number
  polling_allowed: boolean; polling_blockers: string[]; pending: { new: number; updated: number; check: number; rejected: number }
}
type Digest = { id: number; createdAt: string; source_id: number; scan_id: number; label: string; counts: Record<string, number> }
type Price = { amount: string | null; basis: string | null; conflict?: boolean; quote_count?: number; candidate_prices?: { amount: string; basis: string; evidence: string }[] }
type Snapshot = { external_id: string; source_url: string; title: string; category: string; locality: string | null; bedrooms: number | null; bathrooms: number | null
  available_from_source: string | null; total_area_sqm?: number | null; price: Price; market_country?: string; private_address_candidate?: string | null; media_source_urls?: string[] }
type Candidate = { kind: 'property' | 'other_source'; id: number; ref?: string; town?: string; bedrooms?: number; price?: number; title?: string; source?: string; reasons: string[] }
type EventRow = { id: number; source_id: number; source_label: string; category: string; event_type: string; fingerprint: string; status: string; flags: string[]
  current: Snapshot; previous: Snapshot | null; field_changes: Record<string, { previous: any; current: any }>; match_candidates: Candidate[]
  created_at: string; decided_at: string | null; decision_result: any; stale: boolean; wsi_property_id: number | null }
type Detail = EventRow & { property: any; privacy: { address: string | null }; media: { use: string; count: number; urls: string[]; note: string | null }; provider_name: string; last_seen_at: string; first_seen_at: string; missing_scan_count: number }
type Scan = { id: number; trigger: string; started_at: string; finished_at: string | null; status: string; complete: boolean; items_seen: number | null; counts: Record<string, number>; error: string | null }

const TYPE_BADGE: Record<string, { label: string; fg: string; bg: string }> = {
  NEW: { label: 'NEW', fg: '#3ECF8E', bg: 'rgba(62,207,142,0.14)' },
  PRICE_UPDATED: { label: 'PRICE CHANGED', fg: '#F2A53D', bg: 'rgba(242,165,61,0.14)' },
  AVAILABILITY_CHANGED: { label: 'AVAILABILITY', fg: '#7EA0FF', bg: 'rgba(79,123,242,0.14)' },
  MEDIA_CHANGED: { label: 'PHOTOS', fg: '#B79CF7', bg: 'rgba(157,110,242,0.14)' },
  DETAILS_CHANGED: { label: 'DETAILS', fg: '#7EA0FF', bg: 'rgba(79,123,242,0.14)' },
  MISSING_FROM_SOURCE: { label: 'MISSING FROM SOURCE', fg: '#F2597A', bg: 'rgba(242,89,122,0.14)' },
}
const FLAG_LABEL: Record<string, string> = {
  PRICE_CONFLICT: 'Two current prices · lower chosen', NEEDS_PRICE_REVIEW: 'No advertised price', OUTSIDE_MALTA: 'Outside Malta',
  POSSIBLE_DUPLICATE: 'Possible duplicate', AVAILABILITY_CONFLICT: 'Conflicting dates', VERIFY_WITH_PROVIDER: 'Verify with provider',
}
const STATUS_TONE: Record<string, string> = { PENDING: '#F2A53D', CLARIFICATION: '#B79CF7', ACCEPTED: '#3ECF8E', LINKED: '#3ECF8E', REJECTED: DTEXT_FAINT, SUPERSEDED: DTEXT_FAINT, ACKNOWLEDGED: '#7EA0FF' }
const FIELD_LABEL: Record<string, string> = { price_amount: 'Price', price_basis: 'Price basis', price_candidates: 'Price quotes', available_from_source: 'Available from',
  bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', total_area_sqm: 'Area (sqm)', media_source_urls: 'Photos', title: 'Title', category: 'Category',
  availability_state: 'Source status', market_country: 'Market', private_address_candidate: 'Address (private)' }

const fmtTime = (d: string | null) => d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '—'
const money = (p: Price | undefined) => !p || p.amount == null ? 'Price unknown' : `€${Number(p.amount).toLocaleString('en-GB')}${p.basis === 'EUR_MONTH' ? '/month' : ''}`
const cat = (c: string) => c === 'sale' ? 'For Sale' : 'Long Let'
const valueText = (k: string, v: any) => v == null || (Array.isArray(v) && !v.length) ? '—' : k === 'media_source_urls' ? `${v.length} photo${v.length === 1 ? '' : 's'}` : k === 'price_amount' ? `€${Number(v).toLocaleString('en-GB')}` : Array.isArray(v) ? v.join(', ') : String(v)

const ui = {
  card: { background: DCARD, border: `1px solid ${DCARD_BORDER}`, borderRadius: 16, padding: 16 } as React.CSSProperties,
  btn: (tone: 'primary' | 'ghost' | 'danger' = 'ghost', disabled = false): React.CSSProperties => ({
    background: tone === 'primary' ? A : 'transparent', color: tone === 'primary' ? '#fff' : tone === 'danger' ? '#F2597A' : DTEXT,
    border: tone === 'primary' ? 'none' : `1px solid ${tone === 'danger' ? 'rgba(242,89,122,0.45)' : DBORDER}`, borderRadius: 9, padding: '7px 12px',
    fontSize: 12, fontWeight: 700, fontFamily: F, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, minHeight: 36, whiteSpace: 'nowrap' }),
  input: { background: 'var(--crm-raised)', border: `1px solid ${DBORDER}`, borderRadius: 9, padding: '8px 10px', fontSize: 13, color: DTEXT, fontFamily: F, minHeight: 36, minWidth: 0 } as React.CSSProperties,
  label: { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: DTEXT_DIM } as React.CSSProperties,
}
function Badge({ type }: { type: string }) {
  const b = TYPE_BADGE[type] || { label: type, fg: DTEXT_DIM, bg: 'rgba(255,255,255,0.06)' }
  return <span style={{ background: b.bg, color: b.fg, fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 999, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{b.label}</span>
}
function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, color: tone || DTEXT_DIM, border: `1px solid ${DBORDER}`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>{children}</span>
}

function PropertySources() {
  const { me } = useCrm()
  const mobile = useIsMobile()
  const [sources, setSources] = useState<Source[]>([])
  const [totals, setTotals] = useState({ new: 0, updated: 0, check: 0, rejected: 0 })
  const [digests, setDigests] = useState<Digest[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [filter, setFilter] = useState({ status: 'OPEN', type: '', source: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState<string>('')
  const [busy, setBusy] = useState<string>('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [history, setHistory] = useState<Record<number, Scan[] | undefined>>({})
  const [rightsFor, setRightsFor] = useState<number | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [notice, setNotice] = useState<Digest | null>(null)

  const loadSummary = useCallback(async () => {
    const s = await crmFetch('property-sources/summary')
    setSources(s.sources); setTotals(s.totals); setDigests(s.digests)
    let seen = 0
    try { seen = Number(localStorage.getItem('argus_source_digest_seen') || 0) } catch {}
    const latest = s.digests[0]
    setNotice(latest && latest.id > seen ? latest : null)
  }, [])
  const loadEvents = useCallback(async () => {
    const qs = new URLSearchParams({ status: filter.status, ...(filter.type ? { type: filter.type } : {}), ...(filter.source ? { source: filter.source } : {}) })
    setEvents(await crmFetch(`property-sources/events?${qs}`))
    setSelected([])
  }, [filter])
  const reload = useCallback(async () => {
    try { setError(''); await Promise.all([loadSummary(), loadEvents()]) }
    catch (e: any) { setError(e.status === 403 ? 'Property Sources is available to ARGUS admins only.' : e.message) }
    finally { setLoading(false) }
  }, [loadSummary, loadEvents])
  useEffect(() => { reload() }, [reload])
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 3800); return () => window.clearTimeout(t) }, [toast])

  const act = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key)
    try { await fn(); setToast(ok); await reload(); return true }
    catch (e: any) { setToast(e.data?.error || e.message); if (e.status === 409) await reload(); return false }
    finally { setBusy('') }
  }
  const openDetail = async (id: number) => { try { setDetail(await crmFetch(`property-sources/events/${id}`)) } catch (e: any) { setToast(e.message) } }
  const decide = async (ev: { id: number; fingerprint: string }, action: string, body: Record<string, any> = {}) => {
    const done = await act(`${action}-${ev.id}`, () => crmJson(`property-sources/events/${ev.id}/${action}`, 'POST', { fingerprint: ev.fingerprint, ...body }),
      action === 'accept' ? 'Accepted — staged ARGUS draft, not published' : action === 'link' ? 'Linked to the existing ARGUS property' : action === 'reject' ? 'Rejected — kept in source history' : action === 'acknowledge' ? 'Noted — verify with the provider' : 'Marked for clarification')
    if (done) setDetail(null)
  }
  const dismissNotice = () => { if (notice) { try { localStorage.setItem('argus_source_digest_seen', String(notice.id)) } catch {} } setNotice(null) }
  const toggleHistory = async (id: number) => {
    if (history[id]) { setHistory(h => ({ ...h, [id]: undefined })); return }
    try { const rows = await crmFetch(`property-sources/sources/${id}/scans`); setHistory(h => ({ ...h, [id]: rows })) } catch (e: any) { setToast(e.message) }
  }
  const safeIds = useMemo(() => events.filter(e => e.status === 'PENDING' && e.event_type === 'NEW' && !e.stale && !e.flags.some(f => ['PRICE_CONFLICT', 'NEEDS_PRICE_REVIEW', 'OUTSIDE_MALTA', 'POSSIBLE_DUPLICATE', 'AVAILABILITY_CONFLICT'].includes(f))).map(e => e.id), [events])

  if (loading) return <CrmShell title="Property Sources" dark><p style={{ color: DTEXT_DIM, padding: 24 }}>Loading sources…</p></CrmShell>
  if (error && !sources.length) return <CrmShell title="Property Sources" dark><div style={{ ...ui.card, margin: 24 }} role="alert">{error}</div></CrmShell>

  return (
    <CrmShell title="Property Sources" subtitle="Integrations · authorised provider listings, reviewed before they reach ARGUS" dark>
      <div data-testid="property-sources" style={{ padding: mobile ? '12px 12px 96px' : '20px 24px 48px', display: 'grid', gap: 16, fontFamily: F, color: DTEXT, maxWidth: 1320 }}>
        {notice && (
          <div role="status" data-testid="sync-notice" style={{ ...ui.card, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderColor: 'rgba(64,86,232,0.5)' }}>
            <span style={{ fontSize: 18 }}>🔔</span>
            <div style={{ flex: 1, minWidth: 200 }}>
              <b>{notice.label}</b>: {[notice.counts.new ? `${notice.counts.new} new listing${notice.counts.new === 1 ? '' : 's'} detected` : '',
                (notice.counts.price_updated + notice.counts.availability_changed + notice.counts.details_changed + notice.counts.media_changed) ? `${notice.counts.price_updated + notice.counts.availability_changed + notice.counts.details_changed + notice.counts.media_changed} existing listing(s) changed` : '',
                notice.counts.missing ? `${notice.counts.missing} need availability verification` : ''].filter(Boolean).join(' · ')}
              <div style={{ fontSize: 11, color: DTEXT_DIM }}>Scan {fmtTime(notice.createdAt)}</div>
            </div>
            <button style={ui.btn('primary')} onClick={() => { setFilter({ status: 'OPEN', type: '', source: String(notice.source_id) }); dismissNotice() }}>Open review queue</button>
            <button style={ui.btn()} onClick={dismissNotice} aria-label="Dismiss notification">Dismiss</button>
          </div>
        )}

        <section aria-label="Review totals" style={{ display: 'grid', gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, minmax(0, 180px)) 1fr', gap: 10, alignItems: 'stretch' }}>
          {[['New', totals.new, '#3ECF8E', 'NEW'], ['Updated', totals.updated, '#F2A53D', 'PRICE_UPDATED'], ['Check', totals.check, '#F2597A', 'MISSING_FROM_SOURCE'], ['Rejected', totals.rejected, DTEXT_DIM, 'REJECTED']].map(([l, n, c, t]) => (
            <button key={String(l)} data-testid={`kpi-${String(l).toLowerCase()}`} onClick={() => setFilter(f => t === 'REJECTED' ? { ...f, status: 'REJECTED', type: '' } : ({ ...f, status: 'OPEN', type: t === 'PRICE_UPDATED' ? '' : String(t) }))}
              style={{ ...ui.card, textAlign: 'left', cursor: 'pointer', padding: mobile ? 12 : 16 }}>
              <div style={ui.label}>{l}</div><div style={{ fontSize: mobile ? 24 : 30, fontWeight: 800, color: String(c), lineHeight: 1.1 }}>{n}</div>
            </button>
          ))}
          {!mobile && <div style={{ ...ui.card, fontSize: 12, color: DTEXT_DIM, lineHeight: 1.5 }}>Counts come from real scan differences only. Accepting creates an <b style={{ color: DTEXT }}>unpublished staged draft</b>; nothing is posted or messaged.</div>}
        </section>

        <section aria-label="Sources" style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <h2 style={{ fontSize: 16, margin: 0 }}>Sources</h2>
            <button style={ui.btn()} onClick={() => setShowAdd(v => !v)}>{showAdd ? 'Close' : '+ Add source URL'}</button>
          </div>
          {showAdd && <AddSource onDone={async msg => { setShowAdd(false); setToast(msg); await reload() }} />}
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
            {sources.map(s => (
              <article key={s.id} data-testid={`source-${s.id}`} style={{ ...ui.card, display: 'grid', gap: 10 }}>
                <header style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{s.provider_name} · {cat(s.category)}</div>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: DTEXT_DIM, wordBreak: 'break-all' }}>{s.url} ↗</a>
                  </div>
                  <Chip tone={s.sync_enabled ? '#3ECF8E' : DTEXT_DIM}>{s.sync_enabled ? `Auto · every ${s.interval_hours} h` : 'Paused'}</Chip>
                </header>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Chip tone="#3ECF8E">{s.pending.new} New</Chip><Chip tone="#F2A53D">{s.pending.updated} Updated</Chip><Chip tone="#F2597A">{s.pending.check} Check</Chip><Chip>{s.pending.rejected} Rejected</Chip>
                </div>
                <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12, margin: 0 }}>
                  <dt style={{ color: DTEXT_DIM }}>Last check</dt><dd style={{ margin: 0 }}>{fmtTime(s.last_check_at)}{s.last_success_at && s.last_success_at !== s.last_check_at ? ` · last success ${fmtTime(s.last_success_at)}` : ''}</dd>
                  <dt style={{ color: DTEXT_DIM }}>Next check</dt><dd style={{ margin: 0 }}>{s.sync_enabled ? fmtTime(s.next_check_at) : 'Not scheduled'}</dd>
                  <dt style={{ color: DTEXT_DIM }}>Rights</dt><dd style={{ margin: 0 }}>Read/sync: <b>{s.read_permission.replace('_', ' ').toLowerCase()}</b> · Photos: {s.media_use === 'LICENSED' ? 'licensed' : 'link only'} · Text: {s.text_use === 'LICENSED' ? 'licensed' : 'metadata only'}</dd>
                </dl>
                {s.last_error && <div role="alert" style={{ fontSize: 12, color: '#F2597A' }}>Last scan failed: {s.last_error}</div>}
                {!s.polling_allowed && (
                  <div data-testid="polling-blocker" style={{ fontSize: 12, background: 'rgba(242,165,61,0.10)', border: '1px solid rgba(242,165,61,0.35)', borderRadius: 10, padding: '8px 10px', color: '#F2A53D' }}>
                    Connector disabled: {s.polling_blockers.join('; ')}. No request is sent to {new URL(s.url).hostname} until permission is recorded.
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={ui.label}>Interval</span>
                    <select aria-label={`Check interval for ${s.label}`} style={ui.input} value={s.interval_hours}
                      onChange={e => act(`int-${s.id}`, () => crmJson(`property-sources/sources/${s.id}`, 'PATCH', { interval_hours: Number(e.target.value), version: s.version }), 'Interval saved')}>
                      {[6, 12, 24, 48, 72, 168].map(h => <option key={h} value={h}>{h < 24 ? `${h} h` : h === 168 ? 'Weekly' : `${h / 24} day${h === 24 ? '' : 's'}`}</option>)}
                    </select>
                  </label>
                  <button style={ui.btn('ghost', !s.polling_allowed || !!busy)} disabled={!s.polling_allowed || !!busy}
                    title={s.polling_allowed ? '' : s.polling_blockers.join('; ')}
                    onClick={() => act(`sync-${s.id}`, () => crmJson(`property-sources/sources/${s.id}`, 'PATCH', { sync_enabled: !s.sync_enabled, version: s.version }), s.sync_enabled ? 'Automatic checks paused' : 'Automatic checks enabled')}>
                    {s.sync_enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button style={ui.btn('primary', !s.polling_allowed || !!busy)} disabled={!s.polling_allowed || !!busy}
                    onClick={() => act(`scan-${s.id}`, () => crmJson(`property-sources/sources/${s.id}/scan`, 'POST', {}), 'Scan finished')}>
                    {busy === `scan-${s.id}` ? 'Scanning…' : 'Run scan now'}
                  </button>
                  <button style={ui.btn()} onClick={() => setRightsFor(rightsFor === s.id ? null : s.id)}>Rights</button>
                  <button style={ui.btn()} onClick={() => toggleHistory(s.id)} aria-expanded={!!history[s.id]}>Scan history</button>
                </div>
                {rightsFor === s.id && <RightsForm source={s} onDone={async msg => { setRightsFor(null); setToast(msg); await reload() }} />}
                {history[s.id] && (
                  <div style={{ fontSize: 12, display: 'grid', gap: 6 }} data-testid={`history-${s.id}`}>
                    {!history[s.id]!.length && <span style={{ color: DTEXT_DIM }}>No scans yet.</span>}
                    {history[s.id]!.map(h => (
                      <div key={h.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: `1px solid ${DBORDER}`, paddingTop: 6 }}>
                        <b style={{ color: h.status === 'FAILED' ? '#F2597A' : DTEXT }}>{h.status}</b><span>{fmtTime(h.started_at)}</span><span>{h.trigger.toLowerCase()}</span>
                        {h.items_seen != null && <span>{h.items_seen} listings</span>}{!h.complete && h.status !== 'RUNNING' && <span style={{ color: DTEXT_DIM }}>incomplete — nothing marked missing</span>}
                        {h.counts && Object.entries(h.counts).filter(([, n]) => n).map(([k, n]) => <span key={k}>{n} {k.replace('_', ' ')}</span>)}
                        {h.error && <span style={{ color: '#F2597A' }}>{h.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        <section aria-label="Review queue" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <h2 style={{ fontSize: 16, margin: '0 auto 0 0' }}>Review queue</h2>
            <select aria-label="Status filter" style={ui.input} value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
              {[['OPEN', 'Open'], ['PENDING', 'Pending'], ['CLARIFICATION', 'Clarification'], ['ACCEPTED', 'Accepted'], ['LINKED', 'Linked'], ['REJECTED', 'Rejected'], ['SUPERSEDED', 'Superseded'], ['ALL', 'All']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select aria-label="Type filter" style={ui.input} value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}>
              <option value="">All changes</option>{Object.entries(TYPE_BADGE).map(([v, b]) => <option key={v} value={v}>{b.label}</option>)}
            </select>
            <select aria-label="Source filter" style={ui.input} value={filter.source} onChange={e => setFilter(f => ({ ...f, source: e.target.value }))}>
              <option value="">All sources</option>{sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            {selected.length > 0 && filter.source && (
              <button style={ui.btn('primary', !!busy)} disabled={!!busy}
                onClick={() => act('batch', () => crmJson(`property-sources/sources/${filter.source}/accept-safe-new`, 'POST', { ids: selected }), 'Safe new listings staged as drafts')}>
                Accept {selected.length} safe draft{selected.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
          {!events.length && <div style={{ ...ui.card, color: DTEXT_DIM, fontSize: 13 }} data-testid="queue-empty">No proposals for this filter. {sources.every(s => !s.polling_allowed) ? 'Sources are registered but no scan has run: provider permission is not recorded yet.' : ''}</div>}
          <div style={{ display: 'grid', gap: 8 }}>
            {events.map(e => {
              const changeLine = e.event_type === 'PRICE_UPDATED' && e.field_changes.price_amount ? `${valueText('price_amount', e.field_changes.price_amount.previous)} → ${valueText('price_amount', e.field_changes.price_amount.current)}` :
                e.event_type === 'MISSING_FROM_SOURCE' ? 'Verify with provider · never marked rented without confirmation' :
                e.event_type !== 'NEW' ? Object.keys(e.field_changes).map(k => FIELD_LABEL[k] || k).join(', ') : ''
              const open = ['PENDING', 'CLARIFICATION'].includes(e.status)
              const canBatch = filter.source && safeIds.includes(e.id)
              return (
                <article key={e.id} data-testid={`event-${e.id}`} style={{ ...ui.card, padding: 12, display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'auto minmax(0,1fr) auto', gap: 10, alignItems: 'center' }}>
                  {!mobile && <input type="checkbox" aria-label={`Select ${e.current.title}`} disabled={!canBatch} checked={selected.includes(e.id)} onChange={ev => setSelected(s => ev.target.checked ? [...s, e.id] : s.filter(x => x !== e.id))} />}
                  <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Badge type={e.event_type} />
                      <b style={{ fontSize: 14 }}>{e.current.title}</b>
                    </div>
                    <div style={{ fontSize: 12, color: DTEXT_DIM, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ color: DTEXT, fontWeight: 700 }}>{money(e.current.price)}</span>
                      {e.current.bedrooms != null && <span>{e.current.bedrooms} BR</span>}
                      <span>{e.source_label}</span><span>{fmtTime(e.created_at)}</span>
                      {changeLine && <span style={{ color: DTEXT }}>{changeLine}</span>}
                      <span style={{ color: STATUS_TONE[e.status] || DTEXT_DIM, fontWeight: 700 }}>{e.status.toLowerCase()}</span>
                      {e.stale && open && <span style={{ color: '#F2597A' }}>source changed since — review latest</span>}
                    </div>
                    {!!e.flags.length && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{e.flags.map(f => <Chip key={f} tone={f === 'PRICE_CONFLICT' || f === 'OUTSIDE_MALTA' ? '#F2A53D' : undefined}>{FLAG_LABEL[f] || f}</Chip>)}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: mobile ? 'flex-start' : 'flex-end' }}>
                    <button style={ui.btn()} onClick={() => openDetail(e.id)}>{e.event_type === 'NEW' ? 'Preview' : 'Compare evidence'}</button>
                    {open && e.event_type !== 'MISSING_FROM_SOURCE' && <button style={ui.btn('primary', !!busy || e.stale)} disabled={!!busy || e.stale} onClick={() => decide(e, 'accept')}>Accept</button>}
                    {open && e.event_type === 'MISSING_FROM_SOURCE' && <button style={ui.btn('primary', !!busy)} disabled={!!busy} onClick={() => decide(e, 'acknowledge')}>Noted · verify</button>}
                    {open && <button style={ui.btn('danger', !!busy)} disabled={!!busy} onClick={() => openDetail(e.id)} aria-label={`Reject ${e.current.title}`}>Reject…</button>}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        {!!digests.length && (
          <section aria-label="Sync notifications" style={{ ...ui.card, display: 'grid', gap: 6, fontSize: 12 }}>
            <div style={ui.label}>Recent sync notifications</div>
            {digests.slice(0, 6).map(d => <div key={d.id}>{fmtTime(d.createdAt)} · <b>{d.label}</b> · {Object.entries(d.counts || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')}</div>)}
          </section>
        )}
      </div>

      {detail && <DetailPanel detail={detail} mobile={mobile} busy={busy} onClose={() => setDetail(null)} onDecide={decide} />}
      {toast && <div role="status" data-testid="toast" style={{ position: 'fixed', left: '50%', bottom: mobile ? 86 : 24, transform: 'translateX(-50%)', background: '#151C2C', color: '#fff', padding: '10px 16px', borderRadius: 12, fontSize: 13, fontFamily: F, zIndex: 90, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}>{toast}</div>}
    </CrmShell>
  )
}

function AddSource({ onDone }: { onDone: (msg: string) => void }) {
  const [form, setForm] = useState({ category: 'long_let', url: 'https://www.mynexthome.mt/long-let/' })
  const [err, setErr] = useState(''); const [saving, setSaving] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setErr('')
    try { await crmJson('property-sources/sources', 'POST', { adapter: 'mynexthome', ...form }); onDone('Source registered — disabled until permission is recorded') }
    catch (x: any) { setErr(x.data?.error || x.message) } finally { setSaving(false) }
  }
  return (
    <form onSubmit={submit} style={{ ...ui.card, display: 'grid', gap: 10 }} data-testid="add-source">
      <div style={{ fontSize: 12, color: DTEXT_DIM }}>Approved connector: My Next Home. Long Let and For Sale only; Short Let is a separate channel.</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select aria-label="Category" style={ui.input} value={form.category} onChange={e => setForm({ category: e.target.value, url: e.target.value === 'sale' ? 'https://www.mynexthome.mt/for-sale/' : 'https://www.mynexthome.mt/long-let/' })}>
          <option value="long_let">Long Let</option><option value="sale">For Sale</option>
        </select>
        <input aria-label="Collection URL" style={{ ...ui.input, flex: 1, minWidth: 220 }} value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
        <button style={ui.btn('primary', saving)} disabled={saving}>Register</button>
      </div>
      {err && <div role="alert" style={{ color: '#F2597A', fontSize: 12 }}>{err}</div>}
    </form>
  )
}

function RightsForm({ source, onDone }: { source: Source; onDone: (msg: string) => void }) {
  const [p, setP] = useState({ read_permission: source.read_permission, reference: source.permission_reference || '', media_use: source.media_use, text_use: source.text_use })
  const [err, setErr] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('')
    try { await crmJson(`property-sources/sources/${source.id}`, 'PATCH', { permission: p, version: source.version }); onDone('Rights record saved') }
    catch (x: any) { setErr(x.data?.error || x.message) }
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 8, borderTop: `1px solid ${DBORDER}`, paddingTop: 10 }} data-testid={`rights-${source.id}`}>
      <div style={{ fontSize: 12, color: DTEXT_DIM }}>Record only what {source.provider_name} has actually agreed to. Automatic checks stay off without a written permission reference.</div>
      <label style={{ display: 'grid', gap: 4 }}><span style={ui.label}>Read / sync permission</span>
        <select style={ui.input} value={p.read_permission} onChange={e => setP({ ...p, read_permission: e.target.value as Source['read_permission'] })}>
          <option value="NOT_RECORDED">Not recorded</option><option value="GRANTED">Granted in writing</option><option value="REVOKED">Revoked</option>
        </select></label>
      <label style={{ display: 'grid', gap: 4 }}><span style={ui.label}>Evidence (agreement, email, date)</span>
        <input style={ui.input} value={p.reference} onChange={e => setP({ ...p, reference: e.target.value })} placeholder="e.g. Email from provider, 12 Nov 2026" /></label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 4, flex: 1 }}><span style={ui.label}>Photos</span>
          <select style={ui.input} value={p.media_use} onChange={e => setP({ ...p, media_use: e.target.value as Source['media_use'] })}><option value="LINK_ONLY">Link only</option><option value="LICENSED">Licensed for reuse</option></select></label>
        <label style={{ display: 'grid', gap: 4, flex: 1 }}><span style={ui.label}>Descriptions</span>
          <select style={ui.input} value={p.text_use} onChange={e => setP({ ...p, text_use: e.target.value as Source['text_use'] })}><option value="METADATA_ONLY">Metadata only</option><option value="LICENSED">Licensed</option></select></label>
      </div>
      {err && <div role="alert" style={{ color: '#F2597A', fontSize: 12 }}>{err}</div>}
      <button style={ui.btn('primary')}>Save rights record</button>
    </form>
  )
}

function DetailPanel({ detail: d, mobile, busy, onClose, onDecide }: { detail: Detail; mobile: boolean; busy: string; onClose: () => void; onDecide: (ev: { id: number; fingerprint: string }, action: string, body?: Record<string, any>) => void }) {
  const [linkId, setLinkId] = useState('')
  const [reason, setReason] = useState('')
  const open = ['PENDING', 'CLARIFICATION'].includes(d.status)
  const quotes = d.current.price?.candidate_prices || []
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label={`Review ${d.current.title}`} data-testid="detail" onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(5,10,20,0.55)', zIndex: 80, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: mobile ? '100%' : 560, height: '100%', overflowY: 'auto', background: 'var(--crm-bg)', color: DTEXT, fontFamily: F, padding: mobile ? '16px 14px 110px' : 24, display: 'grid', gap: 14, alignContent: 'start', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
          <div><Badge type={d.event_type} /><h2 style={{ margin: '8px 0 4px', fontSize: 19 }}>{d.current.title}</h2>
            <div style={{ fontSize: 12, color: DTEXT_DIM }}>{d.source_label} · first seen {fmtTime(d.first_seen_at)} · last seen {fmtTime(d.last_seen_at)}</div></div>
          <button style={ui.btn()} onClick={onClose} aria-label="Close">✕</button>
        </div>
        {d.stale && open && <div role="alert" style={{ color: '#F2597A', fontSize: 13 }}>The source changed after this proposal. Approve the latest one instead.</div>}
        <section style={{ ...ui.card, display: 'grid', gap: 6 }}>
          <div style={ui.label}>Proposed price</div>
          <div style={{ fontSize: 26, fontWeight: 800 }} data-testid="detail-price">{money(d.current.price)}</div>
          {quotes.length > 1 && <div style={{ fontSize: 12, color: '#F2A53D' }}>PRICE CONFLICT — {quotes.length} explicit current quotes; the lower one is proposed. Both are kept for review.</div>}
          {quotes.map((q, i) => <div key={i} style={{ fontSize: 12, color: DTEXT_DIM }}>€{Number(q.amount).toLocaleString('en-GB')} {q.basis === 'EUR_MONTH' ? 'per month' : 'sale'} — “{q.evidence}”</div>)}
          {d.current.price?.amount == null && <div style={{ fontSize: 12, color: '#F2A53D' }}>No comparable advertised price. The draft keeps the price empty until someone confirms it.</div>}
        </section>
        {d.event_type !== 'NEW' && Object.keys(d.field_changes || {}).length > 0 && (
          <section style={{ ...ui.card }}>
            <div style={ui.label}>What changed</div>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', marginTop: 8 }}>
              <thead><tr style={{ color: DTEXT_DIM, textAlign: 'left' }}><th style={{ padding: '4px 0' }}>Field</th><th>Before</th><th>Now</th></tr></thead>
              <tbody>{Object.entries(d.field_changes).map(([k, v]) => <tr key={k} style={{ borderTop: `1px solid ${DBORDER}` }}><td style={{ padding: '6px 0', color: DTEXT_DIM }}>{FIELD_LABEL[k] || k}</td><td>{valueText(k, v.previous)}</td><td style={{ fontWeight: 700 }}>{valueText(k, v.current)}</td></tr>)}</tbody>
            </table>
          </section>
        )}
        <section style={{ ...ui.card, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px', fontSize: 12.5 }}>
          <span style={{ color: DTEXT_DIM }}>Category</span><span>{cat(d.current.category)} (from the source collection)</span>
          <span style={{ color: DTEXT_DIM }}>Locality</span><span>{d.current.locality || '—'}{d.current.market_country === 'OUTSIDE_MALTA' ? ' · outside Malta' : ''}</span>
          <span style={{ color: DTEXT_DIM }}>Bedrooms / baths</span><span>{d.current.bedrooms ?? '—'} / {d.current.bathrooms ?? '—'}</span>
          <span style={{ color: DTEXT_DIM }}>Area</span><span>{d.current.total_area_sqm ? `${d.current.total_area_sqm} sqm` : '—'}</span>
          <span style={{ color: DTEXT_DIM }}>Available (source)</span><span>{d.current.available_from_source || '—'} · unverified</span>
          <span style={{ color: DTEXT_DIM }}>Address</span><span>{d.privacy.address ? <>🔒 {d.current.private_address_candidate} <i style={{ color: DTEXT_DIM }}>(private, admin only)</i></> : '—'}</span>
          <span style={{ color: DTEXT_DIM }}>Photos</span><span>{d.media.count} at source · {d.media.use === 'LICENSED' ? 'licensed' : 'link only — view on the source page'}</span>
          <span style={{ color: DTEXT_DIM }}>Source</span><a href={d.current.source_url} target="_blank" rel="noopener noreferrer" style={{ color: A, wordBreak: 'break-all' }}>Open source listing ↗</a>
        </section>
        {d.media.urls.length > 0 && <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>{d.media.urls.slice(0, 8).map(u => <img key={u} src={u} alt="" style={{ width: 96, height: 64, objectFit: 'cover', borderRadius: 8 }} />)}</div>}
        {d.property && (
          <section style={{ ...ui.card, fontSize: 12.5 }}>
            <div style={ui.label}>Linked ARGUS property</div>
            <div style={{ marginTop: 6 }}><b>{d.property.ref}</b> · {d.property.town} · {d.property.is_staging ? 'staged draft' : 'active'} · {d.property.published ? 'published' : 'not published'} · {d.property.available_status}</div>
          </section>
        )}
        {d.event_type === 'NEW' && (
          <section style={{ ...ui.card, display: 'grid', gap: 8, fontSize: 12.5 }}>
            <div style={ui.label}>Possible existing matches</div>
            {!d.match_candidates.length && <span style={{ color: DTEXT_DIM }}>No likely match in ARGUS. Same building is never treated as the same flat.</span>}
            {d.match_candidates.map(c => (
              <div key={`${c.kind}-${c.id}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 180 }}>{c.kind === 'property' ? <><b>{c.ref}</b> · {c.town} · {c.bedrooms} BR · {c.price ? `€${Number(c.price).toLocaleString('en-GB')}` : 'no price'}</> : <>{c.title} · {c.source}</>}<br /><span style={{ color: DTEXT_DIM }}>{c.reasons.join(' · ')}</span></span>
                {c.kind === 'property' && open && <button style={ui.btn('ghost', !!busy || d.stale)} disabled={!!busy || d.stale} onClick={() => onDecide(d, 'link', { propertyId: c.id })}>Link to this</button>}
              </div>
            ))}
            {open && <div style={{ display: 'flex', gap: 6 }}><input aria-label="Existing property id" style={{ ...ui.input, flex: 1 }} inputMode="numeric" placeholder="Existing ARGUS property ID" value={linkId} onChange={e => setLinkId(e.target.value.replace(/\D/g, ''))} />
              <button style={ui.btn('ghost', !linkId || !!busy || d.stale)} disabled={!linkId || !!busy || d.stale} onClick={() => onDecide(d, 'link', { propertyId: Number(linkId) })}>Link existing</button></div>}
          </section>
        )}
        {open && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', position: mobile ? 'sticky' : 'static', bottom: 0, background: 'var(--crm-bg)', padding: mobile ? '10px 0' : 0 }}>
            {d.event_type === 'MISSING_FROM_SOURCE'
              ? <button style={ui.btn('primary', !!busy)} disabled={!!busy} onClick={() => onDecide(d, 'acknowledge')}>Noted · verify with provider</button>
              : <button style={ui.btn('primary', !!busy || d.stale)} disabled={!!busy || d.stale} onClick={() => onDecide(d, 'accept')}>{d.event_type === 'NEW' ? 'Accept as staged draft' : 'Accept change'}</button>}
            <button style={ui.btn('ghost', !!busy)} disabled={!!busy} onClick={() => onDecide(d, 'clarify', reason.trim() ? { note: reason.trim() } : {})}>Request clarification</button>
          </div>
        )}
        {open && (
          <section style={{ ...ui.card, display: 'grid', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}><span style={ui.label}>Reason (required to reject, kept in history)</span>
              <textarea data-testid="reject-reason" rows={2} style={{ ...ui.input, resize: 'vertical' }} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Already listed by the owner directly" /></label>
            <button style={ui.btn('danger', !!busy || !reason.trim())} disabled={!!busy || !reason.trim()} onClick={() => onDecide(d, 'reject', { note: reason.trim() })}>Reject with reason</button>
          </section>
        )}
        {!open && d.decision_result && <div style={{ fontSize: 12, color: DTEXT_DIM }} data-testid="decision">Decided {fmtTime(d.decided_at)}: {d.status.toLowerCase()}{(d as any).decision_note ? ` — “${(d as any).decision_note}”` : ''}{d.decision_result.applied ? ` · applied ${d.decision_result.applied.join(', ') || 'nothing'}` : ''}{d.decision_result.skipped?.length ? ` · kept newer owner data for ${d.decision_result.skipped.map((s: any) => s.field).join(', ')}` : ''}</div>}
      </div>
    </div>
  )
}

export default function Page() {
  return <CrmProvider><PropertySources /></CrmProvider>
}
