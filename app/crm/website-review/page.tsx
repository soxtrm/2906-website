'use client'
// ============================================================================
// /crm/website-review — listings taken off the public website (2026-11-20).
// What is hidden, why, and where it comes from. An admin can show an entry again
// when nothing else vouches for it (no ARGUS listing behind it), with a reason
// that goes on record. A listing that follows ARGUS is never forced back here:
// it returns by itself once ARGUS holds it as available and published.
// Data: /api/crm/website-review (admins only). Nothing is deleted on this page.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'
import './review.css'

type Row = {
  websiteId: string; ref: string | null; slug: string | null; title: string | null; location: string | null; price: number | null; category: string | null
  websiteStatus: string; photos: number; createdAt: string; lastChangedAt: string; hiddenAt: string; reason: string
  hasArgusListing: boolean; propertyId: number | null; argusStatus: string | null; argusPublished: boolean | null; argusConfirmedAt: string | null
  source: 'argus' | 'argus_deleted' | 'legacy_website' | 'unknown'; canShow: boolean; howToShow: string
}
type Entry = { at: string; action: string; reason: string | null; argusStatus: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

const SOURCE: Record<Row['source'], string> = { argus: 'ARGUS listing', legacy_website: 'Older website entry', argus_deleted: 'ARGUS listing deleted', unknown: 'Origin unclear' }
const ARGUS_STATUS: Record<string, string> = { available: 'Available', available_confirmed: 'Available, confirmed', rented: 'Rented', archived: 'Archived', not_available: 'Not available', pending_check: 'Availability under review', upcoming: 'Upcoming' }
const ACTION: Record<string, string> = { hide: 'Taken off the website', show: 'Shown again', rented: 'Marked rented', refresh: 'Refreshed from ARGUS' }
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const stamp = (s: string) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const reasonLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1).replace(/_/g, ' ')

export default function WebsiteReviewPage() {
  return <CrmProvider><WebsiteReview /></CrmProvider>
}

