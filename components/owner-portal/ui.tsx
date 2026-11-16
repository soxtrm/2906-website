'use client'
import { AnimatePresence, motion } from 'framer-motion'
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

export const TZ = 'Europe/Malta'
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
const longDayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
export const fmtDay = (iso: string) => dayFmt.format(new Date(iso))
export const fmtLongDay = (iso: string) => longDayFmt.format(new Date(iso))
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso))
export const dayKey = (iso: string | number | Date) => keyFmt.format(new Date(iso))
export const fmtWhen = (iso: string) => `${fmtDay(iso)} · ${fmtTime(iso)}`
export const money = (n: number | string | null | undefined) => n === null || n === undefined || n === '' ? '—' : `€${Number(n).toLocaleString('en-GB')}`

export class ApiError extends Error { code?: string; status: number; data: any
  constructor(message: string, status: number, data: any) { super(message); this.status = status; this.code = data?.code; this.data = data }
}

export async function api<T = any>(base: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const r = await fetch(`${base}${path}`, {
    cache: 'no-store', credentials: 'same-origin', ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(data.error || `Request failed (${r.status})`, r.status, data)
  return data as T
}

export const LABEL: Record<string, string> = {
  REQUESTED: 'New request', OWNER_SLOT_PROPOSED: 'Slot proposed · agent checking', AGENT_CLIENT_CONFIRMATION_PENDING: 'Agent checking with client',
  CONFIRMED: 'Confirmed', DECLINED: 'Declined', RESCHEDULE_REQUESTED: 'Wants another time', CANCELLED: 'Cancelled', EXPIRED: 'Expired', COMPLETED: 'Completed', NO_SHOW: 'No show',
}
export const TONE: Record<string, string> = {
  REQUESTED: 'accent', RESCHEDULE_REQUESTED: 'accent', OWNER_SLOT_PROPOSED: 'warn', AGENT_CLIENT_CONFIRMATION_PENDING: 'warn', CONFIRMED: 'ok',
  DECLINED: 'bad', CANCELLED: 'bad', EXPIRED: 'bad', COMPLETED: 'ok', NO_SHOW: 'bad',
}

export function Chip({ tone, children }: { tone?: string; children: ReactNode }) { return <span className="op-chip" data-tone={tone}>{children}</span> }

export function Sheet({ open, title, onClose, children, footer, labelledBy = 'op-sheet-title' }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef<Element | null>(null)
  useEffect(() => {
    if (!open) return
    last.current = document.activeElement
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]')?.focus(), 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, a[href]')]
        if (!f.length) return
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; (last.current as HTMLElement | null)?.focus?.() }
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && <>
        <motion.div className="op-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
        <motion.div ref={ref} className="op-sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy} data-state="open"
          initial={{ opacity: 0, y: 26, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: .985 }}
          transition={{ type: 'spring', stiffness: 420, damping: 36 }}>
          <div className="op-sheet-head">
            <h2 id={labelledBy} className="op-display" style={{ margin: 0, fontSize: 19 }}>{title}</h2>
            <button className="op-btn op-btn-ghost op-btn-sm" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
          <div className="op-sheet-body">{children}</div>
          {footer && <div className="op-sheet-foot">{footer}</div>}
        </motion.div>
      </>}
    </AnimatePresence>
  )
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null)
  const show = useCallback((m: string) => { setMsg(m); window.setTimeout(() => setMsg(cur => cur === m ? null : cur), 3600) }, [])
  const node = (
    <AnimatePresence>
      {msg && <motion.div className="op-toast" role="status" aria-live="polite" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>{msg}</motion.div>}
    </AnimatePresence>
  )
  return { show, node }
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="op-field">
      <span>{label}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="op-input" readOnly value={value} onFocus={e => e.currentTarget.select()} aria-label={label} />
        <button className="op-btn op-btn-primary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true) } catch { setCopied(false) } }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}
