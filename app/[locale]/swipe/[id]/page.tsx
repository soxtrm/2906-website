'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { motion, AnimatePresence, useMotionValue, useTransform } from 'framer-motion'
import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react'

const API_BASE = ''
const GOLD = '#B8953F'
const BG = '#0B1120'

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
  fullDescription: string
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
    return `tmp${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  }
}

function fmtSpecs(p: SwipeProperty) {
  const parts: string[] = []
  if (p.bedrooms != null) parts.push(p.bedrooms === 0 ? 'Studio' : `${p.bedrooms} bed`)
  if (p.bathrooms != null) parts.push(`${p.bathrooms} bath`)
  if (p.sizeSqm != null) parts.push(`${p.sizeSqm} m²`)
  return parts
}

// ── single-property share page (Kev's Prompt A follow-up, 2026-08-30) ───────
// The visual destination for a property-kind link (Board "Copy" button) —
// editorial/boutique layout, deliberately NOT the dark Tinder-style deck
// above: one property, one photo strip to browse, no like/favourite (that
// mechanic is a multi-property/client-link concept — this page never
// contacts anyone, has nothing to "pick" out of, so it isn't offered here).
// Firewall is inherited for free: `p` is already a SwipeProperty, the same
// shape SWIPE_PROPERTY_COLS/shapeSwipeCard produce for the deck above —
// never owner data, never the exact street address.
const OFFWHITE = '#FAFAF8'
const INK = '#3A3935'
const MUTED = '#9C9A93'
const HAIRLINE = '#E7E5DF'
const PHOTO_BG = '#EDEBE5'

function fmtSinglePrice(p: SwipeProperty) {
  if (p.price == null) return 'Price on request'
  const n = `€${Number(p.price).toLocaleString()}`
  return p.forSale ? n : `${n} /monthly`
}

// The fanned card-stack of UPCOMING photos to the right of the main image —
// real crops (object-cover on a narrowing window), not placeholders. Kev's
// reference: many overlapping slivers, each one narrower AND progressively
// desaturated/bleached (grayscale + brightened, not just faded via opacity)
// until it's nearly indistinguishable from the page background. Count
// adapts to how many photos are actually left (fewer photos = shorter fan).
const FAN_MAX = 8
// Kev's responsive pass (2026-08-30): mobile only wants 2-3 layers peeking —
// rather than branch the whole component on viewport width (and risk a
// hydration mismatch from a JS media-query check), every card past this
// index is simply hidden below the `lg`/`mobile-landscape` breakpoints via
// CSS, so the same fan markup serves both layouts.
const MOBILE_FAN_VISIBLE = 3
function PhotoFan({ photos, index, onSelect, dragX }: { photos: string[]; index: number; onSelect: (i: number) => void; dragX?: any }) {
  const fallbackX = useMotionValue(0)
  const activeX = dragX ?? fallbackX
  // the nearest (soonest-up) card visibly grows as you drag toward it, so it
  // reads as "about to become the active image" rather than a static prop.
  const nearestScale = useTransform(activeX, [-160, 0], [1.08, 1])
  const upcoming = photos.slice(index + 1, index + 1 + FAN_MAX)
  const fanBoxClass = 'flex-1 h-full lg:h-[min(84vh,893px)] mobile-landscape:h-[min(76vh,420px)]'
  if (!upcoming.length) return <div className={fanBoxClass} style={{ background: OFFWHITE }} />
  const n = upcoming.length
  return (
    <div className={`relative overflow-hidden ${fanBoxClass}`}>
      {upcoming.map((src, i) => {
        const t = i / Math.max(n - 1, 1) // 0 (nearest) .. 1 (furthest)
        // Kev, 2026-08-30 (round 3): cards further back must shrink too, not
        // just narrow — vertical inset grows with distance so each card
        // visibly gets smaller as it recedes, on top of the width taper.
        const widthPct = 26 - i * 2
        const leftPct = i * (74 / Math.max(n - 1, 1))
        const insetPct = t * 16 // 0% at front, up to 16% top+bottom by the last card
        // Kev, 2026-08-30 (round 4): "schwarzweiß... alle Bilder die nach dem
        // ersten kommen" — EVERY fan card is fully black & white, no
        // exceptions, starting with the very first one. Only brightness
        // ramps with distance, carrying the "fades toward white" depth cue.
        const grayscale = 1
        const brightness = 1.05 + t * 1.3
        const opacity = 1 - t * 0.3
        return (
          <motion.button
            key={index + 1 + i}
            type="button"
            onClick={() => onSelect(index + 1 + i)}
            aria-label={`Photo ${index + 2 + i}`}
            className={`absolute ${i >= MOBILE_FAN_VISIBLE ? 'hidden lg:block mobile-landscape:block' : ''}`}
            style={{
              left: `${leftPct}%`, width: `${widthPct}%`, top: `${insetPct}%`, bottom: `${insetPct}%`, opacity, zIndex: n - i,
              scale: i === 0 ? nearestScale : 1,
            }}
          >
            <img
              src={src} alt="" className="w-full h-full object-cover" draggable={false}
              style={{ filter: `grayscale(${grayscale}) brightness(${brightness})` }}
            />
          </motion.button>
        )
      })}
      {/* fade the far edge of the fan into the page background rather than a hard clip */}
      <div className="absolute inset-y-0 right-0 w-1/3 pointer-events-none" style={{ background: `linear-gradient(to right, transparent, ${OFFWHITE})` }} />
    </div>
  )
}

// ── fullscreen lightbox — shared by the single-property page and (via the
// same component) works identically on desktop and mobile. Tap opens it from
// the main photo; here, drag/swipe moves between photos, arrows do the same
// on desktop, Escape or the backdrop closes it. Always object-contain — this
// is the one place a photo is never cropped. ─────────────────────────────
function Lightbox({ photos, index, onClose, onIndexChange }: {
  photos: string[] | null
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
}) {
  const total = photos?.length || 0
  const x = useMotionValue(0)

  const advance = useCallback((dir: 1 | -1) => {
    onIndexChange(Math.max(0, Math.min(Math.max(total - 1, 0), index + dir)))
  }, [index, total, onIndexChange])

  useEffect(() => {
    if (!photos) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') advance(1)
      else if (e.key === 'ArrowLeft') advance(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photos, advance, onClose])

  const onDragEnd = useCallback((_: any, info: { offset: { x: number }; velocity: { x: number } }) => {
    const THRESH = 60
    if (info.offset.x < -THRESH || info.velocity.x < -400) { advance(1); x.set(0) }
    else if (info.offset.x > THRESH || info.velocity.x > 400) { advance(-1); x.set(0) }
    // small/aborted drags: let dragConstraints spring the image back on its own
  }, [advance, x])

  return (
    <AnimatePresence>
      {photos && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/92"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <button
            type="button" onClick={(e) => { e.stopPropagation(); onClose() }} aria-label="Close"
            className="absolute top-4 right-4 sm:top-6 sm:right-6 w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors z-10"
          >
            <X className="w-5 h-5 text-white" />
          </button>

          {total > 1 && (
            <>
              <button
                type="button" onClick={(e) => { e.stopPropagation(); advance(-1) }} disabled={index === 0} aria-label="Previous photo"
                className="hidden sm:flex absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full items-center justify-center bg-white/10 hover:bg-white/20 disabled:opacity-25 transition-colors z-10"
              >
                <ChevronLeft className="w-5 h-5 text-white" />
              </button>
              <button
                type="button" onClick={(e) => { e.stopPropagation(); advance(1) }} disabled={index === total - 1} aria-label="Next photo"
                className="hidden sm:flex absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full items-center justify-center bg-white/10 hover:bg-white/20 disabled:opacity-25 transition-colors z-10"
              >
                <ChevronRight className="w-5 h-5 text-white" />
              </button>
            </>
          )}

          <AnimatePresence mode="wait">
            <motion.div
              key={index}
              className="relative w-full h-full flex items-center justify-center px-4 py-14 sm:px-20"
              style={{ x }}
              drag={total > 1 ? 'x' : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={1}
              onDragEnd={onDragEnd}
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {photos[index] && (
                <img src={photos[index]} alt="" className="max-w-full max-h-full object-contain select-none" draggable={false} />
              )}
            </motion.div>
          </AnimatePresence>

          {total > 1 && (
            <div className="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 text-white/55 text-[12px] tabular-nums tracking-wide pointer-events-none">
              {index + 1} / {total}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// Kev, 2026-08-31: one flat, unchanging pace for every gallery — no
// adaptive slowdown after the visitor navigates. 3s reads as "pleasant",
// not a slideshow.
const AUTOPLAY_MS = 3000

function SinglePropertyPage({ p }: { p: SwipeProperty }) {
  const [index, setIndex] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const photos = p.images
  const total = photos.length
  const x = useMotionValue(0)
  // Kev's redesign (2026-08-30): the active image dips slightly as it's
  // dragged toward the next/previous one, instead of just translating flat —
  // reads as a card lifting off the stack rather than a slide.
  const dragOpacity = useTransform(x, [-200, 0, 200], [0.82, 1, 0.82])

  // Kev's redesign (2026-08-30, round 3): direction of the last advance, so
  // the photo swap can slide the new image in from the correct side instead
  // of a hard cut — a ref because it doesn't need to trigger its own render,
  // just be current by the time `index` changes cause one.
  const dirRef = useRef<1 | -1>(1)
  const advance = useCallback((dir: 1 | -1) => {
    dirRef.current = dir
    setIndex(i => Math.max(0, Math.min(Math.max(total - 1, 0), i + dir)))
  }, [total])

  // Kev, 2026-08-31: auto-advance every AUTOPLAY_MS, wrapping past the last
  // photo back to the first — the deck "isn't endless" so looping reads
  // better than stalling at the end or auto-reversing. Keyed on `index`, so
  // ANY navigation (auto or manual) simply restarts the same fixed-length
  // wait — there is no separate "the visitor went back" state to slow down
  // from, by construction. Paused while the lightbox is open.
  useEffect(() => {
    if (total <= 1 || lightboxOpen) return
    const t = setTimeout(() => {
      dirRef.current = 1
      setIndex(i => (i + 1) % total)
    }, AUTOPLAY_MS)
    return () => clearTimeout(t)
  }, [index, total, lightboxOpen])

  // Kev, 2026-08-30 (round 2): "richtig schnell durchblättern" on mobile —
  // a light, quick flick should register, not require a deliberate drag.
  const onDragEnd = useCallback((_: any, info: { offset: { x: number }; velocity: { x: number } }) => {
    const THRESH = 36
    if (info.offset.x < -THRESH || info.velocity.x < -220) { advance(1); x.set(0) }
    else if (info.offset.x > THRESH || info.velocity.x > 220) { advance(-1); x.set(0) }
    // below threshold: don't force-reset x — dragConstraints springs the
    // image back to 0 on its own, which is what actually looks like "return
    // to original position" instead of an abrupt snap.
  }, [advance, x])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightboxOpen) return // the lightbox has its own arrow-key handling
      if (e.key === 'ArrowRight') advance(1)
      if (e.key === 'ArrowLeft') advance(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, lightboxOpen])

  // Mouse wheel (PC): scroll through photos. Throttled — a single scroll
  // gesture fires many wheel events, and each one should only ever move
  // one photo, not cascade through several.
  const wheelCooldown = useRef(false)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (lightboxOpen) return
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (Math.abs(delta) < 12 || wheelCooldown.current) return
      e.preventDefault()
      wheelCooldown.current = true
      advance(delta > 0 ? 1 : -1)
      setTimeout(() => { wheelCooldown.current = false }, 260)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [advance, lightboxOpen])

  const eyebrow = fmtSpecs(p).slice(0, 2).join(' / ')
  const location = p.town || [p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'

  // Prefer the clean editorial website copy over the punchy social/FB text
  // the swipe deck above uses — this page is the boutique/editorial one.
  const desc = p.fullDescription || p.description

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: OFFWHITE }}>
      {/* fixed header — eyebrow (+ ref) + hairline rule to the right edge.
          Kev, 2026-08-30 (round 4): on mobile the "2906" mark now lives
          IN this strip (Sotheby's-style — a name in the header rule, not a
          watermark sitting on the photo) instead of overlaying the image,
          so the whole photo is free of any text. */}
      <div className="flex items-center gap-4 pl-8 pr-5 sm:pl-14 pt-6 pb-4 mobile-landscape:pt-3 mobile-landscape:pb-2 flex-shrink-0">
        <span className="flex-shrink-0 text-[11px] uppercase" style={{ color: MUTED, fontWeight: 400, letterSpacing: '0.16em' }}>
          {eyebrow || 'Property'}{p.ref ? ` · #${p.ref}` : ''}
        </span>
        <div className="flex-1 h-px" style={{ background: HAIRLINE }} />
        <span
          className="sm:hidden flex-shrink-0 text-[12px]"
          style={{ fontFamily: 'var(--font-playfair), Georgia, serif', color: GOLD, letterSpacing: '0.12em' }}
        >
          2906
        </span>
      </div>

      {/* the photo stage — main image + fan of what's coming next. Desktop
          (and landscape phones) get a wide, ~16:9 image sized off a shared
          height so the fan strip lines up beside it; mobile portrait keeps
          the original full-height, wide-as-practical treatment. */}
      <div className="relative flex-1 min-h-0 flex items-stretch lg:items-center mobile-landscape:items-center pl-8 pr-5 sm:pl-14 pb-5 mobile-landscape:pb-2 lg:max-w-[1680px] lg:mx-auto mobile-landscape:max-w-[900px] mobile-landscape:mx-auto">
        {/* desktop / landscape reference — pinned to the true viewport edge
            (fixed, not tied to the row) so the centered row can stay
            centered without dragging the watermark inward with it. */}
        <div className="hidden sm:flex fixed left-3 top-1/2 -translate-y-1/2 z-20 pointer-events-none" style={{ width: 32 }}>
          <span style={{ fontFamily: 'var(--font-playfair), Georgia, serif', color: GOLD, fontSize: 22, letterSpacing: '0.1em', transform: 'rotate(-90deg)', whiteSpace: 'nowrap' }}>2906</span>
        </div>
        <motion.div
          className="relative flex-shrink-0 overflow-hidden w-[92%] h-full lg:w-auto lg:h-[min(84vh,893px)] lg:max-w-[68%] lg:aspect-video mobile-landscape:w-auto mobile-landscape:h-[min(76vh,420px)] mobile-landscape:max-w-[68%] mobile-landscape:aspect-video"
          style={{ x, opacity: dragOpacity }}
          drag={total > 1 ? 'x' : false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={1}
          onDragEnd={onDragEnd}
        >
          {/* Kev, 2026-08-30 (round 3): on real phones, tap-to-open-fullscreen
              on the whole image kept firing on ordinary swipe/scroll touches —
              onTap and axis-locked drag don't disambiguate reliably enough on
              touch hardware. Fullscreen is now its own explicit control, never
              a side effect of touching the image. */}
          <AnimatePresence initial={false} custom={dirRef.current}>
            {photos[index] ? (
              <motion.img
                key={index}
                src={photos[index]} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false}
                custom={dirRef.current}
                variants={{
                  enter: (dir: 1 | -1) => ({ opacity: 0, x: dir * 36 }),
                  center: { opacity: 1, x: 0 },
                  exit: (dir: 1 | -1) => ({ opacity: 0, x: dir * -36 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              />
            ) : (
              <div key="empty" className="absolute inset-0" style={{ background: PHOTO_BG }} />
            )}
          </AnimatePresence>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightboxOpen(true) }}
            aria-label="View fullscreen"
            className="absolute bottom-3 right-3 z-10 w-9 h-9 rounded-full flex items-center justify-center backdrop-blur-sm"
            style={{ background: 'rgba(0,0,0,0.4)' }}
          >
            <Maximize2 className="w-4 h-4 text-white" />
          </button>
        </motion.div>
        <PhotoFan photos={photos} index={index} onSelect={setIndex} dragX={x} />
      </div>

      {/* fixed footer — gold mark, name/price as one wrapping block (stays
          close together on desktop, wraps to its own line under a long
          locality on narrow phones instead of truncating), then the
          description, single line until tapped open. */}
      <div className="flex-shrink-0 pl-8 pr-5 sm:pl-14 pb-7 pt-1 mobile-landscape:pb-3 flex gap-3.5">
        <div className="flex-shrink-0 rounded-full" style={{ width: 4, height: 46, background: GOLD }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="min-w-0" style={{ color: INK, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>{location}</h1>
            <span className="flex-shrink-0" style={{ color: INK, fontSize: 22, fontWeight: 700 }}>{fmtSinglePrice(p)}</span>
          </div>
          {desc && (
            <button
              type="button"
              onClick={() => setDescOpen(o => !o)}
              aria-expanded={descOpen}
              className="relative block mt-2 text-left w-full"
            >
              <div
                className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
                style={{ maxHeight: descOpen ? 320 : 18, overflowY: descOpen ? 'auto' : 'hidden' }}
              >
                <p className="text-[12.5px] leading-relaxed" style={{ color: MUTED, fontWeight: 400 }}>{desc}</p>
              </div>
              {!descOpen && (
                <span
                  className="absolute right-0 bottom-0 text-[12.5px] pl-1"
                  style={{ color: MUTED, background: OFFWHITE }}
                >
                  …
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      <Lightbox
        photos={lightboxOpen ? photos : null}
        index={index}
        onClose={() => setLightboxOpen(false)}
        onIndexChange={setIndex}
      />
    </div>
  )
}

// ── the single pick icon for multi-property links — Kev, 2026-08-31: drawn
// the same way as StarGlyph on the CRM Schedule Board (a plain SVG path,
// solid fill on activation, no lucide, no burst/scale animation) so the
// two match visually across the brand's tools. ────────────────────────────
const HeartGlyph = ({ filled, size = 18, color = GOLD }: { filled: boolean; size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false"
    fill={filled ? color : 'none'} style={{ flexShrink: 0 }}>
    <path
      d="M12 20.3s-7.6-4.5-10.2-9C.3 8.4 1 5.2 3.9 3.9c2.2-1 4.7-.3 6.1 1.6l2 2.7 2-2.7c1.4-1.9 3.9-2.6 6.1-1.6 2.9 1.3 3.6 4.5 2.1 7.4-2.6 4.5-10.2 9-10.2 9z"
      stroke={color} strokeWidth="1.6" strokeLinejoin="round"
    />
  </svg>
)

// ── desktop-only right column for the multi-property page — a clean,
// click-through list (not the old circular ThumbGrid): rectangular
// thumbnail, location/price, its own heart toggle. Kev, 2026-08-31: "eine
// cleane Darstellung der Properties in der du dich durchklicken kannst". ──
function PropertiesList({
  properties, index, liked, onSelect, onToggleLike,
}: {
  properties: SwipeProperty[]
  index: number
  liked: Set<string>
  onSelect: (i: number) => void
  onToggleLike: (ref: string) => void
}) {
  return (
    <div className="hidden lg:flex flex-col w-[260px] xl:w-[300px] flex-shrink-0 py-6 pr-8 gap-1 overflow-y-auto">
      <span className="text-[11px] uppercase mb-3 flex-shrink-0" style={{ color: MUTED, fontWeight: 400, letterSpacing: '0.16em' }}>
        Properties
      </span>
      {properties.map((p, i) => {
        const active = i === index
        const loc = p.town || [p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'
        return (
          <div
            key={p.ref}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(i) }}
            className="flex items-center gap-3 py-2 pr-1 rounded-lg cursor-pointer transition-colors"
            style={{ background: active ? 'rgba(184,149,63,0.08)' : 'transparent' }}
          >
            <div className="flex-shrink-0 rounded-full self-stretch" style={{ width: 3, background: active ? GOLD : 'transparent' }} />
            <div className="relative w-14 h-14 rounded-md overflow-hidden flex-shrink-0" style={{ background: PHOTO_BG }}>
              {p.images[0] && <img src={p.images[0]} alt="" className="w-full h-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium truncate" style={{ color: INK }}>{loc}</div>
              <div className="text-[12px]" style={{ color: MUTED }}>{fmtSinglePrice(p)}</div>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleLike(p.ref) }}
              aria-pressed={liked.has(p.ref)}
              aria-label={liked.has(p.ref) ? 'Remove from picks' : 'Add to picks'}
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
            >
              <HeartGlyph filled={liked.has(p.ref)} size={16} color={GOLD} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ── multi-property share page — the editorial sibling of SinglePropertyPage
// above, for a client-kind link holding several listings. Kev, 2026-08-31:
// replaces the old dark Tinder-style deck ("zu tinderlastig") with the same
// visual language as the single-property page: full-bleed photo + fan,
// clean typography, gold accents. Browsing is click-through (properties
// list on desktop, touchpoint dots on mobile), not a linear swipe deck, so
// there is no forced "end of deck" screen — a pick is just a heart toggle
// that persists across however the visitor gets to that property. ─────────
function MultiPropertyPage({ properties, id }: { properties: SwipeProperty[]; id: string }) {
  const [index, setIndex] = useState(0)
  const [photoIndex, setPhotoIndex] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const [liked, setLiked] = useState<Set<string>>(new Set())
  const visitorId = useRef<string>('')
  useEffect(() => { visitorId.current = getVisitorId(id) }, [id])

  const p = properties[index]
  const photos = p?.images || []
  const total = photos.length
  const x = useMotionValue(0)
  const dragOpacity = useTransform(x, [-200, 0, 200], [0.82, 1, 0.82])
  const dirRef = useRef<1 | -1>(1)

  const advance = useCallback((dir: 1 | -1) => {
    dirRef.current = dir
    setPhotoIndex(i => Math.max(0, Math.min(Math.max(total - 1, 0), i + dir)))
  }, [total])

  const gotoProperty = useCallback((i: number) => {
    setIndex(Math.max(0, Math.min(properties.length - 1, i)))
    setPhotoIndex(0)
    setDescOpen(false)
  }, [properties.length])

  // "richtig schnell durchblättern" — same light-flick threshold as the
  // single-property page.
  const onDragEnd = useCallback((_: any, info: { offset: { x: number }; velocity: { x: number } }) => {
    const THRESH = 36
    if (info.offset.x < -THRESH || info.velocity.x < -220) { advance(1); x.set(0) }
    else if (info.offset.x > THRESH || info.velocity.x > 220) { advance(-1); x.set(0) }
  }, [advance, x])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightboxOpen) return
      if (e.key === 'ArrowRight') advance(1)
      if (e.key === 'ArrowLeft') advance(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, lightboxOpen])

  const wheelCooldown = useRef(false)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (lightboxOpen) return
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (Math.abs(delta) < 12 || wheelCooldown.current) return
      e.preventDefault()
      wheelCooldown.current = true
      advance(delta > 0 ? 1 : -1)
      setTimeout(() => { wheelCooldown.current = false }, 260)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [advance, lightboxOpen])

  // Same flat 3s auto-advance as SinglePropertyPage, scoped to whichever
  // property is currently active — switching property resets the wait
  // naturally since this effect is keyed on both index values below.
  useEffect(() => {
    if (total <= 1 || lightboxOpen) return
    const t = setTimeout(() => {
      dirRef.current = 1
      setPhotoIndex(i => (i + 1) % total)
    }, AUTOPLAY_MS)
    return () => clearTimeout(t)
  }, [index, photoIndex, total, lightboxOpen])

  const toggleLike = useCallback((ref: string) => {
    setLiked(prev => {
      const next = new Set(prev)
      if (next.has(ref)) next.delete(ref); else next.add(ref)
      return next
    })
    fetch(`${API_BASE}/api/swipe/${encodeURIComponent(id)}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, visitorId: visitorId.current }),
    }).catch(() => {})
  }, [id])

  if (!p) return <SinglePropertyMessage text="This selection is empty." />

  const eyebrow = fmtSpecs(p).slice(0, 2).join(' / ')
  const location = p.town || [p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'
  const desc = p.fullDescription || p.description
  const showDots = properties.length > 1

  return (
    <div className="fixed inset-0 flex overflow-hidden" style={{ background: OFFWHITE }}>
      <div className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* header — hairline shortens to make room for one touchpoint dot
            per property once there's more than one to browse. */}
        <div className="flex items-center gap-3 pl-8 pr-5 sm:pl-14 pt-6 pb-4 mobile-landscape:pt-3 mobile-landscape:pb-2 flex-shrink-0">
          <span className="flex-shrink-0 text-[11px] uppercase" style={{ color: MUTED, fontWeight: 400, letterSpacing: '0.16em' }}>
            {eyebrow || 'Property'}{p.ref ? ` · #${p.ref}` : ''}
          </span>
          <div className="h-px" style={{ background: HAIRLINE, flex: showDots ? '0 1 28px' : '1 1 auto' }} />
          {showDots && (
            <div className="flex items-center gap-[5px] flex-shrink-0 flex-1 justify-end">
              {properties.map((pp, i) => (
                <button
                  key={pp.ref}
                  type="button"
                  aria-label={`Go to listing ${i + 1}`}
                  onClick={() => gotoProperty(i)}
                  className="rounded-full transition-all duration-200"
                  style={{
                    width: i === index ? 7 : 5, height: i === index ? 7 : 5,
                    background: liked.has(pp.ref) ? GOLD : i === index ? INK : HAIRLINE,
                    flexShrink: 0,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* photo stage — same fan treatment as the single page, just no
            longer centered across the full viewport now that the
            properties list shares the row on desktop, which is what
            actually produces the "shifted slightly left" look. */}
        <div className="relative flex-1 min-h-0 flex items-stretch lg:items-center mobile-landscape:items-center pl-8 pr-5 sm:pl-14 pb-5 mobile-landscape:pb-2">
          <div className="hidden sm:flex fixed left-3 top-1/2 -translate-y-1/2 z-20 pointer-events-none" style={{ width: 32 }}>
            <span style={{ fontFamily: 'var(--font-playfair), Georgia, serif', color: GOLD, fontSize: 22, letterSpacing: '0.1em', transform: 'rotate(-90deg)', whiteSpace: 'nowrap' }}>2906</span>
          </div>
          <motion.div
            className="relative flex-shrink-0 overflow-hidden w-[92%] h-full lg:w-auto lg:h-[min(84vh,893px)] lg:max-w-[68%] lg:aspect-video mobile-landscape:w-auto mobile-landscape:h-[min(76vh,420px)] mobile-landscape:max-w-[68%] mobile-landscape:aspect-video"
            style={{ x, opacity: dragOpacity }}
            drag={total > 1 ? 'x' : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={1}
            onDragEnd={onDragEnd}
          >
            <AnimatePresence initial={false} custom={dirRef.current}>
              {photos[photoIndex] ? (
                <motion.img
                  key={`${p.ref}-${photoIndex}`}
                  src={photos[photoIndex]} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false}
                  custom={dirRef.current}
                  variants={{
                    enter: (dir: 1 | -1) => ({ opacity: 0, x: dir * 36 }),
                    center: { opacity: 1, x: 0 },
                    exit: (dir: 1 | -1) => ({ opacity: 0, x: dir * -36 }),
                  }}
                  initial="enter" animate="center" exit="exit"
                  transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                />
              ) : (
                <div key="empty" className="absolute inset-0" style={{ background: PHOTO_BG }} />
              )}
            </AnimatePresence>

            {/* the pick — mobile only (desktop uses the list's own heart) */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleLike(p.ref) }}
              aria-pressed={liked.has(p.ref)}
              aria-label={liked.has(p.ref) ? 'Remove from picks' : 'Add to picks'}
              className="lg:hidden absolute top-3 left-3 z-20 w-9 h-9 rounded-full flex items-center justify-center backdrop-blur-sm"
              style={{ background: 'rgba(0,0,0,0.35)' }}
            >
              <HeartGlyph filled={liked.has(p.ref)} size={18} color={liked.has(p.ref) ? GOLD : '#FFFFFF'} />
            </button>

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLightboxOpen(true) }}
              aria-label="View fullscreen"
              className="absolute bottom-3 right-3 z-10 w-9 h-9 rounded-full flex items-center justify-center backdrop-blur-sm"
              style={{ background: 'rgba(0,0,0,0.4)' }}
            >
              <Maximize2 className="w-4 h-4 text-white" />
            </button>
          </motion.div>
          <PhotoFan photos={photos} index={photoIndex} onSelect={setPhotoIndex} dragX={x} />
        </div>

        {/* footer — same shape as the single page's */}
        <div className="flex-shrink-0 pl-8 pr-5 sm:pl-14 pb-7 pt-1 mobile-landscape:pb-3 flex gap-3.5">
          <div className="flex-shrink-0 rounded-full" style={{ width: 4, height: 46, background: GOLD }} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h1 className="min-w-0" style={{ color: INK, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>{location}</h1>
              <span className="flex-shrink-0" style={{ color: INK, fontSize: 22, fontWeight: 700 }}>{fmtSinglePrice(p)}</span>
            </div>
            {desc && (
              <button
                type="button"
                onClick={() => setDescOpen(o => !o)}
                aria-expanded={descOpen}
                className="relative block mt-2 text-left w-full"
              >
                <div
                  className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
                  style={{ maxHeight: descOpen ? 320 : 18, overflowY: descOpen ? 'auto' : 'hidden' }}
                >
                  <p className="text-[12.5px] leading-relaxed" style={{ color: MUTED, fontWeight: 400 }}>{desc}</p>
                </div>
                {!descOpen && (
                  <span className="absolute right-0 bottom-0 text-[12.5px] pl-1" style={{ color: MUTED, background: OFFWHITE }}>…</span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      <PropertiesList properties={properties} index={index} liked={liked} onSelect={gotoProperty} onToggleLike={toggleLike} />

      <Lightbox
        photos={lightboxOpen ? photos : null}
        index={photoIndex}
        onClose={() => setLightboxOpen(false)}
        onIndexChange={setPhotoIndex}
      />
    </div>
  )
}

function SinglePropertyMessage({ text }: { text: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: OFFWHITE }}>
      <div className="text-center max-w-xs">
        <div className="w-11 h-11 rounded-full flex items-center justify-center mb-5 mx-auto" style={{ background: '#F0EEE7' }}>
          <X className="w-5 h-5" style={{ color: MUTED }} />
        </div>
        <h1 className="text-lg mb-2" style={{ fontFamily: 'var(--font-playfair), Georgia, serif', color: INK }}>This link has expired</h1>
        <p className="text-[13px]" style={{ color: MUTED }}>{text}</p>
      </div>
    </div>
  )
}

export default function SwipePage() {
  const params = useParams()
  const id = String(params.id || '')
  const [properties, setProperties] = useState<SwipeProperty[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [expiredMessage, setExpiredMessage] = useState<string | null>(null)
  const [linkKind, setLinkKind] = useState<'property' | 'client' | null>(null)

  useEffect(() => {
    if (!id) return
    fetch(`${API_BASE}/api/swipe/${encodeURIComponent(id)}`)
      .then(r => { if (!r.ok) throw new Error('not found'); return r.json() })
      .then(d => {
        // Kev's Prompt A (2026-08-29): a live link (client TTL, or property
        // TTL/rented/off-market) comes back 200 with expired:true, distinct
        // from a paused/nonexistent link (non-200, notFound below) — the
        // record persists server-side, only public access ends.
        setLinkKind(d.kind === 'property' ? 'property' : 'client')
        if (d.expired) { setExpiredMessage(d.message || 'This link has expired.'); return }
        setProperties(Array.isArray(d.properties) ? d.properties : [])
      })
      .catch(() => setNotFound(true))
  }, [id])

  if (expiredMessage) {
    if (linkKind === 'property') return <SinglePropertyMessage text={expiredMessage} />
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: BG }}>
        <div className="text-center max-w-xs">
          <div className="w-11 h-11 rounded-full flex items-center justify-center mb-5 mx-auto" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <X className="w-5 h-5 text-white/50" />
          </div>
          <h1 className="text-white text-lg mb-2" style={{ fontFamily: 'var(--font-playfair), Georgia, serif' }}>This link has expired</h1>
          <p className="text-white/50 text-[13px]">{expiredMessage}</p>
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: BG }}>
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: BG }}>
        <div className="w-8 h-8 rounded-full border-2 border-white/15 animate-spin" style={{ borderTopColor: GOLD }} />
      </div>
    )
  }

  if (linkKind === 'property') {
    return properties[0] ? <SinglePropertyPage p={properties[0]} /> : <SinglePropertyMessage text="This listing is no longer available." />
  }

  return properties.length
    ? <MultiPropertyPage properties={properties} id={id} />
    : <SinglePropertyMessage text="This selection is empty." />
}
