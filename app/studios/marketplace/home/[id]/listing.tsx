'use client'
// One listing as its own page (shared links, search engines). On the list, the same body opens as an overlay.
// The enquiry goes through the existing SmartTunnel (/api/nexus/interest) into ARGUS; nothing is promised
// that the agency has not confirmed.
import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { NexusStar } from '@/components/brand/logo'
import type { ListingDetail } from '@/lib/marketplace/model'
import { ListingBody } from '../../parts'

export function ListingView({ id }: { id: string }) {
  const [l, setL] = useState<ListingDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [pro, setPro] = useState(false)
  useEffect(() => {
    try { setPro(localStorage.getItem('nx-mp-pro') === '1') } catch { /* private mode */ }
    fetch(`/api/marketplace/listings?id=${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(d => setL(d.listing)).catch(() => setMissing(true))
  }, [id])
  const back = () => { if (window.history.length > 1 && document.referrer.includes(window.location.host)) window.history.back(); else window.location.href = '/marketplace' }

  return (
    <div className="mp mp-detail">
      <header className="mp-top">
        <a className="st-brand" href="/" aria-label="NEXUS STUDIOS home"><NexusStar size={18} className="st-star" />NEXUS <b>STUDIOS</b></a>
        <button className="mp-back" onClick={back}><ArrowLeft size={16} aria-hidden="true" />All homes</button>
      </header>
      {missing ? <p className="mp-empty">This home is no longer listed. <a className="mp-link" href="/marketplace">See all homes</a></p>
        : !l ? <div className="mp-card mp-skel mp-skel-big" aria-busy="true" />
        : <ListingBody l={l} pro={pro} />}
    </div>
  )
}
