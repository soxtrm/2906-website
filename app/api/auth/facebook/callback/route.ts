import { NextRequest, NextResponse } from 'next/server'
import { argus, clientIp, cookieOptions, SESSION_COOKIE } from '@/lib/sync/server'

export const dynamic = 'force-dynamic'
const CALLBACK = 'https://nexussync.one/api/auth/facebook/callback'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  const [state, next] = (req.cookies.get('sync_fb_state')?.value || '').split('.')
  const back = (path: string) => {
    const r = NextResponse.redirect(new URL(path, 'https://nexussync.one'), 302)
    r.cookies.delete({ name: 'sync_fb_state', path: '/api/auth/facebook' })
    return r
  }
  if (!state || q.get('state') !== state) return back('/login?error=facebook_state')
  if (q.get('error') || !q.get('code')) return back(`/${next === 'login' ? 'login' : 'signup'}?error=facebook_cancelled`)
  const { status, body } = await argus('/social', {
    provider: 'facebook', code: q.get('code'), redirectUri: CALLBACK,
    session: req.cookies.get(SESSION_COOKIE)?.value, userAgent: (req.headers.get('user-agent') || '').slice(0, 200),
  }, clientIp(req.headers))
  const session = (body as { session?: { token?: string; maxAgeSeconds?: number } }).session
  if (status !== 200 || !session?.token) return back(`/${next === 'login' ? 'login' : 'signup'}?error=facebook`)
  const account = (body as { account?: { phone?: { verified?: boolean } | null } }).account
  const r = back(account?.phone?.verified ? '/?welcome=1' : '/signup?step=phone')
  r.cookies.set(SESSION_COOKIE, session.token, cookieOptions(session.maxAgeSeconds || 30 * 86400))
  return r
}
