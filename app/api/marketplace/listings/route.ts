// NEXUS Marketplace listings (2026-11-21): ARGUS inventory + places -> compact cards with Smart Intelligence.
// GET /api/marketplace/listings          all public cards
// GET /api/marketplace/listings?id=REF   one listing with all photos, description and the area overview
import { NextRequest, NextResponse } from 'next/server'
import { fetchNexusContext, type NexusPlace } from '@/lib/nexus-property-context'
import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import { toCard, toDetail, toDict, type Dict, type FeatureEntry, type ListingCard } from '@/lib/marketplace/model'

export const dynamic = 'force-dynamic'

// same public filter as /api/nexus/inventory: quarantined references and implausible rents never show
const QUARANTINED = new Set(['2906-9398'])
const publicListing = (p: Record<string, any>) => p && p.listable !== false && !QUARANTINED.has(String(p.id)) && !(p.market !== 'sales' && Number(p.rent) < 100)

let cache: { at: number; cards: ListingCard[] } | null = null
let dictCache: { at: number; dict: Dict } | null = null
async function dictionary(): Promise<Dict> {
  if (dictCache && Date.now() - dictCache.at < 10 * 60e3) return dictCache.dict
  try {
    const r = await fetch(`${process.env.NEXUS_UPSTREAM_URL || ARGUS_ORIGIN}/api/nexus/features`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    const d = r.ok ? await r.json() : { features: [] }
    const entries = (d.features || []).map((f: FeatureEntry & { argus_tag?: string }) => ({ key: f.key, label: f.label, group: f.group, kind: f.kind, filterable: !!f.filterable, aliases: f.aliases || [], argusTag: f.argus_tag || null }))
    dictCache = { at: Date.now(), dict: toDict(entries) }
  } catch { dictCache = dictCache || { at: Date.now(), dict: { entries: [], byTag: {} } } }
  return dictCache.dict
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await fetchNexusContext()
    const raw = (ctx.properties as unknown as Record<string, any>[]).filter(publicListing)
    const places = ctx.places as NexusPlace[]
    const dict = await dictionary()
    const id = req.nextUrl.searchParams.get('id')
    if (id) {
      const p = raw.find(x => String(x.id) === id)
      if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ listing: toDetail(p, places, dict) }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } })
    }
    if (!cache || Date.now() - cache.at > 5 * 60e3) cache = { at: Date.now(), cards: raw.map(p => toCard(p, places, dict)) }
    // searchable features: standard + filterable ones that at least one listing has
    const used = new Set(cache.cards.flatMap(c => c.featureKeys))
    const features = dict.entries.filter(e => e.filterable && used.has(e.key)).map(e => ({ key: e.key, label: e.label, aliases: e.aliases, count: cache!.cards.filter(c => c.featureKeys.includes(e.key)).length }))
    return NextResponse.json({ generatedAt: new Date(cache.at).toISOString(), count: cache.cards.length, listings: cache.cards, features },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } })
  } catch {
    return NextResponse.json({ error: 'Listings are not available right now.' }, { status: 503 })
  }
}
