'use client'
import { useOwner } from '@/lib/owner/store'
import { niceDate } from '@/components/owner/format'

const KIND = { contract: 'Contract', inventory: 'Inventory', certificate: 'Certificate', id: 'ID', other: 'Other' } as const

export default function Documents() {
  const s = useOwner()
  return (
    <>
      <div className="ow-head"><div>
        <h1>Documents</h1>
        <p className="ow-muted">Contracts, inventories and certificates, kept with the property or the room they belong to. Nothing is shared unless you say so.</p>
      </div></div>
      <div className="ow-panel">
        <table className="ow-table">
          <thead><tr><th>Document</th><th>Belongs to</th><th>Added</th><th>Shared with</th></tr></thead>
          <tbody>
            {s.documents.map(d => {
              const p = s.properties.find(x => x.id === d.propertyId)
              const room = d.roomId ? p?.rooms.find(r => r.id === d.roomId) : null
              return (
                <tr key={d.id}>
                  <td><b>{d.title}</b><br /><span className="ow-faint">{KIND[d.kind]}</span></td>
                  <td>{room ? `${room.label}, ` : ''}{p?.name}</td>
                  <td>{niceDate(d.addedAt, false)} {d.addedAt.slice(0, 4)}</td>
                  <td>{d.sharedWith.length ? d.sharedWith.join(', ') : <span className="ow-faint">Only you</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="ow-hint" style={{ marginTop: 14 }}>Uploading opens with the owner sign-in. In this preview the list is read-only.</p>
      </div>
    </>
  )
}
