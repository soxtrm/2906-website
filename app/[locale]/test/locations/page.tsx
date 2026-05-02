'use client'

import { useState } from 'react'
import { LocationSelector, type LocationSelectorValue } from '@/components/location-selector'
import { SingleVillageSelector } from '@/components/single-village-selector'

export default function TestLocations() {
  const [value, setValue] = useState<LocationSelectorValue>({
    selectedAreas: [],
    preferredVillages: [],
    topPriorityVillages: [],
  })

  const [singleVillage, setSingleVillage] = useState<string | null>(null)

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-10">
      <div>
        <h1 className="text-2xl font-serif text-navy mb-1">LocationSelector Test</h1>
        <p className="text-sm text-navy/50">Single tap = blue. Double tap = gold. API: 178.104.162.193:3001</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-100 p-5">
        <LocationSelector value={value} onChange={setValue} showPriority />
      </div>

      <pre className="p-4 bg-off-white rounded text-xs text-navy/70 overflow-auto">
        {JSON.stringify(value, null, 2)}
      </pre>

      <div>
        <h2 className="text-lg font-serif text-navy mb-3">SingleVillageSelector Test</h2>
        <div className="bg-white rounded-lg border border-gray-100 p-5">
          <SingleVillageSelector
            value={singleVillage}
            onChange={setSingleVillage}
          />
        </div>
        <pre className="mt-3 p-4 bg-off-white rounded text-xs text-navy/70">
          {JSON.stringify({ selectedVillage: singleVillage }, null, 2)}
        </pre>
      </div>
    </div>
  )
}
