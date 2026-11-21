// NEXUS Marketplace live status (2026-11-21): GET /api/marketplace/status?ids=2906-039,2906-9202
// Uncached answer from an ARGUS inventory at most 15 s old: is each home still listed, its price and availability.
// The client applies it over cached cards and over every opened home, so a cached "Available" can never hide a newer
// Rented / Off-Market status. Only public fields; at most 40 ids per call.
import { NextRequest, NextResponse } from 'next/server'
import { fetchNexusInventory } from '@/lib/nexus-property-context'
import { liveStatusOf, type LiveStatus } from '@/lib/marketplace/model'

export const dynamic = 'force-dynamic'
const QUARANTINED = new Set(['2906-9398'])
const publicListing = (p: Record<string, any>) => p && p.listable !== false && !QUARANTINED.has(String(p.id)) && !(p.market !== 'sales' && Number(p.rent) < 100)

export async function GET(req: NextRequest) {
  const ids = [...new Set((req.nextUrl.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9-]{3,40}$/.test(s)))].slice(0, 40)
  if (!ids.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })
  try {
    const raw = (await fetchNexusInventory(15e3)) as unknown as Record<string, any>[]
    const byId = new Map(raw.map(p => [String(p.id), p]))
    const status: Record<string, LiveStatus> = {}
    for (const id of ids) { const p = byId.get(id); status[id] = liveStatusOf(p, !!p && publicListing(p)) }
    return NextResponse.json({ at: new Date().toISOString(), status }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Status not available right now.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
