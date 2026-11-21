import { NextRequest, NextResponse } from 'next/server'
import { requestStay, roomsHome } from '@/lib/rooms/server'

// A booking or viewing request for one room, saved in NEXUS Booking (the reservation engine).
// The room, its span and its label come from ARGUS, never from the browser. Nothing is confirmed here:
// the owner (or the agency) holds, confirms or declines it; a viewing request is never a tenancy.
export const dynamic = 'force-dynamic'
const iso = (d: Date) => d.toISOString().slice(0, 10)
function addMonths(day: string, n: number) { const d = new Date(`${day}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return iso(d) }

export async function POST(req: NextRequest, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params
  const b = await req.json().catch(() => ({})) as Record<string, any>
  const demo = req.nextUrl.searchParams.get('demo') === '1'
  const home = await roomsHome(decodeURIComponent(ref), demo).catch(() => null)
  if (!home) return NextResponse.json({ error: 'NOT_FOUND', message: 'This home is not let room by room.' }, { status: 404 })
  const room = home.rooms.find(r => r.id === Number(b.unitId))
  if (!room || !room.span) return NextResponse.json({ error: 'ROOM_NOT_FOUND', message: 'Choose one of the rooms.' }, { status: 400 })
  if (room.status === 'off_market' || room.status === 'occupied') return NextResponse.json({ error: 'NOT_AVAILABLE', message: `${room.label} is not available.` }, { status: 409 })
  const kind = b.kind === 'viewing' ? 'viewing' : 'booking'
  const checkIn = /^\d{4}-\d{2}-\d{2}$/.test(String(b.checkIn || '')) ? String(b.checkIn) : ''
  const short = home.markets.includes('short_let') && b.market === 'short_let'
  const months = Math.max(room.minStayMonths || 1, Math.min(36, Math.round(Number(b.months) || room.minStayMonths || 6)))
  const checkOut = kind === 'booking' ? (short ? String(b.checkOut || '') : (checkIn ? addMonths(checkIn, months) : '')) : undefined
  const r = await requestStay({
    propertyRef: home.ref, unitKey: `room:${room.id}`, unitLabel: room.label, span: room.span, kind, market: short ? 'short_let' : 'long_let',
    checkIn, checkOut, partySize: Number(b.partySize) || undefined, note: String(b.note || '').slice(0, 1000),
    guest: { name: String(b.name || '').slice(0, 120), email: String(b.email || '').slice(0, 254), phone: String(b.phone || '').slice(0, 32) },
    source: demo ? 'marketplace-demo' : 'marketplace', idempotencyKey: /^[A-Za-z0-9_-]{8,64}$/.test(String(b.key || '')) ? b.key : undefined,
  })
  if (r.status >= 300 && r.status !== 409 && r.status !== 400) return NextResponse.json(r.body, { status: r.status })
  if (r.status !== 200 && r.status !== 201) return NextResponse.json(r.body, { status: r.status })
  const s = (r.body as any).stay
  return NextResponse.json({ ok: true, stay: { id: s.id, status: s.status, kind: s.kind, room: s.unitLabel, checkIn: s.checkIn, checkOut: s.checkOut } }, { status: 201 })
}
