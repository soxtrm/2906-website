// NEXUS Marketplace listings (2026-11-21): ARGUS inventory + places -> compact cards with Smart Intelligence.
// GET /api/marketplace/listings          all public cards
// GET /api/marketplace/listings?id=REF   one listing with all photos, description and the area overview
import { NextRequest, NextResponse } from 'next/server'
import { fetchNexusContext, type NexusPlace } from '@/lib/nexus-property-context'
import { toCard, toDetail, type ListingCard } from '@/lib/marketplace/model'

export const dynamic = 'force-dynamic'

// same public filter as /api/nexus/inventory: quarantined references and implausible rents never show
const QUARANTINED = new Set(['2906-9398'])
const publicListing = (p: Record<string, any>) => p && p.listable !== false && !QUARANTINED.has(String(p.id)) && !(p.market !== 'sales' && Number(p.rent) < 100)

let cache: { at: number; cards: ListingCard[] } | null = null

export async function GET(req: NextRequest) {
  try {
    const ctx = await fetchNexusContext()
    const raw = (ctx.properties as unknown as Record<string, any>[]).filter(publicListing)
    const places = ctx.places as NexusPlace[]
    const id = req.nextUrl.searchParams.get('id')
    if (id) {
      const p = raw.find(x => String(x.id) === id)
      if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ listing: toDetail(p, places) }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } })
    }
    if (!cache || Date.now() - cache.at > 5 * 60e3) cache = { at: Date.now(), cards: raw.map(p => toCard(p, places)) }
    return NextResponse.json({ generatedAt: new Date(cache.at).toISOString(), count: cache.cards.length, listings: cache.cards },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } })
  } catch {
    return NextResponse.json({ error: 'Listings are not available right now.' }, { status: 503 })
  }
}
