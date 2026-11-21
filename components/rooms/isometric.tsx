'use client'
// NEXUS Rooms: the interactive 2.5D apartment (2026-11-21). An isometric cutaway of the owner's approximate layout:
// room blocks with low back walls, simple furniture, name, price and live state; tap a room to select it.
// Zoom (wheel / pinch / buttons), pan (drag), and a smooth camera focus on the selected room.
// The layout is drawn by the owner and labelled illustrative: nothing here is a measured floor plan.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Minus, Plus, Maximize2 } from 'lucide-react'

export type IsoUnit = { id: number; kind: 'room' | 'shared'; label: string; sharedType?: string | null; state?: 'available' | 'reserved' | 'occupied' | 'hold' | 'shared'; price?: string | null; furniture?: string[] }
export type IsoBlock = { id: string; unitId: number | null; label?: string | null; x: number; y: number; w: number; h: number; furniture?: string[] }
export type IsoLayout = { grid: { w: number; h: number }; blocks: IsoBlock[] }

const C = Math.cos(Math.PI / 6), S = Math.sin(Math.PI / 6)
const U = 26                        // px per grid unit
const WALL = 0.9                    // wall height in grid units
const iso = (x: number, y: number, z = 0) => [(x - y) * C * U, (x + y) * S * U - z * U] as const
const pts = (list: (readonly [number, number])[]) => list.map(p => p.join(',')).join(' ')

// a schematic arrangement when the owner has not drawn one yet: rooms along the top, shared spaces below
export function schematicLayout(units: IsoUnit[]): IsoLayout {
  const rooms = units.filter(u => u.kind === 'room'), shared = units.filter(u => u.kind === 'shared')
  const blocks: IsoBlock[] = []
  let x = 0
  for (const r of rooms) { blocks.push({ id: `r${r.id}`, unitId: r.id, x, y: 0, w: 5, h: 5, furniture: ['double_bed', 'wardrobe'] }); x += 5 }
  const width = Math.max(10, x)
  const sw = shared.length ? Math.max(3, Math.floor(width / shared.length)) : 0
  shared.forEach((s, i) => {
    const w = i === shared.length - 1 ? width - sw * i : sw
    blocks.push({ id: `s${s.id}`, unitId: s.id, x: sw * i, y: 5, w: Math.max(2, w), h: 4, furniture: s.sharedType === 'kitchen' ? ['kitchen', 'table'] : s.sharedType === 'living' ? ['sofa', 'table'] : s.sharedType === 'bathroom' ? ['shower'] : ['plant'] })
  })
  return { grid: { w: width, h: shared.length ? 9 : 5 }, blocks }
}

const TONE: Record<string, { floor: string; wall: string; edge: string; text: string }> = {
  available: { floor: '#dff4e6', wall: '#bfe6cb', edge: '#22a85a', text: '#0f5a32' },
  reserved: { floor: '#fdf0d9', wall: '#f4dcae', edge: '#e8a33a', text: '#7a4d0c' },
  hold: { floor: '#fdf0d9', wall: '#f4dcae', edge: '#e8a33a', text: '#7a4d0c' },
  occupied: { floor: '#f1e4e1', wall: '#e3cbc6', edge: '#c4574a', text: '#7d2a20' },
  shared: { floor: '#f3f1ec', wall: '#e5e1d8', edge: '#a7a094', text: '#3b4466' },
}

