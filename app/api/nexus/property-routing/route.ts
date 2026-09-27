import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('ref') || ''
  const place = req.nextUrl.searchParams.get('place')
  if (!/^[A-Za-z0-9][\w-]{1,79}$/.test(ref) || (place && !/^nexus-place:\d+$/.test(place))) {
    return NextResponse.json({ status: 'UNKNOWN', reason: 'INVALID_REFERENCE' }, { status: 400 })
  }
  const url = new URL('http://178.104.162.193/api/public/property-routing')
  url.searchParams.set('ref', ref)
  if (place) url.searchParams.set('place', place)
  url.searchParams.set('mode', req.nextUrl.searchParams.get('mode') === 'car' ? 'car' : 'walk')
  try {
    const response = await fetch(url, { next: { revalidate: 60 }, signal: AbortSignal.timeout(25000) })
    return NextResponse.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'public, max-age=60' } })
  } catch {
    return NextResponse.json({ status: 'UNKNOWN', reason: 'ROUTING_UNAVAILABLE' }, { status: 503 })
  }
}
