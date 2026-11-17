import { NextRequest, NextResponse } from 'next/server'
import { ARGUS_ORIGIN } from '@/lib/argus-origin'

// Server-side call to the ARGUS backend on behalf of the signed-in CRM or Board user.
// The session lives in the HTTP-only `crm_session` cookie set by /api/crm/login; it is forwarded as a
// Bearer token and never reaches client JavaScript. Without a session nothing is sent to the backend.
export async function argusSessionFetch(req: NextRequest, path: string, init: { method?: string; body?: string } = {}) {
  const token = req.cookies.get('crm_session')?.value
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'cache-control': 'private, no-store' } })
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const xff = req.headers.get('x-forwarded-for')
  if (xff) headers['x-forwarded-for'] = xff
  const ua = req.headers.get('user-agent')
  if (ua) headers['user-agent'] = ua
  try {
    const res = await fetch(`${ARGUS_ORIGIN}${path}`, {
      method: init.method || 'GET', headers, body: init.body, cache: 'no-store', signal: AbortSignal.timeout(30000),
    })
    const data = await res.json().catch(() => ({ error: 'Bad response' }))
    return NextResponse.json(data, { status: res.status, headers: { 'cache-control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'Backend unavailable' }, { status: 503 })
  }
}
