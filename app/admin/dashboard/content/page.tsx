'use client'
import { useEffect, useState } from 'react'
import { adminApi, SiteContentItem } from '@/lib/admin-api'

export default function ContentPage() {
  const [items, setItems] = useState<SiteContentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    adminApi.getContent()
      .then(data => {
        setItems(data)
        const v: Record<string, string> = {}
        data.forEach(i => { v[i.key] = i.value })
        setValues(v)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function save(key: string) {
    setSaving(key)
    setSaved(null)
    try {
      await adminApi.updateContent(key, values[key] ?? '')
      setSaved(key)
      setTimeout(() => setSaved(null), 2000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  const isMultiline = (key: string) =>
    key.includes('text') || key.includes('description') || key.includes('tagline')

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white">Website Content</h1>
        <p className="text-white/40 text-sm mt-1">Edit text that appears on the public website. Changes go live immediately.</p>
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {loading && <p className="text-white/40 text-sm">Loading…</p>}

      <div className="space-y-5">
        {items.map(item => (
          <div key={item.key} className="bg-white/5 rounded-xl border border-white/10 p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <label className="block text-sm font-medium text-white/80">{item.label}</label>
                <p className="text-xs text-white/30 font-mono mt-0.5">{item.key}</p>
              </div>
              {item.updated_at && (
                <p className="text-xs text-white/20 shrink-0 ml-4">
                  {new Date(item.updated_at).toLocaleDateString()}
                </p>
              )}
            </div>

            {isMultiline(item.key) ? (
              <textarea
                rows={3}
                value={values[item.key] ?? ''}
                onChange={e => setValues(v => ({ ...v, [item.key]: e.target.value }))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F] resize-none"
              />
            ) : (
              <input
                value={values[item.key] ?? ''}
                onChange={e => setValues(v => ({ ...v, [item.key]: e.target.value }))}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#B8953F]"
              />
            )}

            <div className="flex items-center justify-end mt-2">
              {saved === item.key && (
                <span className="text-xs text-green-400 mr-3">✓ Saved</span>
              )}
              <button
                onClick={() => save(item.key)}
                disabled={saving === item.key}
                className="text-xs bg-[#B8953F] hover:bg-[#a07c30] disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                {saving === item.key ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
