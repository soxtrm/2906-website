import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: '/link', destination: '/link-marketplace/index.html' },
      { source: '/Link', destination: '/link-marketplace/index.html' },
      { source: '/link-matrix', destination: '/Link/index.html' },
      { source: '/Link/map-view', destination: '/Link/map-view/index.html' },
    ]
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // jspdf (Agent Profile invoice PDF export) pulls in fflate's Node build,
  // which has a `new Worker(<dynamic>)` call Turbopack cannot statically
  // resolve while building the SSR module graph for the client component
  // that imports it — even via a runtime dynamic import(), since Turbopack
  // still needs a server-side graph entry for the RSC flight manifest.
  // Marking it external skips bundling/analysis entirely; Node resolves it
  // normally at runtime, and it is only ever actually called in the browser.
  serverExternalPackages: ['jspdf'],
}

export default withNextIntl(nextConfig)
