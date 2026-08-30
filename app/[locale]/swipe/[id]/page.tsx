'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { motion, AnimatePresence, useMotionValue, useTransform } from 'framer-motion'
import { Heart, Star, ChevronUp, ChevronDown, BedDouble, Bath, Ruler, MapPin, X, Check, CheckCircle2 } from 'lucide-react'

const API_BASE = ''
const GOLD = '#B8953F'
const GOLD_LIGHT = '#D4B15A'
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

// ── rotating ad slides — top bar + the desktop brand panel share one index ──
const AD_SLIDES = [
  { top: 'JOIN US AS AFFILIATE PARTNER', link: '2906.ESTATE/CONTACT', tagline: 'Leading the way in real estate technology in Malta.', cta: null as string | null },
  { top: 'JOIN US AS AGENT', link: '2906.ESTATE/CONTACT', tagline: null as string | null, cta: null as string | null },
  { top: 'LEADING THE WAY IN REAL ESTATE TECHNOLOGY IN MALTA.', link: null as string | null, tagline: null as string | null, cta: 'JOIN OUR TEAM!' },
  { top: 'SUGGEST US & PROFIT FROM IT', link: null as string | null, tagline: null as string | null, cta: 'JOIN OUR TEAM!' },
]
const AD_ROTATE_MS = 9000

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

