'use client'
import Link from 'next/link'
import { useOwner } from '@/lib/owner/store'

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)

export default function Settings() {
  const s = useOwner()
  const n = s.profile.notify
  return (
    <>
      <div className="ow-head"><div>
        <h1>Settings</h1>
        <p className="ow-muted">How ARGUS reaches you. People and photo are in <Link className="ow-link" href="/owner/profile">your profile</Link>.</p>
      </div></div>
      <div className="ow-grid-2">
        <section className="ow-panel">
          <h2>Messages</h2>
          <div className="ow-switch"><div><b>WhatsApp</b><p>New requests arrive on WhatsApp with the same buttons as here.</p></div>
            <button role="switch" aria-checked={n.whatsapp} aria-label="WhatsApp" className="ow-toggle" onClick={() => s.setNotify({ whatsapp: !n.whatsapp })} /></div>
          <div className="ow-switch"><div><b>Email</b><p>A short daily summary instead of single messages.</p></div>
            <button role="switch" aria-checked={n.email} aria-label="Email" className="ow-toggle" onClick={() => s.setNotify({ email: !n.email })} /></div>
          <div className="ow-switch"><div><b>Quiet hours</b><p>Nothing reaches you in between; it waits until morning.</p></div>
            <span className="ow-inline-form">
              <select aria-label="Quiet from" value={n.quietFrom} onChange={e => s.setNotify({ quietFrom: e.target.value })}>{HOURS.map(h => <option key={h}>{h}</option>)}</select>
              <span>–</span>
              <select aria-label="Quiet until" value={n.quietTo} onChange={e => s.setNotify({ quietTo: e.target.value })}>{HOURS.map(h => <option key={h}>{h}</option>)}</select>
            </span></div>
        </section>
        <section className="ow-panel">
          <h2>Preview</h2>
          <p className="ow-muted" style={{ margin: '6px 0 12px' }}>This workspace runs on demo data. Your changes stay in this browser only.</p>
          <button className="ow-btn" onClick={s.reset}>Reset demo data</button>
        </section>
      </div>
    </>
  )
}
