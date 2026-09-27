import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get('ref') || ''
  const place = req.nextUrl.searchParams.get('place')
  if (!/^[A-Za-z0-9][\w-]{1,79}$/.test(ref) || (place && !/^(?:nexus-place:\d+|malta-overview-(?:valletta-gate|mdina|portomaso|tigne-point|golden-bay|cirkewwa))$/.test(place))) {
    return NextResponse.json({ status: 'UNKNOWN', reason: 'INVALID_REFERENCE' }, { status: 400 })
  }
  const url = new URL('http://178.104.162.193/api/public/property-routing')
  url.searchParams.set('ref', ref)
  if (req.nextUrl.searchParams.get('traffic') === '1') url.searchParams.set('traffic', '1')
  if (place) url.searchParams.set('place', place)
  url.searchParams.set('mode', ['car', 'bus'].includes(req.nextUrl.searchParams.get('mode') || '') ? req.nextUrl.searchParams.get('mode')! : 'walk')
  const traffic = req.nextUrl.searchParams.get('traffic') === '1' || req.nextUrl.searchParams.get('mode') === 'bus'
  try {
    const response = await fetch(url, { ...(traffic ? { cache: 'no-store' as const } : { next: { revalidate: 60 } }), signal: AbortSignal.timeout(25000) })
    return NextResponse.json(await response.json(), { status: response.status, headers: { 'Cache-Control': traffic ? 'no-store' : 'public, max-age=60' } })
  } catch {
    return NextResponse.json({ status: 'UNKNOWN', reason: 'ROUTING_UNAVAILABLE' }, { status: 503 })
  }
}
