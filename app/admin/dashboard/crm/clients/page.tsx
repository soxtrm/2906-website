'use client'
import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import { adminApi, Client } from '@/lib/admin-api'

// ARGUS V3 (Kev, 2026-09-16, spec section 24): "Manual CRM edits become
// canonical" — the form keeps arrays as comma-separated strings (same
// convention app/crm/clientgroups/page.tsx already uses for nationalities)
// and converts at save time, so an agent never has to type JSON.
type EditForm = {
  status: string; notes: string
  budget_min: string; budget_max: string; stretch_budget_max: string
  bedrooms_wanted: string; requires_study_room: boolean
  property_types: string; balcony_requirement: string
  top_priority_villages: string
  lease_type_wanted: string; parking_wanted: string
  move_in_date: string; move_in_to: string
  pets: string; subletting: string
}

function toEditForm(c: Client): EditForm {
  // A client may have named more than one bedroom count as an OR-acceptable
  // alternative (e.g. Jean Claude: "2BR OR 1BR+study") — bedroom_alternatives
  // already IS that OR-list; bedrooms_wanted is the legacy plain minimum.
  // The form shows whichever is set, and "requires study" reflects whether
  // ANY alternative asked for one, since this simple form edits one
  // combined list rather than per-alternative study flags.
  const bedNums = c.bedroom_alternatives?.length
    ? c.bedroom_alternatives.map(a => a.bedrooms)
    : (c.bedrooms_wanted || [])
  return {
    status: c.status || '', notes: c.notes || '',
    budget_min: c.budget_min != null ? String(c.budget_min) : '',
    budget_max: c.budget_max != null ? String(c.budget_max) : '',
    stretch_budget_max: c.stretch_budget_max != null ? String(c.stretch_budget_max) : '',
    bedrooms_wanted: bedNums.join(', '),
    requires_study_room: !!c.bedroom_alternatives?.some(a => a.requires_study_room),
    property_types: (c.property_types || []).join(', '),
    balcony_requirement: c.balcony_requirement || '',
    top_priority_villages: (c.top_priority_villages || c.preferred_villages || c.locations || []).join(', '),
    lease_type_wanted: c.lease_type_wanted || '',
    parking_wanted: c.parking_wanted === true ? 'true' : c.parking_wanted === false ? 'false' : '',
    move_in_date: c.move_in_date ? String(c.move_in_date).slice(0, 10) : '',
    move_in_to: c.move_in_to ? String(c.move_in_to).slice(0, 10) : '',
    pets: c.pets || '', subletting: c.subletting || '',
  }
}

