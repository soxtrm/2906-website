import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001/api/crm'

// Generic authenticated proxy: reads the HTTP-only session cookie and forwards
// it to the backend as a Bearer token (server-to-server, so no CORS/credentials
// issues). Also forwards client IP + UA so the backend can log PII reveals.
async function proxy(req: NextRequest, segments: string[], method: string) {
  const path = segments.join('/')
  const search = new URL(req.url).search
  const token = req.cookies.get('crm_session')?.value

  const headers: Record<string, string> = {}
  if (token) headers['authorization'] = `Bearer ${token}`
  const ct = req.headers.get('content-type')
  if (ct) headers['content-type'] = ct
  const xff = req.headers.get('x-forwarded-for')
  if (xff) headers['x-forwarded-for'] = xff
  const xri = req.headers.get('x-real-ip')
  if (xri) headers['x-real-ip'] = xri
  const ua = req.headers.get('user-agent')
  if (ua) headers['user-agent'] = ua

  const body = method !== 'GET' && method !== 'DELETE'
    ? Buffer.from(await req.arrayBuffer())
    : undefined

  try {
    const vpsRes = await fetch(`${VPS}/${path}${search}`, { method, headers, body })
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
