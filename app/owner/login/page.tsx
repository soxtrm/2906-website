'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useOwner } from '@/lib/owner/store'
import { StarPlay } from '@/components/owner/brand'

export default function Login() {
  const s = useOwner()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  return (
    <div className="ow-auth">
      <form className="ow-auth-card" onSubmit={async e => { e.preventDefault(); if (await s.signIn(email, pw)) router.push('/owner') }}>
        <div className="ow-auth-logo"><StarPlay size={34} color="#071449" /></div>
        <h1>Welcome back</h1>
        <div className="ow-field"><label htmlFor="le">Email</label><input id="le" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div className="ow-field"><label htmlFor="lp">Password</label><input id="lp" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required /></div>
        <button className="ow-btn primary big" type="submit">Sign in</button>
        <p className="ow-faint">New here? <Link className="ow-link" href="/owner/signup">Create an account</Link></p>
        <p className="ow-faint">Forgot the password? ARGUS sends a one-time link to your email.</p>
      </form>
    </div>
  )
}
