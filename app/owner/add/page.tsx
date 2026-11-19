'use client'
// Add a property: the 2906.estate contact upload (same property types, same
// features) rebuilt for owners, with drag and drop for photos and every way a
// home can be offered. One property can carry several offers at once, e.g.
// long let and winter let, or sale and long let.
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { ImagePlus, Star, X } from 'lucide-react'
import { MODE_LABEL, MODE_PERIOD, termsLine, type OfferTerms, type OperatingMode } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { sendToArgus } from '@/lib/owner/argus-sync'

const TYPE_GROUPS = [
  { label: 'Residential', types: ['Apartment', 'Penthouse', 'Duplex Penthouse', 'Maisonette', 'Townhouse', 'Terraced House', 'House of Character', 'Detached Villa', 'Semi-detached Villa', 'Farmhouse', 'Studio'] },
  { label: 'Special', types: ['Boathouse', 'Garage'] },
  { label: 'Commercial', types: ['Office', 'Retail', 'Restaurant/Canteen', 'Gym', 'Commercial Garage', 'Warehouse', 'Other'] },
]
const COMMERCIAL = new Set(TYPE_GROUPS[2].types)
const RESIDENTIAL_OFFERS: OperatingMode[] = ['long_let', 'shortlet', 'winter_let', 'summer_let', 'rooms', 'sale']
const COMMERCIAL_OFFERS: OperatingMode[] = ['commercial', 'commercial_sale']
const OFFER_HINT: Partial<Record<OperatingMode, string>> = {
  long_let: '12 months and more', shortlet: 'Nights and weeks, MTA licence', winter_let: 'October to May',
  summer_let: 'June to September', rooms: 'Room by room', sale: 'Asking price',
  commercial: 'Monthly rent', commercial_sale: 'Asking price',
}
const FEATURES = ['Sea view', 'Pool', 'Balcony', 'Garden', 'Roof terrace', 'Jacuzzi', 'Seafront', 'Garage/Parking', 'AC', 'Heating', 'Solar panels', 'Lift', 'Pet-friendly', 'Brand new', 'Renovated']
const TOWNS = ['Attard', 'Balzan', 'Birkirkara', 'Birzebbuga', 'Bugibba', 'Gzira', 'Gozo', 'Ibragg', 'Mellieha', 'Msida', 'Mosta', 'Naxxar', 'Paceville', 'Pembroke', 'Qawra', 'San Gwann', 'Santa Venera', 'Sliema', 'St Julian\'s', 'St Paul\'s Bay', 'Swieqi', 'Ta\' Xbiex', 'Valletta', 'Victoria', 'Xlendi', 'Zebbug']
const MAX_PHOTOS = 12
const MONTHS_MIN = [1, 2, 3, 6, 9, 12, 24]
const MONTHS_MAX = [3, 6, 9, 12, 24, 36, 60]
const NIGHTS = [1, 2, 3, 5, 7, 14, 30]

// Optional conditions per offer. Everything is a choice, nothing is required:
// rentals choose how short and how long a stay may be, short lets the minimum
// nights, sales how the price and the sale work.
function Terms({ mode, t, set }: { mode: OperatingMode; t: OfferTerms; set: (t: OfferTerms) => void }) {
  const per = MODE_PERIOD[mode]
  const num = (v: string) => (v ? Number(v) : undefined)
  const flag = (k: keyof OfferTerms, label: string) => (
    <button type="button" aria-pressed={!!t[k]} onClick={() => set({ ...t, [k]: !t[k] })}>{label}</button>
  )
  return (
    <div className="ow-terms">
      {per === 'month' && (
        <>
          <label><span>Shortest stay</span>
            <select value={t.minMonths ?? ''} onChange={e => set({ ...t, minMonths: num(e.target.value) })}>
              <option value="">Any</option>{MONTHS_MIN.map(m => <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>)}
            </select></label>
          <label><span>Longest stay</span>
            <select value={t.maxMonths ?? ''} onChange={e => set({ ...t, maxMonths: num(e.target.value) })}>
              <option value="">No limit</option>{MONTHS_MAX.filter(m => !t.minMonths || m >= t.minMonths).map(m => <option key={m} value={m}>{m} months</option>)}
            </select></label>
          {(mode === 'rooms' || mode === 'winter_let' || mode === 'summer_let') && <div className="ow-term-flags">{flag('billsIncluded', 'Bills included')}</div>}
        </>
      )}
      {per === 'night' && (
        <label><span>Minimum nights</span>
          <select value={t.minNights ?? ''} onChange={e => set({ ...t, minNights: num(e.target.value) })}>
            <option value="">Any</option>{NIGHTS.map(n => <option key={n} value={n}>{n}</option>)}
          </select></label>
      )}
      {per === 'total' && (
        <div className="ow-term-flags">
          {flag('negotiable', 'Price negotiable')}
          {flag('furnitureIncluded', 'Furniture included')}
          {flag('soldWithTenant', 'Sold with tenant')}
        </div>
      )}
    </div>
  )
}

