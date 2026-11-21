import { NextRequest, NextResponse } from 'next/server'
import { roomsList } from '@/lib/rooms/server'

// NEXUS Marketplace: homes let room by room (ARGUS). ?demo=1 → the labelled demonstration home only.
export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
  try {
    const out = await roomsList(req.nextUrl.searchParams.get('demo') === '1')
    return NextResponse.json(out, { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } })
  } catch { return NextResponse.json({ error: 'UNAVAILABLE', message: 'Rooms are not available right now.' }, { status: 503 }) }
}
