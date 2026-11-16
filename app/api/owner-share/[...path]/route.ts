import { NextRequest } from 'next/server'
import { OWNER_BACKEND, forward } from '@/lib/owner-portal/backend'

// Agent-facing share and request links: no session, no cookies forwarded.
type Ctx = { params: Promise<{ path: string[] }> }
async function handle(req: NextRequest, ctx: Ctx) {
  const path = (await ctx.params).path.map(encodeURIComponent).join('/')
  return forward(req, `${OWNER_BACKEND}/api/owner-share/${path}`)
}
export const GET = handle
export const POST = handle
