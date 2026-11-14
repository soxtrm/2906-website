'use client'
// Listing-level entry points. Shown only to the listing agent (or an
// administrator) once Facebook publishing is available on this server for
// this account; the backend enforces the same rules again.
import React, { useEffect, useState } from 'react'
import { useCrm } from '@/lib/crm/ui'
import { fb, type FbStatus } from '@/lib/crm/facebook'
import { PublishToFacebookButton } from './publish-button'
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

type Listing = { id: number; noFb?: boolean; listedByAgentId?: number | null }

function useAllowed(p: Listing) {
  const { me } = useCrm()
  const s = useFacebookStatus()
  const mine = !!me && (me.role === 'admin' || Number(p.listedByAgentId) === Number(me.id))
  return { allowed: !!(s && s.configured && mine), status: s }
}

export function FacebookListingAction({ p, compact, style }: { p: Listing; compact?: boolean; style?: React.CSSProperties }) {
  const { allowed } = useAllowed(p)
  if (!allowed) return null
  return <PublishToFacebookButton propertyId={p.id} noFb={p.noFb} compact={compact} style={style} />
}

export function FacebookListingPanel({ p }: { p: Listing }) {
  const { allowed, status } = useAllowed(p)
  const [key, setKey] = useState(0)
  if (!allowed) return null
  return (
    <div className="fbp" style={{ marginBottom: 16, display: 'grid', gap: 10 }}>
      <div className="fbp-row fbp-between">
        <span className="fbp-label">Facebook</span>
        <PublishToFacebookButton propertyId={p.id} noFb={p.noFb} onDone={() => setKey(k => k + 1)} />
      </div>
      <FacebookPublicationsPanel propertyId={p.id} appId={status?.appId} limit={10} refreshKey={key} title="Facebook posts for this listing" emptyText="This listing has not been published to Facebook yet." />
    </div>
  )
}
