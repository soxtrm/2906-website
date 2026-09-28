'use client'
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { crmJson } from '@/lib/crm/api'

const A = 'rgba(212,137,26,1)'
const F = "var(--font-bricolage), 'Bricolage Grotesque', Arial, sans-serif"

export default function CrmLogin() {
  const router = useRouter()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    setErr(''); setLoading(true)
    try {
      const d = await crmJson('login', 'POST', { emailOrUsername: id.trim(), password: pw })
      router.replace(d?.agent?.role === 'board' ? '/schedule-board' : '/')
    } catch (e: any) {
      setErr(e?.message || 'Login failed'); setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#131313', fontFamily: F, padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 360, background: '#FFF', borderRadius: 18, padding: '38px 34px', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--crm-accent)', letterSpacing: '-0.03em', lineHeight: 1 }}>2906</div>
        <div style={{ fontSize: 10, color: '#BBB', marginTop: 6, letterSpacing: '0.18em', textTransform: 'uppercase' }}>Estate · Agent CRM</div>

        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input value={id} onChange={e => setId(e.target.value)} placeholder="Email or username"
            onKeyDown={e => e.key === 'Enter' && submit()}
            style={inp} autoFocus />
          <div style={{ position: 'relative' }}>
          <input value={pw} onChange={e => setPw(e.target.value)} placeholder="Password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" aria-label="Password"
            onKeyDown={e => e.key === 'Enter' && submit()}
            style={{ ...inp, width: '100%', boxSizing: 'border-box', paddingRight: 48 }} />
          <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)} style={{ position: 'absolute', right: 2, top: 0, bottom: 0, width: 44, display: 'grid', placeItems: 'center', border: 0, borderRadius: 8, background: 'transparent', color: '#59616A', cursor: 'pointer' }}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button>
          </div>
          {err && <div style={{ color: '#B91C1C', fontSize: 12, fontWeight: 600 }}>{err}</div>}
          <button onClick={submit} disabled={loading || !id || !pw}
            style={{ background: '#0F0F0F', color: '#FFF', border: 'none', borderRadius: 10, padding: '13px', fontSize: 13, fontWeight: 700, fontFamily: F, cursor: loading ? 'wait' : 'pointer', letterSpacing: '0.03em', opacity: (!id || !pw) ? 0.5 : 1, marginTop: 4 }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        <div style={{ marginTop: 17, display: 'flex', justifyContent: 'center', gap: 8, fontSize: 11 }}>
          <a href="/board-login" style={{ color: '#667085', textDecoration: 'none' }}>Board sign-in</a>
          <span style={{ color: '#D2CEC5' }}>·</span>
          <a href="/board-login?mode=request" style={{ color: A, textDecoration: 'none', fontWeight: 700 }}>Request access</a>
        </div>
        <div style={{ marginTop: 20, fontSize: 10, color: '#CCC', textAlign: 'center' }}>2906 Estate · Malta</div>
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 10, padding: '12px 14px',
  fontSize: 13, color: '#1A1A1A', fontFamily: F, outline: 'none',
}
