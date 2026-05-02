'use client'
import { useCallback, useEffect, useState } from 'react'
import { adminApi, PropertyMatch } from '@/lib/admin-api'

const STATUSES = [
  { key: 'pending_notification', label: 'Pending Notification', color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20' },
  { key: 'notified',             label: 'Notified',             color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/20' },
  { key: 'viewing_scheduled',    label: 'Viewing Scheduled',    color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20' },
  { key: 'closed',               label: 'Closed',               color: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/20' },
  { key: 'rejected',             label: 'Rejected',             color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
]

const NEXT_STATUS: Record<string, string> = {
  pending_notification: 'notified',
  notified: 'viewing_scheduled',
  viewing_scheduled: 'closed',
}

const NEXT_LABEL: Record<string, string> = {
  pending_notification: 'Mark Notified',
  notified: 'Mark Viewing',
  viewing_scheduled: 'Mark Closed',
}

function scoreColor(score: number) {
  if (score >= 80) return 'text-green-400'
  if (score >= 60) return 'text-yellow-400'
  return 'text-white/50'
}

function MatchCard({ match, onAction }: { match: PropertyMatch; onAction: (id: string, status: string) => void }) {
  const [acting, setActing] = useState(false)

  async function act(status: string) {
    setActing(true)
    await onAction(match.id, status)
    setActing(false)
  }

  const nextStatus = NEXT_STATUS[match.status]
  const nextLabel = NEXT_LABEL[match.status]

  return (
    <div className="bg-white/5 border border-white/5 rounded-xl p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-white text-sm font-medium">{match.client_name || 'Unknown Client'}</p>
          <p className="text-white/40 text-[10px]">{match.client_phone}</p>
        </div>
        <div className="text-right">
          <span className={`text-lg font-bold ${scoreColor(match.match_score)}`}>{match.match_score}%</span>
          <p className="text-white/30 text-[9px]">match</p>
        </div>
      </div>

      {/* Property info */}
      <div className="bg-white/3 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-white/70 text-xs truncate">{match.property_location || 'Unknown location'}</p>
            {match.property_display_id && (
              <p className="text-white/30 text-[10px] font-mono">{match.property_display_id}</p>
            )}
          </div>
          {match.property_price > 0 && (
            <span className="text-[#B8953F] text-xs font-medium shrink-0">€{match.property_price?.toLocaleString()}</span>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="flex items-center justify-between text-[10px] text-white/30">
        <span>{match.assigned_agent || '—'}</span>
        <span>{new Date(match.created_at).toLocaleDateString()}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {nextStatus && nextLabel && (
          <button
            onClick={() => act(nextStatus)}
            disabled={acting}
            className="flex-1 text-[10px] py-1.5 rounded-lg bg-[#B8953F]/20 text-[#B8953F] hover:bg-[#B8953F]/30 transition-colors disabled:opacity-50 font-medium"
          >
            {acting ? '…' : nextLabel}
          </button>
        )}
        {match.status !== 'rejected' && match.status !== 'closed' && (
          <button
            onClick={() => act('rejected')}
            disabled={acting}
            className="text-[10px] px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400/70 hover:bg-red-500/20 hover:text-red-400 transition-colors disabled:opacity-50"
          >
            Reject
          </button>
        )}
      </div>
    </div>
  )
}

export default function MatchesPage() {
  const [activeStatus, setActiveStatus] = useState('pending_notification')
  const [allMatches, setAllMatches] = useState<Record<string, PropertyMatch[]>>({})
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const results = await Promise.allSettled(
        STATUSES.map(s => adminApi.getMatches(`?status=${s.key}&limit=50`))
      )
      const newMatches: Record<string, PropertyMatch[]> = {}
      const newCounts: Record<string, number> = {}
      results.forEach((r, i) => {
        const key = STATUSES[i].key
        if (r.status === 'fulfilled') {
          newMatches[key] = r.value.matches
          newCounts[key] = r.value.total
        } else {
          newMatches[key] = []
          newCounts[key] = 0
        }
      })
      setAllMatches(newMatches)
      setCounts(newCounts)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load matches')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  async function handleAction(id: string, status: string) {
    try {
      await adminApi.updateMatch(id, status)
      await loadAll()
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Action failed')
    }
  }

  const currentStatus = STATUSES.find(s => s.key === activeStatus)!
  const currentMatches = allMatches[activeStatus] || []
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Matches Pipeline</h1>
          {totalAll > 0 && <p className="text-white/40 text-xs mt-0.5">{totalAll} total matches</p>}
        </div>
        <button
          onClick={loadAll}
          className="text-xs text-[#B8953F] hover:text-white border border-[#B8953F]/40 hover:border-[#B8953F] px-3 py-2 rounded-lg transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {/* Status tabs */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
        {STATUSES.map(s => (
          <button
            key={s.key}
            onClick={() => setActiveStatus(s.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium whitespace-nowrap border transition-all ${
              activeStatus === s.key
                ? `${s.bg} ${s.color} border-current`
                : 'bg-white/5 text-white/50 border-white/5 hover:border-white/20 hover:text-white'
            }`}
          >
            {s.label}
            {counts[s.key] > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${activeStatus === s.key ? 'bg-white/20' : 'bg-white/10'}`}>
                {counts[s.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Pipeline columns — horizontal scroll on mobile, grid on desktop */}
      {loading ? (
        <p className="text-white/40 text-sm">Loading…</p>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <span className={`text-sm font-medium ${currentStatus.color}`}>{currentStatus.label}</span>
            <span className="text-white/30 text-xs">{currentMatches.length} match{currentMatches.length !== 1 ? 'es' : ''}</span>
          </div>

          {currentMatches.length === 0 ? (
            <div className="text-center py-16">
              <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-3 text-2xl">🔗</div>
              <p className="text-white/30 text-sm">No matches in this stage</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {currentMatches.map(m => (
                <MatchCard key={m.id} match={m} onAction={handleAction} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
