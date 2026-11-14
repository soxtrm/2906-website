'use client'
// Meta redirects here after the official Facebook sign-in. We immediately
// remove the code from the address bar, hand {code, state} to the backend with
// the agent's own session, and go back to the Facebook settings.
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CrmProvider, CrmShell } from '@/lib/crm/ui'
import { crmPath } from '@/components/crm/group-navigation'
import { fb, errorMessage } from '@/lib/crm/facebook'
import { FacebookGlyph, CrmLink } from '@/components/crm/facebook/shared'

function Callback() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname() || '/'
  const once = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (once.current) return
    once.current = true
    const code = params.get('code'), state = params.get('state'), error = params.get('error')
    try { window.history.replaceState(null, '', window.location.pathname) } catch { /* keep going */ }
    fb.complete({ code, state, error })
      .then(() => router.replace(crmPath('/integrations/facebook?connected=1', pathname)))
      .catch(e => setErr(errorMessage(e, 'Facebook could not be connected. Please try again.')))
  }, [params, router, pathname])
  return (
    <div className="fbp fbp-card fbp-stack" style={{ maxWidth: 560 }}>
      <div className="fbp-row"><FacebookGlyph size={24} /><h2 className="fbp-h">{err ? 'Facebook was not connected' : 'Connecting Facebook…'}</h2></div>
      {err ? <><div className="fbp-note" data-tone="bad">{err}</div><div><CrmLink href="/integrations/facebook" className="fbp-btn">Back to Facebook settings</CrmLink></div></>
        : <div className="fbp-row"><div className="fbp-spinner" aria-hidden /><span className="fbp-sub">Checking your Pages and permissions.</span></div>}
    </div>
  )
}

export default function Page() {
  return <CrmProvider><CrmShell title="Facebook Business Pages" subtitle="Integrations"><Suspense fallback={null}><Callback /></Suspense></CrmShell></CrmProvider>
}