// simple furniture as small isometric boxes, placed deterministically inside a block
function Furniture({ b, kinds }: { b: IsoBlock; kinds: string[] }) {
  const items: { x: number; y: number; w: number; d: number; z: number; c: string }[] = []
  const pad = 0.5
  kinds.slice(0, 4).forEach((k, i) => {
    const corner = [[pad, pad], [b.w - pad, pad], [pad, b.h - pad], [b.w - pad, b.h - pad]][i]
    const size: Record<string, [number, number, number, string]> = {
      double_bed: [2.2, 2.8, 0.45, '#ffffff'], bed: [1.5, 2.6, 0.45, '#ffffff'], wardrobe: [1.8, 0.7, 1.6, '#d8cfc2'], desk: [1.5, 0.8, 0.75, '#c9b79c'],
      sofa: [2.6, 1.0, 0.7, '#9aa7c7'], table: [1.4, 1.4, 0.7, '#c9b79c'], kitchen: [3.0, 0.8, 0.9, '#e7e2d8'], bath: [1.8, 0.9, 0.55, '#ffffff'], shower: [1.0, 1.0, 1.9, '#cfe4f1'], plant: [0.6, 0.6, 1.0, '#7fb88f'],
    }
    const s = size[k]; if (!s) return
    const w = Math.min(s[0], b.w - 2 * pad), d = Math.min(s[1], b.h - 2 * pad)
    const x = corner[0] > b.w / 2 ? corner[0] - w : corner[0], y = corner[1] > b.h / 2 ? corner[1] - d : corner[1]
    items.push({ x: b.x + x, y: b.y + y, w, d, z: s[2], c: s[3] })
  })
  return <>{items.map((f, i) => {
    const top = [iso(f.x, f.y, f.z), iso(f.x + f.w, f.y, f.z), iso(f.x + f.w, f.y + f.d, f.z), iso(f.x, f.y + f.d, f.z)]
    const right = [iso(f.x + f.w, f.y, f.z), iso(f.x + f.w, f.y + f.d, f.z), iso(f.x + f.w, f.y + f.d, 0), iso(f.x + f.w, f.y, 0)]
    const front = [iso(f.x, f.y + f.d, f.z), iso(f.x + f.w, f.y + f.d, f.z), iso(f.x + f.w, f.y + f.d, 0), iso(f.x, f.y + f.d, 0)]
    return <g key={i} aria-hidden="true"><polygon points={pts(right)} fill={f.c} style={{ filter: 'brightness(0.82)' }} /><polygon points={pts(front)} fill={f.c} style={{ filter: 'brightness(0.9)' }} /><polygon points={pts(top)} fill={f.c} stroke="rgba(7,20,73,.12)" strokeWidth={0.6} /></g>
  })}</>
}

