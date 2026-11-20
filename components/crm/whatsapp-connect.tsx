'use client'

// WhatsApp connection on the agent profile: one button, then either a code typed
// into WhatsApp (works when ARGUS is open on the same phone, where a QR on its own
// screen cannot be scanned) or the QR for people sitting at a computer.
//
// WAHA shows six QR codes (about two and a half minutes) and then marks the session
// FAILED. The panel restarts it quietly a couple of times so the agent never has to
// know; after that it asks for one tap to try again.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, MessageCircle, QrCode, RefreshCw, Smartphone } from 'lucide-react'
import { crmFetch, crmJson } from '@/lib/crm/api'
import './whatsapp-connect.css'

export type WhatsAppState = { status: string; session: string | null; phone?: string | null; qr?: string; code?: string }
type Phase = 'idle' | 'linking' | 'timedOut'
type Method = 'code' | 'qr'

const POLL_MS = 2500
const SILENT_RESTARTS = 2
const digits = (value: string) => value.replace(/\D/g, '')
const prettyPhone = (value?: string | null) => {
  const d = digits(String(value || '').split(':')[0])
  return d ? `+${d.replace(/^(\d{3})(\d{4})(\d+)$/, '$1 $2 $3')}` : ''
}
const errorText = (e: any, fallback: string) => e?.data?.error || e?.message || fallback
const isLinkingStatus = (status: string) => status === 'QR_REQUIRED' || status === 'CONNECTING'

