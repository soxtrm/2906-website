// NEXUS CTO Cockpit live checks (2026-11-21): sanitized, no secrets. Which website build serves this request
// (Vercel git metadata) and whether the main user-facing endpoints answer right now.
import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

const PROBES = [
  ['Marketplace', 'https://nexusstudios.one/marketplace'],
  ['Marketplace API', 'https://nexusstudios.one/api/marketplace/listings'],
  ['Rooms', 'https://nexusstudios.one/marketplace/rooms'],
  ['NEXUS Sync', 'https://nexussync.one/owner'],
  ['ARGUS API', 'https://api.2906.estate/api/properties'],
  ['NEXUS Booking', 'https://nexuslink.fit/'],
  ['Benestates Work', 'https://benestates.work/api/ben/work-health'],
] as const

export async function GET() {
  const checks = await Promise.all(PROBES.map(async ([name, url]) => {
    const t0 = Date.now()
    try { const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) }); return { name, url, status: r.status, ms: Date.now() - t0 } }
    catch { return { name, url, status: 0, ms: Date.now() - t0 } }
  }))
  return NextResponse.json({
    at: new Date().toISOString(),
    build: { commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null, branch: process.env.VERCEL_GIT_COMMIT_REF || null, deployment: process.env.VERCEL_DEPLOYMENT_ID || null },
    checks,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
