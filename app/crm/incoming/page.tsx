'use client'
// ============================================================================
// /crm/incoming — ARGUS Incoming Properties (2026-11-13)
// Every property that arrived through WhatsApp intake, with its own content
// verification state. Desktop: queue on the left, review card on the right.
// Mobile: one card at a time; swipe the card header or use Previous / Next.
// Data: /api/crm/intake/* — persisted state, refreshed while the page is open.
// ============================================================================
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, BadgeCheck, ChevronLeft, ChevronRight, Inbox, RefreshCw, XCircle } from 'lucide-react'
import { CrmProvider, CrmShell, useCrm, useIsMobile } from '@/lib/crm/ui'
import { crmFetch } from '@/lib/crm/api'
import { FILTERS, type IntakeItem, money, ago, refreshIntakeSummary, thumb, useIntakeSummary } from '@/lib/crm/intake'
import { IntakeReviewCard } from '@/components/crm/intake-review-card'
import '../intake.css'

export default function IncomingPage() {
  return <CrmProvider><Suspense fallback={null}><Incoming /></Suspense></CrmProvider>
}

const keyOf = (i: IntakeItem) => i.kind === 'package' ? `pkg-${i.packageId}` : `p-${i.id}`

function Incoming() {
  const router = useRouter()
  const params = useSearchParams()
  const isMobile = useIsMobile()
  const { me } = useCrm()
  const isAdmin = me?.role === 'admin'
  const summary = useIntakeSummary(30_000)
  const [filter, setFilter] = useState(params.get('filter') || 'needs_verification')
  const [items, setItems] = useState<IntakeItem[] | null>(null)
  const [selected, setSelected] = useState<string | null>(params.get('id') ? `p-${params.get('id')}` : null)
  const [detail, setDetail] = useState<IntakeItem | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [loading, setLoading] = useState(false)
  const reqRef = useRef(0)

  // A deep link (?id=) from WhatsApp or the dashboard shows that property whatever the filter.
  const focusId = params.get('id')
  const load = useCallback(async (keepSelection = true) => {
    const my = ++reqRef.current
    setLoading(true)
    try {
      const d = await crmFetch(`intake/items?filter=${encodeURIComponent(filter)}&limit=120`)
      if (my !== reqRef.current) return
      setItems(d.items || [])
      if (!keepSelection) setSelected(null)
    } catch (e: any) { if (my === reqRef.current) { setItems([]); setToast({ text: e?.message || 'Could not load incoming properties', tone: 'error' }) } }
    finally { if (my === reqRef.current) setLoading(false) }
  }, [filter])
  useEffect(() => { load() }, [load])
  useEffect(() => { // live queue: new uploads appear without reloading the page
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') load() }, 30_000)
    return () => window.clearInterval(t)
  }, [load])

  const list = items || []
  const effectiveSel = selected && (list.some(i => keyOf(i) === selected) || (focusId && selected === `p-${focusId}`)) ? selected : (list[0] ? keyOf(list[0]) : null)
  const index = list.findIndex(i => keyOf(i) === effectiveSel)

  // the selected property is loaded in full (all photos, suggestions, rights)
  useEffect(() => {
    if (!effectiveSel) { setDetail(null); return }
    if (effectiveSel.startsWith('pkg-')) { setDetail(list.find(i => keyOf(i) === effectiveSel) || null); return }
    const id = effectiveSel.slice(2)
    let live = true
    crmFetch(`intake/items/${id}`).then(d => { if (live) setDetail(d.item) }).catch(e => { if (live) { setDetail(null); setToast({ text: e?.message || 'Could not open this property', tone: 'error' }) } })
    return () => { live = false }
  }, [effectiveSel, items])

  const choose = (k: string | null) => {
    setSelected(k)
    const q = new URLSearchParams()
    if (filter !== 'needs_verification') q.set('filter', filter)
    if (k?.startsWith('p-')) q.set('id', k.slice(2))
    router.replace(`/incoming${q.toString() ? `?${q}` : ''}`, { scroll: false })
  }
  const step = (d: number) => { if (!list.length) return; const n = (index + d + list.length) % list.length; choose(keyOf(list[n])) }
  const onDone = (text: string, opts: { advance?: boolean } = {}) => {
    setToast({ text, tone: 'ok' })
    refreshIntakeSummary()
    const next = opts.advance !== false && list.length > 1 ? keyOf(list[(index + 1) % list.length]) : effectiveSel
    load().then(() => { if (opts.advance !== false) choose(next && next !== effectiveSel ? next : null) })
  }
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 4200); return () => window.clearTimeout(t) }, [toast])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (e.key === 'ArrowRight' || e.key === 'j') step(1)
      if (e.key === 'ArrowLeft' || e.key === 'k') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // swipe on the deck header (not on photos or the form)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const swipe = {
    onTouchStart: (e: React.TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = touch.current; touch.current = null
      if (!s) return
      const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1)
    },
  }

  const counts = summary?.counts
  const chips = (
    <div className="ib-filters" role="tablist" aria-label="Incoming property filters">
      {FILTERS.map(f => {
        const n = f.count && counts ? counts[f.count] : null
        return <button key={f.key} role="tab" aria-selected={filter === f.key} title={f.hint} className={`${filter === f.key ? 'is-active' : ''} ${f.key === 'failed' && n ? 'is-alert' : ''}`}
          onClick={() => { setFilter(f.key); setSelected(null); router.replace(f.key === 'needs_verification' ? '/incoming' : `/incoming?filter=${f.key}`, { scroll: false }) }}>
          {f.label}{n != null && <span>{n}</span>}
        </button>
      })}
      <button type="button" className="ib-refresh" onClick={() => { load(); refreshIntakeSummary() }} aria-label="Refresh"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
    </div>
  )

  const subtitle = counts
    ? `${counts.needs_verification} waiting for verification · ${counts.new_today} new today${counts.failed ? ` · ${counts.failed} failed` : ''}`
    : 'Loading…'

  return (
    <CrmShell title="Incoming Properties" subtitle={subtitle} filterBar={chips} dark>
      <div className="ib-page">
        {items === null && <div className="ib-empty">Loading incoming properties…</div>}
        {items !== null && !list.length && <EmptyState filter={filter} />}
        {list.length > 0 && (isMobile ? (
          <div className="ib-deck">
            <div className="ib-deck-head" {...swipe}>
              <button type="button" className="ib-btn ghost" onClick={() => step(-1)} aria-label="Previous property"><ChevronLeft size={18} /></button>
              <span><strong>{index + 1}</strong> of {list.length}<small>swipe here or use the arrows</small></span>
              <button type="button" className="ib-btn ghost" onClick={() => step(1)} aria-label="Next property"><ChevronRight size={18} /></button>
            </div>
            {detail && <IntakeReviewCard key={keyOf(detail)} item={detail} isAdmin={isAdmin} onDone={onDone} onError={t => setToast({ text: t, tone: 'error' })} />}
          </div>
        ) : (
          <div className="ib-split">
            <ol className="ib-queue" aria-label="Queue">
              {list.map(i => <QueueRow key={keyOf(i)} item={i} active={keyOf(i) === effectiveSel} onClick={() => choose(keyOf(i))} />)}
            </ol>
            <div className="ib-detail">
              {detail ? <IntakeReviewCard key={keyOf(detail)} item={detail} isAdmin={isAdmin} onDone={onDone} onError={t => setToast({ text: t, tone: 'error' })} /> : <div className="ib-empty">Select a property.</div>}
            </div>
          </div>
        ))}
      </div>
      {toast && <div className={`ib-toast ${toast.tone}`} role="status">{toast.tone === 'ok' ? <BadgeCheck size={16} /> : <XCircle size={16} />}{toast.text}</div>}
    </CrmShell>
  )
}

