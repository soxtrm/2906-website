'use client'
// The real sign-up on nexussync.one: account, then the mobile number confirmed
// by a WhatsApp message to ARGUS Main (or an e-mail code when there is no
// WhatsApp), then the homes ARGUS found for that number, to confirm. An agent
// verifies ownership before the homes open up.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Check, Eye, EyeOff, Home, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { passwordProblems } from '@/lib/owner/identity'
import { sync, pendingClaims, liveProperties } from '@/lib/owner/live'
import { StarPlay } from './brand'
import { ChannelPicker } from './channel-picker'
import { SocialSignIn } from './social-signin'

const WA_ICON = <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path fill="#fff" d="M16 3C9 3 3.3 8.6 3.3 15.6c0 2.5.7 4.8 2 6.8L3 29l6.8-2.2c1.9 1 4 1.6 6.2 1.6 7 0 12.7-5.6 12.7-12.6S23 3 16 3zm0 23c-2 0-3.9-.6-5.5-1.6l-.4-.2-4 1.3 1.3-3.9-.3-.4a10.3 10.3 0 0 1-1.6-5.6C5.5 9.9 10.2 5.3 16 5.3s10.5 4.6 10.5 10.3S21.8 26 16 26zm5.8-7.7c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7.1-1.9-.9-3.1-1.7-4.3-3.8-.3-.6.3-.5 1-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.3 1.4 3.5c.2.2 2.4 3.7 5.9 5.2 2.2.9 3.1 1 4.2.8.7-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z" /></svg>

const FB_ERRORS: Record<string, string> = {
  facebook: 'Facebook did not confirm the sign-in. Please try again or use e-mail.',
  facebook_cancelled: 'Facebook sign-in was cancelled.',
  facebook_state: 'The Facebook sign-in took too long. Please start again.',
}

