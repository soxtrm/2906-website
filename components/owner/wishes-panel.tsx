'use client'
// What the owner wants and does not want in a tenant, filled from the chat.
// Wishes said for three properties (or for "all my properties") show as
// "All homes". Agents see this list before they suggest a client.
import { useState } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { useOwner } from '@/lib/owner/store'
import { wishesFor } from '@/lib/owner/wishes'
import { propColor } from './format'

const SUGGEST: { label: string; pol: 'plus' | 'minus' }[] = [
  { label: 'Couple', pol: 'plus' }, { label: 'Working professionals', pol: 'plus' }, { label: 'Long stay (12 months+)', pol: 'plus' },
  { label: 'Quiet tenants', pol: 'plus' }, { label: 'Family', pol: 'plus' }, { label: 'No pets', pol: 'minus' },
  { label: 'Non-smokers only', pol: 'minus' }, { label: 'No students', pol: 'minus' }, { label: 'No sharers or groups', pol: 'minus' },
]

export function WishesPanel() {
  const s = useOwner()
  const ids = s.properties.map(p => p.id)
  const [pid, setPid] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [pol, setPol] = useState<'plus' | 'minus'>('plus')
  const list = wishesFor(s.wishes, ids, pid)
  const plus = list.filter(w => w.polarity === 'plus')
  const minus = list.filter(w => w.polarity === 'minus')

  const Item = ({ w }: { w: (typeof list)[number] }) => (
    <li title={`"${w.quote}"`}>
      <span className="ow-wish-label">{w.label}</span>
      {w.scope === 'all' && pid !== null && <span className="ow-wish-all">All homes</span>}
      {w.scope === 'property' && pid === null && w.properties.map(id => <i key={id} className="ow-wish-dot" style={{ background: propColor(ids, id) }} />)}
      <button type="button" aria-label={`Remove ${w.label}`} onClick={() => s.removeWish(w.key, pid)}><X size={14} /></button>
    </li>
  )

  return (
    <section className="ow-panel ow-wishes" aria-labelledby="wishes-h">
      <div className="ow-wishes-head">
        <h2 id="wishes-h">Who you are looking for</h2>
      </div>
      <div className="ow-pills" role="group" aria-label="Property">
        <button type="button" aria-pressed={pid === null} onClick={() => setPid(null)}>All homes</button>
        {s.properties.map(p => (
          <button type="button" key={p.id} aria-pressed={pid === p.id} onClick={() => setPid(p.id)}>
            <i style={{ background: propColor(ids, p.id) }} />{p.name.split(' ').slice(0, 2).join(' ')}
          </button>
        ))}
      </div>
      <div className="ow-wish-cols">
        <div>
          <p className="ow-wish-h plus"><Plus size={15} /> Yes</p>
          <ul className="ow-wish-list plus">{plus.length ? plus.map(w => <Item key={w.key} w={w} />) : <li className="empty">Nothing yet</li>}</ul>
        </div>
        <div>
          <p className="ow-wish-h minus"><Minus size={15} /> No</p>
          <ul className="ow-wish-list minus">{minus.length ? minus.map(w => <Item key={w.key} w={w} />) : <li className="empty">Nothing yet</li>}</ul>
        </div>
      </div>
      <form className="ow-wish-add" onSubmit={e => { e.preventDefault(); s.addWish(text, pol, pid); setText('') }}>
        <div className="ow-wish-pol" role="group" aria-label="Yes or no">
          <button type="button" aria-pressed={pol === 'plus'} onClick={() => setPol('plus')}><Plus size={14} />Yes</button>
          <button type="button" aria-pressed={pol === 'minus'} onClick={() => setPol('minus')}><Minus size={14} />No</button>
        </div>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={pid === null ? 'Add for all homes, e.g. quiet' : 'Add for this home'} aria-label="Add a tag" />
        <button type="submit" className="ow-btn small primary" disabled={!text.trim()}>Add</button>
      </form>
      <div className="ow-wish-suggest" aria-label="Quick tags">
        {SUGGEST.filter(x => !list.some(w => w.label === x.label)).slice(0, 6).map(x => (
          <button type="button" key={x.label} data-pol={x.pol} onClick={() => s.addWish(x.label, x.pol, pid)}>{x.pol === 'plus' ? '+' : '−'} {x.label}</button>
        ))}
      </div>
      <p className="ow-faint ow-wish-foot">ARGUS adds tags from your chats by itself; you can add or remove any. Nationality, origin or religion are never recorded.</p>
    </section>
  )
}
