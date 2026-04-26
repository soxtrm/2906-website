'use client'
import { useEffect, useState } from 'react'
import { adminApi, Client } from '@/lib/admin-api'

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Client | null>(null)
  const [editing, setEditing] = useState<{ status: string; notes: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const limit = 25

  async function load() {
    setLoading(true)
    try {
      const q = `?limit=${limit}&offset=${page * limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`
      const data = await adminApi.getClients(q)
      setClients(data.clients)
      setTotal(data.total)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [page, search]) // eslint-disable-line react-hooks/exhaustive-deps

  function openClient(c: Client) {
    setSelected(c)
    setEditing({ status: c.status || '', notes: c.notes || '' })
  }

  async function saveClient() {
    if (!selected || !editing) return
    setSaving(true)
    try {
      await adminApi.updateClient(selected.phone, editing)
      setSelected(prev => prev ? { ...prev, ...editing } : prev)
      load()
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex gap-6">
      <div className={`${selected ? 'hidden lg:block lg:w-1/2' : 'w-full'}`}>
        <h1 className="text-xl font-semibold text-white mb-4">Clients</h1>

        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          placeholder="Search name or phone…"
          className="w-full max-w-sm bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white placeholder-white/30 text-sm focus:outline-none focus:border-[#B8953F] mb-4"
        />

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        {loading && <p className="text-white/40 text-sm">Loading…</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-white/50 text-xs uppercase tracking-wide">
                <th className="text-left py-2 pr-4">Name</th>
                <th className="text-left py-2 pr-4">Phone</th>
                <th className="text-left py-2 pr-4">Budget</th>
                <th className="text-left py-2 pr-4">Beds</th>
                <th className="text-left py-2 pr-4">Status</th>
                <th className="text-left py-2">Agent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {clients.map(c => (
                <tr key={c.id} onClick={() => openClient(c)}
                  className="hover:bg-white/5 cursor-pointer transition-colors">
                  <td className="py-2.5 pr-4 text-white font-medium">{c.name || '—'}</td>
                  <td className="py-2.5 pr-4 text-white/60">{c.phone}</td>
                  <td className="py-2.5 pr-4 text-white/60">
                    {c.budget_min || c.budget_max ? `€${(c.budget_min || 0).toLocaleString()}–€${(c.budget_max || 0).toLocaleString()}` : '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-white/60">
                    {c.bedrooms_wanted?.length ? c.bedrooms_wanted.join(', ') : '—'}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="text-xs text-white/50 capitalize">{c.status || '—'}</span>
                  </td>
                  <td className="py-2.5 text-white/50 text-xs">{c.assigned_agent || '—'}</td>
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

      {selected && (
        <div className="flex-1 bg-white/3 rounded-xl border border-white/10 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-white">{selected.name || selected.phone}</h2>
            <button onClick={() => setSelected(null)} className="text-white/40 hover:text-white text-sm">✕ Close</button>
          </div>

          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-white/40 text-xs mb-0.5">Phone</p>
                <p className="text-white">{selected.phone}</p>
              </div>
              <div>
                <p className="text-white/40 text-xs mb-0.5">Budget</p>
                <p className="text-white">
                  {selected.budget_min || selected.budget_max
                    ? `€${(selected.budget_min || 0).toLocaleString()} – €${(selected.budget_max || 0).toLocaleString()}`
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-white/40 text-xs mb-0.5">Bedrooms Wanted</p>
                <p className="text-white">{selected.bedrooms_wanted?.join(', ') || '—'}</p>
              </div>
              <div>
                <p className="text-white/40 text-xs mb-0.5">Locations</p>
                <p className="text-white">{selected.locations?.join(', ') || '—'}</p>
              </div>
              <div>
                <p className="text-white/40 text-xs mb-0.5">Agent</p>
                <p className="text-white">{selected.assigned_agent || '—'}</p>
              </div>
              <div>
                <p className="text-white/40 text-xs mb-0.5">Added</p>
                <p className="text-white">{selected.created_at ? new Date(selected.created_at).toLocaleDateString() : '—'}</p>
              </div>
            </div>

            {editing && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-white/50 mb-1">Status</label>
                  <input value={editing.status} onChange={e => setEditing(prev => prev ? { ...prev, status: e.target.value } : prev)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Notes</label>
                  <textarea rows={4} value={editing.notes} onChange={e => setEditing(prev => prev ? { ...prev, notes: e.target.value } : prev)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F] resize-none" />
                </div>
                <button onClick={saveClient} disabled={saving}
                  className="bg-[#B8953F] hover:bg-[#a07c30] disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                  {saving ? 'Saving…' : 'Save Notes'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
