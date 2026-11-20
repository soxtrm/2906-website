import type { SVGProps } from 'react'
import {
  NEXUS_STAR_PATH,
  NEXUS_STAR_VIEWBOX,
  SYNC_WORDMARK_HEIGHT,
  SYNC_WORDMARK_PATH,
  SYNC_WORDMARK_VIEWBOX,
  SYNC_WORDMARK_WIDTH,
} from '@/lib/brand-paths'

// NEXUS design system: the logos as real vector shapes. They take their colour from
// CSS (currentColor), so they stay sharp at any size, follow light and dark mode, and
// can be animated with plain CSS transforms (each part has its own class).

type MarkProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'children'> & {
  /** Accessible name. Leave empty when the logo sits next to visible text. */
  title?: string
}

function a11y(title?: string) {
  return title ? { role: 'img' as const, 'aria-label': title } : { 'aria-hidden': true as const, focusable: 'false' as const }
}

/** The NEXUS star. `size` is the width and height in px (any CSS size also works via className). */
export function NexusStar({ size = 18, title, className, ...rest }: MarkProps & { size?: number | string }) {
  return (
    <svg viewBox={NEXUS_STAR_VIEWBOX} width={size} height={size} fill="currentColor" className={['nx-star', className].filter(Boolean).join(' ')} {...a11y(title)} {...rest}>
      <path d={NEXUS_STAR_PATH} />
    </svg>
  )
}

/** The SYNC wordmark with its two sparkle stars. `height` in px; the width follows. */
export function SyncWordmark({ height = 24, title, className, ...rest }: MarkProps & { height?: number }) {
  return (
    <svg
      viewBox={SYNC_WORDMARK_VIEWBOX}
      height={height}
      width={Math.round((height * SYNC_WORDMARK_WIDTH) / SYNC_WORDMARK_HEIGHT * 10) / 10}
      fill="currentColor"
      className={['nx-sync-word', className].filter(Boolean).join(' ')}
      {...a11y(title)}
      {...rest}
    >
      <path fillRule="evenodd" d={SYNC_WORDMARK_PATH} />
    </svg>
  )
}

/** Star + SYNC side by side. The star is its own element (.nx-logo-star) so it can turn on its own. */
export function SyncLogo({ height = 28, title = 'SYNC', className }: { height?: number; title?: string; className?: string }) {
  return (
    <span className={['nx-logo', className].filter(Boolean).join(' ')} role="img" aria-label={title} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(height * 0.32), lineHeight: 0 }}>
      <NexusStar size={Math.round(height * 1.12)} className="nx-logo-star" />
      <SyncWordmark height={height} className="nx-logo-word" />
    </span>
  )
}
