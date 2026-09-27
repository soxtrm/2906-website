import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const response = await fetch('http://178.104.162.193/api/public/property-routing?view=curation', { next: { revalidate: 60 }, signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('Unavailable')
    return NextResponse.json(await response.json(), { headers: { 'Cache-Control': 'public, max-age=60' } })
  } catch {
    return NextResponse.json({ properties: [], status: 'UNKNOWN' }, { status: 503 })
  }
}