export function RealSignUp() {
  const s = useOwner()
  const router = useRouter()
  const a = s.live.account
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [wa, setWa] = useState<{ waLink: string; text: string; number: string } | null>(null)
  const [viaEmail, setViaEmail] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [code, setCode] = useState('')
  const [decided, setDecided] = useState<Record<string, 'confirm' | 'reject'>>({})
  const [claimsSent, setClaimsSent] = useState(false)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)
  const probs = passwordProblems(pw, email)

  // where to start: signed in already, back from Facebook, or an error from it
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const err = q.get('error'); if (err && FB_ERRORS[err]) setError(FB_ERRORS[err])
    if (!s.live.ready) return
    if (a) setStep(a.phone?.verified ? 3 : 2)
  }, [s.live.ready, a?.id, a?.phone?.verified]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (poll.current) clearInterval(poll.current) }, [])

  async function createAccount(e: React.FormEvent) {
    e.preventDefault(); if (probs.length) return
    setBusy(true); setError(null)
    const ok = await s.signUp(email, pw, name)
    setBusy(false)
    if (ok) setStep(2)
  }

  async function startWhatsApp() {
    setBusy(true); setError(null)
    const r = await sync<{ waLink: string; text: string; number: string }>('phone/start', { channel: 'whatsapp', phone: phone.trim() || undefined })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setWa({ waLink: r.waLink, text: r.text, number: r.number })
    if (poll.current) clearInterval(poll.current)
    const started = Date.now()
    poll.current = setInterval(async () => {
      if (Date.now() - started > 15 * 60e3) { clearInterval(poll.current!); return }
      const st = await sync<{ verified: boolean }>('phone/status')
      if (st.ok && st.verified) { clearInterval(poll.current!); await s.refreshLive(); setStep(3) }
    }, 3000)
  }

  async function sendEmailCode() {
    setBusy(true); setError(null)
    const r = await sync('email/start')
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setEmailSent(true)
  }
  async function confirmEmail(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const r = await sync('email/confirm', { code: code.replace(/\D/g, '') })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    await s.refreshLive(); setStep(3)
  }

  async function sendClaims() {
    const decisions = Object.entries(decided).map(([externalId, decision]) => ({ externalId, decision }))
    if (!decisions.length) return
    setBusy(true)
    const r = await sync('claims/decide', { decisions })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setClaimsSent(true); s.say('Thank you. An agent confirms your homes, usually within one working day.')
    s.refreshLive()
  }

  const claims = pendingClaims(s.live.owner).flatMap(l => l.proposed || [])
  const homes = liveProperties(s.live.owner)

  return (
    <div className="ow-auth">
      <div className="ow-auth-card">
        <div className="ow-auth-logo"><StarPlay size={34} color="#071449" /></div>
        <ol className="ow-auth-steps" aria-label="Steps">
          {['Account', 'Mobile', 'Your homes'].map((x, i) => <li key={x} data-done={step > i + 1} data-now={step === i + 1}><span>{step > i + 1 ? <Check size={14} /> : i + 1}</span>{x}</li>)}
        </ol>
        {error && <p className="ow-error" role="alert">{error}</p>}

        {step === 1 && (
          <form onSubmit={createAccount}>
            <h1>Create your account</h1>
            <p className="ow-muted">For owners of homes in Malta and Gozo. Free.</p>
            <SocialSignIn onDone={() => {}} />
            <div className="ow-field"><label htmlFor="rn">Your name</label><input id="rn" autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></div>
            <div className="ow-field"><label htmlFor="re">Email</label><input id="re" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
            <div className="ow-field"><label htmlFor="rp">Password</label>
              <span className="ow-pw"><input id="rp" type={show ? 'text' : 'password'} autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} required />
                <button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(x => !x)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></span>
              {pw && <p className={probs.length ? 'ow-error' : 'ow-ok'}>{probs.length ? `Needs ${probs.join(', ')}` : 'Strong enough'}</p>}
            </div>
            <button className="ow-btn primary big" type="submit" disabled={busy || !email || !!probs.length}>{busy ? 'Creating…' : 'Create account'}</button>
            <p className="ow-faint">Already have an account? <Link className="ow-link" href="/owner/login">Sign in</Link></p>
          </form>
        )}

        {step === 2 && !viaEmail && (
          <div className="ow-wa-verify">
            <h1>Confirm your mobile</h1>
            <p className="ow-muted">Your mobile links you to the homes ARGUS already knows. One message on WhatsApp to ARGUS Main confirms it: the number you send from is the number we confirm.</p>
            {!wa ? (
              <>
                <div className="ow-field"><label htmlFor="rph">Mobile (optional, with country code)</label>
                  <input id="rph" type="tel" inputMode="tel" autoComplete="tel" placeholder="+356 7900 1234" value={phone} onChange={e => setPhone(e.target.value)} /></div>
                <button type="button" className="ow-wa-big" disabled={busy} onClick={startWhatsApp}>{WA_ICON}{busy ? 'Preparing…' : 'Verify with WhatsApp'}</button>
              </>
            ) : (
              <>
                <a className="ow-wa-big" href={wa.waLink} target="_blank" rel="noopener">{WA_ICON}Open WhatsApp and press send</a>
                <div className="ow-wa-wait"><span className="ow-wa-dots"><i /><i /><i /></span>Waiting for <b>{wa.text}</b> to {wa.number}</div>
                <p className="ow-faint">On a computer? Send exactly <b>{wa.text}</b> from your phone to <b>{wa.number}</b>. This page moves on by itself.</p>
                <button type="button" className="ow-btn quiet" onClick={startWhatsApp}>Get a new code</button>
              </>
            )}
            <button type="button" className="ow-btn quiet" onClick={() => { setViaEmail(true); setError(null) }}>No WhatsApp? Confirm by e-mail</button>
          </div>
        )}

        {step === 2 && viaEmail && (
          <div>
            <h1>Confirm by e-mail</h1>
            {!a?.email ? <p className="ow-muted">Your account has no e-mail address. Please use WhatsApp.</p> : !emailSent ? (
              <>
                <p className="ow-muted">We send a 6-digit code to <b>{a.email}</b>. Your account is then confirmed. To link the homes ARGUS knows under your number, the mobile still needs one confirmation later; SMS is coming.</p>
                <button className="ow-btn primary big" disabled={busy} onClick={sendEmailCode}>{busy ? 'Sending…' : 'Send the code'}</button>
              </>
            ) : (
              <form onSubmit={confirmEmail}>
                <p className="ow-muted">Sent to {a.email}. It is valid for 30 minutes.</p>
                <input className="ow-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} aria-label="Code" placeholder="••••••" />
                <button className="ow-btn primary big" type="submit" disabled={busy || code.replace(/\D/g, '').length < 6}>Confirm</button>
              </form>
            )}
            <button type="button" className="ow-btn quiet" onClick={() => setViaEmail(false)}>Back to WhatsApp</button>
          </div>
        )}

        {step === 3 && (
          <div className="ow-auth-done">
            {claims.length > 0 && !claimsSent ? (
              <>
                <h1>Are these yours?</h1>
                <p className="ow-muted">ARGUS knows these homes under your number. Tell us which are yours; an agent then confirms ownership and they open up here.</p>
                <ul className="ow-claims">
                  {claims.map(c => (
                    <li key={c.externalId}>
                      <Home size={18} aria-hidden="true" />
                      <span><b>{c.propertyType || 'Home'} in {c.town}</b><small>{c.bedrooms ? `${c.bedrooms} bedroom${c.bedrooms === 1 ? '' : 's'} · ` : ''}Ref {c.ref}</small></span>
                      <span className="ow-seg" role="group" aria-label={`Is ${c.ref} yours?`}>
                        <button type="button" aria-pressed={decided[c.externalId] === 'confirm'} onClick={() => setDecided(d => ({ ...d, [c.externalId]: 'confirm' }))}><Check size={15} />Mine</button>
                        <button type="button" aria-pressed={decided[c.externalId] === 'reject'} onClick={() => setDecided(d => ({ ...d, [c.externalId]: 'reject' }))}><X size={15} />Not mine</button>
                      </span>
                    </li>
                  ))}
                </ul>
                <button className="ow-btn primary big" disabled={busy || Object.keys(decided).length < claims.length} onClick={sendClaims}>Send to ARGUS</button>
              </>
            ) : (
              <>
                <h1>{homes.length ? `Welcome, ${homes.length} home${homes.length === 1 ? ' is' : 's are'} ready` : claimsSent || claims.length ? 'Thank you, an agent is confirming your homes' : 'You are all set'}</h1>
                <p className="ow-muted">{homes.length ? 'Check the details and add what is missing.' : claimsSent || claims.length ? 'This usually takes up to one working day. You can already add a new home or write to ARGUS Main.' : 'Add your first home and ARGUS takes care of the rest.'}</p>
                <p className="ow-label">How should ARGUS reach you?</p>
                <ChannelPicker />
                <button className="ow-btn primary big" onClick={() => router.push(homes.length ? '/owner' : '/owner/add')}>{homes.length ? 'Open my homes' : 'Add a property'}</button>
                <Link className="ow-link" href="/owner">Go to my workspace</Link>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
