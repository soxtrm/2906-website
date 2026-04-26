import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

export default createMiddleware(routing)

export const config = {
  // Exclude /admin, /api, static files from locale routing
  matcher: ['/((?!admin|api|_next|_vercel|uploads|.*\\..*).*)'],
}
