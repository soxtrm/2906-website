import createMiddleware from 'next-intl/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { routing } from './i18n/routing'

const intlMiddleware = createMiddleware(routing)

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

  // Unchanged public-site behaviour.
  return intlMiddleware(req)
}

export const config = {
  // Exclude /admin, /api, static files from locale routing (unchanged from original).
  matcher: ['/((?!admin|api|_next|_vercel|uploads|.*\\..*).*)'],
}
