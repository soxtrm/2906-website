import createMiddleware from 'next-intl/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { routing } from './i18n/routing'

const intlMiddleware = createMiddleware(routing)

// The bot backend, same origin CLAUDE.md documents for /app/api/* proxying.
const BACKEND = process.env.BACKEND_ORIGIN || 'http://178.104.162.193:3001'

// Agent Workspace short links (2906.estate/<slug>, e.g. "/493katya" — see
// services/agentWorkspace.js:generateShortSlugCandidate on the backend).
// Digit-led on purpose: no real page route or locale code starts with a
// digit, so this can never shadow existing content. Gated server-side by
// AGENT_WORKSPACE_ENABLED — a disabled backend just 404s the rewritten
// request, same as visiting it directly.
const SHORT_SLUG_RE = /^\/\d{2,6}[a-z0-9]{1,20}$/

// Next.js 16 "proxy" (formerly middleware).
// Public site (2906.estate / other hosts): delegate to next-intl exactly as before.
// CRM subdomain (crm.2906.estate): rewrite to the /crm/* route group, no i18n.
export default function proxy(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase()
  const { pathname } = req.nextUrl

  if (host.startsWith('crm.')) {
    if (pathname.startsWith('/crm')) return NextResponse.next()
    const url = req.nextUrl.clone()
    url.pathname = pathname === '/' ? '/crm' : `/crm${pathname}`
    return NextResponse.rewrite(url)
  }

  // Direct /crm access: bypass i18n. Hidden on the real public domain,
  // but reachable on preview/tunnel hosts (vercel.app, *.loca.lt, etc.).
  if (pathname === '/crm' || pathname.startsWith('/crm/')) {
    const PUBLIC = ['2906.estate', 'www.2906.estate']
    if (PUBLIC.includes(host)) return new NextResponse('Not found', { status: 404 })
    return NextResponse.next()
  }

  // Agent Workspace: the page's own script calls back to /agent-workspace/*
  // with relative fetches (todo/note/publish), so that whole prefix has to
  // proxy through too, not just the initial page load.
  if (pathname.startsWith('/agent-workspace/')) {
    return NextResponse.rewrite(new URL(pathname + req.nextUrl.search, BACKEND))
  }
  if (SHORT_SLUG_RE.test(pathname)) {
    return NextResponse.rewrite(new URL('/workspace' + pathname, BACKEND))
  }

  // Unchanged public-site behaviour.
  return intlMiddleware(req)
}

export const config = {
  // Exclude /admin, /api, static files from locale routing (unchanged from original).
  matcher: ['/((?!admin|api|_next|_vercel|uploads|.*\\..*).*)'],
}