// ── the top ad ticker — shared by mobile top bar and (echoed) the desktop panel ──
function AdBar({ slideIndex }: { slideIndex: number }) {
  const slide = AD_SLIDES[slideIndex]
  return (
    <div className="w-full flex items-center justify-center gap-2 py-2 px-3 text-center overflow-hidden" style={{ background: BG }}>
      <AnimatePresence mode="wait">
        <motion.div
          key={slideIndex}
          className="flex items-center justify-center gap-2"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <span className="text-[10px] font-semibold tracking-[0.14em] text-white uppercase">{slide.top}</span>
          {slide.link && (
            <span className="text-[10px] font-medium tracking-[0.1em] text-white/45">{slide.link}</span>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ── logo: the real wordmark, rotated for the desktop panel's vertical read ──
function BrandLogo({ vertical, size = 46 }: { vertical?: boolean; size?: number }) {
  return (
    <img
      src="/logo-transparent.png"
      alt="2906"
      style={{
        height: size, width: 'auto',
        transform: vertical ? 'rotate(-90deg)' : undefined,
      }}
    />
  )
}

// ── apartment position dots — one per listing, current enlarged, green = favourited ──
function ApartmentDots({ total, index, favourited, onJump }: { total: number; index: number; favourited: boolean[]; onJump: (i: number) => void }) {
  return (
    <div className="absolute top-3 left-3 right-3 z-20 flex items-center justify-center gap-[5px]">
      {Array.from({ length: total }).map((_, i) => {
        const active = i === index
        const fav = favourited[i]
        return (
          <button
            key={i}
            type="button"
            aria-label={`Go to listing ${i + 1}`}
            onClick={() => onJump(i)}
            className="rounded-full transition-all duration-200"
            style={{
              width: active ? 8 : 5, height: active ? 8 : 5,
              background: fav ? '#22C55E' : active ? '#FFFFFF' : 'rgba(255,255,255,0.35)',
              flexShrink: 0,
            }}
          />
        )
      })}
    </div>
  )
}

// ── one card: photo carousel (tap zones) + price overlay ────────────────────
function Card({
  p, active, dragProps, photoIndex, onTapPhoto,
}: {
  p: SwipeProperty
  active: boolean
  dragProps?: { x: any; y: any; onDragEnd: (e: any, info: any) => void }
  photoIndex: number
  onTapPhoto: (dir: 1 | -1) => void
}) {
  const opacity = dragProps ? useTransform(dragProps.x, [-220, 0, 220], [0.5, 1, 0.5]) : undefined
  const rotate = dragProps ? useTransform(dragProps.x, [-220, 220], [-6, 6]) : undefined
  const photos = p.images.length ? p.images : [null]
  const shown = Math.min(photoIndex, photos.length - 1)

  return (
    <motion.div
      className="absolute inset-0 select-none"
      style={active && dragProps ? { x: dragProps.x, y: dragProps.y, opacity, rotate } : undefined}
      drag={active && dragProps ? true : false}
      dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
      dragElastic={0.6}
      onDragEnd={active && dragProps ? dragProps.onDragEnd : undefined}
    >
      <div className="relative w-full h-full overflow-hidden rounded-3xl bg-navy">
        {photos[shown] ? (
          <img src={photos[shown]!} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-navy to-[#0B1120]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0B1120] via-[#0B1120]/5 to-transparent" style={{ height: '45%', top: '55%' }} />
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/35 to-transparent" />

        {/* tap zones — this listing's OWN photos, separate from the card-to-card swipe */}
        {photos.length > 1 && (
          <>
            <button aria-label="Previous photo" className="absolute inset-y-0 left-0 w-1/2 z-10" onClick={() => onTapPhoto(-1)} />
            <button aria-label="Next photo" className="absolute inset-y-0 right-0 w-1/2 z-10" onClick={() => onTapPhoto(1)} />
          </>
        )}

        {/* this listing's own photo position — right edge, tall + prominent so it reads as "more photos here" */}
        {photos.length > 1 && (
          <div className="absolute right-3 top-14 bottom-16 flex flex-col items-center justify-center gap-[7px] z-10 pointer-events-none">
            {photos.map((_, i) => (
              <span key={i} className="rounded-full transition-all duration-150" style={{
                width: i === shown ? 6 : 4, height: i === shown ? 6 : 4,
                background: i === shown ? '#FFFFFF' : 'rgba(255,255,255,0.38)',
                boxShadow: i === shown ? '0 0 0 3px rgba(255,255,255,0.18)' : undefined,
              }} />
            ))}
          </div>
        )}

        {p.availableNow && (
          <div className="absolute top-4 left-4 flex items-center gap-1.5 rounded-full bg-[#0B1120]/60 backdrop-blur-sm px-3 py-1.5 text-[11px] font-medium tracking-wide text-white/90 z-10">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Available now
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 p-5 pb-6 pointer-events-none">
          <div
            className="text-white leading-none"
            style={{ fontFamily: 'var(--font-playfair), Georgia, serif', fontSize: 'clamp(28px, 7vw, 38px)', fontWeight: 600 }}
          >
            {fmtPrice(p)}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

// ── star (favourite) + heart (like) ──────────────────────────────────────────
function ActionButton({
  icon, active, activeColor, onPress, size = 40, alwaysRing = false,
}: {
  icon: React.ReactNode
  active: boolean
  activeColor: string
  onPress: () => void
  size?: number
  // Kev, 2026-08-29: the star outranks the heart — it gets a permanent gold
  // ring even before it's tapped, so it reads as the primary action, not an
  // equal pair.
  alwaysRing?: boolean
}) {
  const [burst, setBurst] = useState(0)
  return (
    <button
      type="button"
      // Kev, 2026-08-29: tapping the already-active one now un-picks it —
      // heart and star are a real toggle, not a one-way flag.
      onClick={() => { onPress(); if (!active) setBurst(b => b + 1) }}
      aria-pressed={active}
      className="relative rounded-full flex items-center justify-center flex-shrink-0"
      style={{
        width: size, height: size,
        background: active ? `${activeColor}22` : 'rgba(255,255,255,0.06)',
        border: alwaysRing && !active ? `1.5px solid ${activeColor}55` : undefined,
      }}
    >
      <AnimatePresence>
        {burst > 0 && (
          <motion.span
            key={burst}
            initial={{ scale: 0.6, opacity: 0.9 }}
            animate={{ scale: 2.1, opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="absolute inset-0 rounded-full border-2"
            style={{ borderColor: activeColor }}
          />
        )}
      </AnimatePresence>
      <motion.span
        animate={active ? { scale: [1, 1.35, 1] } : { scale: 1 }}
        transition={active ? { type: 'tween', duration: 0.36, times: [0, 0.5, 1], ease: 'easeOut' } : { duration: 0.15 }}
      >
        {icon}
      </motion.span>
    </button>
  )
}

// ── the black info strip below the card ──────────────────────────────────────
function BottomBar({
  p, liked, favourited, onLike, onFavourite, onOpenDesc, photoIndex, photoTotal, allPhotosSeen,
  properties, currentIndex, pickedRefs, onJumpDot, onFinish,
}: {
  p: SwipeProperty
  liked: boolean
  favourited: boolean
  onLike: () => void
  onFavourite: () => void
  onOpenDesc: () => void
  photoIndex: number
  photoTotal: number
  allPhotosSeen: boolean
  properties: SwipeProperty[]
  currentIndex: number
  // both kinds — heart and star are mutually exclusive per property now, so
  // this is "every property with a pick", not just likes.
  pickedRefs: Set<string>
  onJumpDot: (i: number) => void
  onFinish: () => void
}) {
  const specs = fmtSpecs(p).join(' · ')
  return (
    <>
    <div className="flex items-center gap-3 px-1 pt-3 pb-1">
      <ActionButton
        size={54}
        alwaysRing
        icon={<Star className="w-[26px] h-[26px]" style={{ color: favourited ? GOLD : '#F6F4EF' }} fill={favourited ? GOLD : 'none'} strokeWidth={favourited ? 0 : 1.75} />}
        active={favourited} activeColor={GOLD} onPress={onFavourite}
      />
      <ActionButton
        size={34}
        icon={<Heart className="w-[14px] h-[14px]" style={{ color: liked ? '#EF4444' : '#F6F4EF' }} fill={liked ? '#EF4444' : 'none'} strokeWidth={liked ? 0 : 1.75} />}
        active={liked} activeColor="#EF4444" onPress={onLike}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-white text-[13px] font-medium">
          <MapPin className="w-3 h-3 text-white/50 flex-shrink-0" />
          <span className="truncate">{[p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'}</span>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-white/55 text-[12px]">{specs}</span>
          {photoTotal > 1 && (
            <div className="flex items-center gap-2 pl-3 flex-shrink-0">
              <span className="w-px h-3 bg-white/15" />
              <span className="flex items-center gap-1 text-[11px] font-medium tabular-nums" style={{ color: allPhotosSeen ? GOLD_LIGHT : 'rgba(255,255,255,0.5)' }}>
                {photoIndex + 1}/{photoTotal}
                <CheckCircle2 className="w-3.5 h-3.5" style={{ color: allPhotosSeen ? GOLD_LIGHT : 'rgba(255,255,255,0.3)' }} />
              </span>
            </div>
          )}
        </div>
        {p.description && (
          <button
            type="button"
            onClick={onOpenDesc}
            className="text-left mt-1 -ml-1 block w-full px-1 py-1.5 rounded-md active:bg-white/5 transition-colors"
          >
            <span className="text-white/40 text-[12px] tracking-[0.2em]">···· <span className="text-white/25 tracking-normal">tap for details</span></span>
          </button>
        )}
      </div>
    </div>

    {/* Kev, 2026-08-29: deck progress — one dot per property (gold once
        liked), plus a "Done" pill once you have at least one like, so you
        can wrap up and send your picks without swiping every remaining card. */}
    {properties.length > 1 && (
      <div className="flex items-center justify-between gap-3 px-1 pt-3 mt-1 border-t border-white/8">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {properties.map((pp, i) => (
            <button
              key={pp.ref}
              type="button"
              aria-label={`Go to listing ${i + 1}`}
              onClick={() => onJumpDot(i)}
              className="rounded-full flex-shrink-0 transition-all duration-150"
              style={{
                width: i === currentIndex ? 7 : 5, height: i === currentIndex ? 7 : 5,
                background: pickedRefs.has(pp.ref) ? GOLD : i === currentIndex ? '#FFFFFF' : 'rgba(255,255,255,0.25)',
              }}
            />
          ))}
        </div>
        {pickedRefs.size > 0 && (
          <button
            type="button"
            onClick={onFinish}
            className="flex items-center gap-1.5 text-[12px] font-medium rounded-full pl-2.5 pr-3 py-1.5 flex-shrink-0"
            style={{ background: GOLD, color: BG }}
          >
            <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
            Done ({pickedRefs.size})
          </button>
        )}
      </div>
    )}
  </>
  )
}

// ── full description — a dark sheet OVER the screen, never inline (inline
// growth used to crush the card's flex height on short mobile viewports) ──
function DescriptionModal({ p, onClose }: { p: SwipeProperty | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {p && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end lg:items-center justify-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
        >
          <motion.div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          />
          <motion.div
            className="relative w-full lg:w-[480px] max-h-[80vh] rounded-t-3xl lg:rounded-3xl overflow-hidden flex flex-col"
            style={{ background: '#111A2E' }}
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'tween', duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 flex-shrink-0 border-b border-white/8">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-white text-[15px] font-medium">
                  <MapPin className="w-3.5 h-3.5 text-white/50 flex-shrink-0" />
                  <span className="truncate">{[p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'}</span>
                </div>
                <div className="text-white/50 text-[13px] mt-1">{fmtSpecs(p).join(' · ')} · {fmtPrice(p)}</div>
              </div>
              <button
                type="button" onClick={onClose} aria-label="Close"
                className="w-8 h-8 rounded-full flex items-center justify-center bg-white/8 hover:bg-white/14 transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4 text-white/80" />
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-5">
              <p className="text-white/75 text-[14px] leading-relaxed whitespace-pre-line">{p.description}</p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── recap, shown once done / after the last card ──────────────────────────
// Kev, 2026-08-29: dropped the "leave your contact" form — he's sending the
// link to a known recipient himself, so nothing to collect here. The picks
// already reach the agent through the CRM's swipe-links panel (Chat/Book
// buttons on each liked listing); this screen is just the customer's recap.
type Picked = { p: SwipeProperty; kind: 'like' | 'favourite'; at: number }

function EndScreen({ pickedList }: { pickedList: Picked[] }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center px-7 text-center">
      <div className="w-11 h-11 rounded-full flex items-center justify-center mb-5" style={{ background: 'rgba(184,149,63,0.14)' }}>
        <Check className="w-5 h-5" style={{ color: GOLD }} />
      </div>
      <h1 className="text-white text-2xl mb-2" style={{ fontFamily: 'var(--font-playfair), Georgia, serif' }}>
        That's everything for you
      </h1>
      <p className="text-white/55 text-[13px] mb-7 max-w-xs">
        {pickedList.length > 0
          ? `You picked ${pickedList.length} place${pickedList.length === 1 ? '' : 's'} — your agent has the list and will follow up.`
          : 'You made it through the whole set. Swipe back any time to look again.'}
      </p>

      {pickedList.length > 0 && (
        <div className="w-full max-w-xs mb-2 flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
          {pickedList.map(({ p, kind, at }) => (
            <div key={p.ref} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-left">
              <div className="relative w-11 h-11 rounded-lg overflow-hidden flex-shrink-0 border border-white/10">
                {p.images[0]
                  ? <img src={p.images[0]} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full bg-navy" />}
                <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: kind === 'favourite' ? GOLD : '#EF4444' }}>
                  {kind === 'favourite'
                    ? <Star className="w-[11px] h-[11px]" fill={BG} color={BG} />
                    : <Heart className="w-[10px] h-[10px]" fill={BG} color={BG} />}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-white text-[12.5px] font-medium truncate">
                  {[p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'}
                </div>
                <div className="text-white/40 text-[11px]">
                  {kind === 'favourite' ? 'Favourited' : 'Liked'}
                  {at > 0 && ` · ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── desktop-only left brand panel, echoes the same rotating slide ────────────
function BrandPanel({ slideIndex }: { slideIndex: number }) {
  const slide = AD_SLIDES[slideIndex]
  return (
    <div className="hidden lg:flex flex-col items-center justify-center w-[260px] xl:w-[340px] 2xl:w-[400px] flex-shrink-0 text-center">
      <BrandLogo vertical size={104} />
      <AnimatePresence mode="wait">
        <motion.div
          key={slideIndex}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        >
          {slide.tagline && (
            <p className="mt-8 text-white/70 text-[15px] xl:text-[16px] leading-relaxed max-w-[260px]">{slide.tagline}</p>
          )}
          {slide.cta && (
            <div className="mt-8 flex flex-col items-center gap-2">
              <span className="text-white text-[14px] font-medium tracking-wide">{slide.cta}</span>
              <span className="text-[12px] text-[#0B1120] bg-white rounded-full px-3.5 py-1.5 font-medium tracking-wide">2906.ESTATE/CONTACT</span>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ── desktop-only right thumbnail grid — every OTHER listing, jump on click ───
function ThumbGrid({ properties, index, favourited, onJump }: { properties: SwipeProperty[]; index: number; favourited: boolean[]; onJump: (i: number) => void }) {
  return (
    <div className="hidden lg:grid flex-shrink-0 h-fit self-center grid-cols-2 gap-3 w-[124px] xl:w-[144px]">
      {properties.map((p, i) => (
        <button
          key={p.ref}
          type="button"
          onClick={() => onJump(i)}
          aria-label={`Jump to #${p.ref}`}
          className="relative w-full aspect-square rounded-full overflow-hidden flex-shrink-0 transition-transform hover:scale-105"
          style={{
            outline: i === index ? '2px solid #FFFFFF' : 'none',
            outlineOffset: 2,
            boxShadow: favourited[i] ? '0 0 0 2px #22C55E' : undefined,
          }}
        >
          {p.images[0] ? (
            <img src={p.images[0]} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-white" />
          )}
        </button>
      ))}
    </div>
  )
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
function PhotoFan({ photos, index, onSelect }: { photos: string[]; index: number; onSelect: (i: number) => void }) {
  const upcoming = photos.slice(index + 1, index + 1 + FAN_MAX)
  if (!upcoming.length) return <div className="flex-1 h-full" style={{ background: OFFWHITE }} />
  const n = upcoming.length
  return (
    <div className="relative flex-1 h-full overflow-hidden">
      {upcoming.map((src, i) => {
        const t = i / Math.max(n - 1, 1) // 0 (nearest) .. 1 (furthest)
        // Kev, 2026-08-30 (round 2): cards were reading as one flat row of
        // near-equal panels, not a fan — narrower from the first card, and
        // tapering faster, so the depth/overlap is unmistakable at a glance.
        const widthPct = 26 - i * 2
        const leftPct = i * (74 / Math.max(n - 1, 1))
        // Even the nearest card reads as muted, not full colour — the whole
        // fan should look bleached, ramping to fully white by the last card.
        const grayscale = Math.min(1, 0.35 + t * 0.75)
        const brightness = 1.15 + t * 0.95
        const opacity = 1 - t * 0.3
        return (
          <button
            key={index + 1 + i}
            type="button"
            onClick={() => onSelect(index + 1 + i)}
            aria-label={`Photo ${index + 2 + i}`}
            className="absolute top-0 bottom-0"
            style={{ left: `${leftPct}%`, width: `${widthPct}%`, opacity, zIndex: n - i }}
          >
            <img
              src={src} alt="" className="w-full h-full object-cover" draggable={false}
              style={{ filter: `grayscale(${grayscale}) brightness(${brightness})` }}
            />
          </button>
        )
      })}
      {/* fade the far edge of the fan into the page background rather than a hard clip */}
      <div className="absolute inset-y-0 right-0 w-1/3 pointer-events-none" style={{ background: `linear-gradient(to right, transparent, ${OFFWHITE})` }} />
    </div>
  )
}

function SinglePropertyPage({ p }: { p: SwipeProperty }) {
  const [index, setIndex] = useState(0)
  const photos = p.images
  const total = photos.length
  const x = useMotionValue(0)

  const advance = useCallback((dir: 1 | -1) => {
    setIndex(i => Math.max(0, Math.min(Math.max(total - 1, 0), i + dir)))
  }, [total])

  // Kev, 2026-08-30 (round 2): "richtig schnell durchblättern" on mobile —
  // a light, quick flick should register, not require a deliberate drag.
  const onDragEnd = useCallback((_: any, info: { offset: { x: number }; velocity: { x: number } }) => {
    const THRESH = 36
    if (info.offset.x < -THRESH || info.velocity.x < -220) advance(1)
    else if (info.offset.x > THRESH || info.velocity.x > 220) advance(-1)
    x.set(0)
  }, [advance, x])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') advance(1)
      if (e.key === 'ArrowLeft') advance(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance])

  // Mouse wheel (PC): scroll through photos. Throttled — a single scroll
  // gesture fires many wheel events, and each one should only ever move
  // one photo, not cascade through several.
  const wheelCooldown = useRef(false)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (Math.abs(delta) < 12 || wheelCooldown.current) return
      e.preventDefault()
      wheelCooldown.current = true
      advance(delta > 0 ? 1 : -1)
      setTimeout(() => { wheelCooldown.current = false }, 260)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [advance])

  const eyebrow = fmtSpecs(p).slice(0, 2).join(' / ')
  const location = p.town || [p.subLocation, p.town].filter(Boolean).join(', ') || 'Malta'

  // Prefer the clean editorial website copy over the punchy social/FB text
  // the swipe deck above uses — this page is the boutique/editorial one.
  const desc = p.fullDescription || p.description

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: OFFWHITE }}>
      {/* fixed header — eyebrow + hairline rule to the right edge */}
      <div className="flex items-center gap-4 pl-8 pr-5 sm:pl-14 pt-6 pb-4 flex-shrink-0">
        <span className="flex-shrink-0 text-[11px] uppercase" style={{ color: MUTED, fontWeight: 400, letterSpacing: '0.16em' }}>
          {eyebrow || 'Property'}
        </span>
        <div className="flex-1 h-px" style={{ background: HAIRLINE }} />
      </div>

      {/* the photo stage — main image + fan of what's coming next. The
          "2906" watermark lives HERE (not the full page height) — Kev's
          reference centres it on the photo area specifically, close to the
          edge, not the header/footer band. */}
      <div className="relative flex-1 min-h-0 flex pl-8 pr-5 sm:pl-14 pb-5">
        <div className="flex sm:hidden absolute left-1.5 top-0 bottom-0 items-center z-20 pointer-events-none" style={{ width: 24 }}>
          <span style={{ fontFamily: 'var(--font-playfair), Georgia, serif', color: GOLD, fontSize: 17, letterSpacing: '0.08em', transform: 'rotate(-90deg)', whiteSpace: 'nowrap' }}>2906</span>
        </div>
        <div className="hidden sm:flex absolute left-3 top-0 bottom-0 items-center z-20 pointer-events-none" style={{ width: 32 }}>
          <span style={{ fontFamily: 'var(--font-playfair), Georgia, serif', color: GOLD, fontSize: 22, letterSpacing: '0.1em', transform: 'rotate(-90deg)', whiteSpace: 'nowrap' }}>2906</span>
        </div>
        <motion.div
          className="relative h-full flex-shrink-0 overflow-hidden"
          style={{ width: '70%', x }}
          drag={total > 1 ? 'x' : false}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.5}
          onDragEnd={onDragEnd}
        >
          {photos[index] ? (
            <img src={photos[index]} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <div className="w-full h-full" style={{ background: PHOTO_BG }} />
          )}
          {total > 1 && (
            <>
              <button aria-label="Previous photo" className="absolute inset-y-0 left-0 w-1/3" onClick={() => advance(-1)} />
              <button aria-label="Next photo" className="absolute inset-y-0 right-0 w-1/3" onClick={() => advance(1)} />
            </>
          )}
        </motion.div>
        <PhotoFan photos={photos} index={index} onSelect={setIndex} />
      </div>

      {/* fixed footer — gold mark, name/price bold on one baseline, then the description */}
      <div className="flex-shrink-0 pl-8 pr-5 sm:pl-14 pb-7 pt-1 flex gap-3.5">
        <div className="flex-shrink-0 rounded-full" style={{ width: 4, height: 46, background: GOLD }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="truncate flex-1 min-w-0" style={{ color: INK, fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em' }}>{location}</h1>
            <span className="flex-shrink-0" style={{ color: INK, fontSize: 18, fontWeight: 700 }}>{fmtSinglePrice(p)}</span>
          </div>
          {desc && (
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: MUTED, fontWeight: 400, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {desc}
            </p>
          )}
        </div>
      </div>
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
  const [index, setIndex] = useState(0)
  const [liked, setLiked] = useState<Set<string>>(new Set())
  const [favourited, setFavourited] = useState<Set<string>>(new Set())
  // Kev, 2026-08-29: the end-screen recap needs a timestamp per pick, not
  // just the image — when it happened, not only what.
  const [pickedAt, setPickedAt] = useState<Map<string, number>>(new Map())
  const [photoIndex, setPhotoIndex] = useState(0)
  const [seenAllPhotos, setSeenAllPhotos] = useState<Set<string>>(new Set())
  const [descModalOpen, setDescModalOpen] = useState(false)
  const [adIndex, setAdIndex] = useState(0)
  const visitorId = useRef<string>('')
  const x = useMotionValue(0)
  const y = useMotionValue(0)

  useEffect(() => {
    if (!id) return
    visitorId.current = getVisitorId(id)
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

  useEffect(() => {
    const t = setInterval(() => setAdIndex(i => (i + 1) % AD_SLIDES.length), AD_ROTATE_MS)
    return () => clearInterval(t)
  }, [])

  // Recap counts BOTH kinds — heart and star are mutually exclusive per
  // property now, so this is just "every property with a pick", newest
  // first, each carrying which kind and when.
  const pickedList = useMemo(() => {
    const list = (properties || [])
      .filter(p => liked.has(p.ref) || favourited.has(p.ref))
      .map(p => ({ p, kind: favourited.has(p.ref) ? 'favourite' as const : 'like' as const, at: pickedAt.get(p.ref) || 0 }))
    return list.sort((a, b) => b.at - a.at)
  }, [properties, liked, favourited, pickedAt])
  const pickedRefs = useMemo(
    () => new Set<string>([...liked, ...favourited]),
    [liked, favourited],
  )
  const favouredFlags = useMemo(
    () => (properties || []).map(p => favourited.has(p.ref)),
    [properties, favourited],
  )

  // Kev, 2026-08-29: the checkmark next to the photo counter confirms "you've
  // paged through every photo on this listing" — it lights up once photoIndex
  // reaches the last frame.
  useEffect(() => {
    const p = properties?.[index]
    if (!p) return
    const total = p.images.length
    if (total > 1 && photoIndex >= total - 1) {
      setSeenAllPhotos(prev => (prev.has(p.ref) ? prev : new Set(prev).add(p.ref)))
    }
  }, [photoIndex, properties, index])

  const jump = useCallback((i: number) => {
    setPhotoIndex(0)
    setDescModalOpen(false)
    setIndex(Math.max(0, Math.min((properties?.length || 0), i)))
  }, [properties])

  const advance = useCallback((dir: 1 | -1) => {
    setIndex(i => {
      const max = (properties?.length || 0)
      setPhotoIndex(0)
      setDescModalOpen(false)
      return Math.max(0, Math.min(max, i + dir))
    })
  }, [properties])

  // Kev, 2026-08-29: heart and star are mutually exclusive per property, and
  // tapping the active one again un-picks it — one pick per property, kind
  // says which. Neither one contacts the owner; both just record the pick
  // for the agent's overview (star ranks above like there — the stronger
  // signal).
  const like = useCallback((ref: string) => {
    setLiked(prev => {
      const next = new Set(prev)
      const turningOn = !next.has(ref)
      if (turningOn) next.add(ref); else next.delete(ref)
      setPickedAt(m => {
        const nm = new Map(m)
        if (turningOn) nm.set(ref, Date.now()); else nm.delete(ref)
        return nm
      })
      return next
    })
    setFavourited(prev => { if (!prev.has(ref)) return prev; const next = new Set(prev); next.delete(ref); return next })
    fetch(`${API_BASE}/api/swipe/${encodeURIComponent(id)}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, visitorId: visitorId.current }),
    }).catch(() => {})
  }, [id])

  const favourite = useCallback((ref: string) => {
    setFavourited(prev => {
      const next = new Set(prev)
      const turningOn = !next.has(ref)
      if (turningOn) next.add(ref); else next.delete(ref)
      setPickedAt(m => {
        const nm = new Map(m)
        if (turningOn) nm.set(ref, Date.now()); else nm.delete(ref)
        return nm
      })
      return next
    })
    setLiked(prev => { if (!prev.has(ref)) return prev; const next = new Set(prev); next.delete(ref); return next })
    fetch(`${API_BASE}/api/swipe/${encodeURIComponent(id)}/favourite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, visitorId: visitorId.current }),
    }).catch(() => {})
  }, [id])

  // Kev, 2026-08-29: LEFT/RIGHT = apartment to apartment (right = like +
  // next, left = back only, never a dislike). UP/DOWN = this listing's OWN
  // photo gallery, not the next apartment — the same thing the right-edge
  // dots and the tap zones on the card already do, just as a swipe too.
  const onTapPhoto = useCallback((dir: 1 | -1) => {
    const total = properties?.[index]?.images.length || 1
    setPhotoIndex(p => Math.max(0, Math.min(total - 1, p + dir)))
  }, [properties, index])

  const onDragEnd = useCallback((_: any, info: { offset: { x: number; y: number }; velocity: { x: number; y: number } }) => {
    const THRESH = 90
    const horizontal = Math.abs(info.offset.x) > Math.abs(info.offset.y)
    if (horizontal) {
      if (info.offset.x > THRESH || info.velocity.x > 500) {
        const ref = properties?.[index]?.ref
        if (ref) like(ref)
        advance(1)
      } else if (info.offset.x < -THRESH || info.velocity.x < -500) {
        advance(-1)
      }
    } else {
      if (info.offset.y < -THRESH || info.velocity.y < -500) onTapPhoto(1)
      else if (info.offset.y > THRESH || info.velocity.y > 500) onTapPhoto(-1)
    }
    x.set(0); y.set(0)
  }, [advance, like, properties, index, x, y, onTapPhoto])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') onTapPhoto(1)
      if (e.key === 'ArrowDown') onTapPhoto(-1)
      if (e.key === 'ArrowRight') { const ref = properties?.[index]?.ref; if (ref) like(ref); advance(1) }
      if (e.key === 'ArrowLeft') advance(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, like, properties, index, onTapPhoto])

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

  const total = properties.length
  const atEnd = index >= total
  const current = !atEnd ? properties[index] : null

  const Stage = (
    <div className="relative w-full h-full flex flex-col">
      <div className="lg:hidden"><AdBar slideIndex={adIndex} /></div>
      <div className="relative flex-1 p-3">
        {atEnd ? (
          <EndScreen pickedList={pickedList} />
        ) : (
          <>
            {total > 0 && (
              <ApartmentDots total={total} index={index} favourited={favouredFlags} onJump={jump} />
            )}
            {properties[index + 1] && (
              <div className="absolute inset-3 pointer-events-none" style={{ transform: 'scale(0.96) translateY(10px)', opacity: 0.5 }}>
                <div className="relative w-full h-full rounded-3xl overflow-hidden bg-navy">
                  {properties[index + 1].images[0] && (
                    <img src={properties[index + 1].images[0]} alt="" className="w-full h-full object-cover" />
                  )}
                </div>
              </div>
            )}
            <AnimatePresence initial={false}>
              <Card
                key={current!.ref}
                p={current!}
                active
                dragProps={{ x, y, onDragEnd }}
                photoIndex={photoIndex}
                onTapPhoto={onTapPhoto}
              />
            </AnimatePresence>

            <div className="hidden md:flex lg:hidden flex-col gap-2 absolute right-4 top-1/2 -translate-y-1/2 z-10">
              <button type="button" onClick={() => advance(-1)} disabled={index === 0}
                className="w-9 h-9 rounded-full flex items-center justify-center bg-white/5 disabled:opacity-20 hover:bg-white/10 transition-colors">
                <ChevronUp className="w-4 h-4 text-white/70" />
              </button>
              <button type="button" onClick={() => advance(1)}
                className="w-9 h-9 rounded-full flex items-center justify-center bg-white/5 hover:bg-white/10 transition-colors">
                <ChevronDown className="w-4 h-4 text-white/70" />
              </button>
            </div>
          </>
        )}
      </div>
      {current && (
        <BottomBar
          p={current}
          liked={liked.has(current.ref)}
          favourited={favourited.has(current.ref)}
          onLike={() => like(current.ref)}
          onFavourite={() => favourite(current.ref)}
          onOpenDesc={() => setDescModalOpen(true)}
          photoIndex={photoIndex}
          photoTotal={current.images.length}
          allPhotosSeen={seenAllPhotos.has(current.ref)}
          properties={properties}
          currentIndex={index}
          pickedRefs={pickedRefs}
          onJumpDot={jump}
          onFinish={() => setIndex(total)}
        />
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 overflow-hidden flex flex-col" style={{ background: BG }}>
      <div
        className="hidden lg:block absolute inset-0 pointer-events-none"
        style={{ background: `radial-gradient(ellipse 1200px 800px at 50% 50%, rgba(184,149,63,0.08), transparent 70%)` }}
      />
      <div className="flex-1 min-h-0 flex items-stretch justify-center gap-10 xl:gap-16 2xl:gap-24 px-6 relative">
        <BrandPanel slideIndex={adIndex} />
        <div className="w-full lg:w-[440px] xl:w-[500px] 2xl:w-[560px] lg:my-6 lg:rounded-[28px] lg:overflow-hidden flex-shrink-0 lg:h-[calc(100%-48px)]">
          {Stage}
        </div>
        {total > 0 && !atEnd && (
          <ThumbGrid properties={properties} index={index} favourited={favouredFlags} onJump={jump} />
        )}
      </div>
      <DescriptionModal p={descModalOpen ? current : null} onClose={() => setDescModalOpen(false)} />
    </div>
  )
}
