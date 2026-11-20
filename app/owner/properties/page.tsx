'use client'
import { LiveProperties } from '@/components/owner/live'
import { useOwner as useOwnerMode } from '@/lib/owner/store'
import { useOwner } from '@/lib/owner/store'
import Link from 'next/link'
import { Pencil, Radio } from 'lucide-react'
import { PropertyCard } from '@/components/owner/property-card'
import { StarButton } from '@/components/owner/brand'

function DemoProperties() {
  const { properties } = useOwner()
  return (
    <>
      <div className="ow-head">
        <div>
          <h1>My properties</h1>
          <p className="ow-muted">Each property keeps its photos, history and verified identity, whether you let it whole, by the room, short term or sell it.</p>
        </div>
      </div>
      <div className="ow-props">
        {properties.map(p => (
          <div key={p.id} className="ow-prop-wrap">
            <PropertyCard p={p} />
            <div className="ow-prop-actions">
              <Link className="ow-btn small primary" href={`/owner/properties/${p.id}?edit=1`}><Pencil size={15} />Edit listing</Link>
              <Link className="ow-btn small" href={`/owner/sharing?p=${p.id}`}><Radio size={15} />Agencies</Link>
            </div>
          </div>
        ))}
      </div>
      {!properties.length && (
        <div className="ow-panel ow-empty-big">
          <h2>No homes yet</h2>
          <p className="ow-muted">Add your first one. If ARGUS already lists your home, confirming your mobile brings it in by itself.</p>
          <StarButton href="/owner/add">Add property</StarButton>
        </div>
      )}
    </>
  )
}

// nexussync.one: the real workspace from ARGUS; ?demo=1: the preview with Maria.
export default function PropertiesPage() {
  const { demo } = useOwnerMode()
  return demo ? <DemoProperties /> : <LiveProperties />
}
