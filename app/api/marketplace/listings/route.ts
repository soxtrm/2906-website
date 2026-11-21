// NEXUS Marketplace listings (2026-11-21): ARGUS inventory + places -> compact cards with Smart Intelligence.
// GET /api/marketplace/listings          all public cards
// GET /api/marketplace/listings?id=REF   one listing with all photos, description and the area overview
import { NextRequest, NextResponse } from 'next/server'
import { fetchNexusContext, type NexusPlace } from '@/lib/nexus-property-context'
import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import { toCard, toDetail, toDict, type Dict, type FeatureEntry, type ListingCard } from '@/lib/marketplace/model'

export const dynamic = 'force-dynamic'
// Freshness (Kev, 21 Nov 2026): listing data is operational, so caches are short and bounded: ARGUS inventory <= 60 s in
// memory, CDN 30 s + 60 s stale-while-revalidate (worst case about 2.5 min). The client also asks /status (uncached)
// for the cards on screen and for every opened home, so a newer Rented / Off-Market status always wins over a cached card.

// same public filter as /api/nexus/inventory: quarantined references and implausible rents never show
const QUARANTINED = new Set(['2906-9398'])
const publicListing = (p: Record<string, any>) => p && p.listable !== false && !QUARANTINED.has(String(p.id)) && !(p.market !== 'sales' && Number(p.rent) < 100)

let cache: { src: unknown; at: number; cards: ListingCard[] } | null = null
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

// The card headline uses the authoritative area. A preview that places the home "in"/"at" another known town
// (copied text, wrong template) is not shown on the card; the full text stays in the detail view.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]?")
function withConsistentTeasers(cards: ListingCard[]) {
  const areas = [...new Set(cards.map(c => c.area).filter(a => a && a !== 'Malta'))]
  return cards.map(c => {
    if (!c.teaser) return c
    const other = areas.find(a => a !== c.area && !c.area.includes(a) && !a.includes(c.area) &&
      new RegExp(`\\b(?:in|at|located in)\\s+(?:the\\s+heart\\s+of\\s+|central\\s+|sought[- ]after\\s+)?${esc(a)}\\b`, 'i').test(c.teaser!))
    return other ? { ...c, teaser: null } : c
  })
}

export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    const ctx = await fetchNexusContext({ inventoryMaxAgeMs: id ? 30e3 : 60e3 })
    const raw = (ctx.properties as unknown as Record<string, any>[]).filter(publicListing)
    const places = ctx.places as NexusPlace[]
    const dict = await dictionary()
    if (id) {
      const p = raw.find(x => String(x.id) === id)
      if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ listing: toDetail(p, places, dict) }, { headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' } })
    }
    if (!cache || cache.src !== ctx.properties) cache = { src: ctx.properties, at: Date.now(), cards: withConsistentTeasers(raw.map(p => toCard(p, places, dict))) }   // rebuilt whenever ARGUS data changed
    // searchable features: standard + filterable ones that at least one listing has
    const used = new Set(cache.cards.flatMap(c => c.featureKeys))
    const features = dict.entries.filter(e => e.filterable && used.has(e.key)).map(e => ({ key: e.key, label: e.label, group: e.group, aliases: e.aliases, count: cache!.cards.filter(c => c.featureKeys.includes(e.key)).length }))
    const quality = { previewHiddenForTownMismatch: cache.cards.filter(c => !c.teaser && raw.find(p => String(p.id) === c.id)?.description).length }
    return NextResponse.json({ generatedAt: new Date(cache.at).toISOString(), count: cache.cards.length, listings: cache.cards, features, quality },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } })
  } catch {
    return NextResponse.json({ error: 'Listings are not available right now.' }, { status: 503 })
  }
}
