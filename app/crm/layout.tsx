import './crm.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'ARGUS · 2906 Estate',
  robots: { index: false, follow: false },
}

// Applies the saved light/dark preference before first paint. Without it the
// server-rendered light shell (and the ARGUS intro) flashed light for dark-mode
// users, and React keeps that server markup through hydration.
const THEME_BOOT = `try{var t=localStorage.getItem('crm_theme_pref');if(t==='dark'||t==='light')document.documentElement.dataset.crmTheme=t}catch(e){}`

export default function CrmRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body className="crm-root" style={{ margin: 0 }}>{children}</body>
    </html>
  )
}
