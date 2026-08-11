'use client'
// ============================================================================
// /schedule-board — the internal availability + location board.
//
// Filter row → Google Map → card grid, all three driven by one filter state
// that is mirrored into the URL so a search is bookmarkable and shareable.
//
// Data comes from /api/crm/schedule-board/* (see routes/crmScheduleBoard.js),
// which is firewalled: no street, no apt, no owner. The exact address is
// reduced server-side to `hasViewingLocation`, which is what enables the
// "Request Viewing-Location" button.
// ============================================================================
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { crmFetch, crmJson } from '@/lib/crm/api'
import { CrmProvider, CrmShell, A, AD, AB, F, FM, useCrm, useIsMobile } from '@/lib/crm/ui'
import { TOWNS, townKey, townLabel, townCoord, spread } from '@/lib/crm/towns'

const GREEN = '#2f6f57'
const GREEN_SOFT = 'rgba(47,111,87,0.10)'
const CARD = '#FFFDFA'
// The Maps key normally arrives from the backend (GET schedule-board/config),
// which hands it to logged-in agents only. A NEXT_PUBLIC_GOOGLE_MAPS_KEY still
// wins if one is set, but it would be inlined into a publicly downloadable
// chunk — and this repo is public — so the served key is the better default.
const BUNDLED_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || ''

type Listing = {
  id: number; ref: string; town: string | null; subLocation: string | null
  type: string | null; beds: number | null; baths: number | null
  sizeSqm: number | null; price: number | null; salePrice: number | null
  shortlet: boolean; availableStatus: string | null; availableDate: string | null
  viewingStatus: string | null; hasViewingLocation: boolean; exclusive: boolean
  images: string[]; imageCount: number
  listedBy: { id: number | null; displayName: string | null; colorHex: string | null }
  isMine: boolean
}

type Filters = {
  beds: string; baths: string; min: string; max: string; type: string; towns: string[]
}
const EMPTY: Filters = { beds: '', baths: '', min: '', max: '', type: '', towns: [] }

type Rect = { north: number; south: number; east: number; west: number }

// The drawn area travels in the URL as rect=north,south,east,west so a shared
// link restores the box, not just the filter row.
function rectToParam(r: Rect): string {
  return [r.north, r.south, r.east, r.west].map(n => n.toFixed(5)).join(',')
}
function parseRect(s: string | null): Rect | null {
  if (!s) return null
  const p = s.split(',').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) return null
  const [north, south, east, west] = p
  if (north <= south || east <= west) return null
  return { north, south, east, west }
}

// ── page ────────────────────────────────────────────────────────────────────
export default function ScheduleBoardPage() {
  return <CrmProvider><Board /></CrmProvider>
}

