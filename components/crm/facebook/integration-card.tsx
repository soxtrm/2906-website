'use client'
// Compact "Facebook Business Pages" card for the agent's own profile page.
import React, { useEffect, useState } from 'react'
import { fb, errorMessage, type FbStatus } from '@/lib/crm/facebook'
import { FacebookGlyph, CrmLink, accentStyle, fmtWhen } from './shared'

export function FacebookIntegrationCard() {
  const [s, setS] = useState<FbStatus | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'not_entitled' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    fb.status().then(r => { setS(r); setState('ready') }).catch(e => setState(e?.status === 403 ? 'not_entitled' : 'error'))
  }, [])

  async function connect() {
    setBusy(true)
    try { window.location.assign((await fb.connect()).url) } catch (e) { alert(errorMessage(e)); setBusy(false) }
  }
  async function disconnect() {
    if (!confirm('Disconnect Facebook? ARGUS stops publishing to your Pages immediately, including automatic posts. Your publication history is kept.')) return
    setBusy(true)
    try { setS((await fb.disconnect()).status) } catch (e) { alert(errorMessage(e)) } finally { setBusy(false) }
  }

  const conn = s?.connection
  const publishable = (s?.pages || []).filter(p => p.canPublish)
  const def = publishable.find(p => p.isDefault)
  const chip = !s ? null : !s.configured ? { tone: 'warn', t: 'Setup pending' } : conn?.state === 'active' ? { tone: 'ok', t: 'Connected' } : conn?.state === 'reconnect_required' ? { tone: 'warn', t: 'Reconnect required' } : { tone: 'muted', t: 'Not connected' }

  return (
    <section className="fbp fbp-card" aria-label="Facebook Business Pages" style={accentStyle(s?.agent.colorHex)}>
      <div className="fbp-integration">
        <div className="fbp-integration-logo"><FacebookGlyph size={28} /></div>
        <div style={{ minWidth: 0 }}>
          <div className="fbp-row" style={{ gap: 10 }}><h2 className="fbp-h">Facebook Business Pages</h2>{chip && <span className="fbp-chip" data-tone={chip.tone}>{chip.t}</span>}</div>
          {state === 'loading' && <p className="fbp-sub">Checking your connection…</p>}
          {state === 'not_entitled' && <p className="fbp-sub">Publish your listings to your own Facebook Page. Not enabled for your account yet: ask an ARGUS administrator.</p>}
          {state === 'error' && <p className="fbp-sub">Could not load the Facebook connection. Try again later.</p>}
          {s && !s.configured && <p className="fbp-sub">Publishing to Facebook becomes available as soon as the Meta app setup is finished.</p>}
          {s && s.configured && conn?.state === 'not_connected' && <p className="fbp-sub">Connect once, then publish any of your listings to your Business Page in a few clicks. No Page IDs or technical setup.</p>}
          {s && conn?.state === 'reconnect_required' && <p className="fbp-sub">{conn.reason || 'Facebook asked ARGUS to confirm your connection again.'} Publishing is paused until you reconnect.</p>}
          {s && conn?.state === 'active' && <div className="fbp-kv">
            <span className="fbp-muted">Account<b>{conn.facebookName || 'Facebook'}</b></span>
            <span className="fbp-muted">Connected Pages<b>{publishable.length}</b></span>
            <span className="fbp-muted">Default Page<b>{def?.name || '—'}</b></span>
            <span className="fbp-muted">Automatic posts<b>{s.preferences.autoPublishEnabled ? 'On' : 'Off'}</b></span>
            {conn.lastCheckedAt && <span className="fbp-muted">Last checked<b>{fmtWhen(conn.lastCheckedAt)}</b></span>}
          </div>}
        </div>
        <div className="fbp-row" style={{ justifyContent: 'flex-end' }}>
          {s && s.configured && conn?.state === 'not_connected' && <button className="fbp-btn fbp-btn-fb" disabled={busy} onClick={connect}><FacebookGlyph mono size={16} /> Connect Facebook</button>}
          {s && conn?.state === 'reconnect_required' && <button className="fbp-btn fbp-btn-fb" disabled={busy} onClick={connect}>Reconnect</button>}
          {s && conn?.state !== 'not_connected' && <CrmLink href="/integrations/facebook" className="fbp-btn">Manage</CrmLink>}
          {s && conn?.state !== 'not_connected' && <button className="fbp-btn fbp-btn-ghost fbp-btn-danger" disabled={busy} onClick={disconnect}>Disconnect</button>}
        </div>
      </div>
    </section>
  )
}
