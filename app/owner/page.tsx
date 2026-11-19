'use client'
import { LiveOverview } from '@/components/owner/live'
import { useOwner as useOwnerMode } from '@/lib/owner/store'
import Link from 'next/link'
import { CalendarPlus, Radio } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { SOURCE_LABEL, type ViewingRequest } from '@/lib/owner/model'
import { PropertyCard } from '@/components/owner/property-card'
import { WeekCalendar } from '@/components/owner/calendar'
import { ArgusChat } from '@/components/owner/chat'
import { WishesPanel } from '@/components/owner/wishes-panel'
import { SituationBanner } from '@/components/owner/banner'
import { StarButton } from '@/components/owner/brand'
import { addDays, datePart, startOfWeek } from '@/lib/owner/engine'
import { initials, occupants, party, propColor, relDay, when } from '@/components/owner/format'

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
      <p className="ow-rrow-facts">{party(r.applicant)} · {r.applicant.months} months{r.applicant.pets ? ` · ${r.applicant.pets}` : ''}</p>
      <p className="ow-rrow-by">{by}</p>
      <div className="ow-rrow-actions">
        <button className="ow-btn small primary" onClick={() => s.decide(r.id, { type: 'accept' })}>Accept</button>
        <Link className="ow-btn small" href={`/owner/requests?compare=${r.id}`}>Details</Link>
        <button className="ow-btn small quiet danger" onClick={() => s.decide(r.id, { type: 'decline' })}>Decline</button>
      </div>
    </li>
  )
}

// Everyone who is coming, as soon as a viewing is accepted.
function ComingUp() {
  const s = useOwner()
  const ids = s.properties.map(p => p.id)
  const list = s.requests.filter(r => r.status === 'confirmed' && datePart(r.start) >= s.today).sort((a, b) => a.start.localeCompare(b.start))
  return (
    <section className="ow-panel ow-coming" aria-labelledby="coming-h">
      <div className="ow-head" style={{ marginBottom: 8 }}><h2 id="coming-h">Who is coming</h2><Link className="ow-link" href="/owner/calendar">Calendar</Link></div>
      {list.length ? (
        <ul>
          {list.slice(0, 5).map(r => {
            const p = s.properties.find(x => x.id === r.propertyId)!
            const agency = r.requester.agencyId ? s.agencies.find(a => a.id === r.requester.agencyId) : null
            const label = party(r.applicant)
            return (
              <li key={r.id}>
                <span className="ow-coming-time"><small>{relDay(datePart(r.start), s.today)}</small><b>{r.start.slice(11, 16)}</b></span>
                <span className="ow-coming-ava" style={{ background: propColor(ids, p.id) }}>{initials(label)}</span>
                <span className="ow-coming-main">
                  <b>{label}{r.applicant.working ? `, ${r.applicant.working.toLowerCase()}` : ''}</b>
                  <small>{occupants(r.applicant)}{r.applicant.pets ? ` · ${r.applicant.pets}` : ''} · {p.name}</small>
                  <small>{agency ? `with ${r.requester.agentName || 'agent'} · ${agency.name}` : SOURCE_LABEL[r.source]}</small>
                </span>
              </li>
            )
          })}
        </ul>
      ) : <p className="ow-muted">Accept a request and the people show up here.</p>}
    </section>
  )
}

function DemoOverview() {
  const { properties, requests, threads, today } = useOwner()
  const waiting = requests.filter(r => r.status === 'awaiting_owner').sort((a, b) => a.start.localeCompare(b.start))
  const mon = startOfWeek(today)
  const soon = requests.filter(r => r.status === 'confirmed' && datePart(r.start) >= today && datePart(r.start) <= addDays(mon, 13)).length
  const live = properties.filter(p => p.listing === 'live').length
  const unread = threads.reduce((n, t) => n + t.unread, 0)

  return (
    <>
      <SituationBanner />
      <div className="ow-toolrow">
        <div className="ow-quick">
          <StarButton href="/owner/add">Add property</StarButton>
          <Link className="ow-btn" href="/owner/calendar"><CalendarPlus size={18} />Viewing hours</Link>
          <Link className="ow-btn" href="/owner/sharing"><Radio size={18} />Sync with agencies</Link>
        </div>
        <div className="ow-stats">
          <Link href="/owner/requests" data-tone="warm"><span>Waiting</span><b>{waiting.length}</b></Link>
          <Link href="/owner/calendar"><span>Viewings soon</span><b>{soon}</b></Link>
          <Link href="/owner/properties"><span>Homes live</span><b>{live}<small>/{properties.length}</small></b></Link>
          <Link href="/owner/messages"><span>New messages</span><b>{unread}</b></Link>
        </div>
      </div>

      <div className="ow-dash">
        <ArgusChat className="ow-dash-chat" />
        <div className="ow-dash-side">
          <ComingUp />
          {waiting.length > 0 && (
            <section className="ow-panel ow-review" aria-labelledby="rq-h">
              <div className="ow-head" style={{ marginBottom: 6 }}>
                <h2 id="rq-h">Requests to review</h2>
                <Link href="/owner/requests" className="ow-link">All</Link>
              </div>
              <ul className="ow-rrows">{waiting.slice(0, 3).map(r => <RequestRow key={r.id} r={r} />)}</ul>
            </section>
          )}
          <WishesPanel />
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

// nexussync.one: the real workspace from ARGUS; ?demo=1: the preview with Maria.
export default function OverviewPage() {
  const { demo } = useOwnerMode()
  return demo ? <DemoOverview /> : <LiveOverview />
}