export function IsometricApartment({ layout, units, selected, onSelect, height = 460, illustrative = true }: {
  layout: IsoLayout; units: IsoUnit[]; selected: number | null; onSelect: (unitId: number) => void; height?: number; illustrative?: boolean
}) {
  const reduce = useReducedMotion()
  const box = useRef<HTMLDivElement>(null)
  const byId = useMemo(() => new Map(units.map(u => [u.id, u])), [units])
  // painter's order: far blocks first
  const blocks = useMemo(() => [...layout.blocks].sort((a, b) => (a.x + a.y) - (b.x + b.y) || a.y - b.y), [layout])
  const bounds = useMemo(() => {
    const all = layout.blocks.flatMap(b => [iso(b.x, b.y, WALL), iso(b.x + b.w, b.y), iso(b.x, b.y + b.h), iso(b.x + b.w, b.y + b.h)])
    if (!all.length) return { x: 0, y: 0, w: 100, h: 100 }
    const xs = all.map(p => p[0]), ys = all.map(p => p[1])
    return { x: Math.min(...xs) - 30, y: Math.min(...ys) - 40, w: Math.max(...xs) - Math.min(...xs) + 60, h: Math.max(...ys) - Math.min(...ys) + 70 }
  }, [layout])
  const [cam, setCam] = useState({ k: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  // focus the selected room: zoom in a little and bring its centre to the middle
  useEffect(() => {
    if (selected == null) return
    const b = layout.blocks.find(x => x.unitId === selected); if (!b) return
    const [cx, cy] = iso(b.x + b.w / 2, b.y + b.h / 2)
    const midX = bounds.x + bounds.w / 2, midY = bounds.y + bounds.h / 2
    const k = Math.min(1.6, Math.max(1.15, cam.k))
    setCam({ k, x: (midX - cx) * k, y: (midY - cy) * k })
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps
  // wheel zoom, drag pan, two-finger pinch
  const ptrs = useRef(new Map<number, { x: number; y: number }>())
  const last = useRef<{ d: number; x: number; y: number } | null>(null)
  const moved = useRef(false)
  useEffect(() => {
    const el = box.current; if (!el) return
    const wheel = (e: WheelEvent) => { e.preventDefault(); setCam(c => ({ ...c, k: Math.min(3, Math.max(0.6, c.k * (e.deltaY < 0 ? 1.1 : 0.9))) })) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  const down = (e: React.PointerEvent) => { ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved.current = false; last.current = null; setDragging(true) }
  const move = (e: React.PointerEvent) => {
    const p = ptrs.current.get(e.pointerId); if (!p) return
    const scale = (box.current?.clientWidth || 1) / bounds.w
    if (ptrs.current.size === 1) {
      const dx = (e.clientX - p.x) / scale, dy = (e.clientY - p.y) / scale
      if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true
      setCam(c => ({ ...c, x: c.x + dx, y: c.y + dy }))
    }
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (last.current) setCam(c => ({ ...c, k: Math.min(3, Math.max(0.6, c.k * d / last.current!.d)) }))
      last.current = { d, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; moved.current = true
    }
  }
  const up = (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); if (ptrs.current.size < 2) last.current = null; if (!ptrs.current.size) setDragging(false) }
  const midX = bounds.x + bounds.w / 2, midY = bounds.y + bounds.h / 2

  return (
    <div className="iso" ref={box} style={{ height }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}>
      <svg viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`} role="group" aria-label="Apartment layout: choose a room">
        <defs>
          <linearGradient id="iso-sel" x1="0" x2="1"><stop offset="0" stopColor="#8e2cff" /><stop offset=".55" stopColor="#ff477d" /><stop offset="1" stopColor="#ff8a56" /></linearGradient>
        </defs>
        <g className="iso-cam" style={{ transformBox: 'view-box', transformOrigin: `${midX}px ${midY}px`, transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`, transition: dragging || reduce ? 'none' : 'transform .55s cubic-bezier(.22,1,.36,1)' } as React.CSSProperties}>
          {blocks.map(b => {
            const u = b.unitId != null ? byId.get(b.unitId) : undefined
            const state = u?.kind === 'shared' || !u ? 'shared' : (u.state || 'available')
            const t = TONE[state] || TONE.shared
            const sel = u && u.id === selected
            const lift = sel ? 0.25 : 0
            const floor = [iso(b.x, b.y, lift), iso(b.x + b.w, b.y, lift), iso(b.x + b.w, b.y + b.h, lift), iso(b.x, b.y + b.h, lift)]
            const back = [iso(b.x, b.y, lift), iso(b.x + b.w, b.y, lift), iso(b.x + b.w, b.y, WALL + lift), iso(b.x, b.y, WALL + lift)]
            const left = [iso(b.x, b.y, lift), iso(b.x, b.y + b.h, lift), iso(b.x, b.y + b.h, WALL + lift), iso(b.x, b.y, WALL + lift)]
            const [cx, cy] = iso(b.x + b.w / 2, b.y + b.h / 2, lift)
            const clickable = u && u.kind === 'room'
            return (
              <g key={b.id} className="iso-block" data-unit={u?.id} data-state={state} data-selected={sel || undefined}
                role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : -1} aria-label={clickable ? `${u!.label}${u!.price ? `, ${u!.price}` : ''}, ${state}` : u?.label}
                onClick={() => { if (clickable && !moved.current) onSelect(u!.id) }} onKeyDown={e => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(u!.id) } }}
                style={{ cursor: clickable ? 'pointer' : 'default' }}>
                <polygon points={pts(left)} fill={t.wall} stroke={t.edge} strokeOpacity={0.35} strokeWidth={0.8} />
                <polygon points={pts(back)} fill={t.wall} stroke={t.edge} strokeOpacity={0.35} strokeWidth={0.8} style={{ filter: 'brightness(1.04)' }} />
                <polygon className="iso-floor" points={pts(floor)} fill={t.floor} stroke={sel ? 'url(#iso-sel)' : t.edge} strokeWidth={sel ? 3 : 1.1} />
                <Furniture b={{ ...b, x: b.x, y: b.y }} kinds={b.furniture || []} />
                <g transform={`translate(${cx} ${cy})`} pointerEvents="none">
                  <rect x={-Math.max(34, (u?.label || b.label || '').length * 3.6 + 10)} y={-15} rx={9} width={Math.max(68, (u?.label || b.label || '').length * 7.2 + 20)} height={u?.price ? 32 : 20} fill="rgba(255,255,255,.92)" stroke={t.edge} strokeOpacity={0.5} />
                  <text textAnchor="middle" y={-1} fontSize={10.5} fontWeight={800} fill={t.text}>{u?.label || b.label || ''}</text>
                  {u?.price && <text textAnchor="middle" y={12} fontSize={9.5} fontWeight={700} fill="#071449">{u.price}</text>}
                </g>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="iso-tools" onPointerDown={e => e.stopPropagation()}>
        <button type="button" aria-label="Zoom in" onClick={() => setCam(c => ({ ...c, k: Math.min(3, c.k * 1.2) }))}><Plus size={16} /></button>
        <button type="button" aria-label="Zoom out" onClick={() => setCam(c => ({ ...c, k: Math.max(0.6, c.k / 1.2) }))}><Minus size={16} /></button>
        <button type="button" aria-label="Show the whole apartment" onClick={() => setCam({ k: 1, x: 0, y: 0 })}><Maximize2 size={15} /></button>
      </div>
      <div className="iso-legend" aria-hidden="true"><span data-k="available">Available</span><span data-k="reserved">Reserved</span><span data-k="occupied">Occupied</span><span data-k="shared">Shared</span></div>
      {illustrative && <p className="iso-note">Illustrative layout, not a measured floor plan. Full 3D walkthrough coming in the future.</p>}
    </div>
  )
}
