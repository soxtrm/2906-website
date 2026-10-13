// Shared motion tokens for the CRM — one physical character everywhere.
// Settles in ~350 ms with almost no overshoot: present, never bouncy.
import type { Transition } from 'framer-motion'

/** Bottom sheets and dialogs arriving / leaving. */
export const SHEET_SPRING: Transition = { type: 'spring', stiffness: 380, damping: 36, mass: 0.8 }
/** Small surfaces: pills, popovers, toasts. */
export const POP_SPRING: Transition = { type: 'spring', stiffness: 460, damping: 34, mass: 0.6 }
/** Backdrops and pure fades. */
export const FADE: Transition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] }
