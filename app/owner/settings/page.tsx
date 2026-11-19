'use client'
import { LiveSettings } from '@/components/owner/live'
import { useOwner as useOwnerMode } from '@/lib/owner/store'
import Link from 'next/link'
import { useOwner } from '@/lib/owner/store'
import { ChannelPicker } from '@/components/owner/channel-picker'

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)

function DemoSettings() {
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
          <h2>How ARGUS reaches you</h2>
          <p className="ow-faint" style={{ margin: '4px 0 12px' }}>Whatever you choose, the chat here stays the same and your answers land in it.</p>
          <ChannelPicker />
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

// nexussync.one: the real workspace from ARGUS; ?demo=1: the preview with Maria.
export default function SettingsPage() {
  const { demo } = useOwnerMode()
  return demo ? <DemoSettings /> : <LiveSettings />
}
