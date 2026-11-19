'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { CalendarDays, FileText, Home, Inbox, LayoutGrid, MessageCircle, MoreHorizontal, Settings, Share2 } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { Brand, NexusStar } from './brand'

const NAV = [
  { href: '/owner', label: 'Overview', icon: LayoutGrid },
  { href: '/owner/messages', label: 'Chat', icon: MessageCircle, count: 'messages' as const },
  { href: '/owner/requests', label: 'Requests', icon: Inbox, count: 'requests' as const },
  { href: '/owner/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/owner/properties', label: 'My properties', icon: Home },
  { href: '/owner/sharing', label: 'Agencies & sharing', icon: Share2 },
  { href: '/owner/documents', label: 'Documents', icon: FileText },
  { href: '/owner/settings', label: 'Settings', icon: Settings },
]
const TABS = [NAV[0], NAV[3], NAV[1]]

export function OwnerShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || '/owner'
  const { requests, threads, toasts, profile, reset } = useOwner()
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
        <Brand />
        <Link href="/owner/add" className="ow-btn primary ow-rail-add ow-star-btn"><span className="ow-star"><NexusStar size={16} /></span>Add property</Link>
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
        <div className="ow-rail-foot">Signed in as {profile.name}<br /><button type="button" className="ow-preview-flag" style={{ marginTop: 8, border: 0 }} onClick={reset} title="Reset the demo">Preview with demo data</button></div>
      </aside>

      <main id="ow-main" className="ow-main">
        <header className="ow-topbar">
          <span className="ow-topbar-logo"><Brand small /></span>
          <div className="ow-topbar-right">
            <Link href="/owner/settings" className="ow-top-icon" aria-label="Settings" title="Settings"><Settings size={20} /></Link>
            <Link href="/owner/settings" className="ow-top-me" aria-label={`Your profile, ${profile.name}`} title="Your profile">
              <span>{profile.name.slice(0, 1).toUpperCase()}</span><b>{profile.name}</b>
            </Link>
          </div>
        </header>
        {children}
      </main>

      <nav className="ow-tabbar" aria-label="Main">
        {TABS.slice(0, 2).map(n => {
          const Icon = n.icon
          const c = n.count ? counts[n.count] : 0
          return (
            <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? 'page' : undefined}>
              <Icon size={22} aria-hidden="true" />{n.label === 'Overview' ? 'Home' : n.label}
              {c > 0 && <span className="ow-dot">{c}</span>}
            </Link>
          )
        })}
        <Link href="/owner/add" className="ow-tab-add" aria-current={isActive('/owner/add') ? 'page' : undefined} aria-label="Add property"><span><i className="ow-star"><NexusStar size={22} /></i></span></Link>
        {TABS.slice(2).map(n => {
          const Icon = n.icon
          const c = n.count ? counts[n.count] : 0
          return (
            <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? 'page' : undefined}>
              <Icon size={22} aria-hidden="true" />{n.label}
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
