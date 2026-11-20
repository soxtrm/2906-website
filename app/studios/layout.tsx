import './studios.css'
import type { Metadata, Viewport } from 'next'
import { Archivo, Manrope } from 'next/font/google'

// NEXUS STUDIOS (nexusstudios.one): the business side of NEXUS. Same type as NEXUS Sync and Booking:
// Manrope for reading, Archivo for headings and numbers.
const body = Manrope({ subsets: ['latin'], variable: '--st-font', display: 'swap' })
const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--st-display', display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL('https://nexusstudios.one'),
  title: 'NEXUS STUDIOS · For agents, agencies and businesses',
  description: 'The professional side of NEXUS: the property Marketplace, venue and booking tools, and the agent network.',
  alternates: { canonical: '/' },
  openGraph: { title: 'NEXUS STUDIOS', description: 'The professional side of NEXUS.', url: 'https://nexusstudios.one', siteName: 'NEXUS STUDIOS', type: 'website' },
}
export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#fbfaf7' }, { media: '(prefers-color-scheme: dark)', color: '#071449' }],
}

export default function StudiosLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body className="st-body">{children}</body>
    </html>
  )
}
