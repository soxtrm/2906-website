'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { CalendarDays, FileText, Home, Inbox, LayoutGrid, MessageCircle, MoreHorizontal, Settings, Share2 } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'

const NAV = [
  { href: '/owner', label: 'Overview', icon: LayoutGrid },
  { href: '/owner/properties', label: 'My properties', icon: Home },
  { href: '/owner/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/owner/requests', label: 'Requests', icon: Inbox, count: 'requests' as const },
  { href: '/owner/messages', label: 'Messages', icon: MessageCircle, count: 'messages' as const },
  { href: '/owner/sharing', label: 'Agencies & sharing', icon: Share2 },
  { href: '/owner/documents', label: 'Documents', icon: FileText },
  { href: '/owner/settings', label: 'Settings', icon: Settings },
]
const TABS = [NAV[0], NAV[2], NAV[3], NAV[4]]

function Mark() {
  // a louvred shutter, the workspace's one motif
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="2" width="14" height="16" rx="2" fill="none" stroke="#fff" strokeWidth="1.6" />
      {[5.5, 8.5, 11.5, 14.5].map(y => <line key={y} x1="5.5" x2="14.5" y1={y} y2={y} stroke="#e7cf98" strokeWidth="1.6" strokeLinecap="round" />)}
    </svg>
  )
}

export function OwnerShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || '/owner'
  const { requests, threads, toasts, profile } = useOwner()
  const [more, setMore] = useState(false)
  const counts = {
    requests: requests.filter(r => r.status === 'awaiting_owner').length,
    messages: threads.reduce((n, t) => n + t.unread, 0),
  }
  const isActive = (href: string) => (href === '/owner' ? path === '/owner' : path.startsWith(href))

  return (
    <div className="ow-shell">
      <a href="#ow-main" className="sr-only" style={{ position: 'absolute', left: -9999 }}>Skip to content</a>
      <aside className="ow-rail" aria-label="Main">
        <div className="ow-brand">
          <span className="ow-brand-mark"><Mark /></span>
          <span><b>Your properties</b><span>ARGUS for owners</span></span>
        </div>
        <nav className="ow-nav">
          {NAV.map(n => {
            const Icon = n.icon
            const c = n.count ? counts[n.count] : 0
            return (
              <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? 'page' : undefined}>
                <Icon size={20} aria-hidden="true" /> {n.label}
                {c > 0 && <span className="ow-count" aria-label={`${c} waiting`}>{c}</span>}
              </Link>
            )
          })}
        </nav>
        <div className="ow-rail-foot">Signed in as {profile.name}<br /><span className="ow-preview-flag" style={{ marginTop: 8 }}>Preview with demo data</span></div>
      </aside>

      <main id="ow-main" className="ow-main">{children}</main>

      <nav className="ow-tabbar" aria-label="Main">
        {TABS.map(n => {
          const Icon = n.icon
          const c = n.count ? counts[n.count] : 0
          return (
            <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? 'page' : undefined}>
              <Icon size={22} aria-hidden="true" />{n.label === 'My properties' ? 'Homes' : n.label}
              {c > 0 && <span className="ow-dot">{c}</span>}
            </Link>
          )
        })}
        <button type="button" onClick={() => setMore(true)} aria-expanded={more}><MoreHorizontal size={22} aria-hidden="true" />More</button>
      </nav>
      {more && (
        <>
          <button className="ow-scrim" aria-label="Close menu" onClick={() => setMore(false)} />
          <div className="ow-more-sheet" role="dialog" aria-label="More">
            {NAV.filter(n => !TABS.includes(n)).map(n => <Link key={n.href} href={n.href} onClick={() => setMore(false)}>{n.label}</Link>)}
          </div>
        </>
      )}

      <div className="ow-toasts" role="status" aria-live="polite">
        {toasts.map(t => <div key={t.id} className="ow-toast" data-tone={t.tone}>{t.text}</div>)}
      </div>
    </div>
  )
}
