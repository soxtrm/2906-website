'use client'
// ============================================================================
// board-dialogs.tsx — the things an agent can start from a board card.
//
//   BookDialog  → books a viewing and records who is coming. Sends nothing
//                 itself; the backend opens the owner chat below if it can.
//   AskDialog   → writes a question, Gemini rewrites it, the agent reads the
//                 exact outgoing text and confirms. Only then does it send.
//   ChatDialog  → the WhatsApp-style conversation Ask/Book open onto. The
//                 agent types straight into it — the bot passes it to the
//                 owner VERBATIM, no rewrite (services/bookRelay.js relayVerbatim,
//                 same code the WhatsApp !r relay uses). The owner is shown
//                 only as an anonymous "Owner ####" label; any phone number
//                 in their replies is masked before it ever reaches here.
//
// Same visual language as components/property-filters.tsx (bg-off-white
// inputs, gold focus ring, navy chips) so these do not read as a second
// design system living inside the first.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Calendar, Clock, EyeOff, HelpCircle, Home, ImagePlus,
  Loader2, MessageCircle, Send, Sparkles, Users, X,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { cn } from '@/lib/utils'
import { useCrm, canCreateGroup } from '@/lib/crm/ui'

// ── shared shell ────────────────────────────────────────────────────────────
const FIELD =
  'w-full px-3 py-2 bg-off-white border-0 rounded text-sm text-navy ' +
  'placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50'
const LABEL = 'block text-[10px] font-semibold uppercase tracking-[0.12em] text-navy/40 mb-1.5'
const PRIMARY =
  'px-4 py-2.5 rounded bg-navy text-white text-sm font-semibold hover:bg-navy-light ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2'
const GHOST = 'px-4 py-2.5 rounded text-sm text-navy/50 hover:text-navy transition-colors'

