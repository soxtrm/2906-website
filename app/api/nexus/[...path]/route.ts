import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_ROUTES = new Set(['inventory', 'taxonomy'])
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
