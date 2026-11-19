'use client'
// Sign up in three calm steps: email and password, mobile number, the code
// that arrives on WhatsApp. A confirmed number that ARGUS already knows brings
// the owner's homes in at once.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Check, Eye, EyeOff } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { passwordProblems } from '@/lib/owner/identity'
import { StarPlay } from '@/components/owner/brand'

export default function SignUp() {
  const s = useOwner()
  const router = useRouter()
  const [step, setStep] = useState<1 | 2 | 3 | 4>(s.account?.signedIn ? (s.account.phoneConfirmed ? 4 : 2) : 1)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [demoCode, setDemoCode] = useState<string | null>(null)
  const [homes, setHomes] = useState(0)
  const probs = passwordProblems(pw, email)

  return (
    <div className="ow-auth">
      <div className="ow-auth-card">
        <div className="ow-auth-logo"><StarPlay size={34} color="#071449" /></div>
        <ol className="ow-auth-steps" aria-label="Steps">
          {['Account', 'Mobile', 'Code'].map((x, i) => <li key={x} data-done={step > i + 1} data-now={step === i + 1}><span>{step > i + 1 ? <Check size={14} /> : i + 1}</span>{x}</li>)}
        </ol>

        {step === 1 && (
          <form onSubmit={async e => { e.preventDefault(); if (!probs.length && await s.signUp(email, pw)) setStep(2) }}>
            <h1>Create your account</h1>
            <p className="ow-muted">For owners of homes in Malta and Gozo. Free.</p>
            <div className="ow-field"><label htmlFor="se">Email</label><input id="se" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
            <div className="ow-field"><label htmlFor="sp">Password</label>
              <span className="ow-pw"><input id="sp" type={show ? 'text' : 'password'} autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} required />
                <button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(x => !x)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></span>
              {pw && <p className={probs.length ? 'ow-error' : 'ow-ok'}>{probs.length ? `Needs ${probs.join(', ')}` : 'Strong enough'}</p>}
            </div>
            <button className="ow-btn primary big" type="submit" disabled={!email || !!probs.length}>Continue</button>
            <p className="ow-faint">Already have an account? <Link className="ow-link" href="/owner/login">Sign in</Link></p>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={e => { e.preventDefault(); const c = s.sendCode(phone); if (c) { setDemoCode(c); setStep(3) } }}>
            <h1>Your mobile number</h1>
            <p className="ow-muted">We send a code on WhatsApp. If ARGUS already knows this number, your homes appear right away.</p>
            <div className="ow-field"><label htmlFor="sph">Mobile</label><input id="sph" type="tel" autoComplete="tel" inputMode="tel" placeholder="+356 7900 1234" value={phone} onChange={e => setPhone(e.target.value)} required /></div>
            <button className="ow-btn primary big" type="submit" disabled={!phone.trim()}>Send code</button>
          </form>
        )}

        {step === 3 && (
          <form onSubmit={e => { e.preventDefault(); const r = s.confirmCode(code); if (r.ok) { setHomes(r.homes || 0); setStep(4) } }}>
            <h1>Enter the code</h1>
            <p className="ow-muted">Sent to +{s.codeSentTo} on WhatsApp. It is valid for 10 minutes.</p>
            {demoCode && <p className="ow-hint">Preview: no message is sent. Your code is <b>{demoCode}</b>.</p>}
            <input className="ow-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} aria-label="Code" placeholder="••••••" />
            <button className="ow-btn primary big" type="submit" disabled={code.replace(/\D/g, '').length < 6}>Confirm</button>
            <button className="ow-btn quiet" type="button" onClick={() => setStep(2)}>Use another number</button>
          </form>
        )}

        {step === 4 && (
          <div className="ow-auth-done">
            <h1>{homes ? `Welcome, we found ${homes} home${homes === 1 ? '' : 's'}` : 'You are all set'}</h1>
            <p className="ow-muted">{homes ? 'They are linked to your account. Check the details and add what is missing.' : 'Add your first home and ARGUS takes care of the rest.'}</p>
            <button className="ow-btn primary big" onClick={() => router.push(homes ? '/owner' : '/owner/add')}>{homes ? 'Open my homes' : 'Add a property'}</button>
            <Link className="ow-link" href="/owner/profile">Complete my profile</Link>
          </div>
        )}
      </div>
    </div>
  )
}
