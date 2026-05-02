import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001/api/locations'

type Ctx = { params: Promise<{ path: string[] }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const path = (await ctx.params).path.join('/')
  const search = new URL(req.url).search
  try {
    const res = await fetch(`${VPS}/${path}${search}`, { cache: 'no-store' })
    const buf = await res.arrayBuffer()
    return new NextResponse(Buffer.from(buf), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
    })
  } catch {
    return NextResponse.json({ error: 'Backend unavailable' }, { status: 503 })
  }
}
