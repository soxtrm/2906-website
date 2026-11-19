'use client'
// The owner's own profile: photo, how to reach her, and the people linked to
// her account (partner, family, property manager). Linked people share one
// conversation with ARGUS: ARGUS writes to the main contact only, so nobody in
// the household is messaged twice about the same home.
import { useRef, useState } from 'react'
import { Camera, MessageCircle, Trash2, UserPlus } from 'lucide-react'
import type { Person } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { initials } from '@/components/owner/format'

const RELATION: Record<NonNullable<Person['relation']>, string> = { partner: 'Partner', family: 'Family', property_manager: 'Property manager', helper: 'Helper' }

function shrink(file: File, max = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file)
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height))
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', .8))
    }
    img.onerror = reject; img.src = url
  })
}

function Avatar({ name, photo, size = 56 }: { name: string; photo?: string; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return photo ? <img className="ow-ava" src={photo} alt="" style={{ width: size, height: size }} /> : <span className="ow-ava" style={{ width: size, height: size, fontSize: size * .38 }}>{initials(name)}</span>
}

export default function Profile() {
  const s = useOwner()
  const pr = s.profile
  const photo = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(pr.name)
  const [phone, setPhone] = useState(pr.phone || '')
  const [email, setEmail] = useState(pr.email || '')
  const [add, setAdd] = useState<Person | null>(null)
  const main = pr.mainContact || 'me'

  return (
    <>
      <div className="ow-head"><div>
        <h1>Your profile</h1>
        <p className="ow-muted">Who you are, how ARGUS reaches you, and who manages your homes with you.</p>
      </div></div>

      <div className="ow-grid-2">
        <section className="ow-panel ow-me">
          <div className="ow-me-photo">
            <button type="button" className="ow-me-ava" onClick={() => photo.current?.click()} aria-label="Change your photo">
              <Avatar name={pr.name} photo={pr.photo} size={104} />
              <span className="ow-me-cam"><Camera size={18} /></span>
            </button>
            <input ref={photo} type="file" accept="image/*" hidden onChange={async e => { const f = e.target.files?.[0]; if (f) s.setProfile({ photo: await shrink(f) }); e.target.value = '' }} />
            <div>
              <h2>{pr.name}</h2>
              <p className="ow-faint">Owner of {s.properties.length} home{s.properties.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          <form className="ow-form-grid" onSubmit={e => { e.preventDefault(); s.setProfile({ name: name.trim() || pr.name, phone, email }) }}>
            <div className="ow-field"><label htmlFor="pn">Name</label><input id="pn" value={name} onChange={e => setName(e.target.value)} /></div>
            <div className="ow-field"><label htmlFor="pp">Phone (WhatsApp)</label><input id="pp" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" /></div>
            <div className="ow-field"><label htmlFor="pe">Email</label><input id="pe" value={email} onChange={e => setEmail(e.target.value)} inputMode="email" /></div>
            <div className="ow-field" style={{ alignSelf: 'end' }}><button className="ow-btn primary" type="submit">Save</button></div>
          </form>
          <p className="ow-label" style={{ marginTop: 16 }}>Languages ARGUS may use with you</p>
          <div className="ow-choice">
            {['English', 'Maltese', 'Italian', 'German', 'French'].map(l => {
              const on = (pr.languages || []).includes(l)
              return <button type="button" key={l} aria-pressed={on} onClick={() => s.setProfile({ languages: on ? (pr.languages || []).filter(x => x !== l) : [...(pr.languages || []), l] })}>{l}</button>
            })}
          </div>
        </section>

        <section className="ow-panel">
          <div className="ow-head" style={{ marginBottom: 6 }}>
            <h2>People on your account</h2>
            <button className="ow-btn small" onClick={() => setAdd({ name: '', relation: 'partner', role: 'manager', properties: 'all', phone: '' })}><UserPlus size={16} />Add person</button>
          </div>
          <p className="ow-faint" style={{ marginBottom: 12 }}>Everyone here is linked to you. ARGUS writes to one of you only, so nobody gets the same message twice.</p>
          <ul className="ow-people">
            <li data-main={main === 'me'}>
              <Avatar name={pr.name} photo={pr.photo} size={44} />
              <span className="ow-people-main"><b>{pr.name} (you)</b><small>Owner · {pr.phone}</small></span>
              <button type="button" className="ow-main-pick" aria-pressed={main === 'me'} onClick={() => s.setProfile({ mainContact: 'me' })}><MessageCircle size={14} />{main === 'me' ? 'ARGUS writes here' : 'Make main contact'}</button>
            </li>
            {pr.delegates.map(d => (
              <li key={d.name} data-main={main === d.name}>
                <Avatar name={d.name} photo={d.photo} size={44} />
                <span className="ow-people-main">
                  <b>{d.name}</b>
                  <small>{d.relation ? RELATION[d.relation] : 'Helper'} · {d.role === 'manager' ? 'can answer requests' : 'can look only'} · {d.properties === 'all' ? 'all homes' : d.properties.map(id => s.properties.find(p => p.id === id)?.name).join(', ')}{d.phone ? ` · ${d.phone}` : ''}</small>
                </span>
                <button type="button" className="ow-main-pick" aria-pressed={main === d.name} onClick={() => s.setProfile({ mainContact: d.name })}><MessageCircle size={14} />{main === d.name ? 'ARGUS writes here' : 'Make main contact'}</button>
                <select aria-label={`What ${d.name} may do`} value={d.role} onChange={e => s.updateDelegate(d.name, { role: e.target.value as Person['role'] })}>
                  <option value="manager">Can answer</option><option value="viewer">Look only</option>
                </select>
                <button type="button" className="ow-icon-btn" aria-label={`Remove ${d.name}`} onClick={() => { if (main === d.name) s.setProfile({ mainContact: 'me' }); s.removeDelegate(d.name) }}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
          {add && (
            <form className="ow-addperson" onSubmit={e => { e.preventDefault(); if (!add.name.trim()) return; s.addDelegate({ ...add, name: add.name.trim() }); setAdd(null) }}>
              <div className="ow-form-grid">
                <div className="ow-field"><label htmlFor="an">Name</label><input id="an" autoFocus value={add.name} onChange={e => setAdd({ ...add, name: e.target.value })} /></div>
                <div className="ow-field"><label htmlFor="ar">Who is this?</label>
                  <select id="ar" value={add.relation} onChange={e => setAdd({ ...add, relation: e.target.value as Person['relation'] })}>
                    {Object.entries(RELATION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select></div>
                <div className="ow-field"><label htmlFor="aph">Phone</label><input id="aph" inputMode="tel" value={add.phone} onChange={e => setAdd({ ...add, phone: e.target.value })} /></div>
                <div className="ow-field"><label htmlFor="aro">May</label>
                  <select id="aro" value={add.role} onChange={e => setAdd({ ...add, role: e.target.value as Person['role'] })}>
                    <option value="manager">Answer requests and edit</option><option value="viewer">Look only</option>
                  </select></div>
              </div>
              <p className="ow-faint">They get their own sign-in. A link alone never makes anyone an owner.</p>
              <div className="ow-req-actions" style={{ marginTop: 10 }}>
                <button className="ow-btn primary" type="submit">Link to my account</button>
                <button className="ow-btn quiet" type="button" onClick={() => setAdd(null)}>Cancel</button>
              </div>
            </form>
          )}
        </section>
      </div>
    </>
  )
}