function QueueRow({ item, active, onClick }: { item: IntakeItem; active: boolean; onClick: () => void }) {
  if (item.kind === 'package') return (
    <li><button type="button" className={`ib-row ${active ? 'is-active' : ''}`} onClick={onClick} aria-current={active || undefined}>
      <span className="ib-row-thumb is-failed"><XCircle size={20} aria-hidden /></span>
      <span className="ib-row-copy"><strong>{item.state === 'FAILED' ? 'Failed upload' : 'Duplicate upload'} · {item.mediaExpected} photos</strong><small>{item.summary || 'no description'}</small><em>{item.uploader.name || '—'} · {ago(item.uploadedAt)}</em></span>
    </button></li>
  )
  const critical = item.missing.filter(m => m.critical)
  return (
    <li><button type="button" className={`ib-row ${active ? 'is-active' : ''}`} onClick={onClick} aria-current={active || undefined}>
      <span className="ib-row-thumb">{item.cover ? <img src={thumb(item.cover, 240)} alt="" loading="lazy" /> : null}<b>{item.imageCount}</b></span>
      <span className="ib-row-copy">
        <strong>{item.town || 'Location missing'} · {item.beds ?? '—'} bed</strong>
        <small>{money(item.rent, item.sale)} · #{item.ref}</small>
        <em>{item.uploader.name || '—'} · {ago(item.uploadedAt)}</em>
      </span>
      <span className={`ib-row-state ${item.verification.status}`}>
        {item.verification.status === 'verified' ? <BadgeCheck size={15} aria-label="Verified" /> : <AlertTriangle size={15} aria-label="Verification required" />}
        {critical.length > 0 && item.pending && <i>{critical.length} missing</i>}
        {item.ready && <i className="ok">ready</i>}
      </span>
    </button></li>
  )
}

function EmptyState({ filter }: { filter: string }) {
  const text: Record<string, string> = {
    needs_verification: 'Nothing waiting. Every uploaded property has been checked.',
    ready: 'No complete draft is waiting for approval.',
    missing_info: 'No draft is missing price, location, bedrooms or photos.',
    new_today: 'No property arrived today yet.',
    failed: 'No failed uploads. Every package was imported or recognised as a duplicate.',
    approved: 'No verified intake yet.',
    duplicates: 'No duplicates recorded.',
  }
  return <div className="ib-empty"><Inbox size={32} aria-hidden /><p>{text[filter] || 'Nothing here.'}</p><small>Uploads from the WhatsApp upload group appear here within about a minute: photos → description → “...”.</small></div>
}
