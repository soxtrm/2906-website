'use client'
import { useEffect, useState } from 'react'
import { adminApi, AdminUser } from '@/lib/admin-api'

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', role: 'moderator' })
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await adminApi.getUsers()
      setUsers(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError('')
    try {
      await adminApi.createUser(form.email, form.password, form.role)
      setForm({ email: '', password: '', role: 'moderator' })
      setShowCreate(false)
      load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  async function toggleActive(user: AdminUser) {
    try {
      await adminApi.updateUser(user.id, { is_active: !user.is_active })
      load()
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed')
    }
  }

  async function deleteUser(id: string, email: string) {
    if (!confirm(`Delete user ${email}? This cannot be undone.`)) return
    try {
      await adminApi.deleteUser(id)
      load()
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Users</h1>
        <button onClick={() => setShowCreate(true)}
          className="bg-[#B8953F] hover:bg-[#a07c30] text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
          + Add User
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {loading && <p className="text-white/40 text-sm">Loading…</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-white/50 text-xs uppercase tracking-wide">
              <th className="text-left py-2 pr-4">Email</th>
              <th className="text-left py-2 pr-4">Role</th>
              <th className="text-left py-2 pr-4">Active</th>
              <th className="text-left py-2 pr-4">Last Login</th>
              <th className="text-left py-2 pr-4">Created By</th>
              <th className="text-left py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-white/5 transition-colors">
                <td className="py-2.5 pr-4 text-white font-medium">{u.email}</td>
                <td className="py-2.5 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                    u.role === 'admin' ? 'bg-[#B8953F]/20 text-[#B8953F]' : 'bg-white/10 text-white/60'
                  }`}>{u.role}</span>
                </td>
                <td className="py-2.5 pr-4">
                  <button onClick={() => toggleActive(u)}
                    className={`text-xs font-medium ${u.is_active ? 'text-green-400' : 'text-red-400/60'}`}>
                    {u.is_active ? '● Active' : '○ Inactive'}
                  </button>
                </td>
                <td className="py-2.5 pr-4 text-white/50 text-xs">
                  {u.last_login ? new Date(u.last_login).toLocaleDateString() : 'Never'}
                </td>
                <td className="py-2.5 pr-4 text-white/40 text-xs">{u.created_by_email || '—'}</td>
                <td className="py-2.5">
                  <button onClick={() => deleteUser(u.id, u.email)}
                    className="text-xs text-red-400/50 hover:text-red-400 transition-colors">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#111827] border border-white/10 rounded-2xl w-full max-w-sm">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <h2 className="font-semibold text-white">Add User</h2>
              <button onClick={() => { setShowCreate(false); setError('') }} className="text-white/40 hover:text-white">✕</button>
            </div>

            <form onSubmit={createUser} className="px-6 py-5 space-y-4">
              {error && <p className="text-red-400 text-sm bg-red-400/10 rounded-lg px-4 py-2">{error}</p>}

              <div>
                <label className="block text-xs text-white/50 mb-1">Email</label>
                <input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} required
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
              </div>
              <div>
                <label className="block text-xs text-white/50 mb-1">Password</label>
                <input type="password" value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} required minLength={8}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
              </div>
              <div>
                <label className="block text-xs text-white/50 mb-1">Role</label>
                <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]">
                  <option value="moderator" className="bg-[#111827]">Moderator</option>
                  <option value="admin" className="bg-[#111827]">Admin</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button type="button" onClick={() => { setShowCreate(false); setError('') }}
                  className="text-sm text-white/50 hover:text-white transition-colors">Cancel</button>
                <button type="submit" disabled={creating}
                  className="bg-[#B8953F] hover:bg-[#a07c30] disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors">
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
