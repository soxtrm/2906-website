'use client'
import React, { useState } from 'react'
import { PublishToFacebookDialog } from './publish-dialog'
import { FacebookGlyph } from './shared'
import type { FbPublication } from '@/lib/crm/facebook'

// Opens the step-by-step dialog (Page, photos, text, confirm). The one-click path is QuickFacebookButton;
// this stays for the cases where the agent wants to choose before posting. Nothing is fetched until it is
// pressed, so long inventory lists stay as fast as before.
export function PublishToFacebookButton({ propertyId, noFb, compact, onDone, style, label }: { propertyId: number; noFb?: boolean; compact?: boolean; onDone?: (p: FbPublication) => void; style?: React.CSSProperties; label?: string }) {
  const [open, setOpen] = useState(false)
  const title = noFb ? 'Marked "no Facebook" — the owner does not want it advertised there' : (label ? 'Choose the Page, photos and text before posting' : 'Publish to Facebook')
  return (
    <>
      <button type="button" className={`fbp-btn ${compact ? 'fbp-btn-sm' : ''}`} disabled={noFb} title={title} aria-label={title}
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        style={label ? { background: 'transparent', color: 'inherit', border: '1px solid currentColor', opacity: noFb ? 0.45 : 0.85, ...style } : style}>
        {!label && <FacebookGlyph size={compact ? 13 : 15} />}{label || (compact ? 'Facebook' : 'Publish to Facebook')}
      </button>
      {open && <PublishToFacebookDialog propertyId={propertyId} open={open} onOpenChange={setOpen} onDone={onDone} />}
    </>
  )
}
