'use client'
// Edit a listing completely: basics, description, features, photos (for the
// whole home and, optionally, per room) and the rooms of a shared flat.
// Text fields are saved with one button; photos and rooms save as you go.
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Property, Room } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { PhotoDrop } from './photo-drop'

const FEATURES = ['Sea view', 'Pool', 'Balcony', 'Garden', 'Roof terrace', 'Jacuzzi', 'Seafront', 'Garage/Parking', 'AC', 'Heating', 'Solar panels', 'Lift', 'Pet-friendly', 'Brand new', 'Renovated', 'Washing machine', 'Dishwasher', 'Fast internet']
const STATUS: Record<Room['status'], string> = { available: 'Free', occupied: 'Let', reserved: 'Reserved', inactive: 'Not offered' }

export function PropertyEditor({ p }: { p: Property }) {
  const s = useOwner()
  const [f, setF] = useState({
    name: p.name, address: p.address, town: p.town, bedrooms: p.bedrooms, bathrooms: p.bathrooms, sizeSqm: p.sizeSqm ?? '',
    availableFrom: p.availableFrom || '', description: p.description || '', features: p.features || [], furnished: p.furnished || 'Furnished',
  })
  const dirty = JSON.stringify(f) !== JSON.stringify({
    name: p.name, address: p.address, town: p.town, bedrooms: p.bedrooms, bathrooms: p.bathrooms, sizeSqm: p.sizeSqm ?? '',
    availableFrom: p.availableFrom || '', description: p.description || '', features: p.features || [], furnished: p.furnished || 'Furnished',
  })
  const shared = p.mode === 'rooms' || p.rooms.length > 0
  const save = () => s.updateProperty(p.id, { ...f, sizeSqm: f.sizeSqm === '' ? undefined : Number(f.sizeSqm), availableFrom: f.availableFrom || undefined, furnished: f.furnished as Property['furnished'] })

  return (
    <div className="ow-editor">
      <section className="ow-panel">
        <h2>Basics</h2>
        <div className="ow-form-grid" style={{ marginTop: 12 }}>
          <div className="ow-field"><label htmlFor="e-name">Name of the listing</label><input id="e-name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
          <div className="ow-field"><label htmlFor="e-town">Town</label><input id="e-town" value={f.town} onChange={e => setF({ ...f, town: e.target.value })} /></div>
          <div className="ow-field"><label htmlFor="e-addr">Street (only ARGUS sees it)</label><input id="e-addr" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></div>
          <div className="ow-field"><label htmlFor="e-bed">Bedrooms</label><input id="e-bed" type="number" min={0} value={f.bedrooms} onChange={e => setF({ ...f, bedrooms: Number(e.target.value) })} /></div>
          <div className="ow-field"><label htmlFor="e-bath">Bathrooms</label><input id="e-bath" type="number" min={0} value={f.bathrooms} onChange={e => setF({ ...f, bathrooms: Number(e.target.value) })} /></div>
          <div className="ow-field"><label htmlFor="e-size">Size in m²</label><input id="e-size" type="number" min={0} value={f.sizeSqm} onChange={e => setF({ ...f, sizeSqm: e.target.value === '' ? '' : Number(e.target.value) })} /></div>
          <div className="ow-field"><label htmlFor="e-from">Free from</label><input id="e-from" type="date" value={f.availableFrom} onChange={e => setF({ ...f, availableFrom: e.target.value })} /></div>
          <div className="ow-field"><span className="ow-label">Furniture</span>
            <div className="ow-seg" role="group" aria-label="Furniture">
              {['Furnished', 'Part', 'Unfurnished'].map(x => <button type="button" key={x} aria-pressed={f.furnished === x} onClick={() => setF({ ...f, furnished: x as typeof f.furnished })}>{x}</button>)}
            </div></div>
        </div>
        <div className="ow-field" style={{ marginTop: 14 }}>
          <label htmlFor="e-desc">Description</label>
          <textarea id="e-desc" maxLength={2000} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} placeholder="What makes it nice to live in? ARGUS polishes the wording for each channel." />
        </div>
        <p className="ow-label" style={{ marginTop: 14 }}>Features</p>
        <div className="ow-choice">
          {FEATURES.map(x => <button type="button" key={x} aria-pressed={f.features.includes(x)} onClick={() => setF({ ...f, features: f.features.includes(x) ? f.features.filter(y => y !== x) : [...f.features, x] })}>{x}</button>)}
        </div>
        <div className="ow-editor-save">
          <button className="ow-btn primary" disabled={!dirty} onClick={save}>{dirty ? 'Save changes' : 'All saved'}</button>
          {dirty && <button className="ow-btn quiet" onClick={() => setF({ name: p.name, address: p.address, town: p.town, bedrooms: p.bedrooms, bathrooms: p.bathrooms, sizeSqm: p.sizeSqm ?? '', availableFrom: p.availableFrom || '', description: p.description || '', features: p.features || [], furnished: p.furnished || 'Furnished' })}>Undo</button>}
        </div>
      </section>

      <section className="ow-panel">
        <h2>Photos of the home</h2>
        <p className="ow-faint" style={{ margin: '4px 0 12px' }}>Drop all of them at once or add them one by one. The first is the cover.{shared ? ' You can say which room a photo shows; that is optional.' : ''}</p>
        <PhotoDrop photos={p.photos} onChange={ph => s.setPhotos(p.id, ph)}
          rooms={shared ? p.rooms.map(r => ({ id: r.id, label: r.label })) : undefined} tags={p.photoRooms} onTag={(u, r) => s.tagPhoto(p.id, u, r)} />
      </section>

      <section className="ow-panel">
        <div className="ow-head" style={{ marginBottom: 6 }}>
          <div>
            <h2>{shared ? 'Rooms' : 'Rooms (optional)'}</h2>
            <p className="ow-faint">{shared ? 'Each room with its own photos, price and status.' : 'Only needed if you let it by the room.'}</p>
          </div>
          <button className="ow-btn small" onClick={() => s.addRoom(p.id)}><Plus size={16} />Add room</button>
        </div>
        <div className="ow-room-edit-list">
          {p.rooms.map(r => (
            <article key={r.id} className="ow-room-edit">
              <div className="ow-form-grid">
                <div className="ow-field"><label htmlFor={`rl-${r.id}`}>Name</label><input id={`rl-${r.id}`} value={r.label} onChange={e => s.updateRoom(p.id, r.id, { label: e.target.value })} /></div>
                <div className="ow-field"><label htmlFor={`rp-${r.id}`}>Rent per month (€)</label><input id={`rp-${r.id}`} type="number" min={0} value={r.price} onChange={e => s.updateRoom(p.id, r.id, { price: Number(e.target.value) })} /></div>
                <div className="ow-field"><label htmlFor={`rs-${r.id}`}>Size m²</label><input id={`rs-${r.id}`} type="number" min={0} value={r.sizeSqm ?? ''} onChange={e => s.updateRoom(p.id, r.id, { sizeSqm: e.target.value ? Number(e.target.value) : undefined })} /></div>
                <div className="ow-field"><label htmlFor={`rst-${r.id}`}>Status</label>
                  <select id={`rst-${r.id}`} value={r.status} onChange={e => s.updateRoom(p.id, r.id, { status: e.target.value as Room['status'] })}>
                    {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select></div>
              </div>
              <div className="ow-room-edit-row">
                <label className="ow-check"><input type="checkbox" checked={!!r.ensuite} onChange={e => s.updateRoom(p.id, r.id, { ensuite: e.target.checked })} />Own bathroom</label>
                <button className="ow-btn small quiet danger" onClick={() => s.removeRoom(p.id, r.id)}><Trash2 size={15} />Remove room</button>
              </div>
              <PhotoDrop compact max={12} label={`Photos of ${r.label}`} photos={r.photos?.length ? r.photos : r.photo ? [r.photo] : []} onChange={ph => s.setRoomPhotos(p.id, r.id, ph)} />
            </article>
          ))}
          {!p.rooms.length && <p className="ow-muted">No rooms yet.</p>}
        </div>
      </section>
    </div>
  )
}
