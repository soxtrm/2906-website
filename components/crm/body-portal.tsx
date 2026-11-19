'use client'

// Full-screen CRM overlays (listing detail, Swipe Links dialogs) render here, straight
// under <body>. Rendered inside the page content they sat in its stacking context, so
// on a phone the ARGUS header covered the close button and the bottom island covered
// the last button of the dialog, whatever z-index the overlay asked for.
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function BodyPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  return mounted ? createPortal(children, document.body) : null
}
