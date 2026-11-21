// SYNC owner API for the nexussync.one frontend. Keeps the session in an
// httpOnly cookie and forwards to the signed ARGUS SYNC account service.
import { NextRequest, NextResponse } from 'next/server'
import { argus, clientIp, cookieOptions, sameOrigin, SESSION_COOKIE } from '@/lib/sync/server'

export const dynamic = 'force-dynamic'

// op → ARGUS path; `session` ops get the cookie's session, `issue` ops set it
const OPS: Record<string, { path: string; session?: boolean; issue?: boolean; end?: boolean }> = {
  signup: { path: '/signup', issue: true },
  login: { path: '/login', issue: true },
  logout: { path: '/logout', session: true, end: true },
  'login/phone/start': { path: '/login/phone/start' },
  'login/phone/status': { path: '/login/phone/status', issue: true },
  prefs: { path: '/prefs', session: true },
  'owner/viewings': { path: '/owner/viewings', session: true },
  'owner/viewings/decide': { path: '/owner/viewings/decide', session: true },
  'owner/hours': { path: '/owner/hours', session: true },
  'owner/window/add': { path: '/owner/window/add', session: true },
  'owner/window/remove': { path: '/owner/window/remove', session: true },
  // calendar 2.0 (2026-11-21): ranges (move / resize / weekly), own appointments, slot length
  'owner/cal': { path: '/owner/cal', session: true },
  'owner/cal/window/add': { path: '/owner/cal/window/add', session: true },
  'owner/cal/window/update': { path: '/owner/cal/window/update', session: true },
  'owner/cal/appointment': { path: '/owner/cal/appointment', session: true },
  'owner/cal/appointment/cancel': { path: '/owner/cal/appointment/cancel', session: true },
  'owner/cal/slot': { path: '/owner/cal/slot', session: true },
  'owner/conditions': { path: '/owner/conditions', session: true },
  'owner/conditions/set': { path: '/owner/conditions/set', session: true },
  'owner/conditions/decide': { path: '/owner/conditions/decide', session: true },
  'owner/activity': { path: '/owner/activity', session: true },
  'owner/features': { path: '/owner/features', session: true },
  'owner/features/suggest': { path: '/owner/features/suggest', session: true },
  'owner/features/set': { path: '/owner/features/set', session: true },
  'owner/features/remove': { path: '/owner/features/remove', session: true },
  'delegates': { path: '/delegates', session: true },
  'delegates/invite': { path: '/delegates/invite', session: true },
  'delegates/update': { path: '/delegates/update', session: true },
  'delegates/revoke': { path: '/delegates/revoke', session: true },
  'invites/accept': { path: '/invites/accept', session: true },
  'invites/decline': { path: '/invites/decline', session: true },
  'documents': { path: '/documents', session: true },
  'documents/upload': { path: '/documents/upload', session: true },
  'documents/file': { path: '/documents/file', session: true },
  'documents/share': { path: '/documents/share', session: true },
  'documents/delete': { path: '/documents/delete', session: true },
  'invites/preview': { path: '/invites/preview' },
  me: { path: '/me', session: true },
  'account/update': { path: '/account/update', session: true },
  'email/start': { path: '/email/start', session: true },
  'email/confirm': { path: '/email/confirm', session: true },
  'phone/start': { path: '/phone/start', session: true },
  'phone/status': { path: '/phone/status', session: true },
  'claims/decide': { path: '/claims/decide', session: true },
  'owner/event': { path: '/owner/event', session: true },
  messages: { path: '/messages', session: true },
  'messages/send': { path: '/messages/send', session: true },
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string[] }> }) {
  const op = (await ctx.params).op.join('/')
  const spec = OPS[op]
  if (!spec) return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 })
  if (!sameOrigin(req.headers)) return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 })
  const input = await req.json().catch(() => ({})) as Record<string, unknown>
  delete input.session
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (spec.session && !token) {
    if (spec.end) { const r = NextResponse.json({ ok: true }); r.cookies.delete(SESSION_COOKIE); return r }
    return NextResponse.json({ ok: false, error: 'SESSION_INVALID', message: 'Please sign in.' }, { status: 401 })
  }
  const body: Record<string, unknown> = { ...input, userAgent: (req.headers.get('user-agent') || '').slice(0, 200) }
  if (spec.session) body.session = token
  const { status, body: out } = await argus(spec.path, body, clientIp(req.headers))
  const session = (out as { session?: { token?: string; maxAgeSeconds?: number } }).session
  delete (out as { session?: unknown }).session
  const res = NextResponse.json(out, { status, headers: { 'Cache-Control': 'no-store' } })
  if (spec.issue && session?.token) res.cookies.set(SESSION_COOKIE, session.token, cookieOptions(session.maxAgeSeconds || 30 * 86400))
  if (spec.end || status === 401) res.cookies.delete(SESSION_COOKIE)
  return res
}
