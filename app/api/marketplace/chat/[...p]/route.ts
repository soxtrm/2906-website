// NEXUS Marketplace chat proxy (2026-11-21): the browser talks to /api/marketplace/chat/*, this forwards to ARGUS
// /api/nexus/mp/* with the visitor's conversation token (X-MP-Token) and the client IP for rate limiting.
import { NextRequest, NextResponse } from 'next/server'
import { ARGUS_ORIGIN } from '@/lib/argus-origin'

export const dynamic = 'force-dynamic'
const ALLOWED = /^conversations(\/[0-9a-f-]{36}(\/(messages|viewing))?)?$/i

async function forward(req: NextRequest, ctx: { params: Promise<{ p: string[] }> }, method: 'GET' | 'POST') {
  const path = (await ctx.params).p.join('/')
  if (!ALLOWED.test(path)) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const token = req.headers.get('x-mp-token'); if (token) headers['x-mp-token'] = token.slice(0, 80)
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || ''
  if (ip) headers['x-mp-client-ip'] = ip
  try {
    const r = await fetch(`${ARGUS_ORIGIN}/api/nexus/mp/${path}`, {
      method, headers, cache: 'no-store', signal: AbortSignal.timeout(20000),
      body: method === 'POST' ? JSON.stringify(await req.json().catch(() => ({}))) : undefined,
    })
    const body = await r.json().catch(() => ({ ok: false, error: 'FAILED', message: 'No answer from the agency system.' }))
    return NextResponse.json(body, { status: r.status, headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE', message: 'Messages are not available right now. Please try again.' }, { status: 503 })
  }
}
export const GET = (req: NextRequest, ctx: { params: Promise<{ p: string[] }> }) => forward(req, ctx, 'GET')
export const POST = (req: NextRequest, ctx: { params: Promise<{ p: string[] }> }) => forward(req, ctx, 'POST')
