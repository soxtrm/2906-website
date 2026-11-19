// Facebook sign-in for SYNC: sends the owner to Facebook's dialog. The code
// comes back to /api/auth/facebook/callback on the apex domain, where ARGUS
// exchanges it with the app secret (the secret never reaches this server).
import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
const CALLBACK = 'https://nexussync.one/api/auth/facebook/callback'

export async function GET(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase()
  // state cookie and callback must live on the same host
  if (host === 'www.nexussync.one') return NextResponse.redirect('https://nexussync.one/api/auth/facebook/start', 302)
  const appId = (process.env.SYNC_FB_APP_ID || '1123354370462124').replace(/\D/g, '')
  const state = randomBytes(24).toString('base64url')
  const next = req.nextUrl.searchParams.get('next') === 'login' ? 'login' : 'signup'
  const url = `https://www.facebook.com/v21.0/dialog/oauth?${new URLSearchParams({ client_id: appId, redirect_uri: CALLBACK, state, scope: 'email,public_profile', response_type: 'code' })}`
  const res = NextResponse.redirect(url, 302)
  res.cookies.set('sync_fb_state', `${state}.${next}`, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/facebook', maxAge: 600 })
  return res
}
