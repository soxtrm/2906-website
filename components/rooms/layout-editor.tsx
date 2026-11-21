'use client'
// NEXUS Rooms: the owner's layout editor (2026-11-21). A top-down grid where every room and shared space is a
// block: drag to move, drag the corner to resize (snaps to the grid), arrow buttons for touch, furniture chips,
// and a live 2.5D preview. Saved as a draft; the public sees it only after the owner confirms it.
// No dimensions are inferred: the plan is approximate and labelled as such.
import { useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Box, Check, Eye, Grid3x3, Minus, Plus, Trash2 } from 'lucide-react'
import { IsometricApartment, schematicLayout, type IsoBlock, type IsoLayout, type IsoUnit } from './isometric'

const CELL = 22
const FURNITURE = [['double_bed', 'Double bed'], ['bed', 'Single bed'], ['wardrobe', 'Wardrobe'], ['desk', 'Desk'], ['sofa', 'Sofa'], ['table', 'Table'], ['kitchen', 'Kitchen'], ['bath', 'Bath'], ['shower', 'Shower'], ['plant', 'Plant']] as const
const overlaps = (a: IsoBlock, b: IsoBlock) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export function LayoutEditor({ units, initial, busy, onSave }: {
  units: IsoUnit[]; initial: IsoLayout | null; busy: boolean; onSave: (layout: IsoLayout, confirm: boolean) => void
}) {
  const [layout, setLayout] = useState<IsoLayout>(() => initial && initial.blocks.length ? initial : schematicLayout(units))
  const [sel, setSel] = useState<string | null>(layout.blocks[0]?.id || null)
  const [preview, setPreview] = useState(false)
  const [problem, setProblem] = useState('')
  const svg = useRef<SVGSVGElement>(null)
  const unitOf = (b: IsoBlock) => units.find(u => u.id === b.unitId)
  const placed = new Set(layout.blocks.map(b => b.unitId))
  const unplaced = units.filter(u => !placed.has(u.id))
  const cur = layout.blocks.find(b => b.id === sel) || null

  const apply = (next: IsoBlock, id: string) => {
    const g = layout.grid
    if (next.x < 0 || next.y < 0 || next.w < 1 || next.h < 1 || next.x + next.w > g.w || next.y + next.h > g.h) { setProblem('That would reach outside the plan. Make the plan bigger first.'); return false }
    if (layout.blocks.some(b => b.id !== id && overlaps(b, next))) { setProblem('Rooms cannot overlap.'); return false }
    setProblem(''); setLayout(l => ({ ...l, blocks: l.blocks.map(b => (b.id === id ? next : b)) })); return true
  }
  const cellAt = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect(); const k = r.width / (layout.grid.w * CELL)
    return { x: (e.clientX - r.left) / k / CELL, y: (e.clientY - r.top) / k / CELL }
  }
  const drag = (b: IsoBlock, mode: 'move' | 'size', e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault(); setSel(b.id)
    const start = cellAt(e); const orig = { ...b }
    const move = (ev: PointerEvent) => {
      const p = cellAt(ev); const dx = Math.round(p.x - start.x), dy = Math.round(p.y - start.y)
      const next = mode === 'move' ? { ...orig, x: orig.x + dx, y: orig.y + dy } : { ...orig, w: Math.max(1, orig.w + dx), h: Math.max(1, orig.h + dy) }
      apply(next, b.id)
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const nudge = (dx: number, dy: number, dw = 0, dh = 0) => { if (cur) apply({ ...cur, x: cur.x + dx, y: cur.y + dy, w: cur.w + dw, h: cur.h + dh }, cur.id) }
  const addBlock = (u: IsoUnit) => {
    const w = u.kind === 'room' ? 5 : 4, h = u.kind === 'room' ? 5 : 3
    for (let y = 0; y + h <= layout.grid.h; y++) for (let x = 0; x + w <= layout.grid.w; x++) {
      const b: IsoBlock = { id: `b${u.id}-${Date.now().toString(36)}`, unitId: u.id, x, y, w, h, furniture: u.kind === 'room' ? ['double_bed', 'wardrobe'] : [] }
      if (!layout.blocks.some(o => overlaps(o, b))) { setLayout(l => ({ ...l, blocks: [...l.blocks, b] })); setSel(b.id); setProblem(''); return }
    }
    setProblem('No free space for that room. Make the plan bigger or move rooms.')
  }
  const grow = (dw: number, dh: number) => {
    const w = Math.min(60, Math.max(6, layout.grid.w + dw)), h = Math.min(60, Math.max(6, layout.grid.h + dh))
    if (layout.blocks.some(b => b.x + b.w > w || b.y + b.h > h)) { setProblem('A room is in the way. Move it before making the plan smaller.'); return }
    setProblem(''); setLayout(l => ({ ...l, grid: { w, h } }))
  }
  const isoUnits = useMemo(() => units.map(u => ({ ...u, furniture: layout.blocks.find(b => b.unitId === u.id)?.furniture })), [units, layout])

  return (
    <div className="le">
      <div className="le-bar">
        <div className="le-seg" role="group" aria-label="View">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}><Grid3x3 size={15} />Plan</button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}><Box size={15} />2.5D preview</button>
        </div>
        <span className="le-size">Plan {layout.grid.w} × {layout.grid.h}
          <button type="button" aria-label="Wider" onClick={() => grow(2, 0)}><Plus size={13} /></button><button type="button" aria-label="Narrower" onClick={() => grow(-2, 0)}><Minus size={13} /></button>
          <button type="button" aria-label="Deeper" onClick={() => grow(0, 2)}><ArrowDown size={13} /></button><button type="button" aria-label="Shallower" onClick={() => grow(0, -2)}><ArrowUp size={13} /></button>
        </span>
      </div>
      {preview
        ? <IsometricApartment layout={layout} units={isoUnits} selected={cur?.unitId ?? null} onSelect={id => setSel(layout.blocks.find(b => b.unitId === id)?.id || null)} height={380} />
        : <div className="le-canvas">
          <svg ref={svg} viewBox={`0 0 ${layout.grid.w * CELL} ${layout.grid.h * CELL}`} role="group" aria-label="Plan editor" onPointerDown={() => setSel(null)}>
            <defs><pattern id="le-grid" width={CELL} height={CELL} patternUnits="userSpaceOnUse"><path d={`M ${CELL} 0 L 0 0 0 ${CELL}`} fill="none" stroke="rgba(7,20,73,.08)" /></pattern></defs>
            <rect width="100%" height="100%" fill="url(#le-grid)" />
            {layout.blocks.map(b => {
              const u = unitOf(b); const on = b.id === sel
              return (
                <g key={b.id} className="le-block" data-kind={u?.kind || 'shared'} data-selected={on || undefined} onPointerDown={e => drag(b, 'move', e)} style={{ cursor: 'move' }}>
                  <rect x={b.x * CELL + 1} y={b.y * CELL + 1} width={b.w * CELL - 2} height={b.h * CELL - 2} rx={6} />
                  <text x={b.x * CELL + 8} y={b.y * CELL + 17}>{u?.label || b.label || 'Space'}</text>
                  <text className="le-dim" x={b.x * CELL + 8} y={b.y * CELL + 31}>{b.w} × {b.h} squares</text>
                  {on && <rect className="le-handle" x={(b.x + b.w) * CELL - 14} y={(b.y + b.h) * CELL - 14} width={12} height={12} rx={3} onPointerDown={e => drag(b, 'size', e)} style={{ cursor: 'nwse-resize' }} />}
                </g>
              )
            })}
          </svg>
        </div>}
      {problem && <p className="le-problem" role="alert">{problem}</p>}
      {cur && !preview && (
        <div className="le-panel">
          <b>{unitOf(cur)?.label || 'Space'}</b>
          <div className="le-nudge" aria-label="Move or resize">
            <button type="button" aria-label="Move left" onClick={() => nudge(-1, 0)}><ArrowLeft size={14} /></button><button type="button" aria-label="Move up" onClick={() => nudge(0, -1)}><ArrowUp size={14} /></button>
            <button type="button" aria-label="Move down" onClick={() => nudge(0, 1)}><ArrowDown size={14} /></button><button type="button" aria-label="Move right" onClick={() => nudge(1, 0)}><ArrowRight size={14} /></button>
            <span /><button type="button" onClick={() => nudge(0, 0, 1, 0)}>Wider</button><button type="button" onClick={() => nudge(0, 0, -1, 0)}>Narrower</button>
            <button type="button" onClick={() => nudge(0, 0, 0, 1)}>Deeper</button><button type="button" onClick={() => nudge(0, 0, 0, -1)}>Shallower</button>
          </div>
          <div className="le-chips" role="group" aria-label="Furniture">
            {FURNITURE.map(([k, l]) => { const on = (cur.furniture || []).includes(k); return <button key={k} type="button" aria-pressed={on} onClick={() => setLayout(L => ({ ...L, blocks: L.blocks.map(b => (b.id === cur.id ? { ...b, furniture: on ? (b.furniture || []).filter(x => x !== k) : [...(b.furniture || []), k].slice(0, 4) } : b)) }))}>{l}</button> })}
          </div>
          <button type="button" className="le-remove" onClick={() => { setLayout(L => ({ ...L, blocks: L.blocks.filter(b => b.id !== cur.id) })); setSel(null) }}><Trash2 size={14} />Take off the plan</button>
        </div>
      )}
      {unplaced.length > 0 && <div className="le-add"><span>Not on the plan yet:</span>{unplaced.map(u => <button key={u.id} type="button" onClick={() => addBlock(u)}><Plus size={13} />{u.label}</button>)}</div>}
      <p className="le-note">Approximate plan: draw the rooms roughly where they are. Squares are not measurements; buyers and tenants see it labelled as illustrative.</p>
      <div className="le-actions">
        <button type="button" className="rm-btn" disabled={busy} onClick={() => onSave(layout, false)}>Save draft</button>
        <button type="button" className="rm-btn ok" disabled={busy || !layout.blocks.length} onClick={() => onSave(layout, true)}><Check size={15} />Confirm and show it on the listing</button>
      </div>
    </div>
  )
}

export function PreviewOnly({ layout, units }: { layout: IsoLayout; units: IsoUnit[] }) {
  const [sel, setSel] = useState<number | null>(null)
  return <IsometricApartment layout={layout} units={units} selected={sel} onSelect={setSel} height={320} />
}
export { Eye }
