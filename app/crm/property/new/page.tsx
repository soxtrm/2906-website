'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { CrmProvider, CrmShell, A, AD, AB, F, FM, fmtMoney } from '@/lib/crm/ui'

export default function NewPropertyPage() {
  return <CrmProvider><NewProperty /></CrmProvider>
}

const lbl: React.CSSProperties = { fontSize: 10, color: '#AAA', fontFamily: F, marginBottom: 4, display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em' }
const inp: React.CSSProperties = { width: '100%', background: '#F6F4EF', border: '1px solid #E8E4DA', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#1A1A1A', fontFamily: F, outline: 'none' }
const card: React.CSSProperties = { background: '#FFF', borderRadius: 14, padding: '22px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }
const TYPES = ['Apartment', 'Penthouse', 'House', 'Maisonette', 'Commercial']
const DURATIONS = [['2 weeks', 2], ['1 month', 4], ['3 months', 13], ['6 months', 26]] as const

function NewProperty() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [locations, setLocations] = useState<string[]>([])
  const [phone, setPhone] = useState('')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<any>(null) // {exists, owner?}
  const [owner, setOwner] = useState({ name: '', email: '', alt_phone: '' })
  const [p, setP] = useState<any>({ property_type: 'Apartment', town: '', sub_location: '', street: '', apt: '', bedrooms: '', bathrooms: '', size_sqm: '', longlet_price: '', shortlet: false, sale_price: '', available_status: 'available', available_date: '', description: '', internal_notes: '' })
  const [images, setImages] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const [excl, setExcl] = useState({ on: false, weeks: 2 })
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { crmFetch('locations').then(d => setLocations(d.locations || [])).catch(() => {}) }, [])
  const setp = (k: string, v: any) => setP((s: any) => ({ ...s, [k]: v }))

  async function doCheck() {
    if (!phone.trim()) return
    setChecking(true); setErr('')
    try { const r = await crmFetch(`owners/check?phone=${encodeURIComponent(phone.trim())}`); setCheck(r); setStep(2) }
    catch (e: any) { setErr(e?.message || 'Check failed') }
    finally { setChecking(false) }
  }

  async function onFiles(files: FileList | null) {
    if (!files || !files.length) return
    setUploading(true); setErr('')
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('images', f))
      const r = await crmFetch('upload', { method: 'POST', body: fd })
      setImages(prev => [...prev, ...(r.images || [])])
    } catch (e: any) { setErr(e?.message || 'Upload failed') }
    finally { setUploading(false) }
  }

  function exclDate() {
    const d = new Date(); d.setDate(d.getDate() + excl.weeks * 7)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  async function submit() {
    setSubmitting(true); setErr('')
    try {
      const body = {
        owner: { phone: phone.trim(), name: owner.name || check?.owner?.name || '', email: owner.email || '' },
        ...p, images,
        is_exclusive: excl.on, exclusive_weeks: excl.on ? excl.weeks : null,
      }
      const r = await crmJson('properties', 'POST', body)
      router.replace(`/property/${r.id}`)
    } catch (e: any) { setErr(e?.message || 'Submit failed'); setSubmitting(false) }
  }

  const stepTitles = ['Owner', 'Owner details', 'Property', 'Exclusive', 'Review']

  return (
    <CrmShell title="Add property" subtitle={`Step ${step} of 5 · ${stepTitles[step - 1]}`}>
      <div style={{ padding: 26, fontFamily: F, maxWidth: 720 }}>
        {/* progress */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
          {[1, 2, 3, 4, 5].map(n => <div key={n} style={{ flex: 1, height: 4, borderRadius: 2, background: n <= step ? A : '#E5E1D8' }} />)}
        </div>
        {err && <div style={{ background: '#FEE2E2', color: '#B91C1C', borderRadius: 8, padding: '10px 12px', fontSize: 12, marginBottom: 14, fontWeight: 600 }}>{err}</div>}

        {/* STEP 1 — owner phone */}
        {step === 1 && (
          <div style={card}>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>Owner phone number</div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>We&apos;ll check if this owner already exists in the system.</div>
            <label style={lbl}>Phone (with country code)</label>
            <input style={inp} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+356 99 12 34 56" onKeyDown={e => e.key === 'Enter' && doCheck()} autoFocus />
            <div style={{ marginTop: 18 }}><button onClick={doCheck} disabled={checking || !phone.trim()} style={primary}>{checking ? 'Checking…' : 'Check owner →'}</button></div>
          </div>
        )}

        {/* STEP 2 — existing / new banner */}
        {step === 2 && (
          <div style={card}>
            {check?.exists ? (
              <>
                <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 10, padding: '16px 18px', marginBottom: 18 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: '#92400E' }}>Owner already in system</div>
                  <div style={{ fontSize: 12.5, color: '#92400E', marginTop: 6, lineHeight: 1.6 }}>
                    Created by <strong>{check.owner.createdBy || 'unattributed'}</strong>{check.owner.since ? ` (${new Date(check.owner.since).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })})` : ''}.<br />
                    You&apos;ll receive <strong>Listing-Bonus (10%)</strong> only. Owner-Bonus stays with {check.owner.createdBy || 'the original creator'}.
                  </div>
                </div>
                <div style={{ fontSize: 13 }}><strong>{check.owner.name || 'Unnamed owner'}</strong> · {phone}</div>
              </>
            ) : (
              <>
                <div style={{ background: '#DCFCE7', border: '1px solid #86EFAC', borderRadius: 10, padding: '16px 18px', marginBottom: 18 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: '#15803D' }}>New owner! You become Owner-Creator 🔑</div>
                  <div style={{ fontSize: 12.5, color: '#15803D', marginTop: 6, lineHeight: 1.6 }}>→ <strong>10% bonus on ALL future properties</strong> from this owner, forever.</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Owner name (optional)</label><input style={inp} value={owner.name} onChange={e => setOwner({ ...owner, name: e.target.value })} /></div>
                  <div><label style={lbl}>Alt phone (optional)</label><input style={inp} value={owner.alt_phone} onChange={e => setOwner({ ...owner, alt_phone: e.target.value })} /></div>
                  <div><label style={lbl}>Email (optional)</label><input style={inp} value={owner.email} onChange={e => setOwner({ ...owner, email: e.target.value })} /></div>
                </div>
              </>
            )}
            <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} nextLabel="Continue to property details →" />
          </div>
        )}

        {/* STEP 3 — property details */}
        {step === 3 && (
          <div style={card}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label style={lbl}>Type</label><select style={inp} value={p.property_type} onChange={e => setp('property_type', e.target.value)}>{TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
              <div><label style={lbl}>Location (town)</label><input style={inp} list="loc-list" value={p.town} onChange={e => setp('town', e.target.value)} /><datalist id="loc-list">{locations.map(l => <option key={l} value={l} />)}</datalist></div>
              <div><label style={lbl}>Sub-location</label><input style={inp} value={p.sub_location} onChange={e => setp('sub_location', e.target.value)} /></div>
              <div><label style={lbl}>Street</label><input style={inp} value={p.street} onChange={e => setp('street', e.target.value)} /></div>
              <div><label style={lbl}>Apt / Unit</label><input style={inp} value={p.apt} onChange={e => setp('apt', e.target.value)} /></div>
              <div><label style={lbl}>Bedrooms</label><input style={inp} type="number" value={p.bedrooms} onChange={e => setp('bedrooms', e.target.value)} /></div>
              <div><label style={lbl}>Bathrooms</label><input style={inp} type="number" value={p.bathrooms} onChange={e => setp('bathrooms', e.target.value)} /></div>
              <div><label style={lbl}>Size (sqm)</label><input style={inp} type="number" value={p.size_sqm} onChange={e => setp('size_sqm', e.target.value)} /></div>
              <div><label style={lbl}>Long-let €/mo</label><input style={inp} type="number" value={p.longlet_price} onChange={e => setp('longlet_price', e.target.value)} /></div>
              <div><label style={lbl}>Sale price €</label><input style={inp} type="number" value={p.sale_price} onChange={e => setp('sale_price', e.target.value)} /></div>
              <div><label style={lbl}>Available status</label><select style={inp} value={p.available_status} onChange={e => setp('available_status', e.target.value)}><option value="available">Available</option><option value="soon_available">Soon</option><option value="rented">Rented</option><option value="reserved">Reserved</option></select></div>
              <div><label style={lbl}>Available date</label><input style={inp} type="date" value={p.available_date} onChange={e => setp('available_date', e.target.value)} /></div>
            </div>
            <label style={{ ...chk, marginTop: 12 }}><input type="checkbox" checked={p.shortlet} onChange={e => setp('shortlet', e.target.checked)} style={{ accentColor: A }} /> Short-let also available</label>
            <div style={{ marginTop: 12 }}><label style={lbl}>Description</label><textarea style={{ ...inp, minHeight: 70, resize: 'vertical' }} value={p.description} onChange={e => setp('description', e.target.value)} /></div>

            {/* images */}
            <div style={{ marginTop: 14 }}>
              <label style={lbl}>Images</label>
              <div onClick={() => fileRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); onFiles(e.dataTransfer.files) }}
                style={{ border: '2px dashed #E0DDD6', borderRadius: 12, padding: '22px', textAlign: 'center', cursor: 'pointer', color: '#AAA', fontSize: 12, background: '#FAFAF7' }}>
                {uploading ? 'Uploading…' : 'Drag & drop images here, or click to select'}
              </div>
              <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => onFiles(e.target.files)} />
              {images.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(90px,1fr))', gap: 6, marginTop: 10 }}>
                  {images.map((im, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      <img src={im.thumbnail || im.url} alt="" style={{ width: '100%', height: 70, objectFit: 'cover', borderRadius: 8 }} />
                      <button onClick={() => setImages(images.filter((_, j) => j !== i))} style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', borderRadius: 6, width: 18, height: 18, fontSize: 11, cursor: 'pointer', lineHeight: 1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ marginTop: 12 }}><label style={lbl}>Internal notes (private)</label><textarea style={{ ...inp, minHeight: 50, resize: 'vertical', background: '#FFFBEB', borderColor: '#FDE68A' }} value={p.internal_notes} onChange={e => setp('internal_notes', e.target.value)} /></div>
            <Nav onBack={() => setStep(2)} onNext={() => setStep(4)} nextLabel="Continue →" disabled={!p.town || !p.property_type} />
          </div>
        )}

        {/* STEP 4 — exclusive */}
        {step === 4 && (
          <div style={card}>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 14 }}>Exclusive lock (optional)</div>
            <label style={chk}><input type="checkbox" checked={excl.on} onChange={e => setExcl({ ...excl, on: e.target.checked })} style={{ accentColor: A }} /> Make this property exclusive</label>
            {excl.on && (
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {DURATIONS.map(([label, wk]) => (
                    <button key={wk} onClick={() => setExcl({ on: true, weeks: wk })} style={{ background: excl.weeks === wk ? A : '#F6F4EF', color: excl.weeks === wk ? '#fff' : '#666', border: `1px solid ${excl.weeks === wk ? A : '#E8E4DA'}`, borderRadius: 8, padding: '9px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>{label}</button>
                  ))}
                </div>
                <div style={{ marginTop: 14, background: AD, border: `1px solid ${AB}`, borderRadius: 10, padding: '12px 14px', fontSize: 12.5, color: '#92400E' }}>
                  🔒 Only you + admins will see this property until <strong>{exclDate()}</strong>.
                </div>
              </div>
            )}
            <Nav onBack={() => setStep(3)} onNext={() => setStep(5)} nextLabel="Review →" />
          </div>
        )}

        {/* STEP 5 — review */}
        {step === 5 && (
          <div style={card}>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 14 }}>Review &amp; submit</div>
            <Review label="Owner" value={`${check?.exists ? (check.owner.name || 'Existing') : (owner.name || 'New owner')} · ${phone}${check?.exists ? ` (existing — listing bonus only)` : ' (new — you are creator)'}`} />
            <Review label="Property" value={`${p.property_type} · ${p.town || '—'}${p.street ? ', ' + p.street : ''}`} />
            <Review label="Specs" value={`${p.bedrooms || '—'} bed · ${p.bathrooms || '—'} bath${p.size_sqm ? ` · ${p.size_sqm} sqm` : ''}`} />
            <Review label="Price" value={[p.longlet_price ? `${fmtMoney(p.longlet_price)}/mo` : null, p.shortlet ? 'short-let' : null, p.sale_price ? `${fmtMoney(p.sale_price)} sale` : null].filter(Boolean).join(' · ') || '—'} />
            <Review label="Availability" value={`${p.available_status}${p.available_date ? ` · ${p.available_date}` : ''}`} />
            <Review label="Images" value={`${images.length} uploaded`} />
            <Review label="Exclusive" value={excl.on ? `Yes · until ${exclDate()}` : 'No'} />
            <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
              <button onClick={() => setStep(4)} style={ghost}>← Back</button>
              <button onClick={submit} disabled={submitting} style={{ ...primary, flex: 1 }}>{submitting ? 'Creating…' : 'Create property'}</button>
            </div>
          </div>
        )}
      </div>
    </CrmShell>
  )
}

