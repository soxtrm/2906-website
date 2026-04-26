import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001/api/admin'

async function proxy(req: NextRequest, pathSegments: string[], method: string) {
  const path = pathSegments.join('/')
  const search = new URL(req.url).search
  const target = `${VPS}/${path}${search}`

  const headers: Record<string, string> = {}
  const auth = req.headers.get('authorization')
  if (auth) headers['authorization'] = auth

  const ct = req.headers.get('content-type')
  if (ct) headers['content-type'] = ct

  const body = method !== 'GET' && method !== 'DELETE'
    ? Buffer.from(await req.arrayBuffer())
    : undefined

  try {
    const vpsRes = await fetch(target, { method, headers, body })
    const buf = await vpsRes.arrayBuffer()
    return new NextResponse(Buffer.from(buf), {
      status: vpsRes.status,
      headers: { 'content-type': vpsRes.headers.get('content-type') || 'application/json' },
    })
  } catch {
    return NextResponse.json({ error: 'Backend unavailable' }, { status: 503 })
  }
}

type Ctx = { params: Promise<{ path: string[] }> }
export async function GET(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path, 'GET') }
export async function POST(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path, 'POST') }
export async function PATCH(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path, 'PATCH') }
export async function DELETE(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path, 'DELETE') }
