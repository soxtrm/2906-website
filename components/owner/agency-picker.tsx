'use client'
// "Which agencies may sell or let my homes": the big Malta agencies first as
// tick cards, then freelance agents, then every other agency (they can register
// themselves). A monogram stands in until an agency uploads its own logo.
import { useMemo, useState } from 'react'
import { Check, Plus, Search } from 'lucide-react'
import { DIRECTORY, FOCUS_LABEL, monogram, rankFor, type Focus } from '@/lib/owner/agency-directory'
import { useOwner } from '@/lib/owner/store'

export function AgencyPicker() {
  const s = useOwner()
  const picks = s.agencyPicks
  const [q, setQ] = useState('')
  const [focus, setFocus] = useState<Focus | null>(null)
  const wants: Focus[] = useMemo(() => [...new Set(s.properties.flatMap(p => (p.mode === 'sale' || p.mode === 'commercial_sale' ? ['sales'] : p.mode === 'commercial' ? ['commercial'] : ['rentals']) as Focus[]))], [s.properties])
  const list = rankFor(DIRECTORY, wants).filter(a => (!focus || a.focus.includes(focus)) && (!q || a.name.toLowerCase().includes(q.toLowerCase())))
  const major = list.filter(a => a.tier === 'major')
  const other = list.filter(a => a.tier === 'other')
  const card = (a: (typeof DIRECTORY)[number]) => {
    const on = picks.ids.includes(a.id)
    return (
      <li key={a.id}>
        <button type="button" className="ow-ag" aria-pressed={on} onClick={() => s.pickAgency(a.id, !on, a.name)}>
          <span className="ow-ag-mono" style={{ background: a.color }}>{monogram(a.name)}</span>
          <span className="ow-ag-main">
            <b>{a.name}</b>
            <small>{a.note}</small>
            <span className="ow-ag-tags">{a.focus.map(f => <em key={f}>{FOCUS_LABEL[f]}</em>)}</span>
          </span>
          <span className="ow-ag-check" aria-hidden="true">{on ? <Check size={18} /> : <Plus size={18} />}</span>
        </button>
      </li>
    )
  }
  return (
    <section className="ow-panel ow-agpick" aria-labelledby="agpick-h">
      <div className="ow-head" style={{ marginBottom: 6 }}>
        <div>
          <h2 id="agpick-h">Agencies that may sell or let your homes</h2>
          <p className="ow-faint">{picks.ids.length ? `${picks.ids.length} chosen` : 'Tick the ones you like. The biggest come first.'}</p>
        </div>
        <button type="button" className="ow-btn small" onClick={() => s.pickMany(DIRECTORY.filter(a => a.tier === 'major').map(a => a.id))}>Tick all big agencies</button>
      </div>
      <div className="ow-agpick-tools">
        <label className="ow-agpick-search"><Search size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Find an agency" aria-label="Find an agency" /></label>
        <div className="ow-pills" role="group" aria-label="Focus">
          <button type="button" aria-pressed={focus === null} onClick={() => setFocus(null)}>All</button>
          {(Object.keys(FOCUS_LABEL) as Focus[]).map(f => <button type="button" key={f} aria-pressed={focus === f} onClick={() => setFocus(f)}>{FOCUS_LABEL[f]}</button>)}
        </div>
      </div>
      {major.length > 0 && <><p className="ow-label">Biggest agencies</p><ul className="ow-ag-grid">{major.map(card)}</ul></>}
      <div className="ow-ag-groups">
        <button type="button" className="ow-ag-group" aria-pressed={picks.freelancers} onClick={() => s.setOpenGroups({ freelancers: !picks.freelancers })}>
          <span className="ow-ag-mono" style={{ background: '#4f6bff' }}>FA</span>
          <span className="ow-ag-main"><b>Freelance agents</b><small>Licensed independent agents verified by ARGUS</small></span>
          <span className="ow-ag-check" aria-hidden="true">{picks.freelancers ? <Check size={18} /> : <Plus size={18} />}</span>
        </button>
        <button type="button" className="ow-ag-group" aria-pressed={picks.others} onClick={() => s.setOpenGroups({ others: !picks.others })}>
          <span className="ow-ag-mono" style={{ background: '#64748b' }}>+</span>
          <span className="ow-ag-main"><b>All other agencies</b><small>Every agency that registers and is approved on ARGUS</small></span>
          <span className="ow-ag-check" aria-hidden="true">{picks.others ? <Check size={18} /> : <Plus size={18} />}</span>
        </button>
      </div>
      {other.length > 0 && <><p className="ow-label">More agencies</p><ul className="ow-ag-grid small">{other.map(card)}</ul></>}
      <p className="ow-faint" style={{ marginTop: 10 }}>Your agency is missing? Agencies register themselves at sync.2906.estate/agencies and appear here once approved.</p>
    </section>
  )
}
