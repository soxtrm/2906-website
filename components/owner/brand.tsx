import Link from 'next/link'

// SYNC. by NEXUS STUDIOS — Kev's logo (19 Nov 2026), cut from his black PNG into
// the star and the wordmark and tinted NEXUS navy, so the star can turn on its
// own when the pointer is over the logo. White full logo: /owner/sync-logo-white.png.
export const LOGO_SRC = '/owner/sync-logo-navy.png'

export function NexusStar({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" fill={color}>
      <path d="M3 3 Q50 58 97 3 Q42 50 97 97 Q50 42 3 97 Q58 50 3 3 Z" />
    </svg>
  )
}

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <Link href="/owner" className={`ow-logo${small ? ' small' : ''}`} aria-label="SYNC. by NEXUS Studios, overview">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="ow-logo-star" src="/owner/sync-star-navy.png" alt="" width={499} height={494} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="ow-logo-word" src="/owner/sync-word-navy.png" alt="" width={1164} height={379} />
    </Link>
  )
}