// Converts the form back to the PATCH payload matchEngine.js's scorer reads.
// bedrooms_wanted stays the legacy minimum-array; bedroom_alternatives is
// only written when "requires study" is checked (a plain multi-bedroom list
// with no study flag has no OR-logic to express, so it stays null and the
// engine falls back to the minimum rule, unchanged behaviour).
function fromEditForm(f: EditForm): Record<string, unknown> {
  const nums = f.bedrooms_wanted.split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n))
  const triState = (v: string) => (v === 'true' ? true : v === 'false' ? false : null)
  return {
    status: f.status || null, notes: f.notes || null,
    budget_min: f.budget_min ? Number(f.budget_min) : null,
    budget_max: f.budget_max ? Number(f.budget_max) : null,
    stretch_budget_max: f.stretch_budget_max ? Number(f.stretch_budget_max) : null,
    bedrooms_wanted: nums.length ? nums : null,
    bedroom_alternatives: f.requires_study_room && nums.length
      ? nums.map(n => ({ bedrooms: n, requires_study_room: true })) : null,
    property_types: f.property_types ? f.property_types.split(',').map(s => s.trim()).filter(Boolean) : null,
    balcony_requirement: f.balcony_requirement || null,
    top_priority_villages: f.top_priority_villages ? f.top_priority_villages.split(',').map(s => s.trim()).filter(Boolean) : null,
    lease_type_wanted: f.lease_type_wanted || null,
    parking_wanted: triState(f.parking_wanted),
    move_in_date: f.move_in_date || null,
    move_in_to: f.move_in_to || null,
    pets: f.pets || null, subletting: f.subletting || null,
  }
}

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Client | null>(null)
  const [editing, setEditing] = useState<EditForm | null>(null)
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
    setEditing(toEditForm(c))
  }

  async function saveClient() {
    if (!selected || !editing) return
    setSaving(true)
    try {
      const payload = fromEditForm(editing)
      await adminApi.updateClient(selected.phone, payload)
      setSelected(prev => prev ? ({ ...prev, ...payload } as unknown as Client) : prev)
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

            {editing && (() => {
              const inputCls = "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]"
              const set = (k: keyof EditForm) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
                setEditing(prev => prev ? { ...prev, [k]: (e.target as HTMLInputElement).type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value } : prev)
              const Field = ({ label, children }: { label: string; children: ReactNode }) => (
                <div><label className="block text-xs text-white/50 mb-1">{label}</label>{children}</div>
              )
              return (
                <div className="space-y-3">
                  <Field label="Status"><input value={editing.status} onChange={set('status')} className={inputCls} /></Field>

                  {/* ARGUS V3 (spec section 24) — the structured requirement
                      fields the match engine's scorer reads. This edit
                      becomes canonical for the NEXT !match run. */}
                  <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/10">
                    <Field label="Budget min (€)"><input value={editing.budget_min} onChange={set('budget_min')} className={inputCls} /></Field>
                    <Field label="Budget max (€)"><input value={editing.budget_max} onChange={set('budget_max')} className={inputCls} /></Field>
                    <Field label="Stretch ceiling (€, optional)"><input value={editing.stretch_budget_max} onChange={set('stretch_budget_max')} className={inputCls} placeholder="e.g. 1700" /></Field>
                    <Field label="Bedrooms wanted (comma-sep)"><input value={editing.bedrooms_wanted} onChange={set('bedrooms_wanted')} className={inputCls} placeholder="e.g. 2, 1" /></Field>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-white/60">
                    <input type="checkbox" checked={editing.requires_study_room} onChange={set('requires_study_room')} className="accent-[#B8953F]" />
                    Smaller bedroom count above only counts with a genuine study/office room
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Preferred property types (comma-sep)"><input value={editing.property_types} onChange={set('property_types')} className={inputCls} placeholder="penthouse, maisonette" /></Field>
                    <Field label="Balcony fallback rule">
                      <select value={editing.balcony_requirement} onChange={set('balcony_requirement')} className={inputCls}>
                        <option value="">None stated</option>
                        <option value="fallback_only">Non-preferred type OK only with a large balcony</option>
                        <option value="required">Balcony required</option>
                      </select>
                    </Field>
                  </div>

                  <Field label="Localities (comma-sep)"><input value={editing.top_priority_villages} onChange={set('top_priority_villages')} className={inputCls} placeholder="Ta' Xbiex, Floriana, Sliema" /></Field>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Move-in from"><input type="date" value={editing.move_in_date} onChange={set('move_in_date')} className={inputCls} /></Field>
                    <Field label="Move-in to (optional range end)"><input type="date" value={editing.move_in_to} onChange={set('move_in_to')} className={inputCls} /></Field>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Lease type accepted">
                      <select value={editing.lease_type_wanted} onChange={set('lease_type_wanted')} className={inputCls}>
                        <option value="">Long-let only (default)</option>
                        <option value="winter_let">Also accepts winter-let</option>
                        <option value="short_let">Also accepts short-let</option>
                        <option value="flexible">Flexible / any lease type</option>
                      </select>
                    </Field>
                    <Field label="Parking wanted">
                      <select value={editing.parking_wanted} onChange={set('parking_wanted')} className={inputCls}>
                        <option value="">Not stated</option><option value="true">Yes</option><option value="false">No</option>
                      </select>
                    </Field>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Pets"><input value={editing.pets} onChange={set('pets')} className={inputCls} /></Field>
                    <Field label="Subletting"><input value={editing.subletting} onChange={set('subletting')} className={inputCls} /></Field>
                  </div>

                  <Field label="Notes">
                    <textarea rows={4} value={editing.notes} onChange={set('notes')} className={inputCls + " resize-none"} />
                  </Field>

                  <button onClick={saveClient} disabled={saving}
                    className="bg-[#B8953F] hover:bg-[#a07c30] disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
