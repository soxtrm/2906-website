'use client'
import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { CrmProvider, CrmShell, Masked, Pill, Bar, Heart, LocationSelect, AVAIL, VIEW, A, AD, AB, F, FM, fmtMoney, fmtDate, useCrm, describe } from '@/lib/crm/ui'

export default function PropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <CrmProvider><Detail id={parseInt(id)} /></CrmProvider>
}

const lbl: React.CSSProperties = { fontSize: 10, color: '#AAA', fontFamily: F, marginBottom: 4, display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em' }
const inp: React.CSSProperties = { width: '100%', background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 8, padding: '9px 11px', fontSize: 13, color: '#1A1A1A', fontFamily: F, outline: 'none' }
const card: React.CSSProperties = { background: '#FFF', borderRadius: 14, padding: '20px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', marginBottom: 16 }
const head: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 14 }

function Detail({ id }: { id: number }) {
  const router = useRouter()
  const { me } = useCrm()
  const [d, setD] = useState<any>(null)
  const [acts, setActs] = useState<any[]>([])
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => crmFetch(`properties/${id}`).then((r) => {
    setD(r); setActs(r.activities || [])
    const p = r.property
    setForm({
      property_type: p.type || '', town: p.location.town || '', street: p.location.street || '', apt: p.location.apt || '',
      bedrooms: p.beds ?? '', bathrooms: p.baths ?? '', size_sqm: p.sizeSqm ?? '',
      longlet_price: p.prices.longlet ?? '', sale_price: p.prices.sale ?? '', shortlet: !!p.prices.shortlet,
      available_status: p.availableStatus || 'available', available_date: p.availableDate ? String(p.availableDate).slice(0, 10) : '',
      viewing_status: p.viewingStatus || 'none', viewing_date: p.viewingDate ? String(p.viewingDate).slice(0, 16) : '',
      viewing_notes: p.viewingNotes || '', internal_notes: p.internalNotes || '', description: p.description || '',
      is_exclusive: !!p.exclusive, exclusive_until: p.exclusiveUntil ? String(p.exclusiveUntil).slice(0, 10) : '', published: !!p.published,
    })
  }).catch(() => {})
  useEffect(() => { load() }, [id])

  const p = d?.property
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true); setMsg('')
    try {
      const r = await crmJson(`properties/${id}`, 'PATCH', form)
      setMsg(`Saved · ${r.activitiesLogged} activity entr${r.activitiesLogged === 1 ? 'y' : 'ies'} logged · completeness ${r.completeness}%`)
      await load()
    } catch (e: any) { setMsg(e?.message || 'Save failed') }
    finally { setSaving(false) }
  }
  async function del() {
    if (!confirm('Delete this property? This cannot be undone.')) return
    try { await crmFetch(`properties/${id}`, { method: 'DELETE' }); router.replace('/inventory') }
    catch (e: any) { setMsg(e?.message || 'Delete failed') }
  }

  return (
    <CrmShell title={p ? `${p.ref} · ${p.type}` : 'Property'} subtitle={p ? `${p.location.town}${p.location.street ? ' · ' + p.location.street : ''}` : undefined}>
      <div style={{ padding: 26, fontFamily: F, maxWidth: 1000 }}>
        <div style={{ marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => router.push('/inventory')} style={{ background: '#F4F2EC', border: '1px solid #E8E4DA', borderRadius: 8, padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: F, color: '#888', fontWeight: 600 }}>← Inventory</button>
          {p?.exclusive && <span style={{ fontSize: 10, fontWeight: 700, color: A, background: AD, border: `1px solid ${AB}`, borderRadius: 5, padding: '3px 8px' }}>🔒 EXCLUSIVE until {fmtDate(p.exclusiveUntil)}</span>}
          {p && <span style={{ background: '#FFF', border: '1px solid #E8E4DA', borderRadius: 8, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#888' }}><Heart propertyId={p.id} fav={p.fav} size={15} /> Favourite</span>}
          {msg && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#15803D', fontWeight: 600 }}>{msg}</span>}
        </div>
        {!p && <div style={{ color: '#BBB' }}>Loading…</div>}
        {p && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
            <div>
              {/* gallery */}
              <div style={card}>
                <div style={head}>Gallery ({p.imageCount})</div>
                {p.imageCount === 0 && <div style={{ height: 180, borderRadius: 10, background: '#F0EEEA', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#CCC', fontSize: 13 }}>No images</div>}
                {p.imageCount > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 8 }}>
                    {p.images.map((im: any, i: number) => (
                      <a key={i} href={im.url || im} target="_blank" rel="noreferrer"><img src={im.thumbnail || im.url || im} alt="" style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 10, filter: p.exclusive ? 'blur(2px) brightness(0.7)' : 'none' }} /></a>
                    ))}
                  </div>
                )}
              </div>

              {/* editable fields */}
              <div style={card}>
                <div style={head}>Edit details</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Type"><input style={inp} value={form.property_type} onChange={e => set('property_type', e.target.value)} /></Field>
                  <Field label="Town"><LocationSelect value={form.town} onChange={v => set('town', v)} /></Field>
                  <Field label="Street"><input style={inp} value={form.street} onChange={e => set('street', e.target.value)} /></Field>
                  <Field label="Apt / Unit"><input style={inp} value={form.apt} onChange={e => set('apt', e.target.value)} /></Field>
                  <Field label="Bedrooms"><input style={inp} type="number" value={form.bedrooms} onChange={e => set('bedrooms', e.target.value)} /></Field>
                  <Field label="Bathrooms"><input style={inp} type="number" value={form.bathrooms} onChange={e => set('bathrooms', e.target.value)} /></Field>
                  <Field label="Size (sqm)"><input style={inp} type="number" value={form.size_sqm} onChange={e => set('size_sqm', e.target.value)} /></Field>
                  <Field label="Long-let €/mo"><input style={inp} type="number" value={form.longlet_price} onChange={e => set('longlet_price', e.target.value)} /></Field>
                  <Field label="Sale price €"><input style={inp} type="number" value={form.sale_price} onChange={e => set('sale_price', e.target.value)} /></Field>
                  <Field label="Available status">
                    <select style={inp} value={form.available_status} onChange={e => set('available_status', e.target.value)}>
                      <option value="available">Available</option><option value="soon_available">Soon</option><option value="rented">Rented</option><option value="reserved">Reserved</option>
                    </select>
                  </Field>
                  <Field label="Available date"><input style={inp} type="date" value={form.available_date} onChange={e => set('available_date', e.target.value)} /></Field>
                  <Field label="Viewing status">
                    <select style={inp} value={form.viewing_status} onChange={e => set('viewing_status', e.target.value)}>
                      <option value="none">None</option><option value="requested">Requested</option><option value="scheduled">Scheduled</option><option value="done">Done</option>
                    </select>
                  </Field>
                  <Field label="Viewing date/time"><input style={inp} type="datetime-local" value={form.viewing_date} onChange={e => set('viewing_date', e.target.value)} /></Field>
                </div>
                <div style={{ marginTop: 12 }}>
                  <label style={lbl}>Description</label>
                  <textarea style={{ ...inp, minHeight: 70, resize: 'vertical' }} value={form.description} onChange={e => set('description', e.target.value)} />
                </div>
                <div style={{ marginTop: 12 }}>
                  <label style={lbl}>Viewing notes</label>
                  <textarea style={{ ...inp, minHeight: 50, resize: 'vertical' }} value={form.viewing_notes} onChange={e => set('viewing_notes', e.target.value)} />
                </div>
                <div style={{ marginTop: 12 }}>
                  <label style={lbl}>Internal notes (private)</label>
                  <textarea style={{ ...inp, minHeight: 50, resize: 'vertical', background: '#FFFBEB', borderColor: '#FDE68A' }} value={form.internal_notes} onChange={e => set('internal_notes', e.target.value)} />
                </div>
                <div style={{ marginTop: 14, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={chk}><input type="checkbox" checked={form.published} onChange={e => set('published', e.target.checked)} style={{ accentColor: A }} /> Published (LIVE)</label>
                  <label style={chk}><input type="checkbox" checked={form.shortlet} onChange={e => set('shortlet', e.target.checked)} style={{ accentColor: A }} /> Short-let available</label>
                  <label style={chk}><input type="checkbox" checked={form.is_exclusive} onChange={e => set('is_exclusive', e.target.checked)} style={{ accentColor: A }} /> Exclusive</label>
                  {form.is_exclusive && <input style={{ ...inp, width: 160 }} type="date" value={form.exclusive_until} onChange={e => set('exclusive_until', e.target.value)} />}
                </div>
                <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
                  <button onClick={save} disabled={saving} style={{ background: '#0F0F0F', color: '#FFF', border: 'none', borderRadius: 9, padding: '11px 20px', fontSize: 12, fontWeight: 700, fontFamily: F, cursor: saving ? 'wait' : 'pointer' }}>{saving ? 'Saving…' : 'Save changes'}</button>
                  {(me?.role === 'admin' || p.listingAgents?.includes(me?.name)) && <button onClick={del} style={{ background: '#FEE2E2', color: '#B91C1C', border: '1px solid #FCA5A5', borderRadius: 9, padding: '11px 16px', fontSize: 12, fontWeight: 700, fontFamily: F, cursor: 'pointer' }}>Delete</button>}
                </div>
              </div>
            </div>

            <div>
              {/* status snapshot */}
              <div style={card}>
                <div style={head}>Status</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}><Pill status={p.availableStatus} map={AVAIL} /><Pill status={p.viewingStatus} map={VIEW} /></div>
                <Bar pct={p.completeness} />
              </div>

              {/* owner */}
              <div style={card}>
                <div style={head}>Owner</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#0F0F0F', marginBottom: 8, cursor: p.owner.id ? 'pointer' : 'default', borderBottom: p.owner.id ? `1px dashed ${AB}` : 'none', display: 'inline-block' }} onClick={() => p.owner.id && router.push(`/owner/${p.owner.id}`)}>{p.owner.name || '—'}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Masked entityType="owner_phone" entityId={p.owner.id} masked={p.owner.phoneMasked} hasValue={p.owner.hasPhone} propertyId={p.id} size={13} />
                  <Masked entityType="owner_email" entityId={p.owner.id} masked={p.owner.emailMasked} hasValue={p.owner.hasEmail} propertyId={p.id} size={13} />
                </div>
              </div>

              {/* commission */}
              <div style={card}>
                <div style={head}>Commission</div>
                {[['🔑 Owner Creator', p.ownerCreator || '—'], ['📋 Listing agent', p.listingAgents.join(' + ') || '—'], ['⚡ Activity', p.activityAgents.join(' + ') || '—']].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #F4F2EC', fontSize: 12 }}>
                    <span style={{ color: '#999' }}>{k}</span><span style={{ fontWeight: 700, color: '#1A1A1A' }}>{v}</span>
                  </div>
                ))}
                <div style={{ fontSize: 10, color: '#CCC', marginTop: 8 }}>Commission engine arrives in Phase 2.</div>
              </div>

              {/* activity log */}
              <div style={card}>
                <div style={head}>Activity log ({acts.length})</div>
                {acts.length === 0 && <div style={{ fontSize: 12, color: '#BBB' }}>No activity yet.</div>}
                {acts.map(h => (
                  <div key={h.id} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid #F4F2EC', fontSize: 11.5, alignItems: 'flex-start' }}>
                    <span style={{ fontFamily: FM, fontSize: 9.5, color: '#CCC', minWidth: 96, flexShrink: 0 }}>{fmtDate(h.when)}</span>
                    <span style={{ background: AD, border: `1px solid ${AB}`, color: A, borderRadius: 4, padding: '1px 6px', fontSize: 9.5, fontWeight: 700, flexShrink: 0 }}>{h.who || '—'}</span>
                    <span style={{ color: '#555' }}>{describe(h)} {h.significant && <span style={{ color: A }}>●</span>}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </CrmShell>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label style={lbl}>{label}</label>{children}</div>
}
const chk: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#666', cursor: 'pointer', fontFamily: F }
