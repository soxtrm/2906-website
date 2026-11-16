import { NextRequest } from 'next/server'
import { OWNER_BACKEND, OWNER_COOKIE, forward } from '@/lib/owner-portal/backend'

type Ctx = { params: Promise<{ path: string[] }> }
async function handle(req: NextRequest, ctx: Ctx) {
  const path = (await ctx.params).path.map(encodeURIComponent).join('/')
  if (path.startsWith('session')) return Response.json({ error: 'Not found' }, { status: 404 })
  const search = new URL(req.url).search
  return forward(req, `${OWNER_BACKEND}/api/owner-portal/${path}${search}`, req.cookies.get(OWNER_COOKIE)?.value)
}
export const GET = handle
export const POST = handle
export const PUT = handle
export const DELETE = handle
