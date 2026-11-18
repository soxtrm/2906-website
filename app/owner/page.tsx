'use client'
import Link from 'next/link'
import { useOwner } from '@/lib/owner/store'
import { RequestCard } from '@/components/owner/request-card'
import { PropertyCard } from '@/components/owner/property-card'
import { WeekCalendar } from '@/components/owner/calendar'
import { datePart } from '@/lib/owner/engine'
import { when } from '@/components/owner/format'

export default function Overview() {
  const { profile, properties, requests, threads, today } = useOwner()
  const waiting = requests.filter(r => r.status === 'awaiting_owner')
  const upcoming = requests.filter(r => r.status === 'confirmed' && datePart(r.start) >= today).sort((a, b) => a.start.localeCompare(b.start))
  const unread = threads.filter(t => t.unread)
  const delisting = properties.flatMap(p => p.channels.filter(c => c.state === 'delisting').map(c => ({ p, c })))
  const hour = new Date().getHours()
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const headline = waiting.length
    ? `${waiting.length} viewing request${waiting.length > 1 ? 's are' : ' is'} waiting for your answer.`
    : upcoming.length ? `Nothing to answer. Next viewing: ${when(upcoming[0].start, today)}.` : 'Nothing needs you today.'

  return (
    <>
      <div className="ow-greet">
        <div>
          <p className="ow-muted">{hello}, {profile.name}</p>
          <h1>{headline}</h1>
        </div>
        <Link className="ow-btn" href="/owner/calendar">Set viewing hours</Link>
      </div>

      <div className="ow-grid-2 ow-section">
        <section aria-labelledby="needs">
          <h2 id="needs" style={{ marginBottom: 14 }}>Needs your answer</h2>
          <div className="ow-attn">
            {waiting.length ? waiting.slice(0, 3).map(r => <RequestCard key={r.id} r={r} />) : <div className="ow-panel ow-empty">All answered. New requests appear here and on WhatsApp.</div>}
            {waiting.length > 3 && <Link className="ow-btn" href="/owner/requests">See all {waiting.length} requests</Link>}
          </div>
        </section>
        <aside className="ow-attn" aria-label="Today">
          <div className="ow-panel">
            <h2>Coming up</h2>
            {upcoming.length ? (
              <ul className="ow-channels" style={{ marginTop: 12 }}>
                {upcoming.slice(0, 4).map(r => {
                  const p = properties.find(x => x.id === r.propertyId)!
                  const room = r.roomId && p.rooms.find(x => x.id === r.roomId)
                  return <li key={r.id}><span><b>{when(r.start, today)}</b><br /><span className="ow-faint">{room ? `${room.label}, ` : ''}{p.name}</span></span><span className="ow-chip">Confirmed</span></li>
                })}
              </ul>
            ) : <p className="ow-muted" style={{ marginTop: 8 }}>No confirmed viewings yet.</p>}
          </div>
          <div className="ow-panel">
            <h2>Messages</h2>
            {unread.length ? unread.map(t => (
              <Link key={t.id} href={`/owner/messages?t=${t.id}`} style={{ display: 'block', marginTop: 10, textDecoration: 'none' }}>
                <b>{t.title}</b> <span className="ow-chip honey">{t.unread} new</span>
                <p className="ow-faint" style={{ marginTop: 4 }}>{t.messages[t.messages.length - 1].text.slice(0, 110)}…</p>
              </Link>
            )) : <p className="ow-muted" style={{ marginTop: 8 }}>No new messages.</p>}
          </div>
          {delisting.length > 0 && (
            <div className="ow-panel">
              <h2>Being taken down</h2>
              <p className="ow-faint" style={{ margin: '6px 0 10px' }}>You removed these channels. ARGUS keeps checking until each one confirms.</p>
              <ul className="ow-channels">{delisting.map(({ p, c }) => <li key={p.id + c.channel}><span>{c.channel}<br /><span className="ow-faint">{p.name}</span></span><span className="ow-chip honey">Removing</span></li>)}</ul>
            </div>
          )}
        </aside>
      </div>

      <section className="ow-section" aria-labelledby="week">
        <div className="ow-head" style={{ marginBottom: 14 }}>
          <h2 id="week">This week</h2>
          <Link href="/owner/calendar" className="ow-btn quiet">Open calendar</Link>
        </div>
        <WeekCalendar compact />
      </section>

      <section className="ow-section" aria-labelledby="homes">
        <h2 id="homes">Your properties</h2>
        <div className="ow-props">{properties.map(p => <PropertyCard key={p.id} p={p} />)}</div>
      </section>
    </>
  )
}
