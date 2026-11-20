'use client'
import { LiveSharing } from '@/components/owner/live'
import { useOwner as useOwnerMode } from '@/lib/owner/store'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOwner } from '@/lib/owner/store'
import { addDays, effectiveDistribution, exclusiveActive, recipients } from '@/lib/owner/engine'
import type { Distribution, Property } from '@/lib/owner/model'
import { niceDate } from '@/components/owner/format'
import { AgentSync } from '@/components/owner/agent-sync'
import { AgencyPicker } from '@/components/owner/agency-picker'

function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} className="ow-toggle" disabled={disabled} onClick={() => onChange(!on)} />
}

function Channels({ d, onChange, agenciesDisabled }: { d: Distribution; onChange: (d: Distribution) => void; agenciesDisabled?: boolean }) {
  const { agencies, today } = useOwner()
  const excl = exclusiveActive(d, today)
  return (
    <div>
      <div className="ow-switch"><div><b>Keep it private</b><p>Nobody new sees it. Existing confirmed viewings stay.</p></div><Toggle on={d.private} label="Private" onChange={v => onChange({ ...d, private: v })} /></div>
      <div className="ow-switch"><div><b>NEXUS Direct</b><p>Tenants find it on NEXUS Housing and book straight with you.</p></div><Toggle on={d.nexusDirect} label="NEXUS Direct" disabled={d.private} onChange={v => onChange({ ...d, nexusDirect: v })} /></div>
      <div className="ow-switch"><div><b>ARGUS agent network</b><p>Verified agents on ARGUS can request viewings for their clients.</p></div><Toggle on={d.argusB2B} label="ARGUS agent network" disabled={d.private || excl || agenciesDisabled} onChange={v => onChange({ ...d, argusB2B: v })} /></div>
      <div className="ow-switch"><div><b>All approved agencies</b><p>Every agency you have approved gets it.</p></div><Toggle on={d.allApprovedAgencies} label="All approved agencies" disabled={d.private || excl || agenciesDisabled} onChange={v => onChange({ ...d, allApprovedAgencies: v })} /></div>
      {!d.allApprovedAgencies && !excl && !d.private && !agenciesDisabled && (
        <fieldset style={{ border: 0, padding: '10px 0', margin: 0 }}>
          <legend className="ow-label">Only these agencies</legend>
          {agencies.filter(a => a.approved).map(a => (
            <label key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0' }}>
              <input type="checkbox" style={{ width: 20, height: 20 }} checked={d.agencyIds.includes(a.id)} onChange={e => onChange({ ...d, agencyIds: e.target.checked ? [...d.agencyIds, a.id] : d.agencyIds.filter(x => x !== a.id) })} />
              {a.name}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  )
}

function PropertySharing({ p }: { p: Property }) {
  const s = useOwner()
  const d = effectiveDistribution(s.profile, p)
  const reach = recipients(d, s.agencies, s.today)
  const excl = exclusiveActive(d, s.today)
  const set = (next: Distribution) => s.setDistribution(p.id, { inherit: false, override: next })
  return (
    <section className="ow-panel" id={`p-${p.id}`} aria-labelledby={`h-${p.id}`}>
      <div className="ow-prop-title"><h2 id={`h-${p.id}`}>{p.name}</h2><span className="ow-chip plain">{p.town}</span></div>
      <AgentSync p={p} />
      <div className="ow-switch">
        <div><b>Use my defaults</b><p>{p.distribution.inherit ? 'Follows your settings above. Change them once, every such property follows.' : 'This property has its own rules.'}</p></div>
        <Toggle on={p.distribution.inherit} label="Use my defaults" onChange={v => s.setDistribution(p.id, { inherit: v, override: v ? p.distribution.override : d })} />
      </div>
      {!p.distribution.inherit && (
        <>
          <Channels d={d} onChange={set} />
          <div className="ow-switch">
            <div>
              <b>Exclusive to one agency</b>
              <p>{excl ? `${s.agencies.find(a => a.id === d.exclusive!.agencyId)?.name} until ${niceDate(d.exclusive!.until, false)}. Afterwards it goes to ${d.exclusive!.thenRelease === 'all_approved' ? 'all approved agencies' : d.exclusive!.thenRelease === 'selected' ? 'your selected agencies' : 'nobody (private)'}.` : 'Give one agency the property alone for a set time.'}</p>
            </div>
            {excl
              ? <button className="ow-btn small" onClick={() => set({ ...d, exclusive: null })}>End now</button>
              : (
                <select aria-label="Exclusive agency" defaultValue="" onChange={e => e.target.value && set({ ...d, exclusive: { agencyId: e.target.value, until: addDays(s.today, 30), thenRelease: 'all_approved' }, private: false })} style={{ minHeight: 40, borderRadius: 10, border: '1px solid var(--ow-line)', padding: '0 10px' }}>
                  <option value="">30 days for…</option>
                  {s.agencies.filter(a => a.approved).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
          </div>
        </>
      )}
      <h3 style={{ marginTop: 16 }}>Shown right now</h3>
      <ul className="ow-channels" style={{ marginTop: 8 }}>
        {p.channels.map(c => (
          <li key={c.channel}>
            <span>{c.channel}</span>
            <span className={`ow-chip ${c.state === 'live' ? '' : c.state === 'pending' ? 'plain' : 'honey'}`}>{c.state === 'live' ? 'Showing' : c.state === 'pending' ? 'Being added' : c.state === 'delisting' ? 'Being removed' : 'Removed'}</span>
          </li>
        ))}
        {!p.channels.length && <li>Nowhere yet.</li>}
      </ul>
      <p className="ow-faint" style={{ marginTop: 8 }}>{reach.length ? `With these settings: ${reach.map(r => r.channel).join(', ')}.` : 'With these settings nobody new can see it.'} Agencies never see each other&rsquo;s clients or notes.</p>
    </section>
  )
}

function SharingInner() {
  const s = useOwner()
  const focus = useSearchParams().get('p')
  const ordered = focus ? [...s.properties].sort((a, b) => (String(a.id) === focus ? -1 : String(b.id) === focus ? 1 : 0)) : s.properties
  return (
    <>
      <div className="ow-head"><div>
        <h1>Agencies &amp; sharing</h1>
        <p className="ow-muted">Decide who may show your properties. Removing a channel asks it to take the listing down, and you can watch until it is gone.</p>
      </div></div>
      <AgencyPicker />
      <div className="ow-grid-2 ow-section">
        <section className="ow-panel" aria-labelledby="defaults">
          <h2 id="defaults">My defaults</h2>
          <p className="ow-faint" style={{ marginTop: 4 }}>New properties and every property set to &ldquo;use my defaults&rdquo; follow these.</p>
          <Channels d={s.profile.defaults} onChange={d => s.setDefaults(d)} />
        </section>
        <section className="ow-panel" aria-labelledby="agencies">
          <h2 id="agencies">Already working with you</h2>
          <p className="ow-faint" style={{ marginTop: 4 }}>Demo partners in this preview.</p>
          <ul className="ow-channels" style={{ marginTop: 12 }}>
            {s.agencies.map(a => <li key={a.id}><span>{a.name}<br /><span className="ow-faint">{a.agents.map(x => x.name).join(', ')}</span></span><span className={`ow-chip ${a.approved ? '' : 'honey'}`}>{a.approved ? 'Approved' : 'Asked to work with you'}</span></li>)}
          </ul>
        </section>
      </div>
      <div className="ow-section">{ordered.map(p => <PropertySharing key={p.id} p={p} />)}</div>
    </>
  )
}

function DemoSharing() {
  return <Suspense fallback={null}><SharingInner /></Suspense>
}

// nexussync.one: the real workspace from ARGUS; ?demo=1: the preview with Maria.
export default function SharingPage() {
  const { demo } = useOwnerMode()
  return demo ? <DemoSharing /> : <LiveSharing />
}
