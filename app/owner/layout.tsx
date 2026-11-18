import './owner.css'
import type { Metadata, Viewport } from 'next'
import { Atkinson_Hyperlegible } from 'next/font/google'
import { OwnerProvider } from '@/lib/owner/store'
import { OwnerShell } from '@/components/owner/shell'

const font = Atkinson_Hyperlegible({ subsets: ['latin'], weight: ['400', '700'], variable: '--ow-font', display: 'swap' })

export const metadata: Metadata = {
  title: 'Your properties · ARGUS',
  robots: { index: false, follow: false },
}
export const viewport: Viewport = { themeColor: '#1f4d3f' }

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={font.variable}>
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
