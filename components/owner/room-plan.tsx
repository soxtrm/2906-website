'use client'
// Lightweight isometric cut-away: half-height walls, door and window marks,
// one selectable zone per room. Plan units are metres; geometry comes from the
// spatial-studio plan (rectangles), so a scan can feed it later and the owner
// can correct it by hand.
import type { FloorPlan, Room } from '@/lib/owner/model'

const COS = Math.cos(Math.PI / 6), SIN = Math.sin(Math.PI / 6)
const S = 26          // px per metre
const WALL = 1.1      // half-height walls (m)
const iso = (x: number, y: number, z = 0) => [(x - y) * COS * S, (x + y) * SIN * S - z * S] as const
const pts = (arr: (readonly [number, number])[]) => arr.map(p => p.join(',')).join(' ')

const FILL: Record<Room['status'], string> = { available: '#cfe3d6', occupied: '#e9dcc0', reserved: '#f1e3c4', inactive: '#e3e5df' }
const EDGE: Record<Room['status'], string> = { available: '#2f6b58', occupied: '#9a7431', reserved: '#b88a3c', inactive: '#9aa39d' }

function Box({ x, y, w, h, fill, stroke }: { x: number; y: number; w: number; h: number; fill: string; stroke: string }) {
  const f = [iso(x, y), iso(x + w, y), iso(x + w, y + h), iso(x, y + h)]
  // back walls (north and west) drawn as half-height panels, front stays open: a cut-away
  const north = [iso(x, y), iso(x + w, y), iso(x + w, y, WALL), iso(x, y, WALL)]
  const west = [iso(x, y), iso(x, y + h), iso(x, y + h, WALL), iso(x, y, WALL)]
  return (
    <>
      <polygon className="top" points={pts(f)} fill={fill} stroke={stroke} strokeWidth={1.2} />
      <polygon points={pts(north)} fill="#f7f6f1" stroke="#b9bfb4" strokeWidth={1} />
      <polygon points={pts(west)} fill="#eceee7" stroke="#b9bfb4" strokeWidth={1} />
    </>
  )
}

export function RoomPlan({ plan, rooms, selected, onSelect }: { plan: FloorPlan; rooms: Room[]; selected?: string; onSelect: (id: string) => void }) {
  const corners = [iso(0, 0, WALL), iso(plan.width, 0, WALL), iso(plan.width, plan.depth), iso(0, plan.depth)]
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1])
  const pad = 18
  const vb = `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${Math.max(...xs) - Math.min(...xs) + pad * 2} ${Math.max(...ys) - Math.min(...ys) + pad * 2}`
  // painter's order: far zones first
  const zones = [
    ...plan.shared.map(z => ({ kind: 'shared' as const, ...z, key: z.label })),
    ...rooms.filter(r => r.zone).map(r => ({ kind: 'room' as const, ...r.zone!, key: r.id, room: r })),
  ].sort((a, b) => (a.x + a.y) - (b.x + b.y))

  return (
    <svg className="ow-plan" viewBox={vb} role="img" aria-label="Floor plan: choose a room">
      <polygon points={pts([iso(0, 0), iso(plan.width, 0), iso(plan.width, plan.depth), iso(0, plan.depth)])} fill="#e6e8e0" />
      {zones.map(z => {
        if (z.kind === 'shared') {
          const c = iso(z.x + z.w / 2, z.y + z.h / 2)
          return (
            <g key={z.key}>
              <Box x={z.x} y={z.y} w={z.w} h={z.h} fill="#f1f1ec" stroke="#c8ccc2" />
              <text x={c[0]} y={c[1]} textAnchor="middle" fontSize="11" fill="#7b8a8f">{z.label}</text>
            </g>
          )
        }
        const r = z.room
        const c = iso(z.x + z.w / 2, z.y + z.h / 2)
        return (
          <g key={z.key} className="zone" data-sel={selected === r.id} role="button" tabIndex={0}
            aria-label={`${r.label}, ${r.status}`} onClick={() => onSelect(r.id)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onSelect(r.id)}>
            <Box x={z.x} y={z.y} w={z.w} h={z.h} fill={FILL[r.status]} stroke={selected === r.id ? '#1e2b33' : EDGE[r.status]} />
            {/* a bed, so a room reads as a room */}
            <polygon points={pts([iso(z.x + .5, z.y + .6, .45), iso(z.x + 2.1, z.y + .6, .45), iso(z.x + 2.1, z.y + 2.6, .45), iso(z.x + .5, z.y + 2.6, .45)])} fill="#ffffff" stroke={EDGE[r.status]} strokeWidth={.8} />
            <text x={c[0]} y={c[1] + 4} textAnchor="middle" fontSize="13" fontWeight="700" fill="#1e2b33">{r.label}</text>
          </g>
        )
      })}
      {plan.windows.map((w, i) => {
        const a = w.side === 'n' ? iso(w.x, w.y, WALL * .7) : iso(w.x, w.y, WALL * .7)
        const b = w.side === 'n' ? iso(w.x + w.len, w.y, WALL * .7) : iso(w.x, w.y + w.len, WALL * .7)
        return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#6aa4c4" strokeWidth={3} strokeLinecap="round" />
      })}
      {plan.doors.map((d, i) => {
        const a = iso(d.x, d.y), b = iso(d.x + .9, d.y)
        return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fbfbf8" strokeWidth={4} />
      })}
    </svg>
  )
}
