import Link from 'next/link'
import { NexusStar as Star, SyncWordmark } from '@/components/brand/logo'

// SYNC — Kev's logo as real vectors from the NEXUS design system (components/brand):
// the NEXUS star and the SYNC wordmark with its sparkles. Both take their colour from
// CSS, so the star can turn on its own when the pointer is over the logo.
export { SyncWordmark }

export function NexusStar({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return <Star size={size} style={color === 'currentColor' ? undefined : { color }} />
}

// The playful NEXUS star (from Link): on hover it turns, slides to the middle,
// lights up as a north star with a small star above, then goes back.
export function StarPlay({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <span className="ow-sp" aria-hidden="true">
      <span className="ow-sp-main"><NexusStar size={size} color={color} /></span>
      <span className="ow-sp-mini"><NexusStar size={Math.round(size * 0.46)} color={color} /></span>
    </span>
  )
}

/** A big friendly button with the star: the star does its north-star move on hover. */
export function StarButton({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={`ow-btn primary ow-north ${className}`}>
      <StarPlay size={17} />
      <span className="ow-north-label">{children}</span>
    </Link>
  )
}

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <Link href="/owner" className={`ow-logo${small ? ' small' : ''}`} aria-label="SYNC by NEXUS, overview">
      <span className="ow-logo-starbox">
        <Star size={small ? 26 : 36} className="ow-logo-star" />
        <span className="ow-logo-mini"><NexusStar size={12} /></span>
      </span>
      <span className="ow-logo-wordbox">
        <SyncWordmark height={small ? 19 : 26} className="ow-logo-word" />
      </span>
    </Link>
  )
}
