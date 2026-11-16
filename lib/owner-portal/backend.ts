// Server-only helpers for the owner-portal route handlers.
// OWNER_PORTAL_BACKEND lets a test or staging run point at another backend;
// production uses the same origin as every other app/api proxy.
export const OWNER_BACKEND = (process.env.OWNER_PORTAL_BACKEND || 'http://178.104.162.193:3001').replace(/\/$/, '')
export const OWNER_COOKIE = 'argus_owner_session'

const PASS_HEADERS = ['content-type', 'x-media-kind', 'x-filename', 'x-visibility', 'user-agent']

export async function forward(req: Request, target: string, bearer?: string) {
  const headers: Record<string, string> = {}
  for (const h of PASS_HEADERS) { const v = req.headers.get(h); if (v) headers[h] = v }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const method = req.method
  const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer())
  try {
    const r = await fetch(target, { method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(30000) })
    const out = new Headers({ 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' })
    for (const h of ['content-type', 'content-disposition', 'x-content-type-options']) { const v = r.headers.get(h); if (v) out.set(h, v) }
    return new Response(await r.arrayBuffer(), { status: r.status, headers: out })
  } catch {
    return Response.json({ error: 'The owner portal is unavailable. Nothing was changed.', code: 'UNAVAILABLE' }, { status: 503 })
  }
}
