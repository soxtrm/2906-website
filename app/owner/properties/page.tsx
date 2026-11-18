'use client'
import { useOwner } from '@/lib/owner/store'
import { PropertyCard } from '@/components/owner/property-card'

export default function Properties() {
  const { properties } = useOwner()
  return (
    <>
      <div className="ow-head">
        <div>
          <h1>My properties</h1>
          <p className="ow-muted">Each property keeps its photos, history and verified identity, whether you let it whole, by the room, short term or sell it.</p>
        </div>
      </div>
      <div className="ow-props">{properties.map(p => <PropertyCard key={p.id} p={p} />)}</div>
    </>
  )
}
