'use client'
// Sign in with the mobile number: WhatsApp opens with "SYNC login CODE" to ARGUS
// Main; the page signs in by itself once the message arrived from that number.
import { useEffect, useRef, useState } from 'react'
import { useOwner } from '@/lib/owner/store'
import { sync } from '@/lib/owner/live'

export function PhoneLogin({ onDone }: { onDone: () => void }) {
  const s = useOwner()
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wait, setWait] = useState<{ waLink: string; text: string; number: string } | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  async function start(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const r = await sync<{ pollKey: string; waLink: string; text: string; number: string }>('login/phone/start', { phone })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setWait({ waLink: r.waLink, text: r.text, number: r.number })
    const key = r.pollKey
    const began = Date.now()
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(async () => {
      if (Date.now() - began > 10 * 60e3) { clearInterval(timer.current!); setError('That took too long. Please start again.'); setWait(null); return }
      const st = await sync<{ waiting: boolean }>('login/phone/status', { pollKey: key })
      if (!st.ok) { clearInterval(timer.current!); setError(st.message); setWait(null); return }
      if (!st.waiting) { clearInterval(timer.current!); await s.refreshLive(); s.say('Welcome back.'); onDone() }
    }, 2500)
  }

  return (
    <div className="ow-phone-login">
      {error && <p className="ow-error" role="alert">{error}</p>}
      {!wait ? (
        <form onSubmit={start}>
          <div className="ow-field"><label htmlFor="pl">Your mobile number</label>
            <input id="pl" type="tel" inputMode="tel" autoComplete="tel" placeholder="+356 7900 1234" value={phone} onChange={e => setPhone(e.target.value)} required /></div>
          <button className="ow-btn primary big" type="submit" disabled={busy || phone.replace(/\D/g, '').length < 8}>{busy ? 'One moment…' : 'Sign in with WhatsApp'}</button>
          <p className="ow-faint">No password. WhatsApp opens with a short message to ARGUS Main; press send and you are in.</p>
        </form>
      ) : (
        <div className="ow-wa-verify">
          <a className="ow-wa-big" href={wait.waLink} target="_blank" rel="noopener">Open WhatsApp and press send</a>
          <div className="ow-wa-wait"><span className="ow-wa-dots"><i /><i /><i /></span>Waiting for <b>{wait.text}</b></div>
          <p className="ow-faint">On a computer? Send <b>{wait.text}</b> from your phone to <b>{wait.number}</b>. This page signs you in by itself.</p>
          <button className="ow-btn quiet" type="button" onClick={() => { if (timer.current) clearInterval(timer.current); setWait(null) }}>Use another number</button>
        </div>
      )}
    </div>
  )
}
