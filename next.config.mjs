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
  // NEXUS private preview (founder review), served from nexuslink.fit behind a
  // hidden path. The preview app requests its own assets and the NEXUS booking
  // API by absolute path, so those prefixes are forwarded too. Nothing else on
  // the 2906 site changes. Remove this block to take the preview down.
  async rewrites() {
    const nexus = 'https://nexuslink.fit'
    return {
      beforeFiles: [
        { source: '/private-preview', destination: `${nexus}/preview-f100547a49` },
        { source: '/private-preview/:path*', destination: `${nexus}/preview-f100547a49/:path*` },
        { source: '/preview-f100547a49', destination: `${nexus}/preview-f100547a49` },
        { source: '/preview-f100547a49/:path*', destination: `${nexus}/preview-f100547a49/:path*` },
        { source: '/api/nexus-booking/:path*', destination: `${nexus}/api/nexus-booking/:path*` },
        { source: '/NexusBooking/:path*', destination: `${nexus}/NexusBooking/:path*` },
        { source: '/node_modules/three/:path*', destination: `${nexus}/node_modules/three/:path*` },
      ],
    }
  },
}

export default withNextIntl(nextConfig)