// Photos are shrunk in the browser before they are kept (the real upload sends originals to ARGUS).
function shrink(file: File, max = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height))
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.72))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')) }
    img.src = url
  })
}

export default function AddProperty() {
  const s = useOwner()
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [type, setType] = useState('')
  const [offers, setOffers] = useState<Partial<Record<OperatingMode, string>>>({})
  const [terms, setTerms] = useState<Partial<Record<OperatingMode, OfferTerms>>>({})
  const [town, setTown] = useState('')
  const [address, setAddress] = useState('')
  const [beds, setBeds] = useState(2)
  const [baths, setBaths] = useState(1)
  const [size, setSize] = useState('')
  const [furnished, setFurnished] = useState('Furnished')
  const [from, setFrom] = useState('')
  const [features, setFeatures] = useState<string[]>([])
  const [desc, setDesc] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const commercial = COMMERCIAL.has(type)
  const offerList = commercial ? COMMERCIAL_OFFERS : RESIDENTIAL_OFFERS
  const chosen = (Object.keys(offers) as OperatingMode[]).filter(m => offerList.includes(m))

  async function addFiles(list: FileList | File[]) {
    const files = [...list].filter(f => f.type.startsWith('image/')).slice(0, MAX_PHOTOS - photos.length)
    if (!files.length) return
    setBusy(true)
    const out: string[] = []
    for (const f of files) { try { out.push(await shrink(f)) } catch { /* skip */ } }
    setPhotos(p => [...p, ...out].slice(0, MAX_PHOTOS)); setBusy(false)
  }

  function toggleOffer(m: OperatingMode) {
    setOffers(o => { const n = { ...o }; if (m in n) delete n[m]; else n[m] = ''; return n })
  }

  const [cName, setCName] = useState(s.profile.name || '')
  const [cPhone, setCPhone] = useState(s.profile.phone || (s.account?.phone ? `+${s.account.phone}` : ''))
  const [cEmail, setCEmail] = useState(s.profile.email || (s.account?.email?.includes('@') ? s.account.email : ''))
  const [sending, setSending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (sending) return
    const errs: string[] = []
    if (!type) errs.push('Choose the type of property.')
    if (!chosen.length) errs.push('Choose at least one way to offer it.')
    for (const m of chosen) if (!(Number(offers[m]) > 0)) errs.push(`Add a price for ${MODE_LABEL[m]}.`)
    if (!town) errs.push('Add the town.')
    if (!s.demo && !cName.trim()) errs.push('Add your name, so ARGUS knows who the home belongs to.')
    if (!s.demo && cPhone.replace(/\D/g, '').length < 8) errs.push('Add your mobile number, so ARGUS can reach you about it.')
    setErrors(errs)
    if (errs.length) { window.scrollTo({ top: 0, behavior: 'smooth' }); return }
    const input = {
      propertyType: type, town, address, bedrooms: commercial ? 0 : beds, bathrooms: commercial ? 0 : baths,
      sizeSqm: Number(size) || undefined, offers: chosen.map(m => ({ mode: m, price: Number(offers[m]), terms: terms[m] })),
      availableFrom: from || undefined, furnished, features, description: desc, photos,
    }
    // real owners: straight into ARGUS (checked by an agent before it goes anywhere); the demo stays in the browser
    if (!s.demo) {
      setSending(true)
      const r = await sendToArgus({ ...input, owner: { name: cName, phone: cPhone, email: cEmail } })
      setSending(false)
      if (!r.ok) { setErrors([r.error]); window.scrollTo({ top: 0, behavior: 'smooth' }); return }
      if (!s.profile.name) s.setProfile({ name: cName.trim(), phone: cPhone.trim(), email: cEmail.trim() || undefined })
      s.say(`Sent to ARGUS${r.ref ? ` (#${r.ref})` : ''}. An agent checks it, then it goes out on your channels.`)
    }
    const id = s.addProperty(input)
    router.push(`/owner/properties/${id}`)
  }

  return (
    <form onSubmit={submit} className="ow-add" noValidate>
      <div className="ow-head"><div>
        <h1>Add a property</h1>
        <p className="ow-muted">ARGUS checks every new home before it goes out on your channels.</p>
      </div></div>

      {errors.length > 0 && <div className="ow-warn" role="alert" style={{ marginBottom: 18 }}>{errors.map(x => <p key={x}>{x}</p>)}</div>}

      <section className="ow-panel ow-add-step">
        <h2><span className="ow-step-no">1</span>What kind of property?</h2>
        {TYPE_GROUPS.map(g => (
          <div key={g.label} className="ow-add-group">
            <p className="ow-faint">{g.label}</p>
            <div className="ow-choice">
              {g.types.map(t => <button type="button" key={t} aria-pressed={type === t} onClick={() => setType(t)}>{t}</button>)}
            </div>
          </div>
        ))}
      </section>

      <section className="ow-panel ow-add-step">
        <h2><span className="ow-step-no">2</span>How do you want to offer it?</h2>
        <p className="ow-faint" style={{ marginBottom: 12 }}>Pick one or more. Each gets its own price and, if you like, its own rules.</p>
        <div className="ow-offers">
          {offerList.map(m => {
            const on = m in offers
            return (
              <div key={m} className="ow-offer" data-on={on}>
                <button type="button" aria-pressed={on} onClick={() => toggleOffer(m)}>
                  <b>{MODE_LABEL[m]}</b><span>{OFFER_HINT[m]}</span>
                </button>
                {on && (
                  <label className="ow-offer-price">
                    <span>€</span>
                    <input inputMode="numeric" value={offers[m]} onChange={e => setOffers(o => ({ ...o, [m]: e.target.value.replace(/[^\d]/g, '') }))}
                      placeholder="Price" aria-label={`${MODE_LABEL[m]} price`} />
                    <small>{MODE_PERIOD[m] === 'month' ? '/ month' : MODE_PERIOD[m] === 'night' ? '/ night' : 'total'}</small>
                  </label>
                )}
                {on && <Terms mode={m} t={terms[m] || {}} set={t => setTerms(x => ({ ...x, [m]: t }))} />}
              </div>
            )
          })}
        </div>
      </section>

      <section className="ow-panel ow-add-step">
        <h2><span className="ow-step-no">3</span>Photos</h2>
        <div className="ow-dropzone" data-over={over}
          onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files) }}
          onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click() } }}>
          <ImagePlus size={30} aria-hidden="true" />
          <b>{busy ? 'Adding photos…' : 'Drop photos here'}</b>
          <span>or tap to choose · up to {MAX_PHOTOS} · the first one is the cover</span>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
        </div>
        {photos.length > 0 && (
          <ul className="ow-thumbs">
            {photos.map((src, i) => (
              <li key={i} data-cover={i === 0}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`Photo ${i + 1}`} />
                {i === 0 ? <span className="ow-cover">Cover</span>
                  : <button type="button" className="ow-thumb-btn left" aria-label="Make cover" onClick={() => setPhotos(p => [p[i], ...p.filter((_, j) => j !== i)])}><Star size={14} /></button>}
                <button type="button" className="ow-thumb-btn" aria-label="Remove photo" onClick={() => setPhotos(p => p.filter((_, j) => j !== i))}><X size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ow-panel ow-add-step">
        <h2><span className="ow-step-no">4</span>Details</h2>
        <div className="ow-form-grid">
          <div className="ow-field"><label htmlFor="town">Town</label>
            <input id="town" list="ow-towns" value={town} onChange={e => setTown(e.target.value)} placeholder="e.g. Swieqi" />
            <datalist id="ow-towns">{TOWNS.map(t => <option key={t} value={t} />)}</datalist></div>
          <div className="ow-field"><label htmlFor="addr">Street (only ARGUS sees it)</label>
            <input id="addr" value={address} onChange={e => setAddress(e.target.value)} placeholder="Street and number" /></div>
          {!commercial && (
            <>
              <div className="ow-field"><span className="ow-label">Bedrooms</span><Stepper value={beds} set={setBeds} min={0} /></div>
              <div className="ow-field"><span className="ow-label">Bathrooms</span><Stepper value={baths} set={setBaths} min={1} /></div>
            </>
          )}
          <div className="ow-field"><label htmlFor="size">Size in m²</label>
            <input id="size" inputMode="numeric" value={size} onChange={e => setSize(e.target.value.replace(/[^\d]/g, ''))} placeholder="Optional" /></div>
          <div className="ow-field"><label htmlFor="from">Free from</label>
            <input id="from" type="date" value={from} min={s.today} onChange={e => setFrom(e.target.value)} /></div>
          <div className="ow-field"><span className="ow-label">Furniture</span>
            <div className="ow-seg" role="group" aria-label="Furniture">
              {['Furnished', 'Part', 'Unfurnished'].map(f => <button type="button" key={f} aria-pressed={furnished === f} onClick={() => setFurnished(f)}>{f}</button>)}
            </div></div>
        </div>
        <p className="ow-label" style={{ marginTop: 18 }}>Features</p>
        <div className="ow-choice">
          {FEATURES.map(f => <button type="button" key={f} aria-pressed={features.includes(f)} onClick={() => setFeatures(x => x.includes(f) ? x.filter(y => y !== f) : [...x, f])}>{f}</button>)}
        </div>
        <div className="ow-field" style={{ marginTop: 18 }}>
          <label htmlFor="desc">Description</label>
          <textarea id="desc" maxLength={2000} value={desc} onChange={e => setDesc(e.target.value)} placeholder="What makes it nice to live in? ARGUS polishes the wording." />
        </div>
      </section>

      {!s.demo && (
        <section className="ow-panel ow-add-step">
          <h2><span className="ow-step-no">5</span>How ARGUS reaches you about it</h2>
          <div className="ow-form-grid">
            <div className="ow-field"><label htmlFor="cn">Your name</label><input id="cn" autoComplete="name" value={cName} onChange={e => setCName(e.target.value)} /></div>
            <div className="ow-field"><label htmlFor="cp">Mobile (WhatsApp)</label><input id="cp" type="tel" autoComplete="tel" inputMode="tel" placeholder="+356 7900 1234" value={cPhone} onChange={e => setCPhone(e.target.value)} /></div>
            <div className="ow-field"><label htmlFor="ce">Email (optional)</label><input id="ce" type="email" autoComplete="email" value={cEmail} onChange={e => setCEmail(e.target.value)} /></div>
          </div>
        </section>
      )}

      <div className="ow-add-submit">
        <p className="ow-faint">{chosen.length ? chosen.map(m => `${MODE_LABEL[m]}${termsLine(m, terms[m]) ? ` (${termsLine(m, terms[m])})` : ''}`).join(' + ') : 'No offer chosen yet'} · {photos.length} photo{photos.length === 1 ? '' : 's'}</p>
        <button className="ow-btn primary big" type="submit" disabled={sending}>{sending ? 'Sending to ARGUS…' : 'Send to ARGUS'}</button>
      </div>
    </form>
  )
}

function Stepper({ value, set, min }: { value: number; set: (n: number) => void; min: number }) {
  return (
    <div className="ow-stepper">
      <button type="button" aria-label="Fewer" onClick={() => set(Math.max(min, value - 1))}>−</button>
      <b aria-live="polite">{value}</b>
      <button type="button" aria-label="More" onClick={() => set(value + 1)}>+</button>
    </div>
  )
}
