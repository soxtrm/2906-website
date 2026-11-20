'use client'
// One banner at the top of the overview that always says the most useful thing
// right now, in this order: people waiting for an answer, a new home being
// checked, a channel still taking a home down, the next viewing, all quiet.
import Link from 'next/link'
import { useOwner } from '@/lib/owner/store'
import { datePart } from '@/lib/owner/engine'
import { NexusStar } from './brand'
import { when } from './format'

type Say = { tone: 'act' | 'info' | 'calm'; title: string; line?: string; href?: string; cta?: string }

export function SituationBanner() {
  const s = useOwner()
  const hour = new Date().getHours()
  const hello = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${s.profile.name}`
  const name = (id: number) => s.properties.find(p => p.id === id)?.name || ''
  const waiting = s.requests.filter(r => r.status === 'awaiting_owner').sort((a, b) => a.start.localeCompare(b.start))
  const checking = s.properties.filter(p => p.listing === 'draft')
  const removing = s.properties.flatMap(p => p.channels.filter(c => c.state === 'delisting').map(c => ({ p, c })))
  const next = s.requests.filter(r => r.status === 'confirmed' && datePart(r.start) >= s.today).sort((a, b) => a.start.localeCompare(b.start))[0]
  const live = s.properties.reduce((n, p) => n + p.channels.filter(c => c.state === 'live').length, 0)

  const all: Say[] = []
  if (waiting.length) all.push({ tone: 'act', title: `${waiting.length} ${waiting.length === 1 ? 'person wants' : 'people want'} to view your homes`, line: `First: ${when(waiting[0].start, s.today)} at ${name(waiting[0].propertyId)}`, href: '/owner/requests', cta: 'Answer now' })
  if (checking.length) all.push({ tone: 'info', title: `ARGUS is checking ${checking.length === 1 ? checking[0].name : `${checking.length} new homes`}`, line: 'It goes out on your channels once verified.', href: `/owner/properties/${checking[0].id}`, cta: 'See it' })
  if (removing.length) all.push({ tone: 'info', title: `${removing[0].c.channel} is still taking down ${removing[0].p.name}`, line: 'ARGUS keeps checking until they confirm.', href: `/owner/sharing?p=${removing[0].p.id}`, cta: 'Sharing' })
  if (next) all.push({ tone: 'calm', title: `Next viewing ${when(next.start, s.today)}`, line: name(next.propertyId), href: '/owner/calendar', cta: 'Calendar' })
  if (!all.length) all.push({ tone: 'calm', title: 'All quiet', line: `Your homes are live on ${live} channel${live === 1 ? '' : 's'}.` })
  const [main, ...rest] = all

  return (
    <section className="ow-banner" data-tone={main.tone} aria-live="polite">
      <span className="ow-banner-star" aria-hidden="true"><NexusStar size={180} /></span>
      <div className="ow-banner-text">
        <p className="ow-banner-hello">{hello}</p>
        <h1>{main.title}</h1>
        {main.line && <p className="ow-banner-line">{main.line}</p>}
        {rest.length > 0 && <ul className="ow-banner-more">{rest.slice(0, 2).map(r => <li key={r.title}>{r.href ? <Link href={r.href}>{r.title}</Link> : r.title}</li>)}</ul>}
      </div>
      {main.href && <Link className="ow-btn ow-banner-cta" href={main.href}>{main.cta}</Link>}
    </section>
  )
}
