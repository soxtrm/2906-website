'use client'
// NEXUS Instant Marketplace (2026-11-21): everything a listing needs before the visitor asks for it.
// - detail data: bounded in-memory cache (LRU, 40 homes) + a small prefetch queue (2 at a time) fed by hover, focus,
//   touch and cards that stay on screen; never all listings at once
// - images: Cloudinary variants per slot (card 400/720, hero 960/1600) and a warm-up for the next hero
// - honest freshness: "Confirmed Today" only from ARGUS' explicit confirmation time, otherwise "Updated 2h Ago"
import type { Availability, ListingDetail } from '@/lib/marketplace/model'

// ---- freshness ------------------------------------------------------------------------------------------
const MALTA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' })
export function ago(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime(); if (!Number.isFinite(t)) return null
  if (MALTA.format(new Date(t)) === MALTA.format(new Date(now))) {
    const m = Math.max(0, Math.round((now - t) / 60e3))
    return m < 60 ? (m < 2 ? 'Just Now' : `${m}m Ago`) : `${Math.round(m / 60)}h Ago`
  }
  const d = Math.max(1, Math.round((now - t) / 86400e3))
  return d === 1 ? 'Yesterday' : d < 14 ? `${d}d Ago` : d < 60 ? `${Math.round(d / 7)} Wk Ago` : d < 365 ? `${Math.round(d / 30)} Mo Ago` : 'Over a Year Ago'
}
const isToday = (iso: string, now = Date.now()) => MALTA.format(new Date(iso)) === MALTA.format(new Date(now))
// "Available · Confirmed Today" | "Available · Confirmed 3d Ago" | "Available · Updated 2h Ago" | "From 12 Dec"
export function availabilityText(a: Availability, updatedAt: string | null, now = Date.now()) {
  if (a.kind === 'from') return { text: a.label, tone: 'from' as const, title: 'Not available yet' }
  if (a.confirmedAt) {
    const when = isToday(a.confirmedAt, now) ? 'Today' : ago(a.confirmedAt, now)
    return { text: `Available · Confirmed ${when}`, tone: 'confirmed' as const, title: `Availability confirmed with the owner or agency ${new Date(a.confirmedAt).toLocaleString('en-GB', { timeZone: 'Europe/Malta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` }
  }
  const u = ago(updatedAt, now)
  return { text: u ? `Available · Updated ${u}` : 'Available', tone: 'now' as const, title: 'Listed as available. Not yet re-confirmed with the owner.' }
}

// ---- images ---------------------------------------------------------------------------------------------
// listing photos come pre-sized (w_720 / w_1600, q_auto, f_auto); ask Cloudinary for the width each slot needs
export const width = (u: string, w: number) => u.replace(/\/image\/upload\/w_\d+,/, `/image/upload/w_${w},`)
export const cardSet = (u: string) => `${width(u, 400)} 400w, ${width(u, 720)} 720w`
export const heroSet = (u: string) => `${width(u, 960)} 960w, ${width(u, 1600)} 1600w`
const warmed = new Set<string>()
export function warm(u: string | undefined, w = 1600) {
  if (!u || typeof window === 'undefined') return
  const src = width(u, window.innerWidth < 900 ? 960 : w)
  if (warmed.has(src)) return
  warmed.add(src); const i = new Image(); i.decoding = 'async'; i.src = src
}

// ---- detail cache + prefetch queue ----------------------------------------------------------------------
const MAX = 40
const cache = new Map<string, ListingDetail>()
const inflight = new Map<string, Promise<ListingDetail | null>>()
const queue: string[] = []
let running = 0
const remember = (d: ListingDetail) => { cache.delete(d.id); cache.set(d.id, d); while (cache.size > MAX) cache.delete(cache.keys().next().value as string) }
export const cached = (id: string) => { const d = cache.get(id); if (d) { cache.delete(id); cache.set(id, d) } return d || null }
export function loadDetail(id: string): Promise<ListingDetail | null> {
  const hit = cached(id); if (hit) return Promise.resolve(hit)
  const busy = inflight.get(id); if (busy) return busy
  const p = fetch(`/api/marketplace/listings?id=${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : null))
    .then(d => { if (d?.listing) { remember(d.listing); return d.listing as ListingDetail } return null }).catch(() => null)
    .finally(() => inflight.delete(id))
  inflight.set(id, p); return p
}
function pump() {
  while (running < 2 && queue.length) {
    const id = queue.shift()!
    if (cache.has(id) || inflight.has(id)) continue
    running++; loadDetail(id).finally(() => { running--; pump() })
  }
}
// low priority: cards on screen. high priority (hover / focus / touch): jumps the queue and warms the hero photo
export function prefetch(id: string, hero?: string, urgent = false) {
  if (urgent) warm(hero)
  if (cache.has(id) || inflight.has(id)) return
  const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1)
  if (urgent) queue.unshift(id); else if (queue.length < 12) queue.push(id)
  pump()
}