function Board() {
  const router = useRouter()
  const params = useSearchParams()
  const isMobile = useIsMobile()
  const { me } = useCrm()

  // Filters initialise from the URL so a shared link restores the search.
  const [f, setF] = useState<Filters>(() => ({
    beds: params.get('beds') || '',
    baths: params.get('baths') || '',
    min: params.get('min') || '',
    max: params.get('max') || '',
    type: params.get('type') || '',
    towns: (params.get('towns') || '').split(',').map(s => s.trim()).filter(Boolean),
  }))
  const [rect, setRect] = useState<Rect | null>(() => parseRect(params.get('rect')))
  const [rows, setRows] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [focusRef, setFocusRef] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const showToast = useCallback((kind: 'ok' | 'err' | 'info', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(t => (t && t.text === text ? null : t)), 5200)
  }, [])

  // ── URL mirror ────────────────────────────────────────────────────────────
  useEffect(() => {
    const q = new URLSearchParams()
    if (f.beds) q.set('beds', f.beds)
    if (f.baths) q.set('baths', f.baths)
    if (f.min) q.set('min', f.min)
    if (f.max) q.set('max', f.max)
    if (f.type) q.set('type', f.type)
    if (f.towns.length) q.set('towns', f.towns.join(','))
    if (rect) q.set('rect', rectToParam(rect))
    const qs = q.toString()
    router.replace(qs ? `/schedule-board?${qs}` : '/schedule-board', { scroll: false })
  }, [f, rect, router])

  // ── fetch ─────────────────────────────────────────────────────────────────
  // Server-side filters are the numeric/enum ones. Town selection is applied
  // client-side because the canonical-town folding (Gzira/Gżira, five
  // spellings of St Paul's Bay) lives in the browser table, not in SQL.
  useEffect(() => {
    let alive = true
    setLoading(true)
    const q = new URLSearchParams()
    if (f.beds) q.set('beds', f.beds)
    if (f.baths) q.set('baths', f.baths)
    if (f.min) q.set('price_min', f.min)
    if (f.max) q.set('price_max', f.max)
    if (f.type) q.set('type', f.type)
    crmFetch(`schedule-board/listings?${q.toString()}`)
      .then(d => { if (!alive) return; setRows(d.listings || []); setErr(null) })
      .catch(e => { if (alive) setErr(e?.message || 'Could not load listings') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [f.beds, f.baths, f.min, f.max, f.type])

  // ── town index + positions ────────────────────────────────────────────────
  // Every listing gets a stable coordinate: town centre plus a deterministic
  // offset so listings in one village fan out instead of stacking.
  const positioned = useMemo(() => {
    const byTown: Record<string, Listing[]> = {}
    for (const r of rows) {
      const k = townKey(r.town) || '_unknown'
      ;(byTown[k] ||= []).push(r)
    }
    const out: Array<Listing & { lat: number | null; lng: number | null; tkey: string }> = []
    for (const [k, list] of Object.entries(byTown)) {
      const base = k === '_unknown' ? null : TOWNS[k]
      list.forEach((r, i) => {
        const p = base ? spread(base, i, list.length) : null
        out.push({ ...r, lat: p?.lat ?? null, lng: p?.lng ?? null, tkey: k })
      })
    }
    return out
  }, [rows])

  const townOptions = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of rows) {
      const k = townKey(r.town)
      if (k) counts[k] = (counts[k] || 0) + 1
    }
    return Object.entries(counts)
      .map(([k, n]) => ({ key: k, label: TOWNS[k].label, n }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
  }, [rows])

  // ── visible set: filters ∩ town selection ∩ drawn rectangle ───────────────
  const visible = useMemo(() => {
    return positioned.filter(r => {
      if (f.towns.length && !f.towns.includes(r.tkey)) return false
      if (rect) {
        if (r.lat == null || r.lng == null) return false
        if (r.lat > rect.north || r.lat < rect.south) return false
        if (r.lng > rect.east || r.lng < rect.west) return false
      }
      return true
    })
  }, [positioned, f.towns, rect])

  const mineCount = visible.filter(r => r.isMine).length

  function toggleTown(k: string) {
    setF(s => ({ ...s, towns: s.towns.includes(k) ? s.towns.filter(x => x !== k) : [...s.towns, k] }))
  }
  function reset() { setF(EMPTY); setRect(null) }

  const onMarkerClick = useCallback((ref: string) => {
    setFocusRef(ref)
    const el = cardRefs.current[ref]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => setFocusRef(cur => (cur === ref ? null : cur)), 2400)
  }, [])

  // ── WhatsApp actions ──────────────────────────────────────────────────────
  // Fire-and-forget: the button never blocks, the result arrives as a toast.
  async function act(kind: 'request-availability' | 'request-location' | 'comment', r: Listing) {
    let note: string | null = null
    if (kind === 'comment') {
      note = window.prompt(`Message to ${r.listedBy.displayName || 'the listing agent'} about #${r.ref}:`)
      if (!note || !note.trim()) return
    }
    showToast('info', kind === 'request-availability' && r.isMine
      ? `Contacting the owner of #${r.ref}…`
      : `Sending to ${r.listedBy.displayName || 'listing agent'}…`)
    try {
      const d = await crmJson(`schedule-board/listings/${encodeURIComponent(r.ref)}/${kind}`, 'POST', { note })
      if (d.status === 'dry_run') {
        showToast('info', `${d.message} (Fall A is not armed yet)`)
      } else {
        showToast('ok', d.message || `Sent for #${r.ref}.`)
      }
    } catch (e: any) {
      const d = e?.data || {}
      showToast('err', d.message || d.error || e?.message || 'Request failed')
    }
  }

  // ── filter bar ────────────────────────────────────────────────────────────
  const filterBar = (
    <>
      <Seg label="Beds" value={f.beds} onChange={v => setF(s => ({ ...s, beds: v }))}
        opts={[['', 'Any'], ['1', '1+'], ['2', '2+'], ['3', '3+']]} />
      <Seg label="Baths" value={f.baths} onChange={v => setF(s => ({ ...s, baths: v }))}
        opts={[['', 'Any'], ['1', '1+'], ['2', '2+']]} />
      <Num placeholder="Min €" value={f.min} onChange={v => setF(s => ({ ...s, min: v }))} />
      <Num placeholder="Max €" value={f.max} onChange={v => setF(s => ({ ...s, max: v }))} />
      <Seg label="Type" value={f.type} onChange={v => setF(s => ({ ...s, type: v }))}
        opts={[['', 'Any'], ['apartment', 'Apartment'], ['penthouse', 'Penthouse'], ['house', 'House'], ['maisonette', 'Maisonette']]} />
      {(f.beds || f.baths || f.min || f.max || f.type || f.towns.length || rect) && (
        <button onClick={reset} style={{ ...btn, background: 'transparent', color: '#999', border: '1px solid #E5E1D8' }}>
          Reset
        </button>
      )}
      <span style={{ marginLeft: 'auto', fontFamily: FM, fontSize: 11, color: '#AAA', whiteSpace: 'nowrap' }}>
        {loading ? 'loading…' : `${visible.length} listing${visible.length === 1 ? '' : 's'}`}
        {mineCount > 0 && <span style={{ color: GREEN, fontWeight: 600 }}> · {mineCount} yours</span>}
      </span>
    </>
  )

  return (
    <CrmShell
      title="Schedule Board"
      subtitle={me ? 'Availability and viewing locations across the whole team' : undefined}
      filterBar={filterBar}
    >
      <div style={{ padding: isMobile ? 14 : 22 }}>
        {err && <Notice text={err} />}

        {/* villages */}
        {townOptions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {townOptions.map(t => {
              const on = f.towns.includes(t.key)
              return (
                <button key={t.key} onClick={() => toggleTown(t.key)} style={{
                  ...chip,
                  background: on ? AD : '#FFF',
                  borderColor: on ? AB : '#E9E5DC',
                  color: on ? A : '#666',
                  fontWeight: on ? 700 : 500,
                }}>
                  {t.label} <span style={{ fontFamily: FM, fontSize: 10, opacity: 0.6 }}>{t.n}</span>
                </button>
              )
            })}
          </div>
        )}

        <MapPanel
          items={visible}
          rect={rect}
          onRect={setRect}
          onMarkerClick={onMarkerClick}
          selectedTowns={f.towns}
          isMobile={isMobile}
        />

        {/* cards */}
        <div style={{
          display: 'grid', gap: 14, marginTop: 18,
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill,minmax(268px,1fr))',
        }}>
          {visible.map(r => (
            <Card
              key={r.ref}
              r={r}
              focused={focusRef === r.ref}
              innerRef={el => { cardRefs.current[r.ref] = el }}
              onOpen={() => setDetail(r.ref)}
              onAct={act}
            />
          ))}
        </div>

        {!loading && !visible.length && !err && (
          <div style={{ padding: '48px 0', textAlign: 'center', color: '#BBB', fontSize: 13 }}>
            Nothing matches this search.
          </div>
        )}
      </div>

      {detail && <DetailModal refId={detail} onClose={() => setDetail(null)} onAct={act} />}
      {toast && <Toast kind={toast.kind} text={toast.text} onClose={() => setToast(null)} />}
    </CrmShell>
  )
}

