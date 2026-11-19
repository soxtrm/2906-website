'use client'
// Walkie-talkie to walkie-talkie: the owner sends a home straight into the
// systems of the agencies it is shared with (their ARGUS, or their walkie-talkie
// if they have no ARGUS), and gets one agent link to share without copying.
// The link only opens the listing for signed-in agents of an allowed agency; it
// never gives anyone owner rights. Planned API: docs/owner-workspace/ARCHITECTURE.md
// "Agency sync".
import { Radio, Share2 } from 'lucide-react'
import type { Property } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'
import { ago } from './format'

// final host follows the NEXUS Sync domain once it is bought
export const AGENT_LINK_BASE = 'https://sync.2906.estate/w/'

export function AgentSync({ p }: { p: Property }) {
  const s = useOwner()
  const synced = s.agencySync[p.id] || []
  const link = `${AGENT_LINK_BASE}${p.ref.toLowerCase()}`
  async function share() {
    const data = { title: p.name, text: `${p.name}: viewing requests go straight to the owner's calendar.`, url: link }
    try {
      if (navigator.share) { await navigator.share(data); return }
    } catch { return /* closed */ }
    try { await navigator.clipboard.writeText(link); s.say('Link ready to paste.') } catch { s.say(link) }
  }
  return (
    <div className="ow-agentsync">
      <div className="ow-agentsync-head">
        <span className="ow-agentsync-icon"><Radio size={18} /></span>
        <div>
          <b>Agents</b>
          <p className="ow-faint">{synced.length ? `In ${synced.length} agenc${synced.length === 1 ? 'y' : 'ies'}' own system` : 'Not sent to any agency yet'}</p>
        </div>
      </div>
      {synced.length > 0 && (
        <ul className="ow-agentsync-list">
          {synced.map(x => <li key={x.agencyId}><span className="ow-live-dot" />{s.agencies.find(a => a.id === x.agencyId)?.name}<span className="ow-faint">synced {ago(x.at, s.today)}</span></li>)}
        </ul>
      )}
      <div className="ow-req-actions">
        <button type="button" className="ow-btn primary small" onClick={() => s.syncAgencies(p.id)}><Radio size={16} />{synced.length ? 'Sync again' : 'Send to my agencies'}</button>
        <button type="button" className="ow-btn small" onClick={share}><Share2 size={16} />Share agent link</button>
      </div>
    </div>
  )
}
