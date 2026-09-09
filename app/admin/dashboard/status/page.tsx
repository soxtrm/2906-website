'use client'
import { useEffect, useState } from 'react'
import { adminApi, FbStatusResponse } from '@/lib/admin-api'

const LEVEL_STYLE: Record<string, string> = {
  info: 'bg-white/10 text-white/60',
  warn: 'bg-yellow-400/10 text-yellow-400',
  error: 'bg-red-400/10 text-red-400',
}

const RUN_STATUS_STYLE: Record<string, string> = {
  running: 'bg-green-400/10 text-green-400',
  paused: 'bg-yellow-400/10 text-yellow-400',
}

function fmt(ts: string) {
  return new Date(ts).toLocaleString()
}

export default function StatusDashboardPage() {
  const [data, setData] = useState<FbStatusResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
      const d = await adminApi.getFbStatus()
      setData(d)
      setError('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load status')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Status Dashboard</h1>
        <span className="text-xs text-white/30">Auto-refreshes every 30s</span>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {loading && <p className="text-white/40 text-sm">Loading…</p>}

      {data && (
        <div className="space-y-6">
          {/* ── FB Page post queue ─────────────────────────────────────── */}
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <h2 className="text-sm font-medium text-white/80 mb-3">Facebook Page Post Queue</h2>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-white/60">
                Queued: <span className="text-white font-medium">{data.pageQueue.queued ?? '—'}</span>
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${data.pageQueue.paused ? 'bg-yellow-400/10 text-yellow-400' : 'bg-green-400/10 text-green-400'}`}>
                {data.pageQueue.paused ? '⏸️ Paused' : '▶️ Running'}
              </span>
            </div>
          </div>

          {/* ── FB group-share runs ────────────────────────────────────── */}
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <h2 className="text-sm font-medium text-white/80 mb-3">Facebook Group Share Runs</h2>
            {data.groupRuns.length === 0 ? (
              <p className="text-white/30 text-sm">No active or paused runs.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-white/50 text-xs uppercase tracking-wide">
                      <th className="text-left py-2 pr-4">Ref</th>
                      <th className="text-left py-2 pr-4">Status</th>
                      <th className="text-left py-2 pr-4">Progress</th>
                      <th className="text-left py-2 pr-4">Reason</th>
                      <th className="text-left py-2">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {data.groupRuns.map(r => (
                      <tr key={r.id} className="hover:bg-white/5 transition-colors">
                        <td className="py-2.5 pr-4 text-white font-medium">#{r.ref}</td>
                        <td className="py-2.5 pr-4">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${RUN_STATUS_STYLE[r.status] || 'bg-white/10 text-white/60'}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-white/70">
                          {r.posted_count}/{r.total_groups} posted{r.failed_count ? ` · ${r.failed_count} failed` : ''}
                        </td>
                        <td className="py-2.5 pr-4 text-white/50 text-xs max-w-xs truncate" title={r.paused_reason || ''}>
                          {r.paused_reason || '—'}
                        </td>
                        <td className="py-2.5 text-white/40 text-xs whitespace-nowrap">{fmt(r.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── WAHA sessions ───────────────────────────────────────────── */}
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <h2 className="text-sm font-medium text-white/80 mb-3">WhatsApp Sessions (WAHA)</h2>
            <div className="flex flex-wrap gap-2">
              {data.wahaSessions.length === 0 && <p className="text-white/30 text-sm">No session data.</p>}
              {data.wahaSessions.map(s => (
                <span key={s.name} className={`text-xs px-2.5 py-1 rounded-full ${
                  s.status === 'WORKING' ? 'bg-green-400/10 text-green-400' : 'bg-yellow-400/10 text-yellow-400'
                }`}>
                  {s.name}: {s.status}
                </span>
              ))}
            </div>
          </div>

          {/* ── Recent automation status log ───────────────────────────── */}
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <h2 className="text-sm font-medium text-white/80 mb-3">Recent Facebook Automation Events</h2>
            {data.log.length === 0 ? (
              <p className="text-white/30 text-sm">No events logged yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-96 overflow-y-auto">
                {data.log.map(entry => (
                  <div key={entry.id} className="flex items-start gap-3 py-1.5 border-b border-white/5 last:border-0 text-sm">
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${LEVEL_STYLE[entry.level] || LEVEL_STYLE.info}`}>
                      {entry.level}
                    </span>
                    <span className="text-white/70 flex-1">
                      {entry.ref && <span className="text-white font-medium">#{entry.ref} — </span>}
                      {entry.message}
                    </span>
                    <span className="text-white/30 text-xs shrink-0 whitespace-nowrap">{fmt(entry.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
