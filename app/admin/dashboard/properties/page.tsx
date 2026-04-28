'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi, AdminProperty } from '@/lib/admin-api'

const EMPTY: Partial<AdminProperty> = {
  title: '', slug: '',
  listing_type: 'To Rent', price: 0, price_after: 'per month',
  bedrooms: null, bathrooms: 1, size: null,
  property_type: 'Apartment', category: 'letting',
  region: '', location: '', status: 'available',
  images: [], summary: '', description: '', full_description: '',
  features: [], available_from: '', featured: false, is_published: false,
}

const PROPERTY_TYPES = ['Apartment', 'Maisonette', 'Penthouse', 'Villa', 'Townhouse', 'Office', 'Retail', 'Warehouse', 'Garage', 'Land']
const REGIONS = ['Valletta', 'Sliema', "St Julian's", 'Msida', 'Gzira', 'Birkirkara', 'Mosta', 'Naxxar', 'Mellieha', 'Gozo', 'Other']

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export default function PropertiesPage() {
  const [properties, setProperties] = useState<AdminProperty[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<AdminProperty> | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [role, setRole] = useState<string | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setRole(localStorage.getItem('admin_role')) }, [])

  const limit = 20

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = `?page=${page + 1}&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`
      const data = await adminApi.getProperties(q)
      setProperties(data.properties)
      setTotal(data.total)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [page, search])

  useEffect(() => { load() }, [load])

  function openNew() { setEditing({ ...EMPTY }); setIsNew(true); setError('') }
  function openEdit(p: AdminProperty) { setEditing({ ...p }); setIsNew(false); setError('') }
  function closeModal() { setEditing(null); setError('') }

  function set(key: string, value: unknown) {
    setEditing(prev => {
      if (!prev) return prev
      const updated = { ...prev, [key]: value }
      if (key === 'title' && isNew) updated.slug = slugify(value as string)
      return updated
    })
  }

  async function save() {
    if (!editing) return
    setSaving(true); setError('')
    try {
      if (isNew) {
        await adminApi.createProperty(editing)
      } else {
        await adminApi.updateProperty(editing.id!, editing)
      }
      closeModal(); load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function del(id: string) {
    if (!confirm('Delete this property?')) return
    try { await adminApi.deleteProperty(id); load() }
    catch (e: unknown) { alert(e instanceof Error ? e.message : 'Delete failed') }
  }

  async function uploadImages(id: string, files: FileList) {
    setUploading(true)
    try {
      const data = await adminApi.uploadImages(id, files)
      setEditing(prev => prev ? { ...prev, images: [...(prev.images || []), ...data.images] } : prev)
      load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  function removeImage(idx: number) {
    setEditing(prev => {
      if (!prev) return prev
      const images = [...(prev.images || [])]
      images.splice(idx, 1)
      return { ...prev, images }
    })
  }

  function reorderImages(from: number, to: number) {
    setEditing(prev => {
      if (!prev) return prev
      const images = [...(prev.images || [])]
      const [moved] = images.splice(from, 1)
      images.splice(to, 0, moved)
      return { ...prev, images }
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Properties</h1>
        <button onClick={openNew} className="bg-[#B8953F] hover:bg-[#a07c30] text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
          + Add Property
        </button>
      </div>

      <div className="mb-4">
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          placeholder="Search properties…"
          className="w-full max-w-sm bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white placeholder-white/30 focus:outline-none focus:border-[#B8953F] text-sm"
        />
      </div>

      {loading && <p className="text-white/40 text-sm">Loading…</p>}
      {error && !editing && <p className="text-red-400 text-sm mb-4">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-white/50 text-xs uppercase tracking-wide">
              <th className="text-left py-3 pr-4">Title</th>
              <th className="text-left py-3 pr-4">Type</th>
              <th className="text-left py-3 pr-4">Price</th>
              <th className="text-left py-3 pr-4">Ref</th>
              <th className="text-left py-3 pr-4">Status</th>
              <th className="text-left py-3 pr-4">Live</th>
              <th className="text-left py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {properties.map(p => (
              <tr key={p.id} className="hover:bg-white/3 transition-colors">
                <td className="py-3 pr-4 text-white font-medium max-w-[180px] truncate">{p.title}</td>
                <td className="py-3 pr-4 text-white/60 text-xs">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${p.listing_type === 'For Sale' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                    {p.listing_type}
                  </span>
                </td>
                <td className="py-3 pr-4 text-white/60">€{p.price?.toLocaleString()} <span className="text-white/30 text-xs">{p.price_after}</span></td>
                <td className="py-3 pr-4 text-white/40 text-xs font-mono">{p.property_reference || '—'}</td>
                <td className="py-3 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    p.status === 'available' ? 'bg-green-500/20 text-green-400' :
                    p.status === 'viewings' ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>{p.status}</span>
                </td>
                <td className="py-3 pr-4">
                  <span className={`text-xs ${p.is_published ? 'text-green-400' : 'text-white/30'}`}>
                    {p.is_published ? '✓' : '—'}
                  </span>
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-3">
                    <button onClick={() => openEdit(p)} className="text-xs text-white/50 hover:text-white transition-colors">Edit</button>
                    <button onClick={() => del(p.id)} className="text-xs text-red-400/50 hover:text-red-400 transition-colors">Delete</button>
                  </div>
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

      {/* Edit/Create Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto">
          <div className="bg-[#111827] border border-white/10 rounded-2xl w-full max-w-2xl my-6">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="font-semibold text-white">{isNew ? 'Add Property' : 'Edit Property'}</h2>
                {!isNew && editing.property_reference && (
                  <p className="text-xs text-white/30 font-mono mt-0.5">{editing.property_reference}</p>
                )}
              </div>
              <button onClick={closeModal} className="text-white/40 hover:text-white">✕</button>
            </div>

            <div className="px-6 py-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {error && <p className="text-red-400 text-sm bg-red-400/10 rounded-lg px-4 py-2">{error}</p>}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs text-white/50 mb-1">Title / Headline</label>
                  <input value={editing.title || ''} onChange={e => set('title', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-white/50 mb-1">Slug (URL)</label>
                  <input value={editing.slug || ''} onChange={e => set('slug', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white/70 text-sm focus:outline-none focus:border-[#B8953F]" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-white/50 mb-1">Listing Type</label>
                  <select value={editing.listing_type || 'To Rent'} onChange={e => set('listing_type', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]">
                    <option value="To Rent" className="bg-[#111827]">To Rent</option>
                    <option value="For Sale" className="bg-[#111827]">For Sale</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Property Type</label>
                  <select value={editing.property_type || 'Apartment'} onChange={e => set('property_type', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]">
                    {PROPERTY_TYPES.map(t => <option key={t} value={t} className="bg-[#111827]">{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Status</label>
                  <select value={editing.status || 'available'} onChange={e => set('status', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]">
                    {['available', 'viewings', 'rented'].map(s => <option key={s} value={s} className="bg-[#111827]">{s}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-white/50 mb-1">Price (€)</label>
                  <input type="number" value={editing.price ?? ''} onChange={e => set('price', Number(e.target.value))}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Price Period</label>
                  <select value={editing.price_after || 'per month'} onChange={e => set('price_after', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]">
                    <option value="per month" className="bg-[#111827]">Per Month</option>
                    <option value="total" className="bg-[#111827]">Total</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Size (m²)</label>
                  <input type="number" value={editing.size ?? ''} onChange={e => set('size', e.target.value ? Number(e.target.value) : null)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-white/50 mb-1">Bedrooms</label>
                  <input type="number" value={editing.bedrooms ?? ''} onChange={e => set('bedrooms', e.target.value ? Number(e.target.value) : null)}
                    placeholder="Leave blank for commercial"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#B8953F]" />
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Bathrooms</label>
                  <input type="number" value={editing.bathrooms ?? ''} onChange={e => set('bathrooms', Number(e.target.value))}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-white/50 mb-1">Region</label>
                  <select value={editing.region || ''} onChange={e => set('region', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]">
                    <option value="" className="bg-[#111827]">Select…</option>
                    {REGIONS.map(r => <option key={r} value={r} className="bg-[#111827]">{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Location / Neighbourhood</label>
                  <input value={editing.location || ''} onChange={e => set('location', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
                </div>
              </div>

              <div>
                <label className="block text-xs text-white/50 mb-1">Available From</label>
                <input type="date" value={editing.available_from?.slice(0, 10) || ''} onChange={e => set('available_from', e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]" />
              </div>

              <div>
                <label className="block text-xs text-white/50 mb-1">Summary <span className="text-white/30">(max 300 chars — shown on cards)</span></label>
                <textarea rows={2} maxLength={300} value={editing.summary || ''} onChange={e => set('summary', e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F] resize-none" />
                <p className="text-right text-xs text-white/30 mt-0.5">{(editing.summary || '').length}/300</p>
              </div>

              <div>
                <label className="block text-xs text-white/50 mb-1">Full Description</label>
                <textarea rows={6} value={editing.full_description || editing.description || ''} onChange={e => set('full_description', e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F] resize-none" />
              </div>

              <div>
                <label className="block text-xs text-white/50 mb-1">Features <span className="text-white/30">(one per line)</span></label>
                <textarea rows={3}
                  value={(editing.features || []).join('\n')}
                  onChange={e => set('features', e.target.value.split('\n').filter(Boolean))}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F] resize-none" />
              </div>

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!editing.featured} onChange={e => set('featured', e.target.checked)} className="rounded" />
                  <span className="text-sm text-white/70">Featured</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!editing.is_published} onChange={e => set('is_published', e.target.checked)} className="rounded" />
                  <span className="text-sm text-white/70">Published (live)</span>
                </label>
              </div>

              {/* Images — drag to reorder */}
              {!isNew && (
                <div>
                  <label className="block text-xs text-white/50 mb-2">
                    Images <span className="text-white/30">(drag to reorder · first = cover · max 10)</span>
                  </label>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {(editing.images || []).map((img, idx) => (
                      <div
                        key={img}
                        draggable
                        onDragStart={() => setDragIdx(idx)}
                        onDragOver={e => { e.preventDefault(); setOverIdx(idx) }}
                        onDrop={e => {
                          e.preventDefault()
                          if (dragIdx !== null && dragIdx !== idx) reorderImages(dragIdx, idx)
                          setDragIdx(null); setOverIdx(null)
                        }}
                        onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                        className={[
                          'relative group cursor-grab active:cursor-grabbing select-none transition-all duration-150',
                          dragIdx === idx ? 'opacity-30 scale-95' : '',
                          overIdx === idx && dragIdx !== idx ? 'ring-2 ring-[#B8953F] scale-105' : '',
                        ].join(' ')}
                      >
                        <img
                          src={img.startsWith('/') ? `http://178.104.162.193:3001${img}` : img}
                          alt=""
                          className="w-20 h-20 object-cover rounded-lg border border-white/10 pointer-events-none"
                        />
                        {idx === 0 && (
                          <span className="absolute bottom-1 left-1 bg-[#B8953F] text-white text-[9px] font-medium px-1.5 py-0.5 rounded leading-tight pointer-events-none">
                            Cover
                          </span>
                        )}
                        <button
                          onClick={() => removeImage(idx)}
                          className="absolute top-1 right-1 bg-black/70 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <input ref={fileRef} type="file" multiple accept="image/*" className="hidden"
                    onChange={e => e.target.files && uploadImages(editing.id!, e.target.files)} />
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="text-xs text-[#B8953F] hover:text-white border border-[#B8953F]/40 hover:border-[#B8953F] rounded-lg px-3 py-2 transition-colors disabled:opacity-50">
                    {uploading ? 'Uploading…' : '+ Upload Images'}
                  </button>
                </div>
              )}
              {isNew && <p className="text-xs text-white/40">Save the property first, then upload images.</p>}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/10">
              <button onClick={closeModal} className="text-sm text-white/50 hover:text-white transition-colors">Cancel</button>
              <button onClick={save} disabled={saving}
                className="bg-[#B8953F] hover:bg-[#a07c30] disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