function WebsiteReview() {
  const { me } = useCrm()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reason, setReason] = useState('all')
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [history, setHistory] = useState<Entry[] | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    try { const d = await crmFetch('website-review'); setRows(d.listings || []); setErr(null) }
    catch (e: any) { setErr(e?.status === 403 ? 'Only admins can review hidden listings.' : (e?.message || 'Could not load the list')) }
  }, [])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    setHistory(null); setNote('')
    if (!open) return
    setNotice(null)
    let alive = true
    crmFetch(`website-review/${open}/history`).then(d => { if (alive) setHistory(d.history || []) }).catch(() => { if (alive) setHistory([]) })
    return () => { alive = false }
  }, [open])

  const reasons = useMemo(() => [...new Set((rows || []).map(r => r.reason))].sort(), [rows])
  const shown = useMemo(() => (rows || []).filter(r =>
    (reason === 'all' || r.reason === reason) && (source === 'all' || r.source === source)
    && (!query.trim() || `${r.ref || ''} ${r.title || ''} ${r.location || ''}`.toLowerCase().includes(query.trim().toLowerCase()))), [rows, reason, source, query])
  const current = (rows || []).find(r => r.websiteId === open) || null
  const count = (fn: (r: Row) => boolean) => (rows || []).filter(fn).length

  async function showAgain() {
    if (!current) return
    setBusy(true); setNotice(null)
    try {
      await crmJson(`website-review/${current.websiteId}/show`, 'POST', { reason: note.trim() })
      setNotice({ tone: 'ok', text: `${current.ref || 'The listing'} is on the website again.` })
      setOpen(null); await load()
    } catch (e: any) { setNotice({ tone: 'err', text: e?.data?.error || e?.message || 'Could not show the listing' }) }
    finally { setBusy(false) }
  }

  return (
    <CrmShell title="Website review" subtitle="Listings taken off the public website, and why">
      {err && <p className="wr-error" role="alert">{err}</p>}
      {notice && !open && <p className={notice.tone === 'ok' ? 'wr-ok' : 'wr-error'} role="status">{notice.text}</p>}
      {rows && me?.role === 'admin' && (
        <>
          <div className="wr-stats">
            <div><strong>{rows.length}</strong><span>hidden in total</span></div>
            <div><strong>{count(r => r.source === 'argus')}</strong><span>follow ARGUS</span></div>
            <div><strong>{count(r => r.canShow)}</strong><span>can be shown by an admin</span></div>
          </div>
          <div className="wr-filters">
            <label><span>Reason</span>
              <select value={reason} onChange={e => setReason(e.target.value)}>
                <option value="all">All reasons</option>
                {reasons.map(r => <option key={r} value={r}>{reasonLabel(r)} ({count(x => x.reason === r)})</option>)}
              </select>
            </label>
            <label><span>Source</span>
              <select value={source} onChange={e => setSource(e.target.value)}>
                <option value="all">All sources</option>
                {(Object.keys(SOURCE) as Row['source'][]).filter(s => count(x => x.source === s) > 0).map(s => <option key={s} value={s}>{SOURCE[s]} ({count(x => x.source === s)})</option>)}
              </select>
            </label>
            <label className="wr-search"><span>Search</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Reference, title or town" /></label>
          </div>

          <div className="wr-grid">
            <div className="wr-list" role="list" aria-label="Hidden listings">
              {!shown.length ? <p className="wr-empty">{rows.length ? 'Nothing matches these filters.' : 'No listing is hidden right now.'}</p> : shown.map(r => (
                <button key={r.websiteId} type="button" role="listitem" className={`wr-row${open === r.websiteId ? ' is-open' : ''}`} onClick={() => setOpen(r.websiteId)}>
                  <span className="wr-row-main"><strong>{r.ref ? `#${r.ref}` : 'No reference'}</strong><em>{[r.location, r.price ? `€${r.price.toLocaleString('en-GB')}` : null].filter(Boolean).join(' · ') || r.title || '—'}</em></span>
                  <span className="wr-row-meta"><i className={`wr-tag is-${r.source}`}>{SOURCE[r.source]}</i><small>{reasonLabel(r.reason)} · hidden {day(r.hiddenAt)}</small></span>
                </button>
              ))}
            </div>

            <aside className="wr-detail" aria-live="polite">
              {!current ? <p className="wr-empty">Choose a listing to see where it comes from and what can be done.</p> : (
                <>
                  <header>
                    <h2>{current.ref ? `#${current.ref}` : 'No reference'}</h2>
                    <p>{current.title || [current.location, current.category].filter(Boolean).join(' · ') || 'No title'}</p>
                  </header>
                  <dl className="wr-facts">
                    <div><dt>Source</dt><dd>{SOURCE[current.source]}</dd></div>
                    <div><dt>Why it is hidden</dt><dd>{reasonLabel(current.reason)}</dd></div>
                    <div><dt>Hidden on</dt><dd>{day(current.hiddenAt)}</dd></div>
                    <div><dt>On the website since</dt><dd>{day(current.createdAt)}</dd></div>
                    <div><dt>Website state</dt><dd>{current.websiteStatus === 'rented' ? 'Rented' : 'Available'} · {current.photos} photo{current.photos === 1 ? '' : 's'}</dd></div>
                    {current.hasArgusListing ? (
                      <>
                        <div><dt>ARGUS status</dt><dd>{ARGUS_STATUS[current.argusStatus || ''] || current.argusStatus || '—'}</dd></div>
                        <div><dt>Published in ARGUS</dt><dd>{current.argusPublished ? 'Yes' : 'No'}</dd></div>
                        <div><dt>Last confirmed available</dt><dd>{current.argusConfirmedAt ? day(current.argusConfirmedAt) : 'Never'}</dd></div>
                      </>
                    ) : <div><dt>ARGUS</dt><dd>No listing behind this entry</dd></div>}
                  </dl>
                  <div className="wr-links">
                    {current.propertyId && <Link href={`/crm/property/${current.propertyId}`}>Open in ARGUS</Link>}
                    {current.slug && <span title="The public page is not reachable while the listing is hidden">Public address: /property/{current.slug}</span>}
                  </div>

                  {current.canShow ? (
                    <form className="wr-show" onSubmit={e => { e.preventDefault(); showAgain() }}>
                      <label htmlFor="wr-note">Why may this listing be shown again?</label>
                      <textarea id="wr-note" value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={300} placeholder="For example: owner confirmed by phone today that it is still available" />
                      <p>Your name and this reason go on record. Nothing checks this listing afterwards, so only show it when someone has confirmed it.</p>
                      <button type="submit" disabled={busy || note.trim().length < 5}>{busy ? 'Showing…' : 'Show on the website again'}</button>
                    </form>
                  ) : (
                    <p className="wr-follow">This listing follows ARGUS. It comes back by itself when it is available and published there; showing it by hand is not possible, because the next check would take it off again.</p>
                  )}
                  {notice && <p className={notice.tone === 'ok' ? 'wr-ok' : 'wr-error'} role="alert">{notice.text}</p>}

                  <h3>History</h3>
                  {!history ? <p className="wr-empty">Loading…</p> : !history.length ? <p className="wr-empty">No recorded changes.</p> : (
                    <ol className="wr-history">
                      {history.map((h, i) => <li key={i}><strong>{ACTION[h.action] || h.action}</strong><span>{stamp(h.at)}</span>{h.reason && <em>{reasonLabel(h.reason)}</em>}</li>)}
                    </ol>
                  )}
                </>
              )}
            </aside>
          </div>
        </>
      )}
      {rows && me && me.role !== 'admin' && <p className="wr-error">Only admins can review hidden listings.</p>}
      {!rows && !err && <p className="wr-empty">Loading…</p>}
    </CrmShell>
  )
}
