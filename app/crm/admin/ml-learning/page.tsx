'use client'
import { useEffect, useState } from 'react'
import { crmGet } from '@/lib/crm/api'
import { CrmProvider, CrmShell, A, AD, AB, F, FM, useCrm } from '@/lib/crm/ui'

type Summary = { system: string; table: string; total: number; approved?: number; pending?: number }
type PendingRow = { id: number; kind: 'style_example' | 'phrasing_variant'; text: string; created_at: string; source?: string; session?: string; purpose?: string }
type MlData = {
  summary: Summary[]
  pendingApprovals: PendingRow[]
  recent: Record<string, any[]>
}

function fmt(ts: string) { return new Date(ts).toLocaleString() }

export default function MlLearningPage() {
  return <CrmProvider><MlLearning /></CrmProvider>
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background: '#FFF', borderRadius: 14, padding: '18px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>{children}</div>
}

function MlLearning() {
  const { me } = useCrm()
  const [data, setData] = useState<MlData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    crmGet('admin/ml-learning').then(d => { setData(d); setError('') }).catch(e => setError(e?.message || 'Failed to load')).finally(() => setLoading(false))
  }, [])

  if (me && me.role !== 'admin') {
    return (
      <CrmShell title="Learning Overview">
        <div style={{ padding: 26, fontFamily: F, color: '#AAA', fontSize: 13 }}>Admins only.</div>
      </CrmShell>
    )
  }

  return (
    <CrmShell title="Learning Overview" subtitle="What the system has actually picked up from your own writing style — plain examples, not raw logs.">
      <div style={{ padding: 26, fontFamily: F }}>
        {loading && <div style={{ fontSize: 12, color: '#AAA' }}>Loading…</div>}
        {error && <div style={{ fontSize: 12, color: '#B91C1C' }}>{error}</div>}

        {data && (
          <>
            {/* ── counts per system ─────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
              {data.summary.map(s => (
                <Card key={s.table}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{s.system}</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#0F0F0F', marginTop: 6 }}>{s.total}</div>
                  <div style={{ fontSize: 11, color: '#AAA', marginTop: 2 }}>examples collected</div>
                  {s.approved != null && (
                    <div style={{ marginTop: 8, fontSize: 11, display: 'flex', gap: 10 }}>
                      <span style={{ color: '#15803D' }}>{s.approved} approved</span>
                      <span style={{ color: (s.pending || 0) > 0 ? '#A16207' : '#CCC' }}>{s.pending} pending</span>
                    </div>
                  )}
                </Card>
              ))}
            </div>

            {/* ── pending approvals ─────────────────────────────────────── */}
            <div style={{ marginTop: 26, background: '#FFF', borderRadius: 14, padding: '18px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 4 }}>
                Waiting for your approval
              </div>
              <div style={{ fontSize: 11, color: '#CCC', marginBottom: 12 }}>
                Nothing here is used by the system until you approve it — no self-learning happens silently.
              </div>
              {!data.pendingApprovals.length && <div style={{ fontSize: 12, color: '#BBB' }}>Nothing waiting right now.</div>}
              {data.pendingApprovals.map(r => (
                <div key={`${r.kind}-${r.id}`} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid #F4F2EC', fontSize: 12.5 }}>
                  <span style={{ fontFamily: FM, fontSize: 10, color: '#CCC', minWidth: 120, flexShrink: 0 }}>{fmt(r.created_at)}</span>
                  <span style={{ background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                    {r.kind === 'style_example' ? (r.session || 'style') : (r.purpose || 'phrasing')}
                  </span>
                  <span style={{ color: '#333', flex: 1 }}>&ldquo;{r.text}&rdquo;</span>
                </div>
              ))}
            </div>

            {/* ── recent examples, per table ─────────────────────────────── */}
            {Object.entries(data.recent).map(([table, rows]) => (
              <div key={table} style={{ marginTop: 18, background: '#FFF', borderRadius: 14, padding: '18px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>
                  {table.replace(/_/g, ' ')}
                </div>
                {!rows.length && <div style={{ fontSize: 12, color: '#BBB' }}>Nothing collected yet.</div>}
                {rows.map((r: any) => (
                  <div key={r.id} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid #F4F2EC', fontSize: 12 }}>
                    <span style={{ fontFamily: FM, fontSize: 10, color: '#CCC', minWidth: 120, flexShrink: 0 }}>{fmt(r.created_at)}</span>
                    {r.direction && <span style={{ fontSize: 10, color: r.direction === 'in' ? '#A16207' : '#15803D', minWidth: 34, flexShrink: 0 }}>{r.direction === 'in' ? 'them' : 'you'}</span>}
                    {'approved' in r && (
                      <span style={{ fontSize: 9, fontWeight: 700, flexShrink: 0, color: r.approved === true ? '#15803D' : r.approved === false ? '#B91C1C' : '#A16207' }}>
                        {r.approved === true ? '✓' : r.approved === false ? '✗' : '…'}
                      </span>
                    )}
                    <span style={{ color: '#555', flex: 1 }}>{r.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </CrmShell>
  )
}
