'use client'
// Dashboard module "Your Properties of the Day": what arrived today, what is
// waiting, what was decided — from the persisted intake records and event log,
// refreshed while the dashboard is open. Every card and line opens the record.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, BadgeCheck, Camera, Inbox, XCircle } from 'lucide-react'
import { crmFetch } from '@/lib/crm/api'
import { type FeedEvent, type IntakeProperty, ago, feedLine, money, thumb, useIntakeSummary } from '@/lib/crm/intake'

export function PropertiesOfTheDay() {
  const summary = useIntakeSummary(30_000)
  const [cards, setCards] = useState<IntakeProperty[] | null>(null)
  const [feed, setFeed] = useState<FeedEvent[]>([])
  const [failed, setFailed] = useState(false)
  const load = useCallback(() => {
    Promise.all([crmFetch('intake/items?filter=needs_verification&limit=12'), crmFetch('intake/feed?limit=8')])
      .then(([a, b]) => { setCards((a.items || []).filter((i: any) => i.kind === 'property')); setFeed(b.events || []); setFailed(false) })
      .catch(() => setFailed(true))
  }, [])
  useEffect(() => {
    load()
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') load() }, 30_000)
    return () => window.clearInterval(t)
  }, [load])
  if (failed && !cards) return null   // agents without intake access simply do not see the module

  const c = summary?.counts
  const lines: { text: string; href: string; tone: 'info' | 'warn' | 'ok' | 'error' }[] = []
  for (const u of summary?.uploadsToday || []) lines.push({ text: `${u.agent} uploaded ${u.n} propert${u.n === 1 ? 'y' : 'ies'} today`, href: '/incoming?filter=new_today', tone: 'info' })
  if (c?.needs_verification) lines.push({ text: `${c.needs_verification} need${c.needs_verification === 1 ? 's' : ''} verification`, href: '/incoming', tone: 'warn' })
  if (c?.ready) lines.push({ text: `${c.ready} ready to approve`, href: '/incoming?filter=ready', tone: 'ok' })
  if (c?.missing_price) lines.push({ text: `${c.missing_price} missing a price`, href: '/incoming?filter=missing_info', tone: 'warn' })
  if (c?.approved_today) lines.push({ text: `${c.approved_today} approved today`, href: '/incoming?filter=approved', tone: 'ok' })
  if (c?.failed) lines.push({ text: `${c.failed} upload${c.failed === 1 ? '' : 's'} failed`, href: '/incoming?filter=failed', tone: 'error' })

  return (
    <section className="ib-potd" aria-labelledby="potd-title">
      <div className="ib-potd-head">
        <div>
          <h2 id="potd-title">Your Properties of the Day</h2>
          <p>{c ? (c.needs_verification ? `${c.needs_verification} waiting for you · newest first` : 'Nothing waiting — every upload is checked') : 'Loading…'}</p>
        </div>
        <Link href="/incoming" className="ib-btn">Open inbox<ArrowRight size={15} aria-hidden /></Link>
      </div>
      {lines.length > 0 && (
        <ul className="ib-potd-lines">
          {lines.map(l => <li key={l.text}><Link href={l.href} className={`tone-${l.tone}`}>{l.tone === 'ok' ? <BadgeCheck size={15} aria-hidden /> : l.tone === 'error' ? <XCircle size={15} aria-hidden /> : l.tone === 'warn' ? <AlertTriangle size={15} aria-hidden /> : <Inbox size={15} aria-hidden />}{l.text}</Link></li>)}
        </ul>
      )}
      {cards && cards.length > 0 && (
        <div className="ib-potd-rail" role="list">
          {cards.map(p => {
            const critical = p.missing.filter(m => m.critical)
            return (
              <Link role="listitem" key={p.id} href={`/incoming?id=${p.id}`} className="ib-potd-card">
                <span className="ib-potd-photo">
                  {p.cover ? <img src={thumb(p.cover, 520)} alt="" loading="lazy" /> : <span className="ib-gallery-empty"><Camera size={22} aria-hidden /></span>}
                  <b className="ib-verify-badge"><AlertTriangle size={12} aria-hidden />{p.verification.status === 'needs_correction' ? 'Needs correction' : 'Verify'}</b>
                  <i><Camera size={12} aria-hidden />{p.imageCount}</i>
                </span>
                <span className="ib-potd-copy">
                  <strong>{p.town || 'Location missing'}</strong>
                  <span className={p.rent == null && p.sale == null ? 'is-missing' : ''}>{money(p.rent, p.sale)}</span>
                  <small>{p.beds ?? '—'} bed · {p.baths ?? '—'} bath · #{p.ref}</small>
                  <small>{p.uploader.name || '—'} · {ago(p.uploadedAt)}</small>
                  {critical.length > 0 ? <em className="is-critical">{critical.map(m => m.label).join(', ')} missing</em> : <em className="ok">Ready to approve</em>}
                </span>
              </Link>
            )
          })}
        </div>
      )}
      {feed.length > 0 && (
        <ol className="ib-potd-feed" aria-label="Recent intake activity">
          {feed.map(e => (
            <li key={e.id}>
              <time>{ago(e.at)}</time>
              {e.propertyId ? <Link href={`/incoming?id=${e.propertyId}`}>{feedLine(e)}</Link> : <Link href="/incoming?filter=failed">{feedLine(e)}</Link>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
