'use client'
// ============================================================================
// board-dialogs.tsx — the two things an agent can start from a board card.
//
//   BookDialog  → books a viewing and records who is coming. Sends nothing.
//   AskDialog   → writes a question, Gemini rewrites it, the agent reads the
//                 exact outgoing text and confirms. Only then does it send.
//
// Same visual language as components/property-filters.tsx (bg-off-white
// inputs, gold focus ring, navy chips) so these do not read as a second
// design system living inside the first.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Clock, ImagePlus, Loader2, Sparkles, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { cn } from '@/lib/utils'

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
