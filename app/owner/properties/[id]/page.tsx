'use client'
import { LiveProperty } from '@/components/owner/live'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { ArrowLeft, Pencil } from 'lucide-react'
import { PropertyEditor } from '@/components/owner/property-editor'
import { useOwner } from '@/lib/owner/store'
import { MODE_LABEL, type OperatingMode, type Room } from '@/lib/owner/model'
import { modeSwitchCheck, effectiveDistribution, recipients } from '@/lib/owner/engine'
import { RoomPlan } from '@/components/owner/room-plan'
import { RequestCard } from '@/components/owner/request-card'
import { activeOffer, ago, euro, niceDate, priceLine } from '@/components/owner/format'
import { availabilityLine } from '@/components/owner/property-card'

const ROOM_STATUS: Record<Room['status'], string> = { available: 'Free', occupied: 'Let', reserved: 'Reserved', inactive: 'Not offered' }

function PropertyDetailInner() {
  const { id } = useParams<{ id: string }>()
  const s = useOwner()
  const p = s.properties.find(x => String(x.id) === id)
  const q = useSearchParams()
  const [tab, setTab] = useState<'overview' | 'edit' | 'rooms' | 'offer' | 'requests' | 'history'>(q.get('edit') ? 'edit' : 'overview')
  const [sel, setSel] = useState<string | undefined>(p?.rooms[0]?.id)
  const [modeMsg, setModeMsg] = useState<string[]>([])
  const [price, setPrice] = useState(String((p && activeOffer(p)?.price) ?? ''))
  const [over, setOver] = useState<string | null>(null)
  if (!p) return <div className="ow-panel ow-empty">This property is not in your account.</div>

  const offer = activeOffer(p)
  const dist = effectiveDistribution(s.profile, p)
  const reach = recipients(dist, s.agencies, s.today)
  const reqs = s.requests.filter(r => r.propertyId === p.id).sort((a, b) => b.start.localeCompare(a.start))
  const tabs = [['overview', 'Overview'], ['edit', 'Edit listing'], ...(p.rooms.length || p.mode === 'rooms' ? [['rooms', 'Rooms']] : []), ['offer', 'Offer & price'], ['requests', `Requests (${reqs.length})`], ['history', 'History']] as [typeof tab, string][]

  const switchMode = (m: OperatingMode) => {
    const res = s.setMode(p.id, m)
    setModeMsg(res.reasons)
  }

  return (
    <>
      <Link href="/owner/properties" className="ow-back"><ArrowLeft size={18} /> My properties</Link>
      <div className="ow-hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {p.photos[0] ? <img src={p.photos[0]} alt={`${p.name}, ${p.town}`} /> : <button className="ow-hero-nophoto" onClick={() => setTab('edit')}>Add photos</button>}
        <div className="ow-panel" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <span className="ow-chip" style={{ justifySelf: 'start' }}>{MODE_LABEL[p.mode]}</span>
          <h1>{p.name}</h1>
          <p className="ow-muted">{p.address}</p>
          <p className="ow-price">{priceLine(offer)}</p>
          <dl className="ow-kv">
            <dt>Availability</dt><dd>{availabilityLine(p, s.today)}</dd>
            <dt>Bedrooms</dt><dd>{p.bedrooms} · {p.bathrooms} Bathrooms{p.sizeSqm ? ` · ${p.sizeSqm} m²` : ''}</dd>
            <dt>Confirmed</dt><dd>{ago(p.lastConfirmedAt, s.today)}</dd>
            <dt>Shown on</dt><dd>{reach.length ? reach.map(r => r.channel).join(', ') : 'Nowhere (private)'}</dd>
            <dt>Reference</dt><dd>{p.ref}</dd>
          </dl>
          <div className="ow-req-actions">
            {p.listing === 'live'
              ? <button className="ow-btn" onClick={() => s.setListing(p.id, 'paused')}>Pause listing</button>
              : <button className="ow-btn primary" onClick={() => s.setListing(p.id, 'live')}>Make live</button>}
            <button className="ow-btn primary" onClick={() => { setTab('edit'); setTimeout(() => document.querySelector('.ow-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50) }}><Pencil size={16} />Edit listing</button>
            <Link className="ow-btn quiet" href={`/owner/sharing?p=${p.id}`}>Change where it is shown</Link>
          </div>
        </div>
      </div>

      <div className="ow-tabs" role="group" aria-label="Sections" style={{ marginTop: 26 }}>
        {tabs.map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'overview' && (
        <div className="ow-grid-2">
          <div className="ow-panel">
            <h2>Waiting for you</h2>
            <div className="ow-attn" style={{ marginTop: 12 }}>
              {reqs.filter(r => r.status === 'awaiting_owner').map(r => <RequestCard key={r.id} r={r} />)}
              {!reqs.some(r => r.status === 'awaiting_owner') && <p className="ow-muted">No open requests for this property.</p>}
            </div>
          </div>
          <div className="ow-panel">
            <h2>Photos</h2>
            <div className="ow-rooms" style={{ marginTop: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.photos.map((ph, i) => <img key={i} src={ph} alt={`Photo ${i + 1}`} style={{ width: '100%', borderRadius: 10, aspectRatio: '4/3', objectFit: 'cover' }} />)}
            </div>
            <p className="ow-faint" style={{ marginTop: 10 }}>Photos stay with the property when you change how you offer it.</p>
          </div>
        </div>
      )}

      {tab === 'edit' && <PropertyEditor p={p} />}

      {tab === 'rooms' && (
        <div className="ow-grid-2">
          <div className="ow-panel">
            <h2>Rooms at a glance</h2>
            <p className="ow-faint" style={{ margin: '4px 0 12px' }}>Tap a room. Green is free, sand is let, grey is not offered.</p>
            {p.plan ? <RoomPlan plan={p.plan} rooms={p.rooms} selected={sel} onSelect={setSel} /> : <p className="ow-hint">No floor plan yet. A scan or a hand-drawn plan can be added later; the rooms below work without it.</p>}
          </div>
          <div className="ow-rooms" style={{ alignContent: 'start' }}>
            {p.rooms.map(r => (
              <div key={r.id} className="ow-room" data-sel={sel === r.id} onClick={() => setSel(r.id)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {r.photo ? <img src={r.photo} alt={`${r.label}`} /> : <div className="ow-room-nophoto">No photo yet</div>}
                <div className="ow-prop-title"><h3>{r.label}</h3><span className={`ow-chip ${r.status === 'available' ? '' : r.status === 'inactive' ? 'plain' : 'honey'}`}>{ROOM_STATUS[r.status]}</span></div>
                <p className="ow-faint">{euro(r.price)} / month{r.sizeSqm ? ` · ${r.sizeSqm} m²` : ''}{r.ensuite ? ' · own bathroom' : ''}</p>
                <p className="ow-faint">{r.status === 'occupied' && r.occupiedUntil ? `Let until ${niceDate(r.occupiedUntil, false)}` : r.availableFrom ? `Free from ${niceDate(r.availableFrom, false)}` : ''}</p>
                <div className="ow-drop" data-over={over === r.id}
                  onDragOver={e => { e.preventDefault(); setOver(r.id) }} onDragLeave={() => setOver(null)}
                  onDrop={e => { e.preventDefault(); setOver(null); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) s.setRoomPhoto(p.id, r.id, URL.createObjectURL(f)) }}>
                  Drop a photo here
                </div>
                {r.status === 'inactive'
                  ? <button className="ow-btn small" onClick={() => s.setRoomStatus(p.id, r.id, 'available')}>Offer this room</button>
                  : r.status === 'available' ? <button className="ow-btn small quiet" onClick={() => s.setRoomStatus(p.id, r.id, 'inactive')}>Stop offering</button> : null}
                <p className="ow-faint" style={{ fontSize: 12 }}>Room ID {r.id}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'offer' && (
        <div className="ow-grid-2">
          <div className="ow-panel">
            <h2>How you offer it</h2>
            <p className="ow-faint" style={{ margin: '4px 0 14px' }}>Switching keeps the same property, photos and history. ARGUS checks tenants and bookings first.</p>
            <div className="ow-tabs" role="group" aria-label="Operating mode">
              {(Object.keys(MODE_LABEL) as OperatingMode[]).map(m => {
                const blocks = modeSwitchCheck(p, m, s.requests, s.today).filter(b => b.level === 'block')
                return <button key={m} aria-pressed={p.mode === m} onClick={() => switchMode(m)} title={blocks[0]?.text}>{MODE_LABEL[m]}</button>
              })}
            </div>
            {modeMsg.map((t, i) => <p key={i} className={i === 0 && !t.startsWith('A ') ? 'ow-warn' : 'ow-hint'} style={{ marginTop: 8 }}>{t}</p>)}
          </div>
          <div className="ow-panel">
            <h2>Price</h2>
            <form className="ow-inline-form" style={{ marginTop: 12 }} onSubmit={e => { e.preventDefault(); const n = Number(price); if (n >= 100) s.setPrice(p.id, n); else s.say('Enter the price in euros, for example 1650.', 'err') }}>
              <label className="ow-label" htmlFor="price">{offer?.period === 'night' ? 'Per night' : offer?.period === 'total' ? 'Asking price' : 'Per month'} (€)</label>
              <input id="price" inputMode="numeric" value={price} onChange={e => setPrice(e.target.value.replace(/\D/g, ''))} style={{ width: 140 }} />
              <button className="ow-btn primary" type="submit">Save price</button>
            </form>
            <div className="ow-switch" style={{ marginTop: 10 }}>
              <div><b>Show &ldquo;price on request&rdquo; to agencies</b><p>The public and NEXUS still see the price.</p></div>
              <button role="switch" aria-checked={!!offer?.hidePriceFor.includes('agencies')} aria-label="Hide price from agencies" className="ow-toggle" onClick={() => s.setHidePrice(p.id, !offer?.hidePriceFor.includes('agencies'))} />
            </div>
          </div>
        </div>
      )}

      {tab === 'requests' && <div className="ow-attn">{reqs.length ? reqs.map(r => <RequestCard key={r.id} r={r} />) : <div className="ow-panel ow-empty">No requests yet.</div>}</div>}

      {tab === 'history' && (
        <div className="ow-panel">
          <h2>How this property has been offered</h2>
          <table className="ow-table" style={{ marginTop: 10 }}>
            <thead><tr><th>Offer</th><th>From</th><th>Until</th></tr></thead>
            <tbody>{[...p.modeHistory].reverse().map((h, i) => <tr key={i}><td>{MODE_LABEL[h.mode]}</td><td>{niceDate(h.from, false)} {h.from.slice(0, 4)}</td><td>{h.to ? `${niceDate(h.to, false)} ${h.to.slice(0, 4)}` : 'Now'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  )
}

function LiveDetail() {
  const { id } = useParams<{ id: string }>()
  return <LiveProperty id={Number(id)} />
}

// nexussync.one: the home as ARGUS holds it; ?demo=1: the preview.
export default function PropertyDetail() {
  const { demo } = useOwner()
  if (!demo) return <LiveDetail />
  return <Suspense fallback={null}><PropertyDetailInner /></Suspense>
}
