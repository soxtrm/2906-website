'use client'
// Listing-level entry points. Shown to every signed-in agent once Facebook publishing is available on this
// server; the backend decides per listing what may be published (owner opt-out, drafts, another agent's
// exclusive, availability) and enforces it again on every request.
import React, { useEffect, useState } from 'react'
import { fb, type FbStatus } from '@/lib/crm/facebook'
import { PublishToFacebookButton } from './publish-button'
import { QuickFacebookButton } from './quick-publish'
import { FacebookPublicationsPanel } from './publications-panel'

let statusPromise: Promise<FbStatus | null> | null = null
function useFacebookStatus() {
  const [s, setS] = useState<FbStatus | null | undefined>(undefined)
  useEffect(() => {
    if (!statusPromise) statusPromise = fb.status().catch(() => null)
    let live = true
    statusPromise.then(r => { if (live) setS(r) })
    return () => { live = false }
  }, [])
  return s
}

type Listing = { id: number; ref?: string | null; noFb?: boolean; listedByAgentId?: number | null }

function useAllowed() {
  const s = useFacebookStatus()
  return { allowed: !!(s && s.configured), status: s }
}

// One click: posts on the agent's default Page with their default wording.
export function FacebookListingAction({ p, compact, style }: { p: Listing; compact?: boolean; style?: React.CSSProperties }) {
  const { allowed } = useAllowed()
  if (!allowed) return null
  return <QuickFacebookButton propertyId={p.id} refLabel={p.ref} noFb={p.noFb} variant="button" size={compact ? 13 : 15} style={style} />
}

export function FacebookListingPanel({ p }: { p: Listing }) {
  const { allowed, status } = useAllowed()
  const [key, setKey] = useState(0)
  if (!allowed) return null
  return (
    <div className="fbp" style={{ marginBottom: 16, display: 'grid', gap: 10 }}>
      <div className="fbp-row fbp-between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="fbp-label">Facebook</span>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <QuickFacebookButton propertyId={p.id} refLabel={p.ref} noFb={p.noFb} variant="button" onDone={() => setKey(k => k + 1)} />
          {/* the step-by-step dialog stays for choosing photos, another Page or editing the text first */}
          <PublishToFacebookButton propertyId={p.id} noFb={p.noFb} onDone={() => setKey(k => k + 1)} label="Customise post" />
        </span>
      </div>
      <FacebookPublicationsPanel propertyId={p.id} appId={status?.appId} limit={10} refreshKey={key} title="Facebook posts for this listing" emptyText="This listing has not been published to Facebook yet." />
    </div>
  )
}
