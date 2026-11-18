'use client'
import { WeekCalendar } from '@/components/owner/calendar'
import { useOwner } from '@/lib/owner/store'

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function CalendarPage() {
  const s = useOwner()
  return (
    <>
      <div className="ow-head"><div>
        <h1>Calendar</h1>
        <p className="ow-muted">Set when people may view. Agents and tenants pick a time inside these hours and you confirm with one tap.</p>
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
                  <td>{s.properties.find(p => p.id === r.propertyId)?.name}</td>
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
