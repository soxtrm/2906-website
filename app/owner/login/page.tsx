'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { sync, type LiveAccount } from '@/lib/owner/live'
import { PhoneLogin } from '@/components/owner/phone-login'
import { useOwner } from '@/lib/owner/store'
import { StarPlay } from '@/components/owner/brand'
import { SocialSignIn } from '@/components/owner/social-signin'

export default function Login() {
  const s = useOwner()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [withEmail, setWithEmail] = useState(false)
  useEffect(() => { const e = new URLSearchParams(location.search).get('error'); if (e?.startsWith('facebook')) setError('Facebook did not confirm the sign-in. Please try again or use e-mail.') }, [])
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null)
    if (!(await s.signIn(email, pw))) return
    if (s.demo) { router.push('/owner'); return }
    const me = await sync<{ account: LiveAccount }>('me')
    router.push(me.ok && me.account.phone?.verified ? '/owner' : '/owner/signup')
  }
  if (!s.demo && !withEmail) return (
    <div className="ow-auth">
      <div className="ow-auth-card">
        <div className="ow-auth-logo"><StarPlay size={34} color="#071449" /></div>
        <h1>Welcome back</h1>
        {error && <p className="ow-error" role="alert">{error}</p>}
        <PhoneLogin onDone={() => router.push('/owner')} />
        <p className="ow-or"><span>or</span></p>
        <SocialSignIn onDone={() => router.push('/owner')} divider={false} />
        <button type="button" className="ow-btn big" onClick={() => setWithEmail(true)}>Use e-mail instead</button>
        <p className="ow-faint">New here? <Link className="ow-link" href="/owner/signup">Create an account</Link></p>
      </div>
    </div>
  )
  return (
    <div className="ow-auth">
      <form className="ow-auth-card" onSubmit={submit}>
        <div className="ow-auth-logo"><StarPlay size={34} color="#071449" /></div>
        <h1>Welcome back</h1>
        {error && <p className="ow-error" role="alert">{error}</p>}
        <SocialSignIn onDone={() => router.push(s.account?.phoneConfirmed ? '/owner' : '/owner/signup')} />
        <div className="ow-field"><label htmlFor="le">Email</label><input id="le" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div className="ow-field"><label htmlFor="lp">Password</label><input id="lp" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required /></div>
        <button className="ow-btn primary big" type="submit">Sign in</button>
        <p className="ow-faint">New here? <Link className="ow-link" href="/owner/signup">Create an account</Link></p>
        {s.demo
          ? <p className="ow-faint">Forgot the password? ARGUS sends a one-time link to your email.</p>
          : <p className="ow-faint">Forgot the password? Write to ARGUS Main on WhatsApp (+356 7967 5060) and we reset it for you.</p>}
      </form>
    </div>
  )
}
