'use client'
import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { crmPath } from '@/components/crm/group-navigation'
import { PUB_TONE } from '@/lib/crm/facebook'
import './facebook.css'

export const FacebookGlyph = ({ size = 16, mono = false }: { size?: number; mono?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden focusable="false">
    <circle cx="10" cy="10" r="10" fill={mono ? 'currentColor' : '#1877F2'} />
    <path d="M12.9 10.4h-1.7V16h-2.3v-5.6H7.7V8.6h1.2V7.3c0-1.4.7-2.6 2.7-2.6h1.6v2h-1c-.4 0-.6.2-.6.7v1.2h1.7l-.4 1.8Z" fill={mono ? 'var(--fbp-fb, #1877F2)' : '#FFF'} />
  </svg>
)

// The agent's own profile colour, when set, becomes the accent of every control here.
export function accentStyle(hex?: string | null): React.CSSProperties {
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? ({ ['--fbp-accent' as any]: hex }) : {}
}

export function StateChip({ state, label }: { state: string; label?: string }) {
  return <span className="fbp-chip" data-tone={PUB_TONE[state] || 'muted'}>{label || state}</span>
}

export function CrmLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const pathname = usePathname() || '/'
  return <Link href={crmPath(href, pathname)} className={className}>{children}</Link>
}

export function PageAvatar({ url, name, size = 44 }: { url?: string | null; name: string; size?: number }) {
  return url
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={url} alt="" className="fbp-avatar" style={{ width: size, height: size }} referrerPolicy="no-referrer" />
    : <span className="fbp-avatar" style={{ width: size, height: size }} aria-hidden>{(name || '?').slice(0, 1).toUpperCase()}</span>
}

export const fmtWhen = (d?: string | null) => {
  if (!d) return '—'
  const dt = new Date(d)
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Malta' })
}

export function listingTitle(p: { type?: string | null; bedrooms?: number | null; town?: string | null; ref?: string | null }) {
  const type = String(p.type || 'property').toLowerCase()
  const beds = Number(p.bedrooms) > 0 && type !== 'studio' ? `${p.bedrooms}-bedroom ` : ''
  return `${beds}${type}${p.town ? ` in ${p.town}` : ''}`.replace(/^./, c => c.toUpperCase())
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}
