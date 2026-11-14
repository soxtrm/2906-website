'use client'
import React, { useState } from 'react'
import { PublishToFacebookDialog } from './publish-dialog'
import { FacebookGlyph } from './shared'
import type { FbPublication } from '@/lib/crm/facebook'

// One button per listing. Nothing is fetched until it is pressed, so long
// inventory lists stay as fast as before.
export function PublishToFacebookButton({ propertyId, noFb, compact, onDone, style }: { propertyId: number; noFb?: boolean; compact?: boolean; onDone?: (p: FbPublication) => void; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false)
  const label = noFb ? 'Marked "no Facebook" — the owner does not want it advertised there' : 'Publish to Facebook'
  return (
    <>
      <button type="button" className={`fbp-btn ${compact ? 'fbp-btn-sm' : ''}`} disabled={noFb} title={label} aria-label={label}
        onClick={e => { e.stopPropagation(); setOpen(true) }} style={style}>
        <FacebookGlyph size={compact ? 13 : 15} />{compact ? 'Facebook' : 'Publish to Facebook'}
      </button>
      {open && <PublishToFacebookDialog propertyId={propertyId} open={open} onOpenChange={setOpen} onDone={onDone} />}
    </>
  )
}
