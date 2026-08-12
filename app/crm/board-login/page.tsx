'use client'
// Passwordless sign-in for Schedule-Board agents. Two states in one page:
// with ?token= it redeems the emailed link, without it asks for the address.
// Brand navy/gold like the board itself, not the CRM login's older orange —
// this is the door outside agents see, and it should look like the product.
import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { crmJson } from '@/lib/crm/api'

const NAVY = '#1B2A4A'
const GOLD = '#B8953F'
const F = "var(--font-bricolage), 'Bricolage Grotesque', Arial, sans-serif"

function BoardLogin() {
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('token')

  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Redeem path: the agent clicked the link in their mail.
  useEffect(() => {
    if (!token) return
    let alive = true
    ;(async () => {
      try {
        await crmJson('board/redeem', 'POST', { token })
        if (alive) router.replace('/schedule-board')
      } catch (e: any) {
        if (alive) setErr(e?.message || 'This link is not valid.')
      }
    })()
    return () => { alive = false }
  }, [token, router])

  async function request() {
    setErr(''); setBusy(true)
    try {
      await crmJson('board/request-link', 'POST', { email: email.trim() })
      setSent(true)
    } catch (e: any) {
      setErr(e?.message || 'Could not send the link.')
    } finally { setBusy(false) }
  }

  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: NAVY, fontFamily: F, padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 380, background: '#FFFDFA', borderRadius: 18,
                    padding: '38px 34px', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: NAVY, letterSpacing: '-0.03em', lineHeight: 1 }}>2906</div>
        <div style={{ fontSize: 10, color: GOLD, marginTop: 6, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 700 }}>
          Schedule Board
        </div>

        {token && !err && (
          <div style={{ marginTop: 28, fontSize: 13, color: '#5a6270' }}>Signing you in…</div>
        )}

        {token && err && (
          <div style={{ marginTop: 24 }}>
            <div style={{ color: '#B91C1C', fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{err}</div>
            <button onClick={() => router.replace('/board-login')} style={btn(true)}>Request a new link</button>
          </div>
        )}

        {!token && !sent && (
          <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12.5, color: '#5a6270', lineHeight: 1.55 }}>
              Enter the address your board access was set up with. We&apos;ll send you a sign-in link — no password to remember.
            </div>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="you@agency.com"
              type="email" autoComplete="email" autoFocus
              onKeyDown={e => e.key === 'Enter' && valid && !busy && request()} style={inp} />
            {err && <div style={{ color: '#B91C1C', fontSize: 12, fontWeight: 600 }}>{err}</div>}
            <button onClick={request} disabled={busy || !valid} style={btn(valid && !busy)}>
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </div>
        )}

        {!token && sent && (
          <div style={{ marginTop: 26 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: NAVY }}>Check your inbox</div>
            <div style={{ fontSize: 12.5, color: '#5a6270', marginTop: 8, lineHeight: 1.55 }}>
              If <strong>{email.trim()}</strong> has board access, a sign-in link is on its way.
              It works once and expires in 30 minutes.
            </div>
            <button onClick={() => { setSent(false); setErr('') }} style={btn(true)}>Use a different address</button>
          </div>
        )}

        <div style={{ marginTop: 22, fontSize: 10, color: '#B9B4A8', textAlign: 'center' }}>2906 Estate · Malta</div>
      </div>
    </div>
  )
}

export default function Page() {
  return <Suspense fallback={null}><BoardLogin /></Suspense>
}

const inp: React.CSSProperties = {
  background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 10, padding: '12px 14px',
  fontSize: 13, color: '#1A1A1A', fontFamily: F, outline: 'none',
}
function btn(on: boolean): React.CSSProperties {
  return {
    marginTop: 14, width: '100%', background: NAVY, color: '#FFF', border: 'none', borderRadius: 10,
    padding: '13px', fontSize: 13, fontWeight: 700, fontFamily: F,
    cursor: on ? 'pointer' : 'not-allowed', letterSpacing: '0.03em', opacity: on ? 1 : 0.5,
  }
}
