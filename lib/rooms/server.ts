import 'server-only'
import { createHash, createHmac } from 'node:crypto'
import { ARGUS_ORIGIN } from '@/lib/argus-origin'

// NEXUS Rooms on the website (2026-11-21): ARGUS gives homes and rooms (public, no personal data);
// NEXUS Booking gives availability and takes requests. Booking calls are signed as client "web".
export type RoomUnit = {
  id: number; kind: 'room' | 'shared'; position: number; label: string; sharedType: string | null; status: 'on_market' | 'hold' | 'off_market' | 'occupied'
  priceMonth: number | null; priceNight: number | null; minStayMonths: number | null; maxOccupants: number | null; sizeSqm: number | null; sizeVerified: boolean
  privateBathroom: boolean; features: string[]; photos: string[]; description: string | null; availableFrom: string | null; span: [number, number] | null
}
export type RoomsHome = {
  propertyId: number; ref: string; town: string; type: string | null; bedrooms: number | null; bathrooms: number | null; photos: string[]; demo: boolean
  markets: string[]; rooms: RoomUnit[]; shared: RoomUnit[]; layout: { grid: { w: number; h: number }; blocks: { id: string; unitId: number | null; label: string | null; x: number; y: number; w: number; h: number; furniture: string[] }[]; note: string } | null
}
export type Block = { unitKey: string; span: [number, number]; checkIn: string; checkOut: string; status: 'held' | 'confirmed' }

const argus = (p: string) => fetch(`${ARGUS_ORIGIN}/api/nexus/rooms${p}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
export async function roomsList(demo = false): Promise<{ homes: (Omit<RoomsHome, 'layout'>)[] }> {
  const r = await argus(demo ? '/demo' : '')
  if (!r.ok) throw new Error('ARGUS rooms unavailable')
  return r.json()
}
export async function roomsHome(ref: string, demo = false): Promise<RoomsHome | null> {
  if (!/^[A-Za-z0-9-]{2,40}$/.test(ref)) return null
  const r = await argus(`${demo ? '/demo' : ''}/${encodeURIComponent(ref)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error('ARGUS rooms unavailable')
  return r.json()
}

function bookingBase() { return (process.env.NEXUS_BOOKING_ROOMS_URL || 'https://nexuslink.fit').replace(/\/+$/, '') }
async function booking(method: 'GET' | 'POST', path: string, payload?: unknown) {
  const secret = process.env.NEXUS_ROOMS_SECRET || ''
  if (secret.length < 32) return { status: 503, body: { error: 'BOOKING_NOT_CONFIGURED', message: 'Room bookings are not connected yet.' } }
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const digest = createHash('sha256').update(body).digest('hex')
  const sig = createHmac('sha256', secret).update(`${ts}.${method}.${path.split('?')[0]}.${digest}`).digest('hex')
  const r = await fetch(`${bookingBase()}${path}`, { method, cache: 'no-store', signal: AbortSignal.timeout(12000), headers: { 'content-type': 'application/json', 'X-Nexus-Rooms-Client': 'web', 'X-Nexus-Rooms-Ts': ts, 'X-Nexus-Rooms-Sig': sig }, body: body || undefined }).catch(() => null)
  if (!r) return { status: 503, body: { error: 'BOOKING_UNREACHABLE', message: 'NEXUS Booking is not reachable. Try again in a moment.' } }
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
export async function availability(ref: string): Promise<Block[] | null> {
  const r = await booking('GET', `/api/nexus-booking/rooms/availability?property=${encodeURIComponent(ref)}`)
  return r.status === 200 ? (r.body as { blocks: Block[] }).blocks : null
}
export const requestStay = (payload: unknown) => booking('POST', '/api/nexus-booking/rooms/requests', payload)

const today = () => new Date().toISOString().slice(0, 10)
// state of a room for a date: a booking stay that covers it wins, otherwise the owner's status
export function roomState(u: RoomUnit, blocks: Block[] | null, on = today()): 'available' | 'reserved' | 'occupied' {
  const hit = (blocks || []).find(b => b.checkIn <= on && on < b.checkOut && u.span && b.span[0] < u.span[1] && u.span[0] < b.span[1])
  if (hit) return hit.status === 'confirmed' ? 'occupied' : 'reserved'
  return u.status === 'occupied' ? 'occupied' : u.status === 'hold' ? 'reserved' : 'available'
}
