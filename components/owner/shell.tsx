'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { CalendarDays, FileText, Home, Inbox, LayoutGrid, MessageCircle, MoreHorizontal, RefreshCw, Settings, UserRound, Share2 } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { Brand, StarButton, StarPlay } from './brand'

const NAV = [
  { href: '/owner', label: 'Overview', icon: LayoutGrid },
  { href: '/owner/messages', label: 'Chat', icon: MessageCircle, count: 'messages' as const },
  { href: '/owner/requests', label: 'Requests', icon: Inbox, count: 'requests' as const },
  { href: '/owner/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/owner/properties', label: 'My properties', icon: Home },
  { href: '/owner/sharing', label: 'Agencies & sharing', icon: Share2 },
  { href: '/owner/documents', label: 'Documents', icon: FileText },
  { href: '/owner/profile', label: 'Profile', icon: UserRound },
  { href: '/owner/settings', label: 'Settings', icon: Settings },
]
const TABS = [NAV[0], NAV[3], NAV[1]]

export function OwnerShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || '/owner'
  const { requests, threads, toasts, profile, reset, account, signOut, demo } = useOwner()
  const [more, setMore] = useState(false)
  // SYNC moment on every page: the star turns into the north star and a thin line
  // runs across the top. The first visit of a session also gets the logo splash.
  const [syncing, setSyncing] = useState(0)
  const [splash, setSplash] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      try { if (!sessionStorage.getItem('ow_splash')) { sessionStorage.setItem('ow_splash', '1'); setSplash(true); setTimeout(() => setSplash(false), 1500) } } catch { /* */ }
    }
    setSyncing(n => n + 1)
  }, [path])
  const counts = {
    requests: requests.filter(r => r.status === 'awaiting_owner').length,
    messages: threads.reduce((n, t) => n + t.unread, 0),
  }
  const isActive = (href: string) => (href === '/owner' ? path === '/owner' : path.startsWith(href))

  if (path.startsWith('/owner/signup') || path.startsWith('/owner/login')) {
    return (
      <div className="ow-authwrap">
        <div className="ow-auth-top"><Brand /></div>
        {demo && <p className="ow-auth-preview">Demo: accounts are kept only in this browser and no code is sent.</p>}
        {children}
        <div className="ow-toasts" role="status" aria-live="polite">{toasts.map(t => <div key={t.id} className="ow-toast" data-tone={t.tone}>{t.text}</div>)}</div>
      </div>
    )
  }

  return (
    <div className="ow-shell">
      <div key={syncing} className="ow-syncline" aria-hidden="true" />
      {syncing > 1 && !splash && (
        <div key={`t${syncing}`} className="ow-trans" aria-hidden="true">
          <span className="ow-trans-card">
            <span className="ow-trans-arrows"><RefreshCw size={30} strokeWidth={2.4} /></span>
            <span className="ow-trans-word">SYNC.</span>
          </span>
        </div>
      )}
      {splash && (
        <div className="ow-splash" aria-hidden="true">
          <span className="ow-splash-mark"><StarPlay size={64} color="#fff" /></span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/owner/sync-logo-white.png" alt="" width={1663} height={494} />
        </div>
      )}
      <a href="#ow-main" className="sr-only" style={{ position: 'absolute', left: -9999 }}>Skip to content</a>
      <aside className="ow-rail" aria-label="Main">
        <Brand />
        <StarButton href="/owner/add" className="ow-rail-add">Add property</StarButton>
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
        <div className="ow-rail-foot">
          {account?.signedIn ? (
            <div className="ow-account">
              <Link href="/owner/profile" className="ow-account-me">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {profile.photo ? <img src={profile.photo} alt="" /> : <span>{profile.name.slice(0, 1).toUpperCase()}</span>}
                <b>{profile.name}<small>{account.provider && account.provider !== 'email' ? `via ${account.provider[0].toUpperCase()}${account.provider.slice(1)}` : account.email}{account.phoneConfirmed ? ' · mobile linked' : ''}</small></b>
              </Link>
              {!account.phoneConfirmed && <Link href="/owner/signup" className="ow-btn small primary">Link my mobile</Link>}
              <button type="button" className="ow-btn small" onClick={signOut}>Sign out</button>
            </div>
          ) : (
            <div className="ow-account">
              <b className="ow-account-title">Your homes, one place</b>
              <Link href="/owner/login" className="ow-btn primary big">Sign in</Link>
              <Link href="/owner/signup" className="ow-btn">Create account</Link>
            </div>
          )}
          {demo && <button type="button" className="ow-preview-flag" style={{ marginTop: 10, border: 0 }} onClick={reset} title="Reset the demo">Demo with sample data</button>}
        </div>
      </aside>

      <main id="ow-main" className="ow-main">
        <header className="ow-topbar">
          <span className="ow-topbar-logo"><Brand small /></span>
          <div className="ow-topbar-right">
            <span key={syncing} className="ow-top-sync" aria-hidden="true"><StarPlay size={15} /><em>Synced</em></span>
            {account?.signedIn
              ? <button type="button" className="ow-btn small quiet" onClick={signOut}>Sign out</button>
              : <Link href="/owner/signup" className="ow-btn small primary">Create account</Link>}
            <Link href="/owner/settings" className="ow-top-icon" aria-label="Settings" title="Settings"><Settings size={20} /></Link>
            <Link href="/owner/profile" className="ow-top-me" aria-label={`Your profile, ${profile.name}`} title="Your profile">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {profile.photo ? <img src={profile.photo} alt="" /> : <span>{(profile.name || 'Y').slice(0, 1).toUpperCase()}</span>}<b>{profile.name || 'You'}</b>
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
        <Link href="/owner/add" className="ow-tab-add" aria-current={isActive('/owner/add') ? 'page' : undefined} aria-label="Add property"><span><StarPlay size={22} /></span></Link>
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
