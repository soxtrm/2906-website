'use client'
// Photos, the way owners actually do it: drop a whole folder at once or add one
// by one, make one the cover, move them, delete them. Optionally say which room
// a photo shows (useful for shared flats, optional everywhere else).
import { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ImagePlus, Star, X } from 'lucide-react'

function shrink(file: File, max = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file)
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height))
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', .72))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')) }
    img.src = url
  })
}

export function PhotoDrop({ photos, onChange, max = 24, compact = false, label = 'Drop photos here', rooms, tags, onTag }: {
  photos: string[]; onChange: (p: string[]) => void; max?: number; compact?: boolean; label?: string
  rooms?: { id: string; label: string }[]; tags?: Record<string, string>; onTag?: (url: string, roomId: string | null) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  async function add(list: FileList | File[]) {
    const files = [...list].filter(f => f.type.startsWith('image/')).slice(0, Math.max(0, max - photos.length))
    if (!files.length) return
    setBusy(true)
    const out: string[] = []
    for (const f of files) { try { out.push(await shrink(f)) } catch { /* skip */ } }
    setBusy(false)
    onChange([...photos, ...out])
  }
  const move = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= photos.length) return; const p = [...photos]; [p[i], p[j]] = [p[j], p[i]]; onChange(p) }
  return (
    <div className={`ow-photodrop${compact ? ' compact' : ''}`}>
      <div className="ow-dropzone" data-over={over} role="button" tabIndex={0}
        onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); add(e.dataTransfer.files) }}>
        <ImagePlus size={compact ? 20 : 28} aria-hidden="true" />
        <b>{busy ? 'Adding…' : label}</b>
        {!compact && <span>or tap to choose · several at once or one by one · up to {max}</span>}
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) add(e.target.files); e.target.value = '' }} />
      </div>
      {photos.length > 0 && (
        <ul className="ow-thumbs">
          {photos.map((src, i) => (
            <li key={src.slice(-40) + i} data-cover={i === 0}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Photo ${i + 1}`} />
              {i === 0 ? <span className="ow-cover">Cover</span>
                : <button type="button" className="ow-thumb-btn left" aria-label="Make this the cover" title="Make cover" onClick={() => onChange([src, ...photos.filter((_, j) => j !== i)])}><Star size={14} /></button>}
              <button type="button" className="ow-thumb-btn" aria-label="Delete photo" title="Delete" onClick={() => onChange(photos.filter((_, j) => j !== i))}><X size={14} /></button>
              <span className="ow-thumb-move">
                <button type="button" aria-label="Move left" disabled={i === 0} onClick={() => move(i, -1)}><ChevronLeft size={14} /></button>
                <button type="button" aria-label="Move right" disabled={i === photos.length - 1} onClick={() => move(i, 1)}><ChevronRight size={14} /></button>
              </span>
              {rooms && rooms.length > 0 && onTag && (
                <select className="ow-thumb-room" aria-label={`Which room is photo ${i + 1}`} value={tags?.[src] || ''} onChange={e => onTag(src, e.target.value || null)}>
                  <option value="">Whole home</option>
                  {rooms.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
