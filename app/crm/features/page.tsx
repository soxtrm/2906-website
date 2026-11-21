'use client'
// /crm/features — property features stated by owners (2026-11-21). Listing agents confirm or reject what owners
// added to their listings; only confirmed (or document-backed / verified) features appear on the public listing.
// Admins curate new terms: promote to a standard feature (optionally a search filter), merge into an existing
// feature (the wording becomes an alias), or retire. Data: /api/crm/property-features/*.
import { useCallback, useEffect, useState } from 'react'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { crmFetch, crmJson } from '@/lib/crm/api'

type Item = { key: string; label: string; kind: string; value: unknown; originalText: string | null; status: string; source: string; propertyId: number; ref: string; town: string | null; listingAgent: string | null; updatedAt: string }
type Cand = { key: string; label: string; aliases: string[]; used: number; createdAt: string }
type Std = { key: string; label: string; group: string }

export default function FeaturesPage() { return <CrmProvider><Features /></CrmProvider> }

function Features() {
  const { me } = useCrm()
  const [items, setItems] = useState<Item[] | null>(null)
  const [cands, setCands] = useState<{ candidates: Cand[]; standard: Std[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [into, setInto] = useState<Record<string, string>>({})
  const admin = me?.role === 'admin'
  const load = useCallback(async () => {
    try { setItems((await crmFetch('property-features/review')).features); setErr(null) } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load.') }
    if (admin) try { setCands(await crmFetch('property-features/dictionary/candidates')) } catch { /* */ }
  }, [admin])
  useEffect(() => { load() }, [load])
  const decide = async (i: Item, decision: 'confirm' | 'reject') => {
    setBusy(`${i.propertyId}:${i.key}`)
    try { await crmJson(`property-features/${i.propertyId}/decide`, 'POST', { key: i.key, decision }); await load() } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
    setBusy(null)
  }
  const curate = async (c: Cand, action: 'promote' | 'merge' | 'retire', extra: Record<string, unknown> = {}) => {
    setBusy(c.key)
    try { setCands(await crmJson('property-features/dictionary/curate', 'POST', { key: c.key, action, ...extra })); await load() } catch (e) { setErr(e instanceof Error ? e.message : 'Not saved.') }
    setBusy(null)
  }
  const card: React.CSSProperties = { background: 'var(--crm-card)', border: '1px solid var(--crm-border)', borderRadius: 14, padding: 14 }
  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({ padding: '7px 12px', borderRadius: 8, border: bg === 'transparent' ? '1px solid var(--crm-border)' : 0, background: bg, color: fg, fontWeight: 600, cursor: 'pointer' })
  const val = (i: Item) => (i.kind === 'count' ? ` · ${String(i.value)}` : i.kind === 'choice' ? ` · ${String(i.value).replace(/_/g, ' ')}` : i.value === false ? ' · no' : '')

  return (
    <CrmShell title="Property features" subtitle="What owners added in SYNC: confirm it before it shows on the listing">
      {err && <p style={{ color: '#F87171', margin: '0 0 12px' }}>{err}</p>}
      <section style={card}>
        <b style={{ fontSize: 16 }}>To confirm{items ? ` · ${items.length}` : ''}</b>
        <p style={{ margin: '4px 0 10px', color: 'var(--crm-muted)', fontSize: 13 }}>{admin ? 'All listings.' : 'Your listings.'} Confirm only what you know is true; owner statements never become a quality seal.</p>
        {!items ? <p style={{ color: 'var(--crm-muted)' }}>Loading…</p> : !items.length ? <p style={{ color: 'var(--crm-muted)' }}>Nothing waiting.</p> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {items.map(i => (
              <div key={`${i.propertyId}:${i.key}`} className="ft-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: 10, borderRadius: 10, border: '1px solid var(--crm-border)' }}>
                <div style={{ display: 'grid', gap: 2 }}>
                  <b>{i.label}{val(i)}{i.status === 'candidate' && <span style={{ marginLeft: 8, fontSize: 11, padding: '1px 7px', borderRadius: 99, background: 'rgba(124,92,255,.15)', color: '#7c5cff' }}>new term</span>}</b>
                  <small style={{ color: 'var(--crm-muted)' }}>#{i.ref}{i.town ? ` · ${i.town}` : ''}{i.listingAgent ? ` · ${i.listingAgent}` : ''}{i.originalText && i.originalText.toLowerCase() !== i.label.toLowerCase() ? ` · owner wrote “${i.originalText}”` : ''}</small>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button disabled={!!busy} onClick={() => decide(i, 'reject')} style={btn('transparent', 'inherit')}>Not true</button>
                  <button disabled={!!busy} onClick={() => decide(i, 'confirm')} style={btn('#16a34a')}>{busy === `${i.propertyId}:${i.key}` ? 'Saving…' : 'Confirm'}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {admin && cands && (
        <section style={{ ...card, marginTop: 16 }}>
          <b style={{ fontSize: 16 }}>New terms · {cands.candidates.length}</b>
          <p style={{ margin: '4px 0 10px', color: 'var(--crm-muted)', fontSize: 13 }}>Wording owners used that is not in the dictionary yet. Merge it into an existing feature (it becomes a synonym), promote it, or retire it.</p>
          {!cands.candidates.length ? <p style={{ color: 'var(--crm-muted)' }}>No new terms.</p> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {cands.candidates.map(c => (
                <div key={c.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: 10, borderRadius: 10, border: '1px solid var(--crm-border)' }}>
                  <div style={{ display: 'grid', gap: 2 }}><b>{c.label}</b><small style={{ color: 'var(--crm-muted)' }}>used on {c.used} listing{c.used === 1 ? '' : 's'}{c.aliases.length > 1 ? ` · also written as ${c.aliases.slice(0, 4).join(', ')}` : ''}</small></div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <select value={into[c.key] || ''} onChange={e => setInto(x => ({ ...x, [c.key]: e.target.value }))} style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--crm-border)', background: 'transparent', color: 'inherit' }}>
                      <option value="">Same as…</option>{cands.standard.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                    <button disabled={!!busy || !into[c.key]} onClick={() => curate(c, 'merge', { into: into[c.key] })} style={btn('transparent', 'inherit')}>Merge</button>
                    <button disabled={!!busy} onClick={() => curate(c, 'promote', { filterable: false })} style={btn('#4f6bff')}>Promote</button>
                    <button disabled={!!busy} onClick={() => curate(c, 'promote', { filterable: true })} style={btn('#4f6bff')}>Promote + filter</button>
                    <button disabled={!!busy} onClick={() => curate(c, 'retire')} style={btn('transparent', '#F87171')}>Retire</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </CrmShell>
  )
}
