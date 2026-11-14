'use client'
// Public status page Meta links to after a data-deletion request
// (no ARGUS login needed: the person may not be an ARGUS user).
import React, { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import '@/components/crm/facebook/facebook.css'

function Status() {
  const code = useSearchParams().get('code') || ''
  const [s, setS] = useState<{ status: string; completedAt?: string } | null | 'missing'>(null)
  useEffect(() => {
    if (!/^[0-9a-f]{24}$/.test(code)) { setS('missing'); return }
    fetch(`/api/meta/facebook/deletion-status?code=${code}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : 'missing')).then(setS).catch(() => setS('missing'))
  }, [code])
  return (
    <main className="fbp" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: 'var(--crm-bg)' }}>
      <div className="fbp-card fbp-stack" style={{ maxWidth: 520 }}>
        <h1 className="fbp-h">Facebook data deletion</h1>
        {s === null && <p className="fbp-sub">Checking…</p>}
        {s === 'missing' && <p className="fbp-sub">We could not find this deletion request. Check the confirmation code from Facebook.</p>}
        {s && s !== 'missing' && <p className="fbp-sub">{s.status === 'completed'
          ? 'Done. ARGUS has disconnected your Facebook account and deleted the stored access credentials. Posts already published on your Page stay on Facebook and can be removed there.'
          : 'Your request was received and is being processed.'}</p>}
        <p className="fbp-faint">Confirmation code: {code || '—'}</p>
      </div>
    </main>
  )
}
export default function Page() { return <Suspense fallback={null}><Status /></Suspense> }
