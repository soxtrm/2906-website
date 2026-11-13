import type { Metadata } from 'next'
import './rating.css'

export const metadata: Metadata = {
  title: 'NEXUS BRAIN · Private Intelligence Lab',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
}
export default function RatingLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body style={{ margin: 0, background: '#09131b' }}>{children}</body></html>
}
