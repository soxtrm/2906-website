'use client'
import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { crmJson } from '@/lib/crm/api'

const NAVY = '#101A2B', GOLD = '#C5A65A', INK = '#1B2A4A'
const F = "var(--font-bricolage), 'Bricolage Grotesque', Arial, sans-serif"
type Mode = 'signin' | 'request'

function BoardLogin() {
  const router = useRouter(), params = useSearchParams(), token = params.get('token')
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'request' ? 'request' : 'signin')
  const [email, setEmail] = useState(''), [name, setName] = useState('')
  const [phone, setPhone] = useState(''), [password, setPassword] = useState('')
  const [sent, setSent] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) return
    let alive = true
    ;(async () => {
      try { await crmJson('board/redeem', 'POST', { token }); if (alive) router.replace('/schedule-board') }
      catch (e: any) { if (alive) setErr(e?.message || 'This link is not valid.') }
    })()
    return () => { alive = false }
  }, [token, router])

  async function submit() {
    setErr(''); setBusy(true)
    try {
      if (mode === 'signin') await crmJson('board/request-link', 'POST', { email: email.trim() })
      else await crmJson('board/request-access', 'POST', { name: name.trim(), email: email.trim(), phone: phone.trim(), password })
      setSent(true)
    } catch (e: any) { setErr(e?.data?.error || e?.message || 'Could not send this request.') }
    finally { setBusy(false) }
  }

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const valid = mode === 'signin' ? emailValid : emailValid && name.trim().length >= 2 && phone.replace(/\D/g, '').length >= 7 && password.length >= 8

  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'radial-gradient(circle at 50% -10%,#263858 0,#101A2B 48%,#09111D 100%)', fontFamily: F, padding: 20 }}>
    <section style={{ width: '100%', maxWidth: 430, background: '#FFFEFB', borderRadius: 22, padding: '34px 32px', boxShadow: '0 28px 90px rgba(0,0,0,.46)', position: 'relative', overflow: 'hidden' }}>
      <div aria-hidden style={{ position: 'absolute', inset: '0 0 auto', height: 3, background: `linear-gradient(90deg,transparent,${GOLD},transparent)` }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 42, height: 42, borderRadius: 13, background: INK, color: GOLD, display: 'grid', placeItems: 'center', fontSize: 23, boxShadow: '0 0 26px rgba(197,166,90,.22)' }}>✦</div>
        <div><div style={{ fontSize: 29, fontWeight: 850, color: INK, letterSpacing: '-.04em', lineHeight: 1 }}>2906</div><div style={{ fontSize: 9.5, color: GOLD, marginTop: 5, letterSpacing: '.18em', fontWeight: 800 }}>AGENT BOARD</div></div>
      </div>

      {token ? <div style={{ marginTop: 28, fontSize: 13, color: err ? '#B91C1C' : '#626B78' }}>{err || 'Opening your board…'}{err && <button onClick={() => router.replace('/crm/board-login')} style={primary(true)}>Request a new link</button>}</div> : <>
        <div role="tablist" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: '#EEECE6', borderRadius: 11, padding: 3, marginTop: 27 }}>
          {(['signin','request'] as Mode[]).map(m => <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setSent(false); setErr('') }} style={{ border: 0, borderRadius: 9, padding: '9px 6px', fontFamily: F, fontSize: 11.5, fontWeight: 750, cursor: 'pointer', color: mode === m ? '#FFF' : '#69717D', background: mode === m ? INK : 'transparent', transition: 'all .2s ease' }}>{m === 'signin' ? 'Sign in' : 'Request access'}</button>)}
        </div>
        {!sent ? <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 12.5, color: '#626B78', lineHeight: 1.55, margin: '0 0 3px' }}>{mode === 'signin' ? 'Use the email linked to your account. We send a secure one-time entry link.' : 'Request your own board identity. Kevin reviews it before the account becomes active.'}</p>
          {mode === 'request' && <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" autoComplete="name" style={input} />}
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="you@agency.com" type="email" autoComplete="email" autoFocus style={input} />
          {mode === 'request' && <><input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Mobile with country code" type="tel" autoComplete="tel" style={input} /><input value={password} onChange={e => setPassword(e.target.value)} placeholder="Create password · min 8 characters" type="password" autoComplete="new-password" style={input} /></>}
          {err && <div style={{ color: '#B91C1C', fontSize: 12, fontWeight: 650 }}>{err}</div>}
          <button onClick={submit} disabled={!valid || busy} style={primary(valid && !busy)}>{busy ? 'Sending…' : mode === 'signin' ? 'Email my sign-in link' : 'Send access request'}</button>
        </div> : <div style={{ marginTop: 25 }}><div style={{ fontSize: 15, fontWeight: 800, color: INK }}>{mode === 'signin' ? 'Check your inbox' : 'Request received'}</div><p style={{ fontSize: 12.5, color: '#626B78', lineHeight: 1.6 }}>{mode === 'signin' ? `If ${email.trim()} is active, the one-time link is on its way.` : 'Your details are waiting in Accounts for review. Access starts only after approval.'}</p><button onClick={() => { setSent(false); setErr('') }} style={primary(true)}>Back</button></div>}
      </>}
      <div style={{ marginTop: 22, fontSize: 9.5, color: '#A6A094', textAlign: 'center', letterSpacing: '.08em' }}>NEXUS ACCESS · 2906 ESTATE</div>
    </section>
  </main>
}

export default function Page() { return <Suspense fallback={null}><BoardLogin /></Suspense> }

const input: React.CSSProperties = { background: '#F4F2EC', border: '1px solid #E2DED3', borderRadius: 10, padding: '12px 13px', fontSize: 13, color: '#191D24', fontFamily: F, outline: 'none' }
function primary(on: boolean): React.CSSProperties { return { marginTop: 10, width: '100%', background: INK, color: '#FFF', border: 0, borderRadius: 10, padding: 13, fontSize: 12.5, fontWeight: 750, fontFamily: F, cursor: on ? 'pointer' : 'not-allowed', opacity: on ? 1 : .45 } }
