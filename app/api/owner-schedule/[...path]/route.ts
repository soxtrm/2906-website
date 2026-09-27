import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001/api/public/owner-booking'
type Ctx = { params: Promise<{ path: string[] }> }

async function proxy(req: NextRequest, ctx: Ctx, method: string) {
  const path = (await ctx.params).path.map(encodeURIComponent).join('/')
  const body = method === 'GET' ? undefined : Buffer.from(await req.arrayBuffer())
  try {
    const r = await fetch(`${VPS}/${path}`, {
      method, body, cache: 'no-store', signal: AbortSignal.timeout(20000),
      headers: method === 'GET' ? {} : { 'content-type': req.headers.get('content-type') || 'application/json' },
    })
    return new NextResponse(await r.arrayBuffer(), {
      status: r.status,
      headers: { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'private, no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'Schedule unavailable' }, { status: 503 })
  }
}

export async function GET(req: NextRequest, ctx: Ctx) { return proxy(req, ctx, 'GET') }
export async function POST(req: NextRequest, ctx: Ctx) { return proxy(req, ctx, 'POST') }
