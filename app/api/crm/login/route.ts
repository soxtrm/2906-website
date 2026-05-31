import { NextRequest, NextResponse } from 'next/server'

const VPS = 'http://178.104.162.193:3001/api/crm'

// Browser posts credentials here (same origin). We call the backend, then store
// the JWT in an HTTP-only cookie so it is never exposed to client JS.
export async function POST(req: NextRequest) {
  const body = await req.text()
  let r: Response
  try {
    r = await fetch(`${VPS}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch {
    return NextResponse.json({ error: 'Backend unavailable' }, { status: 503 })
  }
  const data = await r.json().catch(() => ({ error: 'Bad response' }))
  if (!r.ok || !data.token) {
    return NextResponse.json({ error: data.error || 'Login failed' }, { status: r.status || 401 })
  }
  const res = NextResponse.json({ agent: data.agent })
  res.cookies.set('crm_session', data.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  return res
}
