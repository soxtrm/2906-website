import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import { NextRequest, NextResponse } from 'next/server'

// HTTPS endpoints Meta calls (configured in the Meta app dashboard):
//   POST https://crm.2906.estate/api/meta/facebook/data-deletion   (User Data Deletion callback)
//   POST https://crm.2906.estate/api/meta/facebook/deauthorize     (Deauthorize callback)
//   GET  https://crm.2906.estate/api/meta/facebook/deletion-status?code=…  (status page data)
// The backend verifies Meta's signed_request; this route only relays the body.
const BACKEND = `${ARGUS_ORIGIN}/api/facebook-pages-meta`
const ACTIONS = new Set(['data-deletion', 'deauthorize'])

type Ctx = { params: Promise<{ action: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params
  if (!ACTIONS.has(action)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = Buffer.from(await req.arrayBuffer())
  if (body.length > 16_384) return NextResponse.json({ error: 'too large' }, { status: 413 })
  try {
    const r = await fetch(`${BACKEND}/${action}`, {
      method: 'POST', body, cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': req.headers.get('content-type') || 'application/x-www-form-urlencoded' },
    })
    return new NextResponse(Buffer.from(await r.arrayBuffer()), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'temporarily unavailable' }, { status: 503 })
  }
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params
  const code = new URL(req.url).searchParams.get('code') || ''
  if (action !== 'deletion-status' || !/^[0-9a-f]{24}$/.test(code)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const r = await fetch(`${BACKEND}/data-deletion/${code}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    return new NextResponse(Buffer.from(await r.arrayBuffer()), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'temporarily unavailable' }, { status: 503 })
  }
}