function Sheet({ title, sub, onClose, children, footer }: {
  title: string; sub?: string; onClose: () => void
  children: React.ReactNode; footer?: React.ReactNode
}) {
  // Escape closes. A dialog that traps you is worse than one that closes by
  // accident — nothing here sends without a second, explicit click.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-[199] bg-navy/20 backdrop-blur-[3px]"
      />
      <motion.div
        initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="fixed z-[200] bg-white shadow-2xl flex flex-col
                   inset-x-0 bottom-0 rounded-t-2xl max-h-[88vh]
                   sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2
                   sm:w-[480px] sm:rounded-xl sm:max-h-[86vh]"
      >
        <div className="sm:hidden flex justify-center pt-3 shrink-0">
          <div className="w-9 h-1 rounded-full bg-navy/15" />
        </div>
        <div className="flex items-start justify-between px-5 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-navy tracking-tight">{title}</h2>
            {sub && <p className="text-xs text-navy/40 mt-0.5">{sub}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-8 h-8 rounded flex items-center justify-center bg-off-white text-navy/40 hover:text-navy shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 sm:px-6 py-5 overflow-y-auto grow">{children}</div>
        {footer && (
          <div className="px-5 sm:px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2 shrink-0
                          pb-[calc(1rem+env(safe-area-inset-bottom,0px))] sm:pb-4">
            {footer}
          </div>
        )}
      </motion.div>
    </>
  )
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded bg-red-50 text-red-700 text-xs px-3 py-2 mb-4">
      <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
      <span>{text}</span>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// BOOK
// ════════════════════════════════════════════════════════════════════════════
const RELATIONS = ['Couple', 'Family', 'Friends', 'Colleagues', 'Single']

export function BookDialog({ refId, town, onClose, onDone }: {
  refId: string; town?: string | null
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [agents, setAgents] = useState<{ id: number; name: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [f, setF] = useState({
    clients: '', agentId: '', date: '', time: '',
    groupSize: '', ages: '', pets: '', jobs: '', relation: '', notes: '',
  })
  const set = (p: Partial<typeof f>) => setF(s => ({ ...s, ...p }))

  useEffect(() => {
    crmFetch('schedule-board/agents').then(d => setAgents(d.agents || [])).catch(() => {})
  }, [])

  async function submit() {
    setErr(null)
    if (!f.clients.trim()) return setErr('Who is viewing? Add at least one name.')
    if (!f.date) return setErr('Pick a viewing date.')
    setBusy(true)
    try {
      const d = await crmJson(`schedule-board/listings/${encodeURIComponent(refId)}/book`, 'POST', {
        ...f,
        agentId: f.agentId ? Number(f.agentId) : undefined,
        groupSize: f.groupSize ? Number(f.groupSize) : undefined,
      })
      onDone(d.message || `Viewing booked for #${refId}.`)
      onClose()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not book this viewing.')
    } finally { setBusy(false) }
  }

  return (
    <Sheet
      title="Book a viewing"
      sub={`#${refId}${town ? ` · ${town}` : ''}`}
      onClose={onClose}
      footer={<>
        <button className={GHOST} onClick={onClose} disabled={busy}>Cancel</button>
        <button className={PRIMARY} onClick={submit} disabled={busy}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {busy ? 'Booking…' : 'Book viewing'}
        </button>
      </>}
    >
      {err && <ErrorLine text={err} />}

      <div className="space-y-4">
        <div>
          <label className={LABEL}>Clients *</label>
          <input className={FIELD} value={f.clients} autoFocus
            onChange={e => set({ clients: e.target.value })}
            placeholder="e.g. Sarah & Tom Mifsud" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Date *</label>
            <input type="date" className={FIELD} value={f.date} onChange={e => set({ date: e.target.value })} />
          </div>
          <div>
            <label className={LABEL}>Time</label>
            <input type="time" className={FIELD} value={f.time} onChange={e => set({ time: e.target.value })} />
          </div>
        </div>

        <div>
          <label className={LABEL}>Viewing agent</label>
          <select className={cn(FIELD, 'appearance-none')} value={f.agentId}
            onChange={e => set({ agentId: e.target.value })}>
            <option value="">Me</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        <div className="pt-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-navy/30 mb-3">
            The party — what the owner always asks
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>People</label>
              <input type="number" min={1} className={FIELD} value={f.groupSize}
                onChange={e => set({ groupSize: e.target.value })} placeholder="2" />
            </div>
            <div>
              <label className={LABEL}>Ages</label>
              <input className={FIELD} value={f.ages} onChange={e => set({ ages: e.target.value })}
                placeholder="34, 31 — or mid 30s" />
            </div>
          </div>

          <div className="mt-3">
            <label className={LABEL}>Relation</label>
            <div className="flex flex-wrap gap-1.5">
              {RELATIONS.map(r => (
                <button key={r} type="button"
                  onClick={() => set({ relation: f.relation === r ? '' : r })}
                  className={cn('px-2.5 py-1.5 rounded text-[11px] transition-colors',
                    f.relation === r ? 'bg-navy text-white' : 'bg-off-white text-navy/60 hover:bg-navy/10')}>
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className={LABEL}>Pets</label>
              <input className={FIELD} value={f.pets} onChange={e => set({ pets: e.target.value })}
                placeholder="None / 1 small dog" />
            </div>
            <div>
              <label className={LABEL}>Jobs</label>
              <input className={FIELD} value={f.jobs} onChange={e => set({ jobs: e.target.value })}
                placeholder="Both in iGaming" />
            </div>
          </div>

          <div className="mt-3">
            <label className={LABEL}>Notes</label>
            <textarea className={cn(FIELD, 'resize-none')} rows={2} value={f.notes}
              onChange={e => set({ notes: e.target.value })}
              placeholder="Anything else worth knowing" />
          </div>
        </div>
      </div>
    </Sheet>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ASK — write, preview, confirm.
// ════════════════════════════════════════════════════════════════════════════
type Preview = {
  text: string; dropped: string | null; rewritten: boolean
  recipientLabel: string; mode: 'owner' | 'agent'
  willQueue: boolean; windowNote: string | null
  questionsLeft: number
}

const MAX_IMAGES = 3
const MAX_IMAGE_BYTES = 2_000_000

export function AskDialog({ refId, town, contact, onClose, onDone }: {
  refId: string; town?: string | null
  contact: { mode: 'owner' | 'agent'; reachesName: string | null; questionsUsed: number; questionsPerDay: number }
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [edited, setEdited] = useState('')
  const [images, setImages] = useState<{ name: string; mime: string; dataBase64: string; url: string }[]>([])
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const left = contact.questionsPerDay - contact.questionsUsed

  function addFiles(list: FileList | null) {
    if (!list) return
    setErr(null)
    const room = MAX_IMAGES - images.length
    for (const file of Array.from(list).slice(0, room)) {
      if (file.size > MAX_IMAGE_BYTES) { setErr(`${file.name} is over 2 MB.`); continue }
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result || '')
        setImages(prev => prev.length >= MAX_IMAGES ? prev : [...prev, {
          name: file.name, mime: file.type || 'image/jpeg',
          dataBase64: url.split(',')[1] || '', url,
        }])
      }
      reader.readAsDataURL(file)
    }
  }

  async function doPreview() {
    setErr(null)
    if (!note.trim()) return setErr('Write your question first.')
    setBusy('preview')
    try {
      const d = await crmJson(`schedule-board/listings/${encodeURIComponent(refId)}/ask/preview`, 'POST', { note })
      setPreview(d); setEdited(d.text)
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not prepare the message.')
    } finally { setBusy(null) }
  }

  async function doSend() {
    setErr(null)
    if (!edited.trim()) return setErr('The message is empty.')
    setBusy('send')
    try {
      const d = await crmJson(`schedule-board/listings/${encodeURIComponent(refId)}/ask/send`, 'POST', {
        text: edited,
        images: images.map(i => ({ mime: i.mime, dataBase64: i.dataBase64 })),
      })
      onDone(d.message || 'Sent.')
      onClose()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not send.')
    } finally { setBusy(null) }
  }

  const to = contact.mode === 'owner' ? 'the owner' : (contact.reachesName || 'the listing agent')

  return (
    <Sheet
      title={preview ? 'Check before it sends' : 'Ask a question'}
      sub={`#${refId}${town ? ` · ${town}` : ''} · goes to ${preview?.recipientLabel || to}`}
      onClose={onClose}
      footer={preview ? <>
        <button className={GHOST} onClick={() => setPreview(null)} disabled={busy === 'send'}>Back</button>
        <button className={PRIMARY} onClick={doSend} disabled={busy === 'send'}>
          {busy === 'send' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {busy === 'send' ? 'Sending…' : preview.willQueue ? 'Queue for 08:00' : 'Send now'}
        </button>
      </> : <>
        <button className={GHOST} onClick={onClose}>Cancel</button>
        <button className={PRIMARY} onClick={doPreview} disabled={busy === 'preview' || !note.trim()}>
          {busy === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {busy === 'preview' ? 'Writing…' : 'Preview message'}
        </button>
      </>}
    >
      {err && <ErrorLine text={err} />}

      <AnimatePresence mode="wait">
        {!preview ? (
          <motion.div key="compose" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <label className={LABEL}>Your question</label>
            <textarea
              className={cn(FIELD, 'resize-none')} rows={4} value={note} autoFocus
              onChange={e => setNote(e.target.value)}
              placeholder={contact.mode === 'owner'
                ? 'pets ok? and when is it free'
                : 'is this still available? client wants Saturday'}
            />
            <p className="text-[11px] text-navy/40 mt-2 leading-relaxed">
              Write it however you like — it gets rewritten into a polite message and
              you approve the exact wording on the next step.
            </p>

            {/* images */}
            <div className="mt-4">
              <label className={LABEL}>Photos <span className="normal-case tracking-normal text-navy/25">optional, up to {MAX_IMAGES}</span></label>
              <div className="flex flex-wrap gap-2">
                {images.map((img, i) => (
                  <div key={i} className="relative w-16 h-16 rounded overflow-hidden bg-off-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
                    <button type="button" onClick={() => setImages(p => p.filter((_, x) => x !== i))}
                      className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-navy/70 text-white flex items-center justify-center"
                      aria-label="Remove">
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <button type="button" onClick={() => fileRef.current?.click()}
                    className="w-16 h-16 rounded bg-off-white text-navy/30 hover:text-navy/60 flex items-center justify-center transition-colors">
                    <ImagePlus className="w-5 h-5" />
                  </button>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden
                onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
            </div>

            <div className="mt-5 pt-4 border-t border-gray-100 text-[11px] text-navy/40">
              {left} of {contact.questionsPerDay} questions left on this listing today.
            </div>
          </motion.div>
        ) : (
          <motion.div key="preview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <label className={LABEL}>This is what {preview.recipientLabel} receives</label>
            <textarea
              className={cn(FIELD, 'resize-none leading-relaxed')} rows={5}
              value={edited} onChange={e => setEdited(e.target.value)}
            />
            <p className="text-[11px] text-navy/40 mt-2">Edit it if you want — this exact text is what goes out.</p>

            {preview.dropped && (
              <div className="mt-3 flex items-start gap-2 rounded bg-amber-50 text-amber-800 text-xs px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                <span>Left out of the message: {preview.dropped}</span>
              </div>
            )}
            {!preview.rewritten && (
              <div className="mt-3 rounded bg-off-white text-navy/50 text-xs px-3 py-2">
                Sent as you typed it — the rewriter was unavailable.
              </div>
            )}
            {preview.willQueue && preview.windowNote && (
              <div className="mt-3 flex items-start gap-2 rounded bg-navy/5 text-navy/70 text-xs px-3 py-2">
                <Clock className="w-3.5 h-3.5 mt-px shrink-0" />
                <span>{preview.windowNote}</span>
              </div>
            )}
            {images.length > 0 && (
              <div className="mt-4">
                <label className={LABEL}>Attached</label>
                <div className="flex flex-wrap gap-2">
                  {images.map((img, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={img.url} alt={img.name} className="w-14 h-14 rounded object-cover" />
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// CHAT — premium dark-mode window onto the same relay as Ask/Book (Phase 1,
// Kev 2026-08-27). Polls while open; no websocket in this codebase, and a 4s
// poll is imperceptible next to how slowly a landlord actually replies.
//
//   • Persona badge — which of Kev's accounts the agent IS right now
//     (services/bookRelay.js personaLabel()). Critical for Cedric/Jasmine:
//     an agent forgetting they're "a German" or "in Singapore" mid-chat is
//     the one thing this badge exists to prevent.
//   • Milchglas strip — other agents' activity with this SAME owner. Existence
//     + rough time + kind only, rendered as frosted, unreadable ghost bubbles.
//     The point is "2906 already spoke to them today, stay consistent" — not
//     a window into a colleague's conversation.
//   • Event chips — this agent's own !av / Ask / Book actions on this listing,
//     interleaved into the timeline as system markers. Phase 2 turns the Book
//     one into a live owner survey; Phase 1 just shows it happened.
//   • 50h auto-archive is server-side (bookRelay.js closeIfExpired) — this
//     component just reflects `status: 'closed'` when it gets it back.
// ════════════════════════════════════════════════════════════════════════════
type ChatMessage = { id: number; direction: 'agent_to_owner' | 'owner_to_agent'; text: string; at: string }
type ChatEvent = { kind: 'av' | 'ask' | 'book'; at: string }
type ChatState = {
  open: boolean; status?: string; ownerLabel?: string; persona?: string
  messages: ChatMessage[]; events: ChatEvent[]; otherActivity: ChatEvent[]
  expiresHours?: number
}
type TimelineItem =
  | { kind: 'message'; at: string; sortKey: number; message: ChatMessage }
  | { kind: 'event'; at: string; sortKey: number; event: ChatEvent }

const POLL_MS = 4000

const EVENT_COPY: Record<ChatEvent['kind'], { icon: typeof Home; label: string }> = {
  av:   { icon: Home,       label: 'Availability check sent' },
  ask:  { icon: HelpCircle, label: 'You asked a question' },
  book: { icon: Calendar,   label: 'You booked a viewing' },
}

function timeOnly(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Local, not imported from page.tsx — the milchglas strip only ever needs a
// rough stamp ("3h ago"), never the calendar-aware "13 Aug" page.tsx's own
// ago() falls back to for older items.
function agoShort(iso: string): string {
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000)
  if (!Number.isFinite(mins)) return ''
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export function ChatDialog({ refId, town, viewing, onBook, onCreateGroup, onClose }: {
  refId: string; town?: string | null
  // Kev, 2026-08-28: "the Book button could also be in the chat, and +
  // group too" — same data + same handlers the board card's own Book /
  // Create Group buttons use, just reachable from here too. viewing is the
  // Listing's own snapshot (routes/crmScheduleBoard.js GET /listings, Phase 2
  // canCreateGroup/groupJid) — optional because a caller that only wants the
  // conversation (no Book/Group actions available) can omit all three.
  viewing?: { canCreateGroup?: boolean; groupJid?: string | null } | null
  onBook?: () => void
  onCreateGroup?: () => void
  onClose: () => void
}) {
  const { me } = useCrm()
  const isAdmin = me?.role === 'admin'
  const canCreateGroupBtn = canCreateGroup(me)
  const [state, setState] = useState<ChatState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const reduceMotion = useReducedMotion()

  async function load() {
    try {
      const d = await crmFetch(`schedule-board/listings/${encodeURIComponent(refId)}/relay`)
      setState(d)
      setErr(null)
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not load this conversation.')
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId])

  const timelineLength = (state?.messages.length || 0) + (state?.events.length || 0)
  useEffect(() => {
    if (stickToBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [timelineLength])

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setErr(null)
    try {
      await crmJson(`schedule-board/listings/${encodeURIComponent(refId)}/relay/message`, 'POST', { text })
      setDraft('')
      await load()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not send that.')
    } finally { setSending(false) }
  }

  const closed = state?.open === false && state?.messages && state.messages.length > 0

  // Messages + this agent's own events, one chronological timeline. The
  // backend keeps them as two arrays (different tables, no shared shape) —
  // merging is a client-side concern, not a SQL one.
  const timeline: TimelineItem[] = [
    ...(state?.messages || []).map(m => ({ kind: 'message' as const, at: m.at, sortKey: Date.parse(m.at), message: m })),
    ...(state?.events || []).map(e => ({ kind: 'event' as const, at: e.at, sortKey: Date.parse(e.at), event: e })),
  ].sort((a, b) => a.sortKey - b.sortKey)

  const fade = reduceMotion
    ? { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 }, transition: { duration: 0 } }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
  const rise = reduceMotion
    ? { initial: { opacity: 1, y: 0 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 1, y: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, y: 24 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 24 }, transition: { duration: 0.18, ease: 'easeOut' as const } }

  return (
    <>
      <motion.div {...fade} onClick={onClose} className="fixed inset-0 z-[199] bg-black/50 backdrop-blur-[3px]" />
      <motion.div
        {...rise}
        className="fixed z-[200] shadow-2xl flex flex-col overflow-hidden
                   inset-x-0 bottom-0 rounded-t-2xl h-[88vh]
                   sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2
                   sm:w-[440px] sm:h-[680px] sm:rounded-2xl sm:max-h-[88vh]"
        style={{ background: 'linear-gradient(180deg, #0C1120 0%, #10162A 55%, #0C1120 100%)' }}
      >
        {/* ── 2906 signature watermark — dezent, own identity, never a stock chat look ── */}
        <div
          aria-hidden
          className="pointer-events-none select-none absolute -right-8 -top-4 font-serif italic
                     text-[128px] leading-none text-white/[0.035] tracking-tighter"
        >
          2906
        </div>

        <div className="sm:hidden flex justify-center pt-3 shrink-0 relative z-10">
          <div className="w-9 h-1 rounded-full bg-white/15" />
        </div>

        {/* ── header: owner label + persona identity badge ─────────────────────── */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-white/[0.06] shrink-0 relative z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-full bg-gold/15 border border-gold/25 flex items-center justify-center shrink-0">
              <MessageCircle className="w-4 h-4 text-gold" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white tracking-tight truncate">
                {state?.ownerLabel || 'Owner'}
              </h2>
              <p className="text-[11px] text-white/40 truncate">
                #{refId}{town ? ` · ${town}` : ''}{closed ? ' · closed' : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {state?.persona && (
              <span
                title="The account you're texting from — stay in character"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px]
                           font-semibold tracking-wide bg-gold/10 border border-gold/30 text-gold-light whitespace-nowrap"
              >
                @{state.persona}
              </span>
            )}
            <button onClick={onClose} aria-label="Close"
              className="w-8 h-8 rounded-full flex items-center justify-center bg-white/5 text-white/50 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── quick actions: Book / Create Group, same as the board card ───────
            Kev, 2026-08-28: reachable straight from the chat you're already
            in, instead of having to close it and find the card. Same
            handlers, same gate — Create Group only lights up once
            viewing.canCreateGroup is true (owner said yes, no group yet) AND
            the signed-in agent is an admin, exactly like the card. */}
        {(onBook || onCreateGroup) && (
          <div className="flex items-center gap-2 px-4 sm:px-5 py-2.5 border-b border-white/[0.06] shrink-0 relative z-10">
            {onBook && (
              <button onClick={onBook} title="Book a viewing"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium
                           bg-white/5 text-white/70 hover:text-white hover:bg-white/10 transition-colors">
                <Calendar className="w-3 h-3" /> Book
              </button>
            )}
            {onCreateGroup && (() => {
              const ready = canCreateGroupBtn && !!viewing?.canCreateGroup
              const already = !!viewing?.groupJid
              const title = already
                ? 'Group already created for this booking.'
                : ready
                ? 'Owner confirmed — create the WhatsApp group with the agent and owner.'
                : 'Needs a confirmed booking first — the owner has to say yes.'
              return (
                <button onClick={ready ? onCreateGroup : undefined} disabled={!ready || already} title={title}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium transition-colors',
                    ready && !already
                      ? 'bg-white/5 text-white/70 hover:text-white hover:bg-white/10'
                      : 'bg-transparent text-white/25 border border-dashed border-white/15 cursor-not-allowed',
                  )}>
                  <Users className="w-3 h-3" /> {already ? 'Group created' : 'Create Group'}
                </button>
              )
            })()}
          </div>
        )}

        {/* ── milchglas: other agents' activity with this same owner ───────────── */}
        {!!state?.otherActivity.length && (
          <div className="px-4 sm:px-5 pt-3 pb-1 shrink-0 relative z-10">
            <div className="flex items-center gap-1.5 mb-2 text-[9px] uppercase tracking-[0.14em] text-white/30 font-semibold">
              <EyeOff className="w-3 h-3" /> Also in touch with this owner
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {state.otherActivity.slice(0, 8).map((a, i) => {
                const Icon = EVENT_COPY[a.kind]?.icon || MessageCircle
                return (
                  <div key={i} className="relative shrink-0 w-[92px] h-[46px] rounded-xl overflow-hidden border border-white/10">
                    {/* frosted "ghost bubble" — no content exists to show; the blur IS the message. */}
                    <div className="absolute inset-0 backdrop-blur-md bg-white/[0.06]" />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-white/50">
                      <Icon className="w-3.5 h-3.5" />
                      <span className="text-[8px] tracking-wide">{agoShort(a.at)}</span>
                    </div>
                    <div className="absolute inset-x-2 bottom-1.5 h-1 rounded-full bg-white/20 blur-[2px]" />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── timeline: messages + this agent's own av/ask/book events ─────────── */}
        <div
          ref={scrollRef}
          onScroll={e => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          className="grow overflow-y-auto px-3.5 py-3 space-y-2 relative z-10"
        >
          {err && <ErrorLine text={err} />}

          {!state && !err && (
            <div className="flex items-center justify-center h-full text-white/25 text-xs">Loading…</div>
          )}

          {state && timeline.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <MessageCircle className="w-8 h-8 text-white/10 mb-2" />
              <p className="text-xs text-white/35 leading-relaxed">
                No conversation yet — just type below to start one, or use{' '}
                <span className="font-semibold text-white/55">Ask</span> / <span className="font-semibold text-white/55">Book</span>{' '}
                if you'd rather compose something first. Either way it goes straight to the owner.
              </p>
            </div>
          )}

          {timeline.map(item => {
            if (item.kind === 'event') {
              const copy = EVENT_COPY[item.event.kind]
              const Icon = copy?.icon || MessageCircle
              return (
                <div key={`ev-${item.at}-${item.event.kind}`} className="flex justify-center py-1">
                  <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-white/45 text-[10.5px]">
                    <Icon className="w-3 h-3" />
                    <span>{copy?.label || item.event.kind}</span>
                    <span className="text-white/25">· {timeOnly(item.at)}</span>
                  </div>
                </div>
              )
            }
            const m = item.message
            const mine = m.direction === 'agent_to_owner'
            return (
              <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[78%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-snug whitespace-pre-wrap break-words',
                  mine
                    ? 'bg-gradient-to-br from-gold/25 to-gold/10 border border-gold/25 text-white rounded-br-sm'
                    : 'bg-white/[0.06] border border-white/[0.08] text-white/90 rounded-bl-sm',
                )}>
                  {m.text}
                  <div className={cn('text-[9px] mt-1 text-right', mine ? 'text-gold-light/50' : 'text-white/25')}>
                    {timeOnly(m.at)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* ── composer ───────────────────────────────────────────────────────── */}
        <div className="px-3.5 py-3.5 border-t border-white/[0.06] shrink-0 flex items-end gap-2 relative z-10
                        pb-[calc(0.875rem+env(safe-area-inset-bottom,0px))]">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            rows={1}
            disabled={closed}
            placeholder={closed ? 'This conversation has closed' : 'Type a message — sent to the owner as-is…'}
            className="flex-1 resize-none px-3.5 py-2.5 bg-white/[0.05] border border-white/[0.08] rounded-full text-sm text-white
                       placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-gold/50 focus:border-gold/40
                       disabled:opacity-40 max-h-24"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || sending || closed}
            className="w-10 h-10 rounded-full bg-gold text-navy flex items-center justify-center shrink-0
                       disabled:opacity-25 disabled:cursor-not-allowed hover:bg-gold-light transition-colors"
            aria-label="Send"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </motion.div>
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// STATUS — the three actions that take a card OFF the active board.
//
// All three ask for a reason, and check-out requires one: the backend refuses a
// blank. That is deliberate. A listing that vanished from the board with no
// explanation is the thing nobody can account for three weeks later, and the
// reason is what the review queue and the audit trail have to show.
//
// Presets exist because a free-text box gets "gone", "n/a" and "asked" typed
// into it, which is data nobody can group by later. A chip is one tap and it
// still lands in status_change_reason as readable text.
//
// Nothing here deletes anything. The listing stays in Inventory with its whole
// history — it just stops being offered on the board.
// ════════════════════════════════════════════════════════════════════════════
export type StatusAction = 'check-out' | 'recheck' | 'archive'

const ACTION_COPY: Record<StatusAction, {
  title: string; sub: string; verb: string; presets: string[]; destructive: boolean
}> = {
  'check-out': {
    title: 'Off market',
    sub: 'Takes the card off the active board. Nothing is deleted.',
    verb: 'Mark off market',
    presets: ['Rented out', 'Owner withdrew it', 'Owner not reachable', 'Price changed', 'Not available yet'],
    destructive: true,
  },
  recheck: {
    title: 'Needs a recheck',
    sub: 'Parks it in the review queue until somebody confirms either way.',
    verb: 'Send to review queue',
    presets: ['Owner reply unclear', 'No answer yet', 'Conflicting information', 'Photos look wrong'],
    destructive: false,
  },
  archive: {
    title: 'Archive listing',
    sub: 'Off the board and out of the review queue. Still in Inventory.',
    verb: 'Archive',
    presets: ['Duplicate listing', 'Owner withdrew for good', 'Bad or incomplete data', 'Off market'],
    destructive: true,
  },
}

export function StatusDialog({ refId, town, action, onClose, onDone }: {
  refId: string
  town?: string | null
  action: StatusAction
  onClose: () => void
  /** Called only after the server confirms. The board removes the card on
      click, so this reports the outcome rather than driving it. */
  onDone: (msg: string, ref: string) => void
}) {
  const copy = ACTION_COPY[action]
  const [preset, setPreset] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Kev, 2026-09-04 (explicit request): "duplicate listing, delete just
  // this one" — the one genuinely destructive action on this board, so it
  // gets its own two-step confirm rather than sharing the reason/preset
  // flow above (which this file's own header deliberately keeps soft-only).
  const { me } = useCrm()
  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  async function deleteDuplicate() {
    setErr(null)
    setDeleteBusy(true)
    try {
      const d = await crmFetch(`schedule-board/listings/${encodeURIComponent(refId)}/duplicate`, { method: 'DELETE' })
      onDone(d.message || `#${refId} permanently deleted.`, refId)
      onClose()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not delete this listing.')
      setDeleteBusy(false)
      setDeleteConfirming(false)
    }
  }

  // A preset plus an optional detail, joined — "Rented out — owner said the
  // tenant moved in on Monday" is worth more than either half alone.
  const reason = [preset, note.trim()].filter(Boolean).join(' — ')
  const needsReason = action === 'check-out'
  const canSend = !busy && (!needsReason || reason.length > 0)

  async function submit() {
    if (!canSend) return
    setErr(null)
    setBusy(true)
    try {
      const d = await crmJson(
        `schedule-board/listings/${encodeURIComponent(refId)}/${action}`, 'POST',
        { reason: reason || undefined })
      onDone(d.message || `#${refId} updated.`, refId)
      onClose()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not update this listing.')
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={copy.title}
      sub={`#${refId}${town ? ` · ${town}` : ''} — ${copy.sub}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={GHOST}>Cancel</button>
          <button
            onClick={submit}
            disabled={!canSend}
            className={cn(PRIMARY, copy.destructive && 'bg-red-700 hover:bg-red-800')}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {copy.verb}
          </button>
        </>
      }
    >
      {err && <ErrorLine text={err} />}

      <label className={LABEL}>
        Reason{needsReason && <span className="text-red-600 normal-case tracking-normal"> · required</span>}
      </label>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {copy.presets.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => setPreset(preset === p ? null : p)}
            className={cn('px-2.5 py-1.5 rounded text-[11px] transition-colors',
              preset === p ? 'bg-navy text-white' : 'bg-off-white text-navy/60 hover:bg-navy/10')}
          >
            {p}
          </button>
        ))}
      </div>

      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        rows={3}
        maxLength={400}
        placeholder={preset ? 'Anything to add? (optional)' : 'Or write your own reason…'}
        className={cn(FIELD, 'resize-none')}
      />

      {reason && (
        <div className="mt-3 rounded bg-off-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-navy/40 mb-1">Recorded as</div>
          <div className="text-xs text-navy/80 break-words">{reason}</div>
        </div>
      )}

      {needsReason && !reason && (
        <p className="mt-3 text-[11px] text-navy/40 leading-relaxed">
          Pick a reason or write one. It is stored with the listing so the next
          person can see why it left the board.
        </p>
      )}

      {/* Kev, 2026-09-04: duplicate listing — permanently deletes just THIS
          card, unlike every button above. Admin-only, separate confirm. */}
      {action === 'check-out' && me?.role === 'admin' && (
        <div className="mt-4 pt-4 border-t border-red-100">
          {!deleteConfirming ? (
            <button
              type="button"
              onClick={() => setDeleteConfirming(true)}
              className="text-[11px] text-red-500/70 hover:text-red-700 underline decoration-dotted"
            >
              Duplicate listing? Delete this one permanently
            </button>
          ) : (
            <div className="rounded bg-red-50 px-3 py-2.5">
              <p className="text-[11px] text-red-700 leading-relaxed">
                This permanently deletes #{refId} — not archived, gone. Only do this for a genuine duplicate posting.
              </p>
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={() => setDeleteConfirming(false)} className={GHOST} disabled={deleteBusy}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={deleteDuplicate}
                  disabled={deleteBusy}
                  className="px-4 py-2.5 rounded bg-red-700 hover:bg-red-800 text-white text-sm font-semibold transition-colors disabled:opacity-40 inline-flex items-center gap-2"
                >
                  {deleteBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Yes, permanently delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// AV DATE CONFIRM — the board's small calendar icon next to the € price
// (Kev, 2026-08-31). Available-date / viewable-date drift sometimes (bot
// misreads, !upload inaccuracies) and this is the fast manual fix: edit
// both dates, save, and the listing reposts to its category group with a
// short "still on market" confirmation underneath — the same distribution
// !price already triggers on a price change, just retriggered by a date
// correction instead. Admin only (no board/agent access), same bar as the
// € price edit.
// ════════════════════════════════════════════════════════════════════════════
export function AvDateDialog({ refId, propertyId, town, currentAvailable, currentViewing, onClose, onDone }: {
  refId: string
  propertyId: number
  town?: string | null
  currentAvailable?: string | null
  currentViewing?: string | null
  onClose: () => void
  onDone: (msg: string, ref: string) => void
}) {
  const toInputDate = (v?: string | null) => (v ? String(v).slice(0, 10) : '')
  const [availableDate, setAvailableDate] = useState(toInputDate(currentAvailable))
  const [viewingDate, setViewingDate] = useState(toInputDate(currentViewing))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const changed = availableDate !== toInputDate(currentAvailable) || viewingDate !== toInputDate(currentViewing)
  const canSend = !busy && changed

  async function submit() {
    if (!canSend) return
    setErr(null)
    setBusy(true)
    try {
      // 1. Save both dates — same field the full property editor and the €
      // price-edit button already write (routes/crm.js PATCH
      // /properties/:id, EDITABLE includes available_date/viewing_date).
      // No new save path.
      await crmFetch(`properties/${propertyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          available_date: availableDate || null,
          viewing_date: viewingDate || null,
        }),
      })
      // 2. Repost + "still on market" confirmation into the property's
      // category group — same distribution pipeline !upload/!price use
      // (routes/crmScheduleBoard.js POST .../av-date-confirm).
      const d = await crmJson(
        `schedule-board/listings/${encodeURIComponent(refId)}/av-date-confirm`, 'POST', {})
      onDone(d?.message || `#${refId} dates updated — reposting to its group now.`, refId)
      onClose()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not update the dates.')
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="Update availability"
      sub={`#${refId}${town ? ` · ${town}` : ''} — confirms + reposts to its group`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={GHOST}>Cancel</button>
          <button onClick={submit} disabled={!canSend} className={PRIMARY}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save &amp; repost
          </button>
        </>
      }
    >
      {err && <ErrorLine text={err} />}

      <label className={LABEL}>Available from</label>
      <input
        type="date"
        value={availableDate}
        onChange={e => setAvailableDate(e.target.value)}
        className={cn(FIELD, 'mb-4')}
      />

      <label className={LABEL}>Viewings from</label>
      <input
        type="date"
        value={viewingDate}
        onChange={e => setViewingDate(e.target.value)}
        className={FIELD}
      />

      <p className="mt-3 text-[11px] text-navy/40 leading-relaxed">
        Saving reposts this listing to its category group with the updated
        date and a short &quot;still on market&quot; note underneath.
      </p>
    </Sheet>
  )
}
