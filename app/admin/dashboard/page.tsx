'use client'
import { useEffect, useState } from 'react'
import { adminApi } from '@/lib/admin-api'

export default function DashboardPage() {
  const [stats, setStats] = useState<Record<string, number> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi.stats().then(setStats).catch(e => setError(e.message))
  }, [])

  const cards = stats
    ? [
        { label: 'Total Owners', value: stats.total_owners ?? 0, color: 'text-blue-400' },
        { label: 'Active Owners', value: stats.active_owners ?? 0, color: 'text-green-400' },
        { label: 'Total Clients', value: stats.total_clients ?? 0, color: 'text-purple-400' },
        { label: 'Warm Contacts', value: stats.warm_contacts ?? 0, color: 'text-orange-400' },
        { label: 'Outreach (30d)', value: stats.outreach_30d ?? 0, color: 'text-yellow-400' },
        { label: 'Properties', value: stats.total_properties ?? 0, color: 'text-[#B8953F]' },
      ]
    : []

  return (
    <div>
      <h1 className="text-xl font-semibold text-white mb-6">Overview</h1>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {!stats && !error && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white/5 rounded-xl p-5 animate-pulse h-24" />
          ))}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map(card => (
            <div key={card.label} className="bg-white/5 rounded-xl p-5 border border-white/5">
              <p className="text-xs text-white/50 uppercase tracking-wide mb-2">{card.label}</p>
              <p className={`text-3xl font-bold ${card.color}`}>{card.value.toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
