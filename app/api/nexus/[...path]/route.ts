import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_ROUTES = new Set(['inventory', 'taxonomy', 'places'])
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join('/')
  if (!PUBLIC_ROUTES.has(path)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const response = await fetch(`http://178.104.162.193:3001/api/nexus/${path}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (!response.ok) return NextResponse.json({ error: 'Nexus inventory unavailable' }, { status: 503 })
    return NextResponse.json(await response.json(), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Nexus inventory unavailable' }, { status: 503 })
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join('/')
  if (path !== 'interest') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const response = await fetch('http://178.104.162.193:3001/api/nexus/interest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await req.json()),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })
    const body = await response.json().catch(() => ({ error: 'Could not save availability request' }))
    return NextResponse.json(body, { status: response.status, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Could not save availability request' }, { status: 503 })
  }
}
