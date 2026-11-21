'use client'
// Documents: drop a file in, keep it with the home (or room) it belongs to,
// open it, send it in the ARGUS chat, and share it with agencies. Nothing is
// shared until the owner chooses who sees it.
import { useRef, useState } from 'react'
import { FileText, MessageCircle, Share2, Upload } from 'lucide-react'
import type { DocumentItem } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { LiveDocuments } from '@/components/owner/live-people-docs'
import { niceDate, propColor } from '@/components/owner/format'

const KIND: Record<DocumentItem['kind'], string> = { contract: 'Contract', inventory: 'Inventory', certificate: 'Certificate', id: 'ID', other: 'Other' }

function read(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) })
}

function DemoDocuments() {
  const s = useOwner()
  const ids = s.properties.map(p => p.id)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [pid, setPid] = useState(s.properties[0]?.id)
  const [kind, setKind] = useState<DocumentItem['kind']>('contract')
  const [shareFor, setShareFor] = useState<string | null>(null)

  async function add(list: FileList | null) {
    if (!pid) { s.say('Add a home first, then its documents.', 'warn'); return }
    for (const f of [...(list || [])].slice(0, 5)) {
      const dataUrl = f.size < 3_000_000 ? await read(f) : undefined
      s.addDocument({ title: f.name.replace(/\.[^.]+$/, ''), kind, propertyId: pid, dataUrl, fileName: f.name })
    }
  }

  return (
    <>
      <div className="ow-head"><div>
        <h1>Documents</h1>
        <p className="ow-muted">Kept with the home they belong to. Only you see them until you share.</p>
      </div></div>

      <section className="ow-panel">
        <div className="ow-form-grid" style={{ marginBottom: 12 }}>
          <div className="ow-field"><label htmlFor="dp">For which home</label>
            <select id="dp" value={pid} onChange={e => setPid(Number(e.target.value))}>{s.properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div className="ow-field"><label htmlFor="dk">What is it</label>
            <select id="dk" value={kind} onChange={e => setKind(e.target.value as DocumentItem['kind'])}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        </div>
        <div className="ow-dropzone" data-over={over} role="button" tabIndex={0}
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter') input.current?.click() }}
          onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); add(e.dataTransfer.files) }}>
          <Upload size={28} aria-hidden="true" />
          <b>Drop documents here</b>
          <span>PDF, photos or Word · or tap to choose</span>
          <input ref={input} type="file" multiple hidden onChange={e => { add(e.target.files); e.target.value = '' }} />
        </div>
      </section>

      <ul className="ow-docs">
        {s.documents.map(d => {
          const p = s.properties.find(x => x.id === d.propertyId)
          const room = d.roomId ? p?.rooms.find(r => r.id === d.roomId) : null
          return (
            <li key={d.id} className="ow-panel">
              <span className="ow-doc-icon"><FileText size={22} /></span>
              <span className="ow-doc-main">
                <b>{d.title}</b>
                <small><i style={{ background: propColor(ids, d.propertyId) }} />{KIND[d.kind]} · {room ? `${room.label}, ` : ''}{p?.name} · {niceDate(d.addedAt, false)}</small>
                <small className={d.sharedWith.length ? 'shared' : ''}>{d.sharedWith.length ? `Shared with ${d.sharedWith.join(', ')}` : 'Only you'}</small>
              </span>
              <span className="ow-doc-actions">
                {d.dataUrl && <a className="ow-btn small" href={d.dataUrl} target="_blank" rel="noopener" download={d.fileName}>Open</a>}
                <button className="ow-btn small" onClick={() => s.sendDocument(d.id)}><MessageCircle size={15} />Send in chat</button>
                <button className="ow-btn small primary" aria-expanded={shareFor === d.id} onClick={() => setShareFor(x => (x === d.id ? null : d.id))}><Share2 size={15} />Share</button>
              </span>
              {shareFor === d.id && (
                <div className="ow-doc-share">
                  <p className="ow-label">Who may see it</p>
                  {s.agencies.filter(a => a.approved).map(a => (
                    <label key={a.id}>
                      <input type="checkbox" checked={d.sharedWith.includes(a.name)}
                        onChange={e => s.shareDocument(d.id, e.target.checked ? [...d.sharedWith, a.name] : d.sharedWith.filter(x => x !== a.name))} />
                      {a.name}
                    </label>
                  ))}
                  <button className="ow-btn small quiet" onClick={() => setShareFor(null)}>Done</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

export default function Documents() {
  const { demo } = useOwner()
  return demo ? <DemoDocuments /> : <LiveDocuments />
}