// ── Google map ──────────────────────────────────────────────────────────────
// Loaded lazily via the official loader script.
//
// The rectangle tool is hand-rolled from map mouse events. google.maps.drawing
// .DrawingManager was REMOVED in Maps JavaScript API 3.65 — asking for it does
// not degrade, it throws, and an uncaught throw here takes the whole board down
// with it. google.maps.Rectangle is still supported, so the box is drawn by
// anchoring on mousedown and resizing until mouseup.
// There is exactly one rectangle at a time and it can be cleared and redrawn.
function MapPanel({ items, rect, onRect, onMarkerClick, selectedTowns, isMobile }: {
  items: Array<Listing & { lat: number | null; lng: number | null; tkey: string }>
  rect: Rect | null
  onRect: (r: Rect | null) => void
  onMarkerClick: (ref: string) => void
  selectedTowns: string[]
  isMobile: boolean
}) {
  const divRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const shapeRef = useRef<any>(null)
  const areaRef = useRef<any[]>([])
  const anchorRef = useRef<any>(null)
  const overlayRef = useRef<any>(null)
  const [ready, setReady] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  // null = still asking the backend, '' = there is no key
  const [mapsKey, setMapsKey] = useState<string | null>(BUNDLED_MAPS_KEY || null)

  useEffect(() => {
    if (mapsKey !== null) return
    let alive = true
    crmFetch('schedule-board/config')
      .then(d => { if (alive) setMapsKey((d && d.mapsKey) || '') })
      .catch(() => { if (alive) setMapsKey('') })
    return () => { alive = false }
  }, [mapsKey])

  // load the script once the key is known
  useEffect(() => {
    if (mapsKey === null) return
    if (!mapsKey) { setLoadErr('no-key'); return }
    const w = window as any
    if (w.google?.maps?.Map) { setReady(true); return }
    const existing = document.getElementById('gmaps-js') as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => setReady(true))
      existing.addEventListener('error', () => setLoadErr('load-failed'))
      return
    }
    const s = document.createElement('script')
    s.id = 'gmaps-js'
    s.async = true
    // No `libraries=drawing`: that library's DrawingManager is gone since 3.65
    // and the rectangle below is drawn from pointer events instead.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}`
    s.onload = () => setReady(true)
    s.onerror = () => setLoadErr('load-failed')
    document.head.appendChild(s)
  }, [mapsKey])

  // init map
  useEffect(() => {
    if (!ready || !divRef.current || mapRef.current) return
    const g = (window as any).google
    mapRef.current = new g.maps.Map(divRef.current, {
      center: { lat: 35.9042, lng: 14.4600 },
      zoom: isMobile ? 10 : 11,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      styles: [
        { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] },
      ],
    })
    // An empty OverlayView exists purely for its projection: it is the only
    // supported way to turn a pixel inside the map container into a coordinate,
    // which is what the area tool below needs.
    const ov = new g.maps.OverlayView()
    ov.onAdd = () => {}
    ov.draw = () => {}
    ov.onRemove = () => {}
    ov.setMap(mapRef.current)
    overlayRef.current = ov
  }, [ready, isMobile])

  // ── the area tool ─────────────────────────────────────────────────────────
  // Armed by the "Draw area" button. While armed the map stops panning, so a
  // drag draws the box instead of moving Malta. A drag too small to be a real
  // selection counts as "changed my mind" and clears instead of filtering
  // everything away.
  //
  // The events are DOM pointer events on the map container, NOT map events:
  // google.maps.Map fires click, mousemove and the drag events, but it has no
  // mousedown or mouseup, so a rectangle tracked through map listeners never
  // starts. Pointer events also cover touch and pen for free. Pixels become
  // coordinates through the OverlayView projection created above.
  useEffect(() => {
    if (!ready || !mapRef.current || !divRef.current) return
    const g = (window as any).google
    const map = mapRef.current
    const div = divRef.current

    if (!drawing) {
      map.setOptions({ draggable: true, draggableCursor: null })
      div.style.touchAction = ''
      return
    }
    map.setOptions({ draggable: false, draggableCursor: 'crosshair' })
    div.style.touchAction = 'none'   // otherwise a touch drag scrolls the page

    const toLatLng = (ev: PointerEvent) => {
      const proj = overlayRef.current && overlayRef.current.getProjection()
      if (!proj) return null
      const r = div.getBoundingClientRect()
      return proj.fromContainerPixelToLatLng(
        new g.maps.Point(ev.clientX - r.left, ev.clientY - r.top))
    }
    const boundsOf = (a: any, b: any) => new g.maps.LatLngBounds(
      { lat: Math.min(a.lat(), b.lat()), lng: Math.min(a.lng(), b.lng()) },
      { lat: Math.max(a.lat(), b.lat()), lng: Math.max(a.lng(), b.lng()) },
    )

    const onDown = (ev: PointerEvent) => {
      const ll = toLatLng(ev)
      if (!ll) return
      ev.preventDefault()
      anchorRef.current = ll
      if (shapeRef.current) { shapeRef.current.setMap(null); shapeRef.current = null }
      shapeRef.current = new g.maps.Rectangle({
        map,
        bounds: boundsOf(ll, ll),
        fillColor: A, fillOpacity: 0.10, strokeColor: A, strokeWeight: 1.5, clickable: false,
      })
    }
    const onMove = (ev: PointerEvent) => {
      if (!anchorRef.current || !shapeRef.current) return
      const ll = toLatLng(ev)
      if (!ll) return
      shapeRef.current.setBounds(boundsOf(anchorRef.current, ll))
    }
    const onUp = (ev: PointerEvent) => {
      const anchor = anchorRef.current
      anchorRef.current = null
      if (!anchor) return
      const ll = toLatLng(ev) || anchor
      const b = boundsOf(anchor, ll)
      const ne = b.getNorthEast(), sw = b.getSouthWest()
      const tiny = Math.abs(ne.lat() - sw.lat()) < 0.0008 && Math.abs(ne.lng() - sw.lng()) < 0.0008
      setDrawing(false)
      if (tiny) {
        if (shapeRef.current) { shapeRef.current.setMap(null); shapeRef.current = null }
        onRect(null)
        return
      }
      onRect({ north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng() })
    }

    // Capture phase, because the map's own panes sit inside this container and
    // swallow some events on the way up. mouseup goes on the window so a
    // release outside the map still finishes the box.
    div.addEventListener('pointerdown', onDown, true)
    div.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    return () => {
      div.removeEventListener('pointerdown', onDown, true)
      div.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      div.style.touchAction = ''
    }
  }, [ready, drawing, onRect])

  // A rect restored from a shared link has no rectangle on the map yet — draw
  // it once so the box is visible, not just silently filtering.
  useEffect(() => {
    if (!ready || !mapRef.current || !rect || shapeRef.current) return
    const g = (window as any).google
    shapeRef.current = new g.maps.Rectangle({
      map: mapRef.current,
      bounds: { north: rect.north, south: rect.south, east: rect.east, west: rect.west },
      fillColor: A, fillOpacity: 0.10, strokeColor: A, strokeWeight: 1.5, clickable: false,
    })
    mapRef.current.fitBounds(shapeRef.current.getBounds())
  }, [ready, rect])

  // markers
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = (window as any).google
    markersRef.current.forEach(m => m.setMap(null))
    markersRef.current = []
    for (const it of items) {
      if (it.lat == null || it.lng == null) continue
      const colour = it.isMine ? GREEN : A
      const m = new g.maps.Marker({
        position: { lat: it.lat, lng: it.lng },
        map: mapRef.current,
        title: `#${it.ref} · ${it.price ? '€' + it.price.toLocaleString() : 'price n/a'}`,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: colour,
          fillOpacity: 0.95,
          strokeColor: '#FFFDFA',
          strokeWeight: 2,
        },
      })
      m.addListener('click', () => onMarkerClick(it.ref))
      markersRef.current.push(m)
    }
  }, [ready, items, onMarkerClick])

  // soft highlight over the selected villages
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = (window as any).google
    areaRef.current.forEach(c => c.setMap(null))
    areaRef.current = []
    for (const k of selectedTowns) {
      const t = TOWNS[k]
      if (!t) continue
      areaRef.current.push(new g.maps.Circle({
        map: mapRef.current,
        center: { lat: t.lat, lng: t.lng },
        radius: 900,
        fillColor: A, fillOpacity: 0.10,
        strokeColor: A, strokeOpacity: 0.35, strokeWeight: 1,
        clickable: false,
      }))
    }
  }, [ready, selectedTowns])

  function startDraw() {
    if (!mapRef.current) return
    if (shapeRef.current) { shapeRef.current.setMap(null); shapeRef.current = null }
    setDrawing(true)
  }
  function clearDraw() {
    if (shapeRef.current) { shapeRef.current.setMap(null); shapeRef.current = null }
    setDrawing(false)
    onRect(null)
  }

  const height = isMobile ? 260 : 420

  if (loadErr === 'no-key') {
    return (
      <div style={{ ...mapBox, height, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20 }}>
        <div>
          <div style={{ fontFamily: F, fontWeight: 700, color: '#8A6412', fontSize: 14 }}>Map needs a Google Maps key</div>
          <div style={{ fontSize: 12, marginTop: 6, maxWidth: 420, lineHeight: 1.5, color: '#999' }}>
            Set <code style={{ fontFamily: FM }}>SCHEDULE_BOARD_MAPS_KEY</code> in the backend
            <code style={{ fontFamily: FM }}> .env</code> and restart it — no frontend deploy needed.
            Filters, villages and cards below all work without it.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <div ref={divRef} style={{ ...mapBox, height }} />
      {!ready && !loadErr && (
        <div style={{ ...mapBox, height, position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#BBB', fontSize: 12 }}>
          loading map…
        </div>
      )}
      {loadErr === 'load-failed' && (
        <div style={{ ...mapBox, height, position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#B91C1C', fontSize: 12, textAlign: 'center', padding: 16 }}>
          Google Maps failed to load. Check the API key restrictions and that Maps JavaScript API is enabled.
        </div>
      )}
      {ready && (
        <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 6 }}>
          <button onClick={startDraw} style={{ ...btn, background: drawing ? A : '#FFF', color: drawing ? '#FFF' : '#444', boxShadow: '0 1px 4px rgba(0,0,0,0.16)', border: 'none' }}>
            {drawing ? 'Draw a box…' : '▭ Draw area'}
          </button>
          {rect && (
            <button onClick={clearDraw} style={{ ...btn, background: '#FFF', color: '#444', boxShadow: '0 1px 4px rgba(0,0,0,0.16)', border: 'none' }}>
              ✕ Clear area
            </button>
          )}
        </div>
      )}
      {ready && (
        <div style={{ position: 'absolute', bottom: 10, left: 10, display: 'flex', gap: 12, background: 'rgba(255,253,250,0.94)', padding: '6px 10px', borderRadius: 8, fontSize: 10, color: '#666', boxShadow: '0 1px 4px rgba(0,0,0,0.10)' }}>
          <Dot c={GREEN} /> yours <Dot c={A} /> team
        </div>
      )}
    </div>
  )
}

const Dot = ({ c }: { c: string }) => (
  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, marginRight: 3 }} />
)

