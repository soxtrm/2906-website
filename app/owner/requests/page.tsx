'use client'
import { LiveRequests } from '@/components/owner/live'
import { useOwner as useOwnerMode } from '@/lib/owner/store'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useOwner } from '@/lib/owner/store'
import { RequestCard } from '@/components/owner/request-card'
import { competing } from '@/lib/owner/engine'
import { when } from '@/components/owner/format'

const FILTERS = [
  ['open', 'Waiting for you'], ['others', 'Waiting for others'], ['confirmed', 'Confirmed'], ['past', 'Past & closed'],
] as const

function RequestsInner() {
  const s = useOwner()
  const q = useSearchParams()
  const [f, setF] = useState<(typeof FILTERS)[number][0]>('open')
  const compareId = q.get('compare')
  const base = compareId ? s.requests.find(r => r.id === compareId) : null

  if (base) {
    const group = [base, ...competing(s.requests, base)]
    const p = s.properties.find(x => x.id === base.propertyId)!
    return (
      <>
        <Link href="/owner/requests" className="ow-back">All requests</Link>
        <div className="ow-head"><div>
          <h1>{group.length} requests for {when(base.start, s.today)}</h1>
          <p className="ow-muted">{p.name}. Each requester only sees their own request. Accept one, then suggest other times to the rest.</p>
        </div></div>
        <div className="ow-compare">{group.map(r => <RequestCard key={r.id} r={r} />)}</div>
      </>
    )
  }

  const list = s.requests.filter(r =>
    f === 'open' ? r.status === 'awaiting_owner'
      : f === 'others' ? r.status === 'question' || r.status === 'new_time_proposed'
        : f === 'confirmed' ? r.status === 'confirmed'
          : ['declined', 'cancelled', 'completed'].includes(r.status),
  ).sort((a, b) => a.start.localeCompare(b.start))

  return (
    <>
      <div className="ow-head"><div>
        <h1>Requests</h1>
        <p className="ow-muted">Every request lands here, whether it came from an agency, NEXUS Housing, your booking link, Facebook or WhatsApp.</p>
      </div></div>
      <div className="ow-tabs" role="group" aria-label="Filter">
        {FILTERS.map(([k, l]) => {
          const n = s.requests.filter(r => (k === 'open' ? r.status === 'awaiting_owner' : k === 'others' ? ['question', 'new_time_proposed'].includes(r.status) : k === 'confirmed' ? r.status === 'confirmed' : ['declined', 'cancelled', 'completed'].includes(r.status))).length
          return <button key={k} aria-pressed={f === k} onClick={() => setF(k)}>{l} ({n})</button>
        })}
      </div>
      <div className="ow-attn">{list.length ? list.map(r => <RequestCard key={r.id} r={r} />) : <div className="ow-panel ow-empty">Nothing here.</div>}</div>
    </>
  )
}

function DemoRequests() {
  return <Suspense fallback={null}><RequestsInner /></Suspense>
}

// nexussync.one: the real workspace from ARGUS; ?demo=1: the preview with Maria.
export default function RequestsPage() {
  const { demo } = useOwnerMode()
  return demo ? <DemoRequests /> : <LiveRequests />
}
