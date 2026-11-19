'use client'
// Details for contracts. Everything is optional; the owner gives what they
// like. What ARGUS does not have yet is filled in there too (never overwritten),
// so agents stop asking the same questions at the end of every deal.
import { useRef, useState } from 'react'
import { BadgeCheck, ShieldCheck, Upload } from 'lucide-react'
import { DETAIL_LABEL, detailsProgress, type OwnerDetails } from '@/lib/owner/identity'
import { useOwner } from '@/lib/owner/store'

function read(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) })
}

export function ContractDetails() {
  const s = useOwner()
  const [d, setD] = useState<OwnerDetails>(s.details)
  const [company, setCompany] = useState(!!(s.details.companyName || s.details.companyNumber))
  const idFile = useRef<HTMLInputElement>(null)
  const prog = detailsProgress(d, company)
  const pct = Math.round((prog.done / prog.total) * 100)
  const field = (k: Exclude<keyof OwnerDetails, 'idVerified'>, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="ow-field">
      <label htmlFor={`cd-${k}`}>{DETAIL_LABEL[k]}{s.argusDetails[k] && !d[k] ? <small className="ow-known"> · ARGUS has this</small> : null}</label>
      <input id={`cd-${k}`} value={d[k] || ''} placeholder={s.argusDetails[k] ? String(s.argusDetails[k]) : 'Optional'} onChange={e => setD({ ...d, [k]: e.target.value })} {...extra} />
    </div>
  )
  return (
    <section className="ow-panel ow-section ow-contract">
      <div className="ow-contract-head">
        <span className="ow-ring" style={{ ['--p' as string]: `${pct}%` }}><b>{pct}%</b></span>
        <div>
          <h2>Details for contracts</h2>
          <p className="ow-faint">All optional. What you add here saves time when a tenant or buyer signs. Only ARGUS uses it; agencies never see it.</p>
        </div>
      </div>
      <div className="ow-seg" role="group" aria-label="I rent out as" style={{ margin: '6px 0 14px' }}>
        <button type="button" aria-pressed={!company} onClick={() => setCompany(false)}>As a private person</button>
        <button type="button" aria-pressed={company} onClick={() => setCompany(true)}>Through a company</button>
      </div>
      <form className="ow-form-grid" onSubmit={e => { e.preventDefault(); s.setDetails(d) }}>
        {field('legalName', { autoComplete: 'name' })}
        {field('idNumber', { autoComplete: 'off' })}
        {company && field('companyName', { autoComplete: 'organization' })}
        {company && field('companyNumber')}
        {company && field('vatNumber')}
        {field('address', { autoComplete: 'street-address' })}
        {field('locality', { autoComplete: 'address-level2' })}
        {field('postcode', { autoComplete: 'postal-code' })}
        <div className="ow-field" style={{ alignSelf: 'end' }}><button className="ow-btn primary" type="submit">Save details</button></div>
      </form>
      <div className="ow-verify" data-state={s.details.idVerified || 'none'}>
        {s.details.idVerified === 'verified' ? <BadgeCheck size={26} /> : <ShieldCheck size={26} />}
        <div>
          <b>{s.details.idVerified === 'verified' ? 'Verified owner' : s.details.idVerified === 'pending' ? 'ID received, ARGUS is checking it' : 'Get the verified badge'}</b>
          <p className="ow-faint">Upload a photo of your ID card or passport. It is kept private in Documents and only used to confirm you are the owner.</p>
        </div>
        {s.details.idVerified !== 'verified' && (
          <>
            <button className="ow-btn small" onClick={() => idFile.current?.click()}><Upload size={15} />{s.details.idVerified === 'pending' ? 'Upload again' : 'Upload ID'}</button>
            <input ref={idFile} type="file" accept="image/*,application/pdf" hidden onChange={async e => {
              const f = e.target.files?.[0]; if (!f) return
              s.addDocument({ title: 'ID for verification', kind: 'id', propertyId: s.properties[0].id, dataUrl: f.size < 3_000_000 ? await read(f) : undefined, fileName: f.name })
              s.setDetails({ idVerified: 'pending' }); e.target.value = ''
            }} />
          </>
        )}
      </div>
    </section>
  )
}