// ── card ────────────────────────────────────────────────────────────────────
function Card({ r, focused, innerRef, onOpen, onAct }: {
  r: Listing
  focused: boolean
  innerRef: (el: HTMLDivElement | null) => void
  onOpen: () => void
  onAct: (kind: 'request-availability' | 'request-location' | 'comment', r: Listing) => void
}) {
  const status = r.availableStatus === 'available' ? { c: GREEN, t: 'available' }
    : r.availableStatus === 'rented' ? { c: '#B91C1C', t: 'rented' }
    : { c: '#C9C4B8', t: 'unknown' }

  return (
    <div
      ref={innerRef}
      style={{
        background: CARD,
        borderRadius: 14,
        overflow: 'hidden',
        border: focused ? `2px solid ${A}` : `1px solid ${r.isMine ? 'rgba(47,111,87,0.28)' : '#EDE9E0'}`,
        boxShadow: focused ? '0 6px 22px rgba(212,137,26,0.20)' : '0 1px 3px rgba(0,0,0,0.05)',
        transition: 'box-shadow 0.18s, border-color 0.18s',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div onClick={onOpen} style={{ cursor: 'pointer', position: 'relative', height: 150, background: '#F1EEE7' }}>
        {r.images[0]
          ? <img src={r.images[0]} alt={`#${r.ref}`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#CCC', fontSize: 11 }}>no photo</div>}
        {r.isMine && (
          <span style={{ position: 'absolute', top: 9, left: 9, background: GREEN, color: '#FFF', fontSize: 9, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', padding: '3px 7px', borderRadius: 5 }}>
            Yours
          </span>
        )}
        {r.imageCount > 1 && (
          <span style={{ position: 'absolute', bottom: 9, right: 9, background: 'rgba(0,0,0,0.55)', color: '#FFF', fontSize: 10, fontFamily: FM, padding: '2px 6px', borderRadius: 4 }}>
            {r.imageCount}
          </span>
        )}
      </div>

      <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span onClick={onOpen} style={{ fontFamily: FM, fontSize: 12, fontWeight: 500, color: A, cursor: 'pointer' }}>#{r.ref}</span>
          <span style={{ fontFamily: FM, fontSize: 14, fontWeight: 500, color: '#0F0F0F' }}>
            {r.price ? `€${r.price.toLocaleString()}` : r.salePrice ? `€${r.salePrice.toLocaleString()}` : '—'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: status.c, flexShrink: 0 }} title={status.t} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{townLabel(r.town)}</span>
        </div>

        <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
          {[r.beds != null ? `${r.beds} bed` : null, r.baths != null ? `${r.baths} bath` : null, r.type]
            .filter(Boolean).join(' · ')}
        </div>

        <div style={{ fontSize: 10, color: '#B5AFA2', marginTop: 8, marginBottom: 10 }}>
          Listed by {r.listedBy.displayName || 'unassigned'}
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {r.isMine ? (
            <button onClick={() => onAct('request-availability', r)} style={{ ...btn, background: GREEN, color: '#FFF', border: 'none', flex: 1 }}>
              Ask owner
            </button>
          ) : (
            <>
              <button onClick={() => onAct('request-availability', r)} style={{ ...btn, background: A, color: '#FFF', border: 'none', flex: 1 }}>
                Availability
              </button>
              {!r.hasViewingLocation && (
                <button onClick={() => onAct('request-location', r)} style={{ ...btn, background: '#FFF', color: '#7A6534', border: `1px solid ${AB}` }} title="Ask the listing agent where the viewing is">
                  Location
                </button>
              )}
              <button onClick={() => onAct('comment', r)} style={{ ...btn, background: '#FFF', color: '#888', border: '1px solid #E9E5DC' }}>
                Comment
              </button>
            </>
          )}
        </div>
        {r.isMine && (
          <div style={{ fontSize: 9.5, color: GREEN, marginTop: 6, opacity: 0.85 }}>
            Messages the owner directly via the last account in contact.
          </div>
        )}
      </div>
    </div>
  )
}

// ── detail modal ────────────────────────────────────────────────────────────
function DetailModal({ refId, onClose, onAct }: {
  refId: string
  onClose: () => void
  onAct: (kind: 'request-availability' | 'request-location' | 'comment', r: Listing) => void
}) {
  const [d, setD] = useState<any>(null)
  const [e, setE] = useState<string | null>(null)
  const [i, setI] = useState(0)

  useEffect(() => {
    let alive = true
    crmFetch(`schedule-board/listings/${encodeURIComponent(refId)}`)
      .then(x => { if (alive) setD(x) })
      .catch(x => { if (alive) setE(x?.message || 'Could not load listing') })
    return () => { alive = false }
  }, [refId])

  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(19,19,19,0.55)', zIndex: 200,
      display: 'grid', placeItems: 'center', padding: 16,
    }}>
      <div onClick={ev => ev.stopPropagation()} style={{
        background: CARD, borderRadius: 16, maxWidth: 720, width: '100%',
        maxHeight: '88vh', overflowY: 'auto', fontFamily: F,
        boxShadow: '0 18px 60px rgba(0,0,0,0.30)',
      }}>
        {e && <div style={{ padding: 26 }}><Notice text={e} /></div>}
        {!d && !e && <div style={{ padding: 44, textAlign: 'center', color: '#BBB', fontSize: 12 }}>loading…</div>}
        {d && (
          <>
            <div style={{ position: 'relative', height: 300, background: '#F1EEE7' }}>
              {d.images?.length
                ? <img src={d.images[i]} alt={`#${d.ref}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                : <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#CCC', fontSize: 12 }}>no photos</div>}
              <button onClick={onClose} style={{
                position: 'absolute', top: 12, right: 12, border: 'none', cursor: 'pointer',
                background: 'rgba(0,0,0,0.55)', color: '#FFF', width: 30, height: 30,
                borderRadius: '50%', fontSize: 15, lineHeight: 1,
              }}>×</button>
              {d.images?.length > 1 && (
                <div style={{ position: 'absolute', bottom: 10, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 5 }}>
                  {d.images.map((_: string, n: number) => (
                    <button key={n} onClick={() => setI(n)} style={{
                      width: 7, height: 7, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
                      background: n === i ? '#FFF' : 'rgba(255,255,255,0.45)',
                    }} />
                  ))}
                </div>
              )}
            </div>

            <div style={{ padding: '18px 22px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontFamily: FM, fontSize: 12, color: A }}>#{d.ref}</div>
                  <h2 style={{ margin: '3px 0 0', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
                    {townLabel(d.town)}
                  </h2>
                </div>
                <div style={{ fontFamily: FM, fontSize: 19, fontWeight: 500 }}>
                  {d.price ? `€${d.price.toLocaleString()}` : d.salePrice ? `€${d.salePrice.toLocaleString()}` : '—'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
                {[
                  d.beds != null && `${d.beds} bed`,
                  d.baths != null && `${d.baths} bath`,
                  d.type,
                  d.sizeSqm && `${d.sizeSqm} m²`,
                  d.availableStatus,
                  d.exclusive && 'exclusive',
                ].filter(Boolean).map((t: any, n: number) => (
                  <span key={n} style={{ ...chip, background: '#F6F4EF', borderColor: '#E9E5DC', color: '#666' }}>{t}</span>
                ))}
              </div>

              {d.description && (
                <p style={{ fontSize: 13, lineHeight: 1.65, color: '#444', whiteSpace: 'pre-wrap', margin: '0 0 14px' }}>
                  {d.description}
                </p>
              )}

              {!!d.features?.length && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                  {d.features.map((x: string, n: number) => (
                    <span key={n} style={{ ...chip, background: AD, borderColor: AB, color: '#7A6534' }}>{x}</span>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 11, color: '#B5AFA2', marginBottom: 14 }}>
                Listed by {d.listedBy?.displayName || 'unassigned'}
                {d.isMine && <span style={{ color: GREEN, fontWeight: 700 }}> · yours</span>}
                {' · '}
                {d.hasViewingLocation ? 'viewing location on file' : 'no viewing location on file'}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {d.isMine ? (
                  <button onClick={() => onAct('request-availability', d)} style={{ ...btn, background: GREEN, color: '#FFF', border: 'none' }}>
                    Ask the owner
                  </button>
                ) : (
                  <>
                    <button onClick={() => onAct('request-availability', d)} style={{ ...btn, background: A, color: '#FFF', border: 'none' }}>
                      Request availability
                    </button>
                    {!d.hasViewingLocation && (
                      <button onClick={() => onAct('request-location', d)} style={{ ...btn, background: '#FFF', color: '#7A6534', border: `1px solid ${AB}` }}>
                        Request viewing location
                      </button>
                    )}
                    <button onClick={() => onAct('comment', d)} style={{ ...btn, background: '#FFF', color: '#888', border: '1px solid #E9E5DC' }}>
                      Comment
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── small pieces ────────────────────────────────────────────────────────────
function Seg({ label, value, onChange, opts }: {
  label: string; value: string; onChange: (v: string) => void; opts: Array<[string, string]>
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: 9, color: '#BBB', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{label}</span>
      <div style={{ display: 'flex', border: '1px solid #E9E5DC', borderRadius: 7, overflow: 'hidden', background: '#FFF' }}>
        {opts.map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)} style={{
            border: 'none', cursor: 'pointer', padding: '5px 9px', fontSize: 11, fontFamily: F,
            background: value === v ? A : 'transparent',
            color: value === v ? '#FFF' : '#777',
            fontWeight: value === v ? 700 : 500,
          }}>{l}</button>
        ))}
      </div>
    </div>
  )
}

function Num({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      inputMode="numeric"
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      style={{
        width: 78, padding: '6px 9px', fontSize: 11, fontFamily: FM,
        border: '1px solid #E9E5DC', borderRadius: 7, background: '#FFF', color: '#444', outline: 'none',
      }}
    />
  )
}

function Notice({ text }: { text: string }) {
  return (
    <div style={{ background: '#FEE2E2', color: '#B91C1C', borderRadius: 10, padding: '10px 14px', fontSize: 12, fontWeight: 600, marginBottom: 14 }}>
      {text}
    </div>
  )
}

function Toast({ kind, text, onClose }: { kind: 'ok' | 'err' | 'info'; text: string; onClose: () => void }) {
  const bg = kind === 'ok' ? GREEN : kind === 'err' ? '#B91C1C' : '#131313'
  return (
    <div onClick={onClose} style={{
      position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
      background: bg, color: '#FFF', padding: '11px 18px', borderRadius: 10,
      fontSize: 12.5, fontFamily: F, fontWeight: 600, zIndex: 300, cursor: 'pointer',
      boxShadow: '0 8px 28px rgba(0,0,0,0.28)', maxWidth: '90vw', textAlign: 'center',
    }}>
      {text}
    </div>
  )
}

const btn: React.CSSProperties = {
  padding: '6px 11px', borderRadius: 7, fontSize: 11, fontFamily: F,
  fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
}
const chip: React.CSSProperties = {
  padding: '4px 9px', borderRadius: 999, fontSize: 11, fontFamily: F,
  border: '1px solid', cursor: 'pointer', background: '#FFF',
}
const mapBox: React.CSSProperties = {
  width: '100%', borderRadius: 14, overflow: 'hidden',
  border: '1px solid #EDE9E0', background: '#EFECE4',
}
