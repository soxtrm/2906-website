'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, MapPin, RefreshCw, Search, Settings2 } from 'lucide-react'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import taxonomy from '@/lib/nexus-bridge/taxonomy.json'
import { NexusPlaceEditor } from '@/components/crm/nexus-place-editor'

type Place = { id: number; key: string | null; label: string; coordinates: [number, number] | null; precision: string }
type Settings = Record<string, string | number | boolean | string[] | null>
type Listing = { id: number; ref: string | null; town: string | null; updatedAt: string; settings: Settings; canEdit: boolean; reviewReasons: string[]; tagStatus: string; availability: string; location: { coordinates: [number, number] | null; precision: string }; featureFacts: Record<string, { status: string; value: unknown }> }
type Queue = { listings: Listing[]; total: number; reviewTotal: number; localities: Place[]; editableTags: string[]; propertyTypes: string[] }
const input = 'w-full rounded-lg border border-white/15 bg-[#0f1521] px-3 py-2.5 text-sm text-[#edeae1] focus:outline-none focus:ring-2 focus:ring-[#b8953f] disabled:opacity-60'
const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm disabled:opacity-50'
const numberFields = [['bedrooms', 'Beds'], ['bathrooms', 'Baths'], ['size_sqm', 'Floor area · m²'], ['longlet_price', 'Monthly rent · €'], ['sale_price', 'Sale price · €']] as const
const permissionFields = [['pets_allowed', 'Pets'], ['sharing_allowed', 'Sharing'], ['subletting_allowed', 'Subletting'], ['has_balcony', 'Balcony'], ['has_study_room', 'Separate study'], ['parking_available', 'Parking'], ['viewings_allowed', 'Viewings allowed']] as const
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function LocalityMap({ places, selected, onSelect, disabled }: { places: Place[]; selected: number | null; onSelect: (id: number) => void; disabled: boolean }) {
  const target = useRef<HTMLDivElement>(null)
  const map = useRef<any>(null)
  const markers = useRef<any[]>([])
  const callback = useRef(onSelect)
  callback.current = onSelect
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let attempts = 0
    const detect = () => { if ((window as any).google?.maps?.Map) { setReady(true); return true } return ++attempts >= 40 }
    if (detect()) return
    const timer = window.setInterval(() => { if (detect()) window.clearInterval(timer) }, 250)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!ready || !target.current) return
    const google = (window as any).google
    map.current = new google.maps.Map(target.current, { center: { lat: 35.93, lng: 14.43 }, zoom: 10, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, gestureHandling: 'cooperative' })
    markers.current = places.filter(p => p.coordinates && p.key).map(place => {
      const marker = new google.maps.Marker({ map: map.current, position: { lat: place.coordinates![1], lng: place.coordinates![0] }, title: place.label, clickable: !disabled })
      marker.addListener('click', () => { if (!disabled) callback.current(place.id) })
      return { marker, id: place.id }
    })
    return () => { markers.current.forEach(({ marker }) => { google.maps.event.clearInstanceListeners(marker); marker.setMap(null) }); markers.current = []; map.current = null }
  }, [ready, places, disabled])
  useEffect(() => {
    const place = places.find(p => p.id === selected)
    if (place?.coordinates && map.current) { map.current.panTo({ lat: place.coordinates[1], lng: place.coordinates[0] }); map.current.setZoom(13) }
    for (const { marker, id } of markers.current) marker.setOpacity(id === selected ? 1 : 0.45)
  }, [selected, places, ready])
  return <div><div ref={target} className="h-56 rounded-lg bg-[#0f1521]" aria-label="Choose a locality pin on the map" />{!ready && <p className="mt-2 text-xs text-[#adb5c6]">Map preview unavailable. The locality selector below uses the same canonical pins.</p>}</div>
}

