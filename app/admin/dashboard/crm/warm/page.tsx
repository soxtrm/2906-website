'use client'
import { useEffect, useState } from 'react'
import { adminApi, WarmContact } from '@/lib/admin-api'

export default function WarmPage() {
  const [contacts, setContacts] = useState<WarmContact[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'all' | 'warm' | 'upcoming' | 'property'>('all')

  const limit = 30

  async function load() {
    setLoading(true)
    try {
      let q = `?limit=${limit}&offset=${page * limit}`
      if (filter === 'warm') q += '&is_warm=true'
      if (filter === 'upcoming') q += '&is_upcoming=true'
      if (filter === 'property') q += '&has_property=true'
      const data = await adminApi.getWarm(q)
      setContacts(data.contacts)
      setTotal(data.total)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [page, filter]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h1 className="text-xl font-semibold text-white mb-4">Warm Contacts</h1>

      <div className="flex gap-2 mb-4">
        {(['all', 'warm', 'upcoming', 'property'] as const).map(f => (
          <button key={f} onClick={() => { setFilter(f); setPage(0) }}
            className={`text-xs px-3 py-1.5 rounded-full capitalize transition-colors ${
              filter === f ? 'bg-[#B8953F] text-white' : 'bg-white/5 text-white/50 hover:text-white'
            }`}>
            {f === 'property' ? 'Has Property' : f}
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      {loading && <p className="text-white/40 text-sm">Loading…</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-white/50 text-xs uppercase tracking-wide">
              <th className="text-left py-2 pr-4">Phone</th>
              <th className="text-left py-2 pr-4">Name</th>
              <th className="text-left py-2 pr-4">Session</th>
              <th className="text-left py-2 pr-4">Warm</th>
              <th className="text-left py-2 pr-4">Has Property</th>
              <th className="text-left py-2 pr-4">Upcoming</th>
              <th className="text-left py-2">Last Interaction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {contacts.map(c => (
              <tr key={c.phone} className="hover:bg-white/5 transition-colors">
                <td className="py-2.5 pr-4 text-white font-medium">{c.phone}</td>
                <td className="py-2.5 pr-4 text-white/60">{c.owner_name || '—'}</td>
                <td className="py-2.5 pr-4 text-white/60 text-xs">{c.session}</td>
                <td className="py-2.5 pr-4">
                  <span className={`text-xs ${c.is_warm ? 'text-orange-400' : 'text-white/20'}`}>{c.is_warm ? '🔥' : '—'}</span>
                </td>
                <td className="py-2.5 pr-4">
                  <span className={`text-xs ${c.has_property ? 'text-green-400' : 'text-white/20'}`}>{c.has_property ? '✓' : '—'}</span>
                </td>
                <td className="py-2.5 pr-4">
                  <span className={`text-xs ${c.is_upcoming ? 'text-blue-400' : 'text-white/20'}`}>{c.is_upcoming ? '📅' : '—'}</span>
                </td>
                <td className="py-2.5 text-white/50 text-xs">
                  {c.last_interaction ? new Date(c.last_interaction).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > limit && (
        <div className="flex items-center gap-3 mt-4 text-sm">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="text-white/50 hover:text-white disabled:opacity-30">← Prev</button>
          <span className="text-white/30">{page + 1} / {Math.ceil(total / limit)}</span>
          <button disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)} className="text-white/50 hover:text-white disabled:opacity-30">Next →</button>
        </div>
      )}
    </div>
  )
}
