'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch } from '@/lib/crm/api'
import {
  CrmProvider, CrmShell, A, AD, AB, F, FM, fmtDate, useCrm,
  DCARD, DCARD_BORDER, DTEXT, DTEXT_DIM, DTEXT_FAINT, DBORDER, glowFor,
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
      <div style={{ padding: 26, fontFamily: F }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14 }}>
          {cards.map((c, i) => {
            const g = glowFor(c.label)
            return (
              <div key={c.label} style={{
                background: DCARD, borderRadius: 14, padding: '18px 20px',
                border: `1px solid ${DCARD_BORDER}`,
                boxShadow: `0 0 0 1px rgba(255,255,255,0.02), 0 16px 40px -22px ${g.glow}`,
              }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: DTEXT, letterSpacing: '-0.02em' }}>{c.value}</div>
                <div style={{ fontSize: 11, color: DTEXT_FAINT, marginTop: 4 }}>{c.label}</div>
              </div>
            )
          })}
        </div>

        <div style={{ marginTop: 26, background: DCARD, borderRadius: 14, padding: '18px 22px', border: `1px solid ${DCARD_BORDER}` }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: DTEXT_FAINT, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Recent activity feed</div>
          {(!s || !s.recent?.length) && <div style={{ fontSize: 12, color: DTEXT_FAINT }}>No activity yet.</div>}
          {s?.recent?.map((a: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${DBORDER}`, fontSize: 12 }}>
              <span style={{ fontFamily: FM, fontSize: 10, color: DTEXT_FAINT, minWidth: 120 }}>{fmtDate(a.when)}</span>
              <span style={{ background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>{a.who || '—'}</span>
              <span style={{ color: DTEXT_DIM }}>
                <strong style={{ color: DTEXT }}>{a.ref}</strong> · {a.town} — {(a.type || '').replace(/_/g, ' ')}
              </span>
              {a.significant && <span style={{ marginLeft: 'auto', fontSize: 9, color: A }}>●</span>}
            </div>
          ))}
        </div>

        {/* ARGUS/Outreach moved into the sidebar nav (admin-only) —
            Kev, 2026-09-11: "outreach kann auch ins crm tab, halt nur für
            mich". The dashboard tile it used to live in here is gone rather
            than duplicated. */}

        {me?.role === 'admin' && (
          <div onClick={() => router.push('/admin/ml-learning')} style={{ marginTop: 18, background: DCARD, borderRadius: 14, padding: '14px 20px', border: `1px solid ${DCARD_BORDER}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: DTEXT }}>🧠 Learning Overview</div>
              <div style={{ fontSize: 11, color: DTEXT_FAINT, marginTop: 2 }}>See what the style-learning system has actually picked up, in plain language.</div>
            </div>
            <span style={{ fontSize: 12, color: A }}>Open →</span>
          </div>
        )}

        <div style={{ marginTop: 18, fontSize: 11, color: DTEXT_FAINT }}>Earnings, commissions and admin tools arrive in Phase 2.</div>
      </div>
    </CrmShell>
  )
}