export function WhatsAppConnect({ agentId, savedPhone, initial, canManage, onChange }: {
  agentId: number; savedPhone: string | null; initial: WhatsAppState; canManage: boolean; onChange: () => void
}) {
  const [live, setLive] = useState<WhatsAppState>(initial)
  const [phase, setPhase] = useState<Phase>(isLinkingStatus(initial.status) && canManage ? 'linking' : 'idle')
  const [method, setMethod] = useState<Method>('qr')
  const [phone, setPhone] = useState(savedPhone || '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [codeBusy, setCodeBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const restarts = useRef(0)
  const ticking = useRef(false)
  const base = `agent-profile/${agentId}/whatsapp`
  const connected = live.status === 'CONNECTED'

  useEffect(() => { setLive(prev => (prev.status === initial.status && prev.qr ? prev : initial)) }, [initial])
  // A phone cannot scan its own screen, so touch devices start on the code.
  useEffect(() => { if (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 720) setMethod('code') }, [])

  const finish = useCallback((state: WhatsAppState) => {
    setLive(state); setPhase('idle'); setCode(''); setError(''); restarts.current = 0
    const number = digits(String(state.phone || '').split(':')[0])
    // Keep the profile's number in step with the phone that was really linked.
    const save = number && number !== digits(savedPhone || '')
      ? crmJson(`agent-profile/${agentId}`, 'PATCH', { whatsapp_phone: number }).catch(() => null)
      : Promise.resolve(null)
    save.finally(onChange)
  }, [agentId, savedPhone, onChange])

  const start = useCallback(async (silent = false) => {
    if (!silent) { setBusy(true); setError(''); restarts.current = 0 }
    setCode('')
    try {
      const state: WhatsAppState = await crmFetch(`${base}/connect`, { method: 'POST' })
      if (state.status === 'CONNECTED') finish(state)
      else { setLive(state); setPhase('linking') }
    } catch (e) {
      if (!silent) setError(errorText(e, 'WhatsApp could not be started. Try again.'))
      else setPhase('timedOut')
    } finally { if (!silent) setBusy(false) }
  }, [base, finish])

  useEffect(() => {
    if (phase !== 'linking') return
    const tick = async () => {
      if (ticking.current || document.hidden) return
      ticking.current = true
      try {
        const state: WhatsAppState = await crmFetch(`${base}/status`)
        if (state.status === 'CONNECTED') finish(state)
        else if (isLinkingStatus(state.status)) setLive(prev => ({ ...state, qr: state.qr || prev.qr }))
        else if (restarts.current < SILENT_RESTARTS) { restarts.current += 1; await start(true) }
        else { setLive(state); setCode(''); setPhase('timedOut') }
      } catch { /* a dropped request is not a failed connection; the next tick retries */ }
      finally { ticking.current = false }
    }
    const timer = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [phase, base, finish, start])

  async function getCode() {
    const number = digits(phone)
    if (number.length < 8 || number.length > 15) { setError('Enter your WhatsApp number with the country code, for example 356 9912 3456.'); return }
    setCodeBusy(true); setError('')
    try {
      const state: WhatsAppState = await crmJson(`${base}/pair-code`, 'POST', { phone: number })
      if (state.status === 'CONNECTED') finish(state)
      else if (state.code) { setCode(String(state.code)); setLive(prev => ({ ...prev, ...state, qr: state.qr || prev.qr })) }
      else setError('WhatsApp did not give a code. Try again, or use the QR code.')
    } catch (e) { setError(errorText(e, 'Could not get a code. Try again, or use the QR code.')) }
    finally { setCodeBusy(false) }
  }

  async function copyCode() {
    try { await navigator.clipboard.writeText(code.replace(/-/g, '')); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* the code stays on screen to type */ }
  }

  async function disconnect() {
    setBusy(true); setError('')
    try { await crmJson(`${base}/disconnect`, 'POST', {}); setConfirmOff(false); setLive(prev => ({ ...prev, status: 'OFFLINE', qr: undefined })); onChange() }
    catch (e) { setError(errorText(e, 'Could not disconnect. Try again.')) }
    finally { setBusy(false) }
  }

  const pill = connected ? { tone: 'ok', label: 'Connected' } : phase === 'linking' ? { tone: 'wait', label: 'Waiting for your phone' } : { tone: 'off', label: 'Not connected' }

  return (
    <section className="wa-connect" data-state={connected ? 'connected' : phase} aria-live="polite">
      <header className="wa-connect-head">
        <span className="wa-connect-icon"><MessageCircle size={18} aria-hidden /></span>
        <div><h3>WhatsApp</h3><p>{connected ? 'ARGUS sends and receives through your WhatsApp.' : 'Link your WhatsApp so ARGUS can work for you.'}</p></div>
        <span className={`wa-connect-pill is-${pill.tone}`}><i />{pill.label}</span>
      </header>

      {connected && (
        <div className="wa-connect-done">
          <span className="wa-connect-check"><Check size={20} aria-hidden /></span>
          <div><strong>{prettyPhone(live.phone) || 'Your WhatsApp'}</strong><span>Linked as a device, like WhatsApp Web. Your phone can stay in your pocket.</span></div>
          {canManage && !confirmOff && <button type="button" className="wa-connect-link" onClick={() => setConfirmOff(true)}>Disconnect</button>}
          {canManage && confirmOff && (
            <div className="wa-connect-confirm">
              <span>ARGUS stops sending from this number.</span>
              <button type="button" className="wa-connect-btn is-danger" disabled={busy} onClick={disconnect}>{busy ? 'Disconnecting…' : 'Yes, disconnect'}</button>
              <button type="button" className="wa-connect-btn is-quiet" disabled={busy} onClick={() => setConfirmOff(false)}>Keep it</button>
            </div>
          )}
        </div>
      )}

      {!connected && !canManage && <p className="wa-connect-note">Only this agent or an admin can connect this WhatsApp.</p>}

      {!connected && canManage && phase !== 'linking' && (
        <div className="wa-connect-start">
          {phase === 'timedOut' && <p className="wa-connect-note is-warn">The link was not finished in time. Nothing is broken, just start again.</p>}
          <button type="button" className="wa-connect-btn is-primary is-big" disabled={busy} onClick={() => start()}>
            {busy ? <Loader2 size={18} className="wa-spin" aria-hidden /> : <MessageCircle size={18} aria-hidden />}
            {busy ? 'Starting…' : phase === 'timedOut' ? 'Try again' : 'Connect WhatsApp'}
          </button>
          <span className="wa-connect-hint">Takes about a minute. You need your phone with WhatsApp on it.</span>
        </div>
      )}

      {!connected && canManage && phase === 'linking' && (
        <div className="wa-connect-flow">
          <div className="wa-connect-tabs" role="tablist" aria-label="How to link">
            <button type="button" role="tab" aria-selected={method === 'code'} className={method === 'code' ? 'is-on' : ''} onClick={() => { setMethod('code'); setError('') }}><Smartphone size={15} aria-hidden /> With a code</button>
            <button type="button" role="tab" aria-selected={method === 'qr'} className={method === 'qr' ? 'is-on' : ''} onClick={() => { setMethod('qr'); setError('') }}><QrCode size={15} aria-hidden /> Scan QR</button>
          </div>

          {method === 'code' && (
            <div className="wa-connect-pane">
              {!code ? (
                <form className="wa-connect-phone" onSubmit={event => { event.preventDefault(); getCode() }}>
                  <label htmlFor="wa-connect-phone">Your WhatsApp number, with country code</label>
                  <div>
                    <input id="wa-connect-phone" value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="356 9912 3456" />
                    <button type="submit" className="wa-connect-btn is-primary" disabled={codeBusy}>{codeBusy ? <Loader2 size={16} className="wa-spin" aria-hidden /> : null}{codeBusy ? 'Getting code…' : 'Get code'}</button>
                  </div>
                </form>
              ) : (
                <div className="wa-connect-code">
                  <span>Type this code into WhatsApp</span>
                  <output aria-label={`Code ${code.replace(/-/g, '').split('').join(' ')}`}>
                    {code.replace(/-/g, '').split('').map((char, index) => <b key={index} className={index === 4 ? 'is-gap' : ''}>{char}</b>)}
                  </output>
                  <div>
                    <button type="button" className="wa-connect-btn is-quiet" onClick={copyCode}>{copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}{copied ? 'Copied' : 'Copy code'}</button>
                    <button type="button" className="wa-connect-btn is-quiet" disabled={codeBusy} onClick={getCode}><RefreshCw size={15} className={codeBusy ? 'wa-spin' : ''} aria-hidden />New code</button>
                  </div>
                </div>
              )}
              <ol className="wa-connect-steps">
                <li>Open <strong>WhatsApp</strong> on your phone.</li>
                <li>Go to <strong>Settings → Linked devices → Link a device</strong>.</li>
                <li>Tap <strong>Link with phone number instead</strong> and type the code.</li>
              </ol>
            </div>
          )}

          {method === 'qr' && (
            <div className="wa-connect-pane is-qr">
              <div className="wa-connect-qr">
                {live.qr ? <img src={live.qr} alt="QR code to link WhatsApp" /> : <span><Loader2 size={22} className="wa-spin" aria-hidden />Preparing your QR…</span>}
              </div>
              <ol className="wa-connect-steps">
                <li>Open <strong>WhatsApp</strong> on your phone.</li>
                <li>Go to <strong>Settings → Linked devices → Link a device</strong>.</li>
                <li>Point the phone at this code. It refreshes by itself.</li>
              </ol>
            </div>
          )}

          <p className="wa-connect-waiting"><Loader2 size={14} className="wa-spin" aria-hidden /> Waiting for your phone. This page updates by itself.</p>
        </div>
      )}

      {error && <p className="wa-connect-error" role="alert">{error}</p>}
    </section>
  )
}