function Nav({ onBack, onNext, nextLabel, disabled }: { onBack: () => void; onNext: () => void; nextLabel: string; disabled?: boolean }) {
  return (
    <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
      <button onClick={onBack} style={ghost}>← Back</button>
      <button onClick={onNext} disabled={disabled} style={{ ...primary, flex: 1, opacity: disabled ? 0.5 : 1 }}>{nextLabel}</button>
    </div>
  )
}
function Review({ label, value }: { label: string; value: string }) {
  return <div style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: '1px solid #F4F2EC', fontSize: 13 }}><span style={{ color: '#AAA', minWidth: 96 }}>{label}</span><span style={{ fontWeight: 600, color: '#1A1A1A' }}>{value}</span></div>
}
const primary: React.CSSProperties = { background: '#0F0F0F', color: '#FFF', border: 'none', borderRadius: 9, padding: '12px 20px', fontSize: 12.5, fontWeight: 700, fontFamily: F, cursor: 'pointer', letterSpacing: '0.02em' }
const ghost: React.CSSProperties = { background: '#F4F2EC', color: '#888', border: '1px solid #E8E4DA', borderRadius: 9, padding: '12px 18px', fontSize: 12.5, fontWeight: 700, fontFamily: F, cursor: 'pointer' }
const chk: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#666', cursor: 'pointer', fontFamily: F }
