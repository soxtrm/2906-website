import { NextRequest, NextResponse } from 'next/server'
import { OWNER_BACKEND, OWNER_COOKIE } from '@/lib/owner-portal/backend'

// Exchanges a one-time owner invitation for a server-side session. The session
// token lives only in an httpOnly cookie, separate from the staff crm_session.
export async function POST(req: NextRequest) {
  const body = await req.text()
  let r: Response
  try {
    r = await fetch(`${OWNER_BACKEND}/api/owner-portal/session/claim`, {
      method: 'POST', body, cache: 'no-store',
      headers: { 'content-type': 'application/json', 'user-agent': req.headers.get('user-agent') || '' },
    })
  } catch {
    return NextResponse.json({ error: 'The owner portal is unavailable.' }, { status: 503 })
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok || !data.sessionToken) return NextResponse.json({ error: data.error || 'This link is not valid any more.', code: data.code }, { status: r.status || 400 })
  const res = NextResponse.json({ ok: true, delegate: !!data.delegate })
  res.cookies.set(OWNER_COOKIE, data.sessionToken, {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/',
    maxAge: Math.max(60, Math.floor((Date.parse(data.expiresAt) - Date.now()) / 1000)),
  })
  return res
}

export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(OWNER_COOKIE)?.value
  if (token) await fetch(`${OWNER_BACKEND}/api/owner-portal/session/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => {})
  const res = NextResponse.json({ ok: true })
  res.cookies.set(OWNER_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0 })
  return res
}
