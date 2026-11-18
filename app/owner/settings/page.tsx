'use client'
import { useOwner } from '@/lib/owner/store'

export default function Settings() {
  const s = useOwner()
  return (
    <>
      <div className="ow-head"><div>
        <h1>Settings</h1>
        <p className="ow-muted">How ARGUS reaches you and who may help you manage your properties.</p>
      </div></div>
      <div className="ow-grid-2">
        <section className="ow-panel">
          <h2>Notifications</h2>
          <div className="ow-switch"><div><b>WhatsApp</b><p>New requests and changes arrive on WhatsApp with the same buttons as here.</p></div><span className={`ow-chip ${s.profile.notify.whatsapp ? '' : 'plain'}`}>{s.profile.notify.whatsapp ? 'On' : 'Off'}</span></div>
          <div className="ow-switch"><div><b>Email</b><p>A short summary instead of single messages.</p></div><span className={`ow-chip ${s.profile.notify.email ? '' : 'plain'}`}>{s.profile.notify.email ? 'On' : 'Off'}</span></div>
          <div className="ow-switch"><div><b>Quiet hours</b><p>Nothing reaches you in between; urgent changes wait until morning.</p></div><b>{s.profile.notify.quietFrom}–{s.profile.notify.quietTo}</b></div>
        </section>
        <section className="ow-panel">
          <h2>People who help you</h2>
          <ul className="ow-channels" style={{ marginTop: 12 }}>
            {s.profile.delegates.map(d => (
              <li key={d.name}><span>{d.name}<br /><span className="ow-faint">{d.role === 'manager' ? 'Can answer requests and edit' : 'Can look only'} · {d.properties === 'all' ? 'all properties' : d.properties.map(id => s.properties.find(p => p.id === id)?.name).join(', ')}</span></span><button className="ow-btn small quiet danger" onClick={() => s.say('In the preview access cannot be removed. With sign-in this ends their access at once.', 'warn')}>Remove access</button></li>
            ))}
          </ul>
          <p className="ow-faint" style={{ marginTop: 10 }}>A helper gets their own sign-in. Sharing a link never gives anyone ownership.</p>
        </section>
      </div>
      <section className="ow-section ow-panel">
        <h2>Preview</h2>
        <p className="ow-muted" style={{ margin: '6px 0 12px' }}>This workspace runs on demo data. Your changes stay in this browser only.</p>
        <button className="ow-btn" onClick={s.reset}>Reset demo data</button>
      </section>
    </>
  )
}
