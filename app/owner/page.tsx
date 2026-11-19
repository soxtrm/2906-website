'use client'
import Link from 'next/link'
import { CalendarPlus, Radio } from 'lucide-react'
import { SituationBanner } from '@/components/owner/banner'
import { NexusStar } from '@/components/owner/brand'
import { useOwner } from '@/lib/owner/store'
import { SOURCE_LABEL, type ViewingRequest } from '@/lib/owner/model'
import { PropertyCard } from '@/components/owner/property-card'
import { WeekCalendar } from '@/components/owner/calendar'
import { ArgusChat } from '@/components/owner/chat'
import { WishesPanel } from '@/components/owner/wishes-panel'
import { addDays, datePart, startOfWeek } from '@/lib/owner/engine'
import { occupants, propColor, when } from '@/components/owner/format'

function RequestRow({ r }: { r: ViewingRequest }) {
  const s = useOwner()
  const p = s.properties.find(x => x.id === r.propertyId)!
  const room = r.roomId ? p.rooms.find(x => x.id === r.roomId) : null
  const agency = r.requester.agencyId ? s.agencies.find(a => a.id === r.requester.agencyId) : null
  const by = agency ? `${r.requester.agentName ? `${r.requester.agentName} · ` : ''}${agency.name}` : SOURCE_LABEL[r.source]
  return (
    <li className="ow-rrow">
      <div className="ow-rrow-top">
        <b>{when(r.start, s.today)}</b>
        <span className="ow-rrow-prop"><i style={{ background: propColor(s.properties.map(x => x.id), p.id) }} />{room ? `${room.label}, ` : ''}{p.name}</span>
      </div>
      <p className="ow-rrow-facts">{occupants(r.applicant)} · {r.applicant.months} months{r.applicant.pets ? ` · ${r.applicant.pets}` : ''}</p>
      <p className="ow-rrow-by">{by}</p>
      <div className="ow-rrow-actions">
        <button className="ow-btn small primary" onClick={() => s.decide(r.id, { type: 'accept' })}>Accept</button>
        <Link className="ow-btn small" href={`/owner/requests?compare=${r.id}`}>Details</Link>
      </div>
    </li>
  )
}

export default function Overview() {
  const { properties, requests, threads, today } = useOwner()
  const waiting = requests.filter(r => r.status === 'awaiting_owner').sort((a, b) => a.start.localeCompare(b.start))
  const mon = startOfWeek(today)
  const thisWeek = requests.filter(r => r.status === 'confirmed' && datePart(r.start) >= today && datePart(r.start) <= addDays(mon, 6)).length
  const live = properties.filter(p => p.listing === 'live').length
  const unread = threads.reduce((n, t) => n + t.unread, 0)

  return (
    <>
      <SituationBanner />
      <div className="ow-quick">
        <Link className="ow-btn primary ow-star-btn" href="/owner/add"><span className="ow-star"><NexusStar size={16} /></span>Add property</Link>
        <Link className="ow-btn" href="/owner/calendar"><CalendarPlus size={18} />Viewing hours</Link>
        <Link className="ow-btn" href="/owner/sharing"><Radio size={18} />Sync with agencies</Link>
      </div>

      <dl className="ow-stats">
        <div data-tone="warm"><dt>Waiting for you</dt><dd>{waiting.length}</dd></div>
        <div><dt>Viewings this week</dt><dd>{thisWeek}</dd></div>
        <div><dt>Homes live</dt><dd>{live}<small>/{properties.length}</small></dd></div>
        <div><dt>New messages</dt><dd>{unread}</dd></div>
      </dl>

      <div className="ow-dash">
        <ArgusChat className="ow-dash-chat" />
        <div className="ow-dash-side">
          <WishesPanel />
          <section className="ow-panel" aria-labelledby="rq-h">
            <div className="ow-head" style={{ marginBottom: 6 }}>
              <h2 id="rq-h">Requests to review</h2>
              <Link href="/owner/requests" className="ow-link">All</Link>
            </div>
            {waiting.length
              ? <ul className="ow-rrows">{waiting.slice(0, 4).map(r => <RequestRow key={r.id} r={r} />)}</ul>
              : <p className="ow-muted">Nothing waiting. New requests appear here and in the chat.</p>}
          </section>
        </div>
      </div>

      <section className="ow-section" aria-labelledby="week">
        <div className="ow-head" style={{ marginBottom: 12 }}>
          <h2 id="week">This week</h2>
          <Link href="/owner/calendar" className="ow-link">Open calendar</Link>
        </div>
        <WeekCalendar compact />
      </section>

      <section className="ow-section" aria-labelledby="homes">
        <div className="ow-head" style={{ marginBottom: 12 }}>
          <h2 id="homes">Your properties</h2>
          <Link href="/owner/add" className="ow-link">Add property</Link>
        </div>
        <div className="ow-props">{properties.map(p => <PropertyCard key={p.id} p={p} />)}</div>
      </section>
    </>
  )
}
