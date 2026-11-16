'use client'
// ARGUS Owner Portal. The owner arrives with a one-time link (#t=… in the
// fragment, so the token never reaches a server log). It is exchanged for an
// httpOnly session cookie and removed from the address bar immediately.
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Activity as ActivityIcon, CalendarDays, Clock, Home, LogOut, Share2 } from 'lucide-react'
import { api, ApiError, useToast } from '@/components/owner-portal/ui'
import type { Me } from '@/components/owner-portal/types'
import { ViewingDesk } from '@/components/owner-portal/desk'
import { AvailabilityEditor } from '@/components/owner-portal/availability'
import { Properties } from '@/components/owner-portal/properties'
import { Activity, Sharing } from '@/components/owner-portal/sharing'

type View = 'desk' | 'availability' | 'properties' | 'sharing' | 'activity'
const BASE = '/api/owner-portal'

export default function OwnerPortalPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [state, setState] = useState<'loading' | 'signed_out' | 'error' | 'ready'>('loading')
  const [message, setMessage] = useState('')
  const [view, setView] = useState<View>('desk')
  const toast = useToast()

  const loadMe = useCallback(async () => {
    try { setMe(await api<Me>(BASE, '/me')); setState('ready') }
    catch (e) { if ((e as ApiError).status === 401) setState('signed_out'); else { setMessage((e as Error).message); setState('error') } }
  }, [])

  useEffect(() => {
    const m = window.location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/)
    if (!m) { loadMe(); return }
    history.replaceState(null, '', window.location.pathname)
    fetch('/api/owner-portal/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m[1] }) })
      .then(async r => { if (!r.ok) { const j = await r.json().catch(() => ({})); setMessage(j.error || 'This link is not valid any more.'); setState('signed_out'); return } loadMe() })
      .catch(() => { setMessage('The owner portal is unavailable right now.'); setState('error') })
  }, [loadMe])

  useEffect(() => { if (me && !me.scopes.includes('requests') && !me.scopes.includes('schedule') && view === 'desk') setView('properties') }, [me, view])

  if (state === 'loading') return <div className="op-root" style={{ display: 'grid', placeItems: 'center' }}><Splash text="Opening your portal…" /></div>
  if (state !== 'ready' || !me) return (
    <div className="op-root" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="op-card op-card-pad" style={{ maxWidth: 440, textAlign: 'center', display: 'grid', gap: 12 }}>
        <div className="op-mark" style={{ margin: '0 auto' }}>A</div>
        <h1 className="op-h1" style={{ fontSize: 26 }}>{state === 'error' ? 'Something went wrong' : 'Open your owner link'}</h1>
        <p className="op-lede" style={{ margin: 0 }}>{message || 'For your security the portal opens only from the personal link ARGUS gave you. If it has expired, ask your ARGUS contact for a new one.'}</p>
      </div>
    </div>
  )

  const open = me.properties.reduce((n, p) => n + p.openRequests, 0)
  const nav: { key: View; label: string; icon: React.ReactNode; show: boolean; count?: number }[] = [
    { key: 'desk', label: 'Viewings', icon: <CalendarDays size={18} />, show: me.scopes.includes('requests') || me.scopes.includes('schedule'), count: open },
    { key: 'availability', label: 'Availability', icon: <Clock size={18} />, show: me.scopes.includes('schedule') },
    { key: 'properties', label: 'Properties', icon: <Home size={18} />, show: true },
    { key: 'sharing', label: 'Sharing', icon: <Share2 size={18} />, show: me.scopes.includes('sharing') || me.role === 'owner' },
    { key: 'activity', label: 'Activity', icon: <ActivityIcon size={18} />, show: true },
  ]
  const shown = nav.filter(n => n.show)

  return (
    <div className="op-root">
      <header className="op-header">
        <motion.div className="op-mark" initial={{ scale: .6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 22 }} aria-hidden>A</motion.div>
        <div className="op-brand"><small>ARGUS · Owner portal</small><b>{me.delegate ? `${me.delegate.name} for ${me.owner.name}` : me.owner.name}</b></div>
        <nav className="op-tabs" aria-label="Sections">
          {shown.map(n => <button key={n.key} type="button" className="op-tab" aria-current={view === n.key ? 'page' : undefined} onClick={() => setView(n.key)}>{n.icon}{n.label}{n.count ? <span className="op-count">{n.count}</span> : null}</button>)}
        </nav>
        <button type="button" className="op-btn op-btn-ghost op-btn-sm" aria-label="Sign out" onClick={async () => { await fetch('/api/owner-portal/session', { method: 'DELETE' }); setMe(null); setMessage('You are signed out. Open your owner link to come back.'); setState('signed_out') }}><LogOut size={16} /></button>
      </header>

      <main className="op-main">
        {!me.propertiesConfirmedAt && me.role === 'owner' && <ConfirmProperties me={me} onDone={(n) => { toast.show(n ? 'Thank you. ARGUS will check the properties you flagged.' : 'Thank you. Your property list is confirmed.'); loadMe() }} />}
        <motion.div key={view} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .28, ease: [.2, .8, .2, 1] }}>
          {view === 'desk' && <ViewingDesk me={me} notify={toast.show} onChanged={loadMe} />}
          {view === 'availability' && <AvailabilityEditor me={me} notify={toast.show} />}
          {view === 'properties' && <Properties me={me} notify={toast.show} onChanged={loadMe} />}
          {view === 'sharing' && <Sharing me={me} notify={toast.show} />}
          {view === 'activity' && <Activity me={me} notify={toast.show} />}
        </motion.div>
      </main>

      <nav className="op-dock" aria-label="Sections" style={{ gridTemplateColumns: `repeat(${shown.length},1fr)` }}>
        {shown.map(n => <button key={n.key} type="button" aria-current={view === n.key ? 'page' : undefined} onClick={() => { setView(n.key); window.scrollTo({ top: 0 }) }}>{n.icon}<span>{n.label}</span>{n.count ? <span className="op-count">{n.count}</span> : null}</button>)}
      </nav>
      {toast.node}
    </div>
  )
}

function Splash({ text }: { text: string }) {
  return <motion.div initial={{ opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} style={{ display: 'grid', placeItems: 'center', gap: 14 }}><div className="op-mark" style={{ width: 56, height: 56, fontSize: 24 }}>A</div><span style={{ color: 'var(--op-muted)' }}>{text}</span></motion.div>
}

function ConfirmProperties({ me, onDone }: { me: Me; onDone: (flagged: number) => void }) {
  const [notMine, setNotMine] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  return (
    <section className="op-card op-card-pad" style={{ marginBottom: 18, display: 'grid', gap: 10, boxShadow: 'var(--op-glow)' }}>
      <div className="op-eyebrow">First, a quick check</div>
      <b className="op-display" style={{ fontSize: 20 }}>Are these your properties?</b>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {me.properties.map(p => <button key={p.id} type="button" className="op-toggle" aria-pressed={!notMine.includes(p.id)} onClick={() => setNotMine(n => n.includes(p.id) ? n.filter(x => x !== p.id) : [...n, p.id])}>#{p.ref} · {p.town}{notMine.includes(p.id) ? ' · not mine' : ''}</button>)}
      </div>
      <div><button className="op-btn op-btn-primary" disabled={busy} onClick={async () => { setBusy(true); await api(BASE, '/me/confirm-properties', { method: 'POST', json: { notMine } }).catch(() => {}); onDone(notMine.length) }}>{notMine.length ? `Confirm, and flag ${notMine.length}` : 'Yes, all mine'}</button></div>
    </section>
  )
}
