'use client'
// Sign up in three calm steps: email and password, mobile number, the code
// that arrives on WhatsApp. A confirmed number that ARGUS already knows brings
// the owner's homes in at once.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Check, Eye, EyeOff } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { passwordProblems, waLink, waVerifyText } from '@/lib/owner/identity'

// ARGUS Main's WhatsApp number, set per environment (NEXT_PUBLIC_ARGUS_MAIN_WA).
const ARGUS_MAIN_WA = process.env.NEXT_PUBLIC_ARGUS_MAIN_WA || ''
import { StarPlay } from '@/components/owner/brand'
import { SocialSignIn } from '@/components/owner/social-signin'
import { ChannelPicker } from '@/components/owner/channel-picker'
import { RealSignUp } from '@/components/owner/real-signup'

// nexussync.one: the real sign-up. ?demo=1: the preview with simulated messages.
export default function SignUp() {
  const s = useOwner()
  return s.demo ? <DemoSignUp /> : <RealSignUp />
}

function DemoSignUp() {
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
  const [token, setToken] = useState<string | null>(null)
  const [viaCode, setViaCode] = useState(false)
  const [simPhone, setSimPhone] = useState('+356 0000 0000')
  const link = token ? waLink(ARGUS_MAIN_WA, token) : null
  const probs = passwordProblems(pw, email)

  return (
    <div className="ow-auth">
      <div className="ow-auth-card">
        <div className="ow-auth-logo"><StarPlay size={34} color="#071449" /></div>
        <ol className="ow-auth-steps" aria-label="Steps">
          {['Account', 'WhatsApp', 'Done'].map((x, i) => <li key={x} data-done={step > i + 1} data-now={step === i + 1}><span>{step > i + 1 ? <Check size={14} /> : i + 1}</span>{x}</li>)}
        </ol>

        {step === 1 && (
          <form onSubmit={async e => { e.preventDefault(); if (!probs.length && await s.signUp(email, pw)) setStep(2) }}>
            <h1>Create your account</h1>
            <p className="ow-muted">For owners of homes in Malta and Gozo. Free.</p>
            <SocialSignIn onDone={() => setStep(s.account?.phoneConfirmed ? 4 : 2)} />
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

        {step === 2 && !viaCode && (
          <div className="ow-wa-verify">
            <div className="ow-seg" role="group" aria-label="Confirm with">
              <button type="button" aria-pressed="true">WhatsApp</button>
              <button type="button" aria-pressed="false" onClick={() => setViaCode(true)}>SMS code</button>
            </div>
            <h1>Confirm with WhatsApp</h1>
            <p className="ow-muted">{s.account?.provider && s.account.provider !== 'email' ? 'Whichever way you signed in, ' : ''}One tap opens WhatsApp with a message to ARGUS Main. Press send and you are done. If ARGUS knows your number, your homes appear right away.</p>
            {!token ? (
              <button type="button" className="ow-wa-big" onClick={() => setToken(s.startWaVerify())}>
                <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path fill="#fff" d="M16 3C9 3 3.3 8.6 3.3 15.6c0 2.5.7 4.8 2 6.8L3 29l6.8-2.2c1.9 1 4 1.6 6.2 1.6 7 0 12.7-5.6 12.7-12.6S23 3 16 3zm0 23c-2 0-3.9-.6-5.5-1.6l-.4-.2-4 1.3 1.3-3.9-.3-.4a10.3 10.3 0 0 1-1.6-5.6C5.5 9.9 10.2 5.3 16 5.3s10.5 4.6 10.5 10.3S21.8 26 16 26zm5.8-7.7c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7.1-1.9-.9-3.1-1.7-4.3-3.8-.3-.6.3-.5 1-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.3 1.4 3.5c.2.2 2.4 3.7 5.9 5.2 2.2.9 3.1 1 4.2.8.7-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z" /></svg>
                Verify with WhatsApp
              </button>
            ) : (
              <>
                {link
                  ? <a className="ow-wa-big" href={link} target="_blank" rel="noopener">Open WhatsApp again</a>
                  : <p className="ow-hint">Preview: ARGUS Main&apos;s WhatsApp number is not set here, so WhatsApp cannot open. The message would be <b>{waVerifyText(token)}</b>.</p>}
                <div className="ow-wa-wait"><span className="ow-wa-dots"><i /><i /><i /></span>Waiting for your message <b>{waVerifyText(token)}</b></div>
                <form className="ow-wa-sim" onSubmit={e => { e.preventDefault(); const r = s.receiveWa(simPhone, waVerifyText(token)); if (r.ok) { setHomes(r.homes || 0); setStep(4) } }}>
                  <p className="ow-faint">Preview only: pretend the message arrived from this number.</p>
                  <input value={simPhone} onChange={e => setSimPhone(e.target.value)} aria-label="Sender number (preview)" />
                  <button className="ow-btn primary" type="submit">Message arrived</button>
                </form>
              </>
            )}
            <button type="button" className="ow-btn quiet" onClick={() => setViaCode(true)}>No WhatsApp? Get a code by SMS</button>
          </div>
        )}

        {step === 2 && viaCode && (
          <form onSubmit={e => { e.preventDefault(); const c = s.sendCode(phone); if (c) { setDemoCode(c); setStep(3) } }}>
            <div className="ow-seg" role="group" aria-label="Confirm with">
              <button type="button" aria-pressed="false" onClick={() => setViaCode(false)}>WhatsApp</button>
              <button type="button" aria-pressed="true">SMS code</button>
            </div>
            <h1>Confirm by SMS</h1>
            <p className="ow-muted">{s.account?.provider && s.account.provider !== 'email' ? 'Whichever way you signed in, your mobile number links you to your homes. ' : ''}We send a code by SMS. If ARGUS already knows this number, your homes appear right away.</p>
            <div className="ow-field"><label htmlFor="sph">Mobile</label><input id="sph" type="tel" autoComplete="tel" inputMode="tel" placeholder="+356 7900 1234" value={phone} onChange={e => setPhone(e.target.value)} required /></div>
            <button className="ow-btn primary big" type="submit" disabled={!phone.trim()}>Send code</button>
            <button type="button" className="ow-btn quiet" onClick={() => setViaCode(false)}>Back to WhatsApp</button>
          </form>
        )}

        {step === 3 && (
          <form onSubmit={e => { e.preventDefault(); const r = s.confirmCode(code); if (r.ok) { setHomes(r.homes || 0); setStep(4) } }}>
            <h1>Enter the code</h1>
            <p className="ow-muted">Sent to +{s.codeSentTo} by SMS. It is valid for 10 minutes.</p>
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
            <p className="ow-label">How should ARGUS reach you?</p>
            <ChannelPicker />
            <button className="ow-btn primary big" onClick={() => router.push(homes ? '/owner' : '/owner/add')}>{homes ? 'Open my homes' : 'Add a property'}</button>
            <Link className="ow-link" href="/owner/profile">Complete my profile</Link>
          </div>
        )}
      </div>
    </div>
  )
}
