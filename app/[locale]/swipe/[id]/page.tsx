'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { motion, AnimatePresence, useMotionValue, useTransform } from 'framer-motion'
import { Heart, ChevronUp, ChevronDown, BedDouble, Bath, Ruler, MapPin, X, Check } from 'lucide-react'

const API_BASE = ''

interface SwipeProperty {
  ref: string
  town: string | null
  subLocation: string | null
  propertyType: string | null
  bedrooms: number | null
  bathrooms: number | null
  sizeSqm: number | null
  forSale: boolean
  price: number | null
  shortlet: boolean
  availableNow: boolean
  images: string[]
  description: string
}

function visitorKey(id: string) { return `swipe_visitor_${id}` }

function getVisitorId(id: string) {
  if (typeof window === 'undefined') return ''
  try {
    const existing = localStorage.getItem(visitorKey(id))
    if (existing) return existing
    const fresh = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '')
    localStorage.setItem(visitorKey(id), fresh)
    return fresh
  } catch {
    // Private browsing / storage blocked: a per-session id still lets the
    // deck and likes work, it just won't be remembered on a reload.
    return `tmp${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  }
}

function fmtPrice(p: SwipeProperty) {
  if (p.price == null) return 'Price on request'
  const n = `€${Number(p.price).toLocaleString()}`
  return p.forSale ? n : `${n}/mo`
}

function fmtSpecs(p: SwipeProperty) {
  const parts: string[] = []
  if (p.bedrooms != null) parts.push(p.bedrooms === 0 ? 'Studio' : `${p.bedrooms} bed`)
  if (p.bathrooms != null) parts.push(`${p.bathrooms} bath`)
  if (p.sizeSqm != null) parts.push(`${p.sizeSqm} m²`)
  return parts
}

// ── one card ──────────────────────────────────────────────────────────────
function Card({
  p, active, liked, onLike, dragProps,
}: {
  p: SwipeProperty
  active: boolean
  liked: boolean
  onLike: () => void
  dragProps?: { y: any; onDragEnd: (e: any, info: any) => void }
}) {
  const opacity = dragProps ? useTransform(dragProps.y, [-220, 0, 220], [0.4, 1, 0.4]) : undefined
  const rotate = dragProps ? useTransform(dragProps.y, [-220, 220], [-3, 3]) : undefined

  return (
    <motion.div
      className="absolute inset-0 select-none"
      style={active && dragProps ? { y: dragProps.y, opacity, rotate } : undefined}
      drag={active && dragProps ? 'y' : false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={0.6}
      onDragEnd={active && dragProps ? dragProps.onDragEnd : undefined}
    >
      <div className="relative w-full h-full overflow-hidden rounded-3xl bg-navy">
        {p.images[0] ? (
          <img src={p.images[0]} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-navy to-[#0B1120]" />
        )}
        {/* legibility scrim */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0B1120] via-[#0B1120]/10 to-transparent" style={{ height: '65%', top: '35%' }} />
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/40 to-transparent" />

        {p.availableNow && (
          <div className="absolute top-4 left-4 flex items-center gap-1.5 rounded-full bg-[#0B1120]/60 backdrop-blur-sm px-3 py-1.5 text-[11px] font-medium tracking-wide text-white/90">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Available now
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 p-6 pb-8 pr-20">
          <div className="flex items-center gap-1.5 text-white/70 text-[13px] font-medium mb-2">
            <MapPin className="w-3.5 h-3.5" />
            <span>{[p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'}</span>
          </div>
          <div
            className="text-white leading-none mb-2"
            style={{ fontFamily: 'var(--font-playfair), Georgia, serif', fontSize: 'clamp(30px, 8vw, 40px)', fontWeight: 600 }}
          >
            {fmtPrice(p)}
          </div>
          <div className="flex items-center gap-3 text-white/80 text-[13px] mb-3">
            {fmtSpecs(p).map((s, i) => (
              <span key={i} className="flex items-center gap-1">
                {i === 0 && p.bedrooms != null && <BedDouble className="w-3.5 h-3.5" />}
                {i === 1 && p.bathrooms != null && <Bath className="w-3.5 h-3.5" />}
                {i === 2 && p.sizeSqm != null && <Ruler className="w-3.5 h-3.5" />}
                {s}
              </span>
            ))}
          </div>
          {p.description && (
            <p className="text-white/70 text-[13px] leading-relaxed line-clamp-2 max-w-md">{p.description}</p>
          )}
        </div>

        {/* like — thumb reach, bottom right */}
        <div className="absolute right-4 bottom-24 flex flex-col items-center gap-1.5">
          <LikeButton liked={liked} onLike={onLike} />
        </div>
      </div>
    </motion.div>
  )
}

// ── like button with the gold "unlock" pop ───────────────────────────────
function LikeButton({ liked, onLike }: { liked: boolean; onLike: () => void }) {
  const [burst, setBurst] = useState(0)
  return (
    <button
      type="button"
      onClick={() => { if (!liked) { onLike(); setBurst(b => b + 1) } }}
      aria-pressed={liked}
      aria-label={liked ? 'Liked' : 'Like this apartment'}
      className="relative w-14 h-14 rounded-full flex items-center justify-center"
      style={{ background: liked ? 'rgba(184,149,63,0.16)' : 'rgba(11,17,32,0.55)', backdropFilter: 'blur(6px)' }}
    >
      <AnimatePresence>
        {burst > 0 && (
          <motion.span
            key={burst}
            initial={{ scale: 0.6, opacity: 0.9 }}
            animate={{ scale: 2.2, opacity: 0 }}
            transition={{ duration: 0.55, ease: 'easeOut' }}
            className="absolute inset-0 rounded-full border-2"
            style={{ borderColor: '#D4B15A' }}
          />
        )}
      </AnimatePresence>
      <motion.span
        animate={liked ? { scale: [1, 1.35, 1] } : { scale: 1 }}
        transition={liked ? { type: 'tween', duration: 0.38, times: [0, 0.5, 1], ease: 'easeOut' } : { duration: 0.15 }}
      >
        <Heart
          className="w-6 h-6"
          style={{ color: liked ? '#B8953F' : '#F6F4EF' }}
          fill={liked ? '#B8953F' : 'none'}
          strokeWidth={liked ? 0 : 1.75}
        />
      </motion.span>
    </button>
  )
}

// ── recap + optional contact, shown after the last card ──────────────────
function EndScreen({
  likedList, onSendContact, sending, sent,
}: {
  likedList: SwipeProperty[]
  onSendContact: (name: string, phone: string) => void
  sending: boolean
  sent: boolean
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  return (
    <div className="w-full h-full flex flex-col items-center justify-center px-7 text-center">
      <div className="w-11 h-11 rounded-full flex items-center justify-center mb-5" style={{ background: 'rgba(184,149,63,0.14)' }}>
        <Check className="w-5 h-5" style={{ color: '#B8953F' }} />
      </div>
      <h1 className="text-white text-2xl mb-2" style={{ fontFamily: 'var(--font-playfair), Georgia, serif' }}>
        That's everything for you
      </h1>
      <p className="text-white/55 text-[13px] mb-7 max-w-xs">
        {likedList.length > 0
          ? `You liked ${likedList.length} place${likedList.length === 1 ? '' : 's'} — we're checking availability and will follow up if it's still on.`
          : 'You made it through the whole set. Swipe back up any time to look again.'}
      </p>

      {likedList.length > 0 && (
        <div className="flex gap-2 mb-8 overflow-x-auto max-w-full pb-1 px-1">
          {likedList.map(p => (
            <div key={p.ref} className="relative w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 border border-white/10">
              {p.images[0]
                ? <img src={p.images[0]} alt="" className="w-full h-full object-cover" />
                : <div className="w-full h-full bg-navy" />}
            </div>
          ))}
        </div>
      )}

      {!sent ? (
        <div className="w-full max-w-xs">
          <p className="text-white/40 text-[11px] uppercase tracking-wider mb-3">Want us to reach out first? (optional)</p>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Your name"
            className="w-full mb-2 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 outline-none focus:border-[#B8953F]/60"
          />
          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="Phone number"
            inputMode="tel"
            className="w-full mb-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 outline-none focus:border-[#B8953F]/60"
          />
          <button
            type="button"
            disabled={sending || (!name.trim() && !phone.trim())}
            onClick={() => onSendContact(name.trim(), phone.trim())}
            className="w-full py-3 rounded-xl text-sm font-medium text-[#0B1120] disabled:opacity-30 transition-opacity"
            style={{ background: '#B8953F' }}
          >
            {sending ? 'Sending…' : 'Leave my details'}
          </button>
        </div>
      ) : (
        <p className="text-[13px]" style={{ color: '#D4B15A' }}>Thanks — we'll be in touch.</p>
      )}
    </div>
  )
}

export default function SwipePage() {
  const params = useParams()
  const id = String(params.id || '')
  const [properties, setProperties] = useState<SwipeProperty[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [index, setIndex] = useState(0)
  const [liked, setLiked] = useState<Set<string>>(new Set())
  const [contactSending, setContactSending] = useState(false)
  const [contactSent, setContactSent] = useState(false)
  const visitorId = useRef<string>('')
  const y = useMotionValue(0)

  useEffect(() => {
    if (!id) return
    visitorId.current = getVisitorId(id)
    fetch(`${API_BASE}/api/swipe/${encodeURIComponent(id)}`)
      .then(r => { if (!r.ok) throw new Error('not found'); return r.json() })
      .then(d => setProperties(Array.isArray(d.properties) ? d.properties : []))
      .catch(() => setNotFound(true))
  }, [id])

  const likedList = useMemo(
    () => (properties || []).filter(p => liked.has(p.ref)),
    [properties, liked],
  )

  const advance = useCallback((dir: 1 | -1) => {
    setIndex(i => {
      const max = (properties?.length || 0) // one past the last card = end screen
      const next = i + dir
      return Math.max(0, Math.min(max, next))
    })
  }, [properties])

  const onDragEnd = useCallback((_: any, info: { offset: { y: number }; velocity: { y: number } }) => {
    const THRESH = 90
    if (info.offset.y < -THRESH || info.velocity.y < -500) advance(1)
    else if (info.offset.y > THRESH || info.velocity.y > 500) advance(-1)
    y.set(0)
  }, [advance, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') advance(1)
      if (e.key === 'ArrowDown') advance(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance])

  const like = useCallback((ref: string) => {
    setLiked(prev => {
      if (prev.has(ref)) return prev
      const next = new Set(prev); next.add(ref); return next
    })
    fetch(`${API_BASE}/api/swipe/${encodeURIComponent(id)}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, visitorId: visitorId.current }),
    }).catch(() => {})
  }, [id])

  const sendContact = useCallback((name: string, phone: string) => {
    setContactSending(true)
    fetch(`${API_BASE}/api/swipe/${encodeURIComponent(id)}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId.current, name: name || undefined, phone: phone || undefined }),
    })
      .then(() => setContactSent(true))
      .finally(() => setContactSending(false))
  }, [id])

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0B1120' }}>
        <div className="text-center max-w-xs">
          <div className="w-11 h-11 rounded-full flex items-center justify-center mb-5 mx-auto" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <X className="w-5 h-5 text-white/50" />
          </div>
          <h1 className="text-white text-lg mb-2" style={{ fontFamily: 'var(--font-playfair), Georgia, serif' }}>This link isn't active</h1>
          <p className="text-white/50 text-[13px]">Ask your agent for a new one.</p>
        </div>
      </div>
    )
  }

  if (!properties) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#0B1120' }}>
        <div className="w-8 h-8 rounded-full border-2 border-white/15 animate-spin" style={{ borderTopColor: '#B8953F' }} />
      </div>
    )
  }

  const total = properties.length
  const atEnd = index >= total

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: '#0B1120' }}>
      {/* progress */}
      {total > 0 && (
        <div className="absolute top-3 left-3 right-3 z-20 flex gap-1">
          {properties.map((_, i) => (
            <div key={i} className="h-[3px] flex-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.18)' }}>
              <div
                className="h-full rounded-full transition-transform duration-300 ease-out"
                style={{ background: '#B8953F', transform: `scaleX(${i < index ? 1 : i === index ? (atEnd ? 1 : 0.15) : 0})`, transformOrigin: 'left' }}
              />
            </div>
          ))}
        </div>
      )}

      <div className="relative w-full h-full p-3 pt-8">
        {atEnd ? (
          <EndScreen likedList={likedList} onSendContact={sendContact} sending={contactSending} sent={contactSent} />
        ) : (
          <>
            {/* peek of next card for stack depth */}
            {properties[index + 1] && (
              <div className="absolute inset-3 pt-8 pointer-events-none" style={{ transform: 'scale(0.96) translateY(10px)', opacity: 0.5 }}>
                <div className="relative w-full h-full rounded-3xl overflow-hidden bg-navy">
                  {properties[index + 1].images[0] && (
                    <img src={properties[index + 1].images[0]} alt="" className="w-full h-full object-cover" />
                  )}
                </div>
              </div>
            )}
            <AnimatePresence initial={false}>
              <Card
                key={properties[index].ref}
                p={properties[index]}
                active
                liked={liked.has(properties[index].ref)}
                onLike={() => like(properties[index].ref)}
                dragProps={{ y, onDragEnd }}
              />
            </AnimatePresence>

            {/* desktop / accessible nav */}
            <div className="hidden md:flex flex-col gap-2 absolute right-4 top-1/2 -translate-y-1/2 z-10">
              <button
                type="button"
                onClick={() => advance(-1)}
                disabled={index === 0}
                className="w-9 h-9 rounded-full flex items-center justify-center bg-white/5 disabled:opacity-20 hover:bg-white/10 transition-colors"
              >
                <ChevronUp className="w-4 h-4 text-white/70" />
              </button>
              <button
                type="button"
                onClick={() => advance(1)}
                className="w-9 h-9 rounded-full flex items-center justify-center bg-white/5 hover:bg-white/10 transition-colors"
              >
                <ChevronDown className="w-4 h-4 text-white/70" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
