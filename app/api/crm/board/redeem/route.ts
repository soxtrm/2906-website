import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001/api/crm'

// Board agents arrive here with a one-time token from their email. The backend
// checks it and hands back a board-audience JWT; this route is what turns that
// into the same HTTP-only crm_session cookie staff get from /api/crm/login, so
// the raw JWT never reaches client JS. Its own route rather than the catch-all
// proxy for exactly that reason — the catch-all cannot set cookies.
export async function POST(req: NextRequest) {
  const body = await req.text()
  let r: Response
  try {
    r = await fetch(`${VPS}/board/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch {
    return NextResponse.json({ error: 'Backend unavailable' }, { status: 503 })
  }
  const data = await r.json().catch(() => ({ error: 'Bad response' }))
  if (!r.ok || !data.token) {
    return NextResponse.json({ error: data.error || 'This link is not valid.' },
      { status: r.status || 401 })
  }
  const res = NextResponse.json({ agent: data.agent })
  res.cookies.set('crm_session', data.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // matches the 30d JWT the backend signed
  })
  return res
}
