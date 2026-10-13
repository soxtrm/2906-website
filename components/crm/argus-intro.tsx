'use client'
// ============================================================================
// argus-intro.tsx — the ARGUS wordmark that greets a cold load of the CRM.
//
// Replaces the old static "2906" logo-wide.png splash. The wordmark is the
// approved /argus-logo-kevin-wordmark.png used as a CSS mask, so it takes the
// theme's ink colour (light and dark) and stays pixel-sharp at any size.
// Each of the five letters is its own masked slice and rises into place on a
// short stagger; a single light sweep crosses the finished mark; while the
// session is still loading a hairline breathes underneath. On exit the mark
// eases forward and dissolves into the app instead of being swapped out.
//
// Everything animates transform / opacity / filter only (compositor work),
// and prefers-reduced-motion collapses it to a plain fade.
// ============================================================================
import { useEffect, useRef, useState } from 'react'

// Column ranges of A·R·G·U·S inside the 1038 × 148 wordmark (measured from
// the asset's alpha channel). Used to cut one masked slice per letter.
const WORDMARK = { src: '/argus-logo-kevin-wordmark.png', width: 1038, height: 148 }
const LETTERS: Array<[number, number]> = [[0, 221], [245, 432], [440, 630], [659, 839], [864, 1038]]

/** How long the entrance takes before an exit may start (ms). */
export const ARGUS_INTRO_ENTRANCE_MS = 1150
const EXIT_MS = 520

// Light/dark comes from html[data-crm-theme] (set before first paint in
// app/crm/layout.tsx), never from React state: the server cannot know the
// stored preference, and a class that differs would break hydration.
export function ArgusIntro({ leaving, onExited }: { leaving: boolean; onExited: () => void }) {
  const [gone, setGone] = useState(false)
  const exitedRef = useRef(onExited)
  exitedRef.current = onExited

  useEffect(() => {
    if (!leaving) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => { setGone(true); exitedRef.current() }, reduce ? 160 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])

  if (gone) return null
  return (
    <div className={`argus-intro${leaving ? ' is-leaving' : ''}`} role="status" aria-live="polite" aria-label="Loading ARGUS">
      <div
        className="argus-intro-mark"
        style={{ '--argus-mask': `url(${WORDMARK.src})`, aspectRatio: `${WORDMARK.width} / ${WORDMARK.height}` } as React.CSSProperties}
      >
        {LETTERS.map(([from, to], index) => (
          <span
            key={index}
            className="argus-intro-letter"
            style={{
              left: `${(from / WORDMARK.width) * 100}%`,
              width: `${((to - from) / WORDMARK.width) * 100}%`,
              // The mask is the full wordmark, scaled to the mark's width and
              // shifted so only this letter's columns show through.
              WebkitMaskSize: `${(WORDMARK.width / (to - from)) * 100}% 100%`,
              maskSize: `${(WORDMARK.width / (to - from)) * 100}% 100%`,
              WebkitMaskPosition: `${(from / (WORDMARK.width - (to - from))) * 100}% 0`,
              maskPosition: `${(from / (WORDMARK.width - (to - from))) * 100}% 0`,
              animationDelay: `${120 + index * 70}ms`,
            }}
          />
        ))}
        <span className="argus-intro-sheen" aria-hidden />
      </div>
      <span className="argus-intro-line" aria-hidden><i /></span>
    </div>
  )
}
