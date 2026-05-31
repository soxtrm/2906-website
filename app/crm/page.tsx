'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch } from '@/lib/crm/api'
import { CrmProvider, CrmShell, A, AD, AB, F, FM, fmtDate, useCrm } from '@/lib/crm/ui'

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
    <CrmShell title="Dashboard" subtitle={me ? `Welcome back, ${me.name || me.username}` : undefined} onAdd={() => router.push('/property/new')}>
      <div style={{ padding: 26, fontFamily: F }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14 }}>
          {cards.map(c => (
            <div key={c.label} style={{ background: '#FFF', borderRadius: 14, padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#0F0F0F', letterSpacing: '-0.02em' }}>{c.value}</div>
              <div style={{ fontSize: 11, color: '#AAA', marginTop: 4 }}>{c.label}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 26, background: '#FFF', borderRadius: 14, padding: '18px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Recent activity feed</div>
          {(!s || !s.recent?.length) && <div style={{ fontSize: 12, color: '#BBB' }}>No activity yet.</div>}
          {s?.recent?.map((a: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #F4F2EC', fontSize: 12 }}>
              <span style={{ fontFamily: FM, fontSize: 10, color: '#CCC', minWidth: 120 }}>{fmtDate(a.when)}</span>
              <span style={{ background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>{a.who || '—'}</span>
              <span style={{ color: '#555' }}>
                <strong style={{ color: '#0F0F0F' }}>{a.ref}</strong> · {a.town} — {(a.type || '').replace(/_/g, ' ')}
              </span>
              {a.significant && <span style={{ marginLeft: 'auto', fontSize: 9, color: A }}>●</span>}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18, fontSize: 11, color: '#CCC' }}>Earnings, commissions and admin tools arrive in Phase 2.</div>
      </div>
    </CrmShell>
  )
}
