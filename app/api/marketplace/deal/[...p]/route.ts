// NEXUS Deal Room, client proxy (2026-11-21): /api/marketplace/deal/<conversation>[/documents[/<id>]] -> ARGUS
// /api/nexus/mp-deal/... with the visitor's conversation token. Uploads are JSON (base64, up to ~3 MB through Vercel);
// downloads stream the private file back with no caching.
import { NextRequest, NextResponse } from 'next/server'
import { ARGUS_ORIGIN } from '@/lib/argus-origin'

export const dynamic = 'force-dynamic'
const ALLOWED = /^[0-9a-f-]{36}(\/documents(\/\d{1,12})?)?$/i

async function forward(req: NextRequest, ctx: { params: Promise<{ p: string[] }> }, method: 'GET' | 'POST') {
  const path = (await ctx.params).p.join('/')
  if (!ALLOWED.test(path)) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const token = req.headers.get('x-mp-token'); if (token) headers['x-mp-token'] = token.slice(0, 80)
  try {
    const r = await fetch(`${ARGUS_ORIGIN}/api/nexus/mp-deal/${path}`, {
      method, headers, cache: 'no-store', signal: AbortSignal.timeout(30000),
      body: method === 'POST' ? await req.text() : undefined,
    })
    const ct = r.headers.get('content-type') || ''
    if (!ct.includes('application/json')) {   // a document download
      return new NextResponse(r.body, { status: r.status, headers: { 'content-type': ct, 'content-disposition': r.headers.get('content-disposition') || 'attachment', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
    }
    return NextResponse.json(await r.json(), { status: r.status, headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE', message: 'The Deal Room is not available right now. Please try again.' }, { status: 503 })
  }
}
export const GET = (req: NextRequest, ctx: { params: Promise<{ p: string[] }> }) => forward(req, ctx, 'GET')
export const POST = (req: NextRequest, ctx: { params: Promise<{ p: string[] }> }) => forward(req, ctx, 'POST')
