import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import createMiddleware from 'next-intl/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { routing } from './i18n/routing'

const intlMiddleware = createMiddleware(routing)

// Same origin every app/api/*/route.ts proxies to.
const BACKEND = ARGUS_ORIGIN

// Agent Workspace short links (2906.estate/<slug>, e.g. "/493katya" — see
// services/agentWorkspace.js:generateShortSlugCandidate on the backend).
// Digit-led on purpose: no real page route or locale code starts with a
// digit, so this can never shadow existing content. Gated server-side by
// AGENT_WORKSPACE_ENABLED — a disabled backend just 404s the rewritten
// request, same as visiting it directly.
const SHORT_SLUG_RE = /^\/\d{2,6}[a-z0-9]{1,20}$/

const STUDIOS_HOSTS = new Set(['nexusstudios.one', 'www.nexusstudios.one'])
const MP_HOSTS = new Set(['nexusmp.one', 'www.nexusmp.one'])

// Next.js 16 "proxy" (formerly middleware).
// Public site (2906.estate / other hosts): delegate to next-intl exactly as before.
// CRM subdomain (crm.2906.estate): rewrite to the /crm/* route group, no i18n.
export default function proxy(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase()
  const { pathname } = req.nextUrl

  // NEXUS STUDIOS (2026-11-20): nexusstudios.one is the business side of NEXUS. Its Marketplace is the
  // existing one (public/link-marketplace, same data), served at /marketplace. nexusmp.one is a direct entry
  // into that Marketplace (308, query kept): not a third product. Anything else on these hosts is not found.
  if (STUDIOS_HOSTS.has(host) || MP_HOSTS.has(host)) {
    if (MP_HOSTS.has(host)) {
      // a shared home link keeps its home: nexusmp.one/home/2906-039 -> nexusstudios.one/marketplace/home/2906-039
      const home = /^\/home\/([A-Za-z0-9-]{2,40})\/?$/.exec(req.nextUrl.pathname)
      const to = new URL(home ? `https://nexusstudios.one/marketplace/home/${home[1]}` : 'https://nexusstudios.one/marketplace')
      to.search = req.nextUrl.search
      return NextResponse.redirect(to, 308)
    }
    if (host.startsWith('www.')) return NextResponse.redirect(new URL(pathname + req.nextUrl.search, 'https://nexusstudios.one'), 308)
    const url = req.nextUrl.clone()
    if (pathname === '/') { url.pathname = '/studios'; return NextResponse.rewrite(url) }
    // React Marketplace (2026-11-21); the previous static app stays reachable as /marketplace/classic
    if (pathname === '/marketplace' || pathname === '/marketplace/') { url.pathname = '/studios/marketplace'; return NextResponse.rewrite(url) }
    const home = pathname.match(/^\/marketplace\/home\/([A-Za-z0-9-]{1,40})\/?$/)
    if (home) { url.pathname = `/studios/marketplace/home/${home[1]}`; return NextResponse.rewrite(url) }
    if (pathname === '/marketplace/classic' || pathname === '/marketplace/classic/') { url.pathname = '/link-marketplace/index.html'; return NextResponse.rewrite(url) }
    // NEXUS STUDIOS Exchange (2026-11-21): co-agency inventory on agreed terms, participating agencies, partner requests
    if (pathname === '/exchange' || pathname === '/exchange/') { url.pathname = '/studios/exchange'; return NextResponse.rewrite(url) }
    if (pathname.startsWith('/link-marketplace/') || pathname.startsWith('/Link/') || pathname === '/link-matrix') return NextResponse.next()
    return new NextResponse('Not found', { status: 404 })
  }
  if (/^\/studios(\/|$)/.test(pathname)) {
    if (!host.endsWith('.vercel.app') && !host.startsWith('localhost')) return new NextResponse('Not found', { status: 404 })
    return NextResponse.next()
  }

  // Nexus Link has a fast marketplace at /link and the deeper Matrix at
  // /link-matrix. Keep both static surfaces out of locale and CRM rewriting.
  // The legacy scorecard still lives in public/Link for /link-matrix. Its
  // physical directory wins over a normal rewrite on case-sensitive hosts,
  // so force the exact historical /Link entry URL to the marketplace here.
  if (/^\/(?:en\/|de\/|fr\/|it\/|es\/)?link\/?$/i.test(pathname)) {
    const url = req.nextUrl.clone()
    url.pathname = '/link-marketplace/index.html'
    return NextResponse.rewrite(url)
  }
  if (pathname === '/link' || pathname.startsWith('/link/') || pathname === '/link-matrix' || pathname.startsWith('/link-matrix/') || pathname.startsWith('/link-marketplace/') || pathname.startsWith('/Link/')) return NextResponse.next()

  // Tokenised owner tools are deliberately unlocalised capability links.
  // Running them through next-intl rewrites the token route to /[locale] and
  // turns otherwise valid owner links into a 404 on the public domains.
  if (pathname.startsWith('/owner-schedule/') || pathname.startsWith('/owner-upload/')) return NextResponse.next()

  // Owner Workspace (2026-11-18): owner.2906.estate → /owner/*, no i18n.
  // Preview only: hidden on the public domains until owner sign-in exists.
  // nexussync.one (Kev, 19 Nov 2026) serves the same owner workspace as owner.2906.estate.
  if (host.startsWith('owner.') || host === 'nexussync.one' || host === 'www.nexussync.one') {
    if (/^\/owner(\/|$)/.test(pathname)) return NextResponse.next()
    const url = req.nextUrl.clone()
    url.pathname = pathname === '/' ? '/owner' : `/owner${pathname}`
    return NextResponse.rewrite(url)
  }
  if (/^\/owner(\/|$)/.test(pathname)) {
    if (['2906.estate', 'www.2906.estate'].includes(host)) return new NextResponse('Not found', { status: 404 })
    return NextResponse.next()
  }

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
  // The NEXUS private preview paths are forwarded by next.config rewrites, not localised.
  matcher: ['/((?!admin|api|_next|_vercel|uploads|private-preview|preview-f100547a49|NexusBooking|node_modules|.*\\..*).*)'],
}
