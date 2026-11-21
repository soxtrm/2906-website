import { NextRequest, NextResponse } from 'next/server'
import { availability, roomState, roomsHome } from '@/lib/rooms/server'

// One home let room by room: rooms and shared spaces from ARGUS, availability from NEXUS Booking.
export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params
  const demo = req.nextUrl.searchParams.get('demo') === '1'
  try {
    const home = await roomsHome(decodeURIComponent(ref), demo)
    if (!home) return NextResponse.json({ error: 'NOT_FOUND', message: 'This home is not let room by room.' }, { status: 404 })
    const blocks = await availability(home.ref)
    return NextResponse.json({
      home: { ...home, rooms: home.rooms.map(r => ({ ...r, state: roomState(r, blocks) })) },
      blocks: (blocks || []).map(b => ({ unitKey: b.unitKey, span: b.span, checkIn: b.checkIn, checkOut: b.checkOut, status: b.status })),
      bookingOnline: blocks !== null,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return NextResponse.json({ error: 'UNAVAILABLE', message: 'This home cannot be loaded right now.' }, { status: 503 }) }
}
