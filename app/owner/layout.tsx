import './owner.css'
import './nexus-sync.css'
import './sync-play.css'
import './live.css'
import './sync-calendar.css'
import type { Metadata, Viewport } from 'next'
import { Archivo, Manrope } from 'next/font/google'
import { OwnerProvider } from '@/lib/owner/store'
import { OwnerShell } from '@/components/owner/shell'

// NEXUS type: Manrope for reading, Archivo (wide, weight ~620, never ultra-bold) for headings and numbers.
const body = Manrope({ subsets: ['latin'], variable: '--ow-font', display: 'swap' })
const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--ow-display', display: 'swap' })

export const metadata: Metadata = {
  title: 'SYNC. · Your properties',
  robots: { index: false, follow: false },
}
export const viewport: Viewport = { themeColor: '#071449' }

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body style={{ margin: 0 }}>
        <div className="ow">
          <OwnerProvider>
            <OwnerShell>{children}</OwnerShell>
          </OwnerProvider>
        </div>
      </body>
    </html>
  )
}
