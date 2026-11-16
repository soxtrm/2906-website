import '@fontsource/archivo/500.css'
import '@fontsource/archivo/700.css'
import '@/components/owner-portal/portal.css'
import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'Property · ARGUS',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f4f3ef' }, { media: '(prefers-color-scheme: dark)', color: '#0b0d12' }],
}

export default function PropertyLinkLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  )
}
