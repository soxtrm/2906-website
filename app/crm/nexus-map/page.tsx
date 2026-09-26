'use client'

import { CrmProvider, CrmShell } from '@/lib/crm/ui'
import { NexusPlaceEditor } from '@/components/crm/nexus-place-editor'

export default function NexusMapPage() {
  return <CrmProvider><NexusMap /></CrmProvider>
}

function NexusMap() {
  return <CrmShell title="Nexus Places Map" subtitle="Fast 2D intelligence map · internal" dark>
    <div className="flex min-h-0 flex-1 bg-[#141b29] text-[#edeae1]">
      <NexusPlaceEditor />
    </div>
  </CrmShell>
}
