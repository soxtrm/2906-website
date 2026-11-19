'use client'
import { WeekCalendar } from '@/components/owner/calendar'
import { useOwner } from '@/lib/owner/store'
import { propColor } from '@/components/owner/format'

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function CalendarPage() {
  const s = useOwner()
  return (
    <>
      <div className="ow-head"><div>
        <h1>Calendar</h1>
        <p className="ow-muted">People can only ask for times inside your viewing hours.</p>
      </div></div>
      <WeekCalendar />
      <section className="ow-section">
        <h2>Your weekly viewing hours</h2>
        <div className="ow-panel">
          <table className="ow-table">
            <thead><tr><th>Property</th><th>Day</th><th>Hours</th><th /></tr></thead>
            <tbody>
              {s.rules.slice().sort((a, b) => a.propertyId - b.propertyId || ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7)).map(r => (
                <tr key={r.id}>
                  <td><span className="ow-dayrow-name"><i style={{ background: propColor(s.properties.map(p => p.id), r.propertyId) }} />{s.properties.find(p => p.id === r.propertyId)?.name}</span></td>
                  <td>Every {DAY[r.weekday]}</td>
                  <td>{r.start}–{r.end}</td>
                  <td style={{ textAlign: 'right' }}><button className="ow-btn small quiet danger" onClick={() => s.removeRule(r.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