function SettingsEditor({ listing, data, onSaved, editState }: { listing: Listing; data: Queue; onSaved: (listing: Listing) => void; editState: React.MutableRefObject<{ dirty: boolean; busy: boolean }> }) {
  const [values, setValues] = useState<Settings>(() => structuredClone(listing.settings))
  const [tagsChecked, setTagsChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const update = (key: string, value: Settings[string]) => { setValues(v => ({ ...v, [key]: value })); setSaved('') }
  const selectedTags = (values.feature_tags || []) as string[]
  const place = data.localities.find(p => p.id === values.locality_id)
  const changed = Object.entries(values).some(([k, v]) => !equal(v, listing.settings[k])) || tagsChecked
  useEffect(() => {
    editState.current = { dirty: changed, busy }
    const protect = (event: BeforeUnloadEvent) => { if (changed || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => { window.removeEventListener('beforeunload', protect); editState.current = { dirty: false, busy: false } }
  }, [changed, busy, editState])
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved('')
    const patch: Record<string, unknown> = { updatedAt: listing.updatedAt }
    for (const [key, value] of Object.entries(values)) if (!equal(value, listing.settings[key])) patch[key] = value
    if (tagsChecked) patch.feature_tags = selectedTags
    try {
      const result = await crmJson(`nexus/properties/${listing.id}/settings`, 'PATCH', patch)
      setValues(structuredClone(result.listing.settings)); setTagsChecked(false); onSaved(result.listing)
      setSaved(Object.values(result.synchronization || {}).includes('needs_retry') ? 'Settings saved. A downstream refresh needs retrying.' : 'Settings saved. Map and Nexus facts refreshed.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save these settings.') }
    finally { setBusy(false) }
  }
  return <form onSubmit={save} className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-[#b8953f]">PROPERTY SETTINGS</p><h3 className="mt-1 text-2xl font-semibold">{listing.ref || `Listing ${listing.id}`}</h3><p className="mt-1 text-sm text-[#adb5c6]">{listing.town || 'Location to check'} · {listing.availability || 'Availability unknown'}</p></div><span className="rounded-full border border-white/15 px-3 py-1 text-xs">{listing.canEdit ? 'Editable' : 'Read only'}</span></div>
    {listing.reviewReasons.length > 0 && <div className="flex flex-wrap gap-2">{listing.reviewReasons.map(reason => <span key={reason} className="rounded-md bg-amber-400/10 px-2 py-1 text-xs text-amber-200">{reason}</span>)}</div>}
    <fieldset disabled={!listing.canEdit || busy} className="space-y-6 disabled:opacity-80">
      <section><h4 className="mb-3 font-semibold">Home Fit</h4><div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {numberFields.map(([key, label]) => <label key={key} className="space-y-1 text-xs text-[#adb5c6]"><span>{label}</span><input className={input} type="number" min={key === 'bedrooms' || key === 'bathrooms' ? 0 : 1} max={key === 'bedrooms' || key === 'bathrooms' ? 30 : undefined} step={key === 'bedrooms' || key === 'bathrooms' ? 1 : 'any'} value={values[key] == null ? '' : String(values[key])} placeholder="Unknown" onChange={e => update(key, e.target.value === '' ? null : Number(e.target.value))} /></label>)}
        <label className="space-y-1 text-xs text-[#adb5c6]"><span>Property type</span><select className={input} value={String(values.property_type || '')} onChange={e => update('property_type', e.target.value || null)}><option value="">Unknown</option>{data.propertyTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
      </div></section>
      <section className="space-y-3"><h4 className="flex items-center gap-2 font-semibold"><MapPin size={16} /> Location & map pin</h4>
        <LocalityMap places={data.localities} selected={values.locality_id as number | null} onSelect={id => update('locality_id', id)} disabled={!listing.canEdit || busy} />
        <label className="block space-y-1 text-xs text-[#adb5c6]"><span>Canonical locality</span><select className={input} value={values.locality_id == null ? '' : String(values.locality_id)} onChange={e => update('locality_id', e.target.value ? Number(e.target.value) : null)}><option value="">Location unknown</option>{data.localities.filter(p => p.key && p.coordinates).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <p className="text-xs leading-5 text-[#adb5c6]">{place ? `${place.label} · ${place.coordinates?.[1].toFixed(4)}, ${place.coordinates?.[0].toFixed(4)}` : 'No pin until a locality is selected.'}<br />The pin marks the locality, not the building or apartment. Saving a locality protects your correction from automatic backfills.</p>
      </section>
      <section><h4 className="mb-3 font-semibold">Permissions & confirmed features</h4><div className="grid grid-cols-2 gap-3 md:grid-cols-3">{permissionFields.map(([key, label]) => <label key={key} className="space-y-1 text-xs text-[#adb5c6]"><span>{label}</span><select className={input} value={values[key] === true ? 'yes' : values[key] === false ? 'no' : ''} onChange={e => update(key, e.target.value === '' ? null : e.target.value === 'yes')}><option value="">Unknown</option><option value="yes">Yes</option><option value="no">No</option></select></label>)}</div></section>
      <section><h4 className="mb-3 font-semibold">Availability</h4><div className="grid grid-cols-2 gap-3"><label className="space-y-1 text-xs text-[#adb5c6]"><span>Status</span><select className={input} value={String(values.available_status || 'pending_check')} onChange={e => update('available_status', e.target.value)}>{['available','available_confirmed','upcoming','pending_check','not_available','rented'].map(s => <option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></label>{[['available_date', 'Available from'], ['available_until', 'Available until'], ['viewings_from_date', 'Viewings from']].map(([key, label]) => <label key={key} className="space-y-1 text-xs text-[#adb5c6]"><span>{label}</span><input className={input} type="date" value={String(values[key] || '')} onChange={e => update(key, e.target.value || null)} /></label>)}</div><div className="mt-3 flex flex-wrap gap-4">{[['long_let', 'Long let'], ['winter_let', 'Winter let'], ['short_let', 'Short let']].map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(values.rental_modes as string[]).includes(key)} onChange={e => update('rental_modes', e.target.checked ? [...(values.rental_modes as string[]), key] : (values.rental_modes as string[]).filter(k => k !== key))} />{label}</label>)}</div></section>
      <section><div className="mb-3 flex items-center justify-between"><h4 className="font-semibold">Features → Nexus pillars</h4><span className="text-xs text-[#adb5c6]">{listing.tagStatus.toLowerCase()}</span></div><p className="mb-3 text-xs text-[#adb5c6]">Select only confirmed features. Unselected features remain unstated. Image suggestions do not count as facts.</p>
        <div className="grid gap-2 sm:grid-cols-2">{data.editableTags.map(key => { const tag = taxonomy.features.find(f => f.key === key); return <label key={key} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${selectedTags.includes(key) ? 'border-[#b8953f]/60 bg-[#b8953f]/10' : 'border-white/10'}`}><input type="checkbox" className="mt-1 accent-[#b8953f]" checked={selectedTags.includes(key)} onChange={e => { update('feature_tags', e.target.checked ? [...selectedTags, key] : selectedTags.filter(t => t !== key)); setTagsChecked(true) }} /><span><span className="block text-sm">{tag?.label || key}</span><span className="mt-1 block text-[11px] text-[#adb5c6]">{tag?.pillars.map(p => taxonomy.pillars.find(x => x.key === p)?.label).join(' · ')}</span></span></label> })}</div>
        {listing.tagStatus === 'UNCHECKED' && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={tagsChecked} onChange={e => setTagsChecked(e.target.checked)} />I have checked the feature information.</label>}
      </section>
    </fieldset>
    <details className="rounded-lg border border-white/10 p-3"><summary className="cursor-pointer text-sm">All eight Nexus pillars</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{taxonomy.pillars.map(p => <div key={p.key}><strong className="text-sm">{p.label}</strong><p className="text-xs text-[#adb5c6]">{p.description}</p></div>)}</div><p className="mt-3 text-xs text-[#adb5c6]">Property facts, area facts, user preferences and derived results are separate. Missing evidence never becomes a score of zero.</p></details>
    {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
    {saved && <p role="status" className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-200">{saved}</p>}
    <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-white/10 bg-[#141b29] py-4"><button className={`${button} bg-[#b8953f] font-semibold text-[#151c2c]`} disabled={!listing.canEdit || busy || !changed} type="submit"><Check size={16} />{busy ? 'Saving…' : 'Save settings'}</button>{listing.canEdit && <a className={`${button} text-[#edeae1]`} href={`${typeof window !== 'undefined' && window.location.hostname.startsWith('crm.') ? '' : '/crm'}/property/${listing.id}`} target="_blank" rel="noreferrer">All CRM settings ↗</a>}<span className="text-xs text-[#adb5c6]">Corrections are recorded. This editor sends no messages.</span></div>
  </form>
}

export function NexusCheckWorkbench({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const editState = useRef({ dirty: false, busy: false })
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const navigate = (action: () => void) => { if (editState.current.busy) return; if (editState.current.dirty) setPendingNavigation(() => action); else action() }
  const [data, setData] = useState<Queue | null>(null)
  const [selected, setSelected] = useState<Listing | null>(null)
  const [all, setAll] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [workspace, setWorkspace] = useState<'properties' | 'places'>('properties')
  const reload = useCallback(() => setRevision(r => r + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('')
      try { const result = await crmFetch(`nexus/open-to-check?all=${all ? '1' : '0'}&q=${encodeURIComponent(query)}&offset=${offset}`, { signal: controller.signal }); if (!controller.signal.aborted) setData(result) }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the review list.') }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [all, query, offset, revision])
  const saved = (listing: Listing) => { setSelected(listing); reload(); onChanged() }
  return <Dialog open onOpenChange={open => { if (!open) navigate(onClose) }}><DialogContent className="flex h-[92dvh] w-[min(1280px,96vw)] max-w-[96vw] flex-col gap-0 overflow-hidden border-white/15 bg-[#141b29] p-0 text-[#edeae1] sm:max-w-[1280px]">
    <header className="shrink-0 border-b border-white/10 px-5 py-4 pr-12"><DialogTitle className="flex items-center gap-2"><Settings2 size={20} className="text-[#b8953f]" /> OPEN TO CHECK</DialogTitle><DialogDescription className="mt-2 text-[#adb5c6]">Review inventory facts and build the internal Nexus Places Intelligence map.</DialogDescription><nav className="mt-4 flex gap-2" aria-label="Open to Check workspace"><button className={`${button} ${workspace==='properties'?'border-[#b8953f] bg-[#b8953f]/10 text-[#f4d58b]':''}`} onClick={()=>navigate(()=>setWorkspace('properties'))}>Property settings</button><button className={`${button} ${workspace==='places'?'border-[#b8953f] bg-[#b8953f]/10 text-[#f4d58b]':''}`} onClick={()=>navigate(()=>setWorkspace('places'))}><MapPin size={15}/>Places Intelligence</button></nav></header>
    {pendingNavigation && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-300/30 bg-amber-300/10 px-5 py-3"><p className="flex-1 text-sm">You have unsaved property settings.</p><button className={button} onClick={() => setPendingNavigation(null)}>Keep editing</button><button className={button} onClick={() => { const action = pendingNavigation; setPendingNavigation(null); editState.current = { dirty: false, busy: false }; action() }}>Discard changes and continue</button></div>}
    {workspace==='places'?<NexusPlaceEditor/>:<div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_1fr]">
      <aside className={`${selected ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-white/10`}>
        <div className="space-y-3 border-b border-white/10 p-4"><label className="flex items-center gap-2"><Search size={16} /><input aria-label="Search listing reference or locality" className={input} placeholder="Reference or locality" value={query} onChange={e => { setQuery(e.target.value); setOffset(0) }} /></label><div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={all} onChange={e => { setAll(e.target.checked); setOffset(0) }} />All properties</label><button className={button} aria-label="Refresh review list" onClick={() => { navigate(() => { setSelected(null); reload() }) }}><RefreshCw size={14} /></button></div><p aria-live="polite" className="text-xs text-[#adb5c6]">{data ? `${data.reviewTotal} need checking · ${data.total} in this view` : 'Loading inventory…'}</p></div>
        {error && <p role="alert" className="p-4 text-sm text-red-200">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={loading}>{data?.listings.map(row => <button key={row.id} className={`mb-2 w-full rounded-lg border p-3 text-left ${row.id === selected?.id ? 'border-[#b8953f] bg-[#b8953f]/10' : 'border-white/10 hover:bg-white/5'}`} onClick={() => { if (row.id !== selected?.id) navigate(() => setSelected(row)) }}><strong className="text-sm">{row.ref || `Listing ${row.id}`}</strong><span className="mt-1 block text-xs text-[#adb5c6]">{row.town || 'Location unknown'} · {row.settings.bedrooms ?? '?'} beds / {row.settings.bathrooms ?? '?'} baths</span><span className="mt-2 block text-xs text-amber-200">{row.reviewReasons.join(' · ') || 'Core facts complete'}</span></button>)}{!loading && !error && !data?.listings.length && <p className="p-4 text-sm text-[#adb5c6]">No listings in this view.</p>}</div>
        <div className="flex justify-between border-t border-white/10 p-3"><button className={button} disabled={offset === 0 || loading} onClick={() => setOffset(o => Math.max(0, o - 100))}>Previous</button><button className={button} disabled={!data || offset + 100 >= data.total || loading} onClick={() => setOffset(o => o + 100)}>Next</button></div>
      </aside>
      <main className={`${selected ? 'block' : 'hidden md:block'} min-h-0 overflow-y-auto p-5 md:p-7`}>{selected && data ? <><button className={`${button} mb-4 md:hidden`} onClick={() => { navigate(() => setSelected(null)) }}>← Review list</button><SettingsEditor key={selected.id} listing={selected} data={data} onSaved={saved} editState={editState} /></> : <div className="flex h-full min-h-48 items-center justify-center text-center text-[#adb5c6]"><p>Choose a listing to review its facts,<br />Nexus pillars and map position.</p></div>}</main>
    </div>}
  </DialogContent></Dialog>
}
