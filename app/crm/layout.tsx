import './crm.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '2906 Estate · CRM',
  robots: { index: false, follow: false },
}

export default function CrmRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="crm-root" style={{ margin: 0, background: '#F6F4EF' }}>{children}</body>
    </html>
  )
}
