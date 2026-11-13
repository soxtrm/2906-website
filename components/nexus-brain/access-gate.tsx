'use client'
import { useState } from 'react'
import { ArrowUpRight, LockKeyhole, Orbit } from 'lucide-react'

export default function AccessGate({ state }: { state: 'signin' | 'denied' | 'unavailable' }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const data = new FormData(event.currentTarget)
    try {
      const res = await fetch('/rating/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emailOrUsername: data.get('identity'), password: data.get('password') }) })
      if (!res.ok) throw new Error('Sign-in failed. Check your account details and try again.')
      const body = await res.json()
      if (body?.agent?.role !== 'admin') throw new Error('This account is not authorized to present the Intelligence Lab.')
      window.location.assign('/rating')
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in is unavailable. Please try again.'); setBusy(false) }
  }
  return <main className="brain gate"><div className="gate-card"><Orbit size={40} /><p className="eyebrow">NEXUS / PRIVATE INTELLIGENCE LAB</p><h1>A little closer<br />to <em>understanding.</em></h1><p>Sign in with your authorized ARGUS admin account to open the presentation.</p>
    {state === 'denied' && <p role="alert">This account does not have presenter access. Sign in with an admin account.</p>}
    {state === 'unavailable' && <p role="alert">Account verification is temporarily unavailable. Your presentation remains protected. Please retry.</p>}
    <form onSubmit={login}><label htmlFor="identity">Email or username</label><input id="identity" name="identity" autoComplete="username" required /><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required />{error && <p role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Verifying account…' : 'Open the lab'}<ArrowUpRight size={17} /></button></form><small><LockKeyhole size={13} /> Private presentation · Authorized accounts only</small></div></main>
}
