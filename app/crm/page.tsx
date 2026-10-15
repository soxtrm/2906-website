'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Brain, Presentation } from 'lucide-react'
import { crmFetch } from '@/lib/crm/api'
import {
  CrmProvider, CrmShell, F, FM, fmtDate, useCrm, glowFor,
} from '@/lib/crm/ui'

export default function DashboardPage() {
  return <CrmProvider><Dashboard /></CrmProvider>
}

function Dashboard() {
  const router = useRouter()
  const { me } = useCrm()
  const [s, setS] = useState<any>(null)
  useEffect(() => { crmFetch('stats').then(setS).catch(() => {}) }, [])

  const cards = [
    { label: 'Total listings', value: s?.totalListings ?? '—' },
    { label: 'My listings', value: s?.myListings ?? '—' },
    { label: 'Hot owners (2+)', value: s?.hotOwners ?? '—' },
    { label: 'Recent activity', value: s?.recent?.length ?? '—' },
  ]

  return (
    <CrmShell title="Dashboard" subtitle={me ? `Welcome back, ${me.name || me.username}` : undefined} onAdd={() => router.push('/property/new')} dark>
      <div className="crm-dashboard" style={{ fontFamily: F }}>
        <div className="crm-dashboard-stats">
          {cards.map(c => {
            const g = glowFor(c.label)
            return (
              <div key={c.label} className="crm-dashboard-stat" style={{ '--dashboard-glow': g.glow } as React.CSSProperties}>
                <div className="crm-dashboard-value">{c.value}</div>
                <div className="crm-dashboard-label">{c.label}</div>
              </div>
            )
          })}
        </div>

        <section className="crm-dashboard-panel" aria-labelledby="recent-activity-title">
          <h2 id="recent-activity-title" className="crm-dashboard-eyebrow">Recent activity feed</h2>
          {(!s || !s.recent?.length) && <div className="crm-dashboard-empty">No activity yet.</div>}
          {s?.recent?.map((a: any, i: number) => (
            <div key={i} className="crm-dashboard-activity">
              <time style={{ fontFamily: FM }}>{fmtDate(a.when)}</time>
              <span className="crm-dashboard-person">{a.who || '—'}</span>
              <span className="crm-dashboard-description">
                <strong>{a.ref}</strong> · {a.town} — {(a.type || '').replace(/_/g, ' ')}
              </span>
              {a.significant && <span className="crm-dashboard-signal" aria-label="Significant activity">●</span>}
            </div>
          ))}
        </section>

        {/* ARGUS/Outreach moved into the sidebar nav (admin-only) —
            Kev, 2026-09-11: "outreach kann auch ins crm tab, halt nur für
            mich". The dashboard tile it used to live in here is gone rather
            than duplicated. */}

        {me?.role === 'admin' && (
          <Link href="/crm/pitch" className="crm-dashboard-link crm-dashboard-link-featured">
            <div className="crm-dashboard-link-copy">
              <span className="crm-dashboard-link-icon"><Presentation size={20} aria-hidden /></span>
              <div>
                <strong>Argus System · Ben Estates presentation</strong>
                <p>Live product story: agent workflow, distribution, outreach, assistants and Nexus Link.</p>
              </div>
            </div>
            <span className="crm-dashboard-link-action">Present <span aria-hidden>→</span></span>
          </Link>
        )}

        {me?.role === 'admin' && (
          <Link href="/crm/admin/ml-learning" className="crm-dashboard-link">
            <div className="crm-dashboard-link-copy">
              <span className="crm-dashboard-link-icon"><Brain size={19} aria-hidden /></span>
              <div>
                <strong>Learning Overview</strong>
                <p>See what the style-learning system has actually picked up, in plain language.</p>
              </div>
            </div>
            <span className="crm-dashboard-link-action">Open <span aria-hidden>→</span></span>
          </Link>
        )}

        <div style={{ marginTop: 18, fontSize: 11, color: DTEXT_FAINT }}>Earnings, commissions and admin tools arrive in Phase 2.</div>
      </div>
    </CrmShell>
  )
}
