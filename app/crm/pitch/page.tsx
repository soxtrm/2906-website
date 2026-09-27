'use client'

import { useEffect, useState } from 'react'
import {
  ArrowRight, Bot, Boxes, Building2, Check, CircleGauge, CloudUpload,
  Database, ExternalLink, Facebook, Gauge, Globe2, HeartHandshake,
  Link2, MessageCircle, Network, RadioTower, RefreshCw, Search, ShieldCheck,
  Sparkles, Users, Workflow,
} from 'lucide-react'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'

const distribution = [
  { label: 'CRM', note: 'canonical record', icon: Database },
  { label: 'Agent Board', note: 'live market status', icon: Building2 },
  { label: '2906 website', note: 'public inventory', icon: Globe2 },
  { label: 'Facebook', note: 'selected campaigns', icon: Facebook },
  { label: 'Marketplaces', note: 'channel-ready data', icon: ExternalLink },
  { label: 'Owner groups', note: 'context attached', icon: Users },
  { label: 'Matched clients', note: 'relevant first', icon: HeartHandshake },
]

const outreachAccounts = [
  { name: 'Main', role: 'System bridge', state: 'ONLINE', tone: 'cyan' },
  { name: 'Backup', role: 'Second server', state: 'STANDBY', tone: 'gold' },
  { name: 'Outreach #1', role: 'Owner discovery', state: 'READY', tone: 'pink' },
  { name: 'Outreach #2', role: 'Owner discovery', state: 'COOLDOWN', tone: 'violet' },
  { name: 'Outreach #3', role: 'Owner discovery', state: 'READY', tone: 'green' },
  { name: 'Outreach #X', role: 'Expandable pool', state: 'ADD', tone: 'blue' },
]

const chapters = [
  ['01', 'Symphony'], ['02', 'Agentboard'], ['03', 'One upload'],
  ['04', 'Outreach'], ['05', 'Assistants'], ['06', 'Nexus Link'],
]

export default function PitchPage() {
  return <CrmProvider><PitchExperience /></CrmProvider>
}

function PitchExperience() {
  const { me } = useCrm()
  const [active, setActive] = useState(0)
  useEffect(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-pitch-section]')]
    const observer = new IntersectionObserver(entries => {
      const top = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (top) setActive(Number((top.target as HTMLElement).dataset.pitchSection || 0))
    }, { root: document.querySelector('.crm-content'), threshold: [.3, .58] })
    nodes.forEach(node => observer.observe(node))
    return () => observer.disconnect()
  }, [])

  if (me && me.role !== 'admin') {
    return <CrmShell title="Argus System" dark><div className="pitch-denied">Admins only.</div></CrmShell>
  }

  return (
    <CrmShell title="Argus System" subtitle="Ben Estates partnership presentation · live product view" dark>
      <main className="argus-pitch">
        <nav className="pitch-rail" aria-label="Presentation chapters">
          {chapters.map(([number, label], index) => <a key={number} href={`#pitch-${index + 1}`} aria-current={active === index ? 'step' : undefined}><span>{number}</span>{label}</a>)}
        </nav>

        <section id="pitch-1" data-pitch-section="0" className="pitch-section pitch-opening">
          <div className="pitch-copy">
            <span className="pitch-eyebrow">ARGUS · AGENCY SYSTEM</span>
            <h2>A symphony of agent workflows</h2>
            <p>Argus keeps owners, agents and clients inside one shared operating context. It turns scattered chats into verified facts, visible work and controlled next actions.</p>
            <div className="pitch-proof"><ShieldCheck /><span><b>One context firewall</b> blocks stale actions before they reach an owner.</span></div>
          </div>
          <div className="symphony" aria-label="Argus connects owners, agents and clients">
            <div className="symphony-core"><img src="/argus-logo.png" alt="Argus" /><span>ORCHESTRATION LAYER</span></div>
            <div className="symphony-node node-owner"><Users /><b>Owners</b><small>facts · media · decisions</small></div>
            <div className="symphony-node node-agent"><Building2 /><b>Agents</b><small>inventory · bookings · actions</small></div>
            <div className="symphony-node node-client"><HeartHandshake /><b>Clients</b><small>needs · matches · viewings</small></div>
            <div className="symphony-ring ring-one" /><div className="symphony-ring ring-two" />
          </div>
          <div className="efficiency-strip">
            <div><Gauge /><span>Friction resolved</span><strong>duplicate work · stale reminders · lost context</strong></div>
            <div><CircleGauge /><span>Efficiency measurement</span><strong>time to list · response time · actions closed</strong></div>
          </div>
        </section>

        <section id="pitch-2" data-pitch-section="1" className="pitch-section pitch-agentboard">
          <div className="pitch-heading"><span>02 / ARGUS AGENTBOARD</span><h2>Airbnb clarity for real-estate operations</h2><p>Every property has an owner, a current market state and one visible next action.</p></div>
          <div className="board-stage">
            <div className="board-top"><span>MONDAY · LIVE MARKET</span><div><i className="live" />142 ACTIVE <i />9 NEED ACTION</div></div>
            <div className="board-columns">
              <article><div className="board-photo board-photo-one" /><span>AVAILABLE</span><h3>Creekville Residence</h3><p>Swieqi · €3,000 / month</p><footer><b>Owner confirmed</b><small>12 min ago</small></footer></article>
              <article><div className="board-photo board-photo-two" /><span>VIEWING</span><h3>Harbour Apartment</h3><p>Sliema · €2,450 / month</p><footer><b>2 requests</b><small>Back-to-back possible</small></footer></article>
              <article><div className="board-photo board-photo-three" /><span>RECHECK</span><h3>Townhouse Collection</h3><p>Attard · price on request</p><footer><b>Human review</b><small>Context changed</small></footer></article>
            </div>
          </div>
          <div className="board-benefits"><span><Check /> Status at a glance</span><span><Check /> Action reason visible</span><span><Check /> Owner context attached</span><span><Check /> Booking flow inside the board</span></div>
        </section>

        <section id="pitch-3" data-pitch-section="2" className="pitch-section pitch-upload">
          <div className="pitch-heading"><span>03 / ONE SOURCE</span><h2>Upload in one place. Publish where it belongs.</h2><p>One canonical listing feeds selected channels. Each destination keeps its own status and can be paused without breaking the source record.</p></div>
          <div className="distribution-flow">
            <div className="upload-source"><CloudUpload /><b>UPLOAD</b><small>facts · media · availability</small></div>
            <div className="distribution-line"><i /><i /><i /><i /><i /><i /><i /></div>
            <div className="distribution-targets">
              {distribution.map(({ label, note, icon: Icon }) => <article key={label}><Icon /><div><b>{label}</b><small>{note}</small></div><span>CONNECTED</span></article>)}
            </div>
          </div>
          <div className="pitch-callout"><RefreshCw /><div><b>Update once</b><p>Availability, media and corrections flow from the canonical record. Distribution stays traceable.</p></div></div>
        </section>

        <section id="pitch-4" data-pitch-section="3" className="pitch-section pitch-outreach">
          <div className="pitch-heading"><span>04 / OUTREACH FLOW</span><h2>Market intelligence creates movement</h2><p>Accounts work as a controlled network. The planner sees real last-send times, protects the next window and keeps reminders under review.</p></div>
          <div className="outreach-network">
            {outreachAccounts.map(account => <article key={account.name} data-tone={account.tone}><RadioTower /><div><b>{account.name}</b><small>{account.role}</small></div><span>{account.state}</span></article>)}
          </div>
          <div className="outreach-rules">
            <div><b>24h 15m</b><span>minimum protection from the actual last outreach</span></div>
            <div><b>2 hours</b><span>lists can prepare before the permitted send window</span></div>
            <div><b>REVIEW ONLY</b><span>owner rechecks do not become messages by themselves</span></div>
          </div>
          <aside className="ben-workforce"><span>BEN SMART MANAGERS</span><h3>A scalable business-to-customer layer</h3><p>Five Ben accounts can serve client chats, owner conversations and the notification bridge. When an outreach identity is unavailable, selected customer flows can move to a Ben account acting as the owner’s friend. The operating role stays visible and auditable.</p><div><Bot /> OWNER’S FRIEND <ArrowRight /> CLIENT SERVICE <ArrowRight /> BOOKING</div></aside>
        </section>

        <section id="pitch-5" data-pitch-section="4" className="pitch-section pitch-assistants">
          <div className="pitch-heading"><span>05 / OWNER & CLIENT ASSISTANTS</span><h2>Read the conversation before taking action</h2><p>The assistant collects missing facts, closes answered tasks and adapts the next question to the property’s actual state.</p></div>
          <div className="assistant-loop">
            <article><MessageCircle /><span>01</span><h3>Speak</h3><p>Short, natural messages in the identity assigned to the conversation.</p></article>
            <article><Search /><span>02</span><h3>Read</h3><p>New replies, human activity, existing photos and property history load first.</p></article>
            <article><Boxes /><span>03</span><h3>Collect</h3><p>Only missing facts become tasks. Upload closes the collection flow.</p></article>
            <article><Workflow /><span>04</span><h3>Act</h3><p>Agents see availability, booking requests and the reason behind each hold.</p></article>
          </div>
          <div className="availability-timeline">
            <div><span>AVAILABLE DATE</span><b>Market clock starts</b></div><i />
            <div><span>CONFIGURABLE FLOW</span><b>General recheck every 4 days</b></div><i />
            <div><span>DAY 11</span><b>Price review if the agent has not opened one</b></div><i />
            <div><span>EVERY SEND</span><b>Context firewall and contact permission</b></div>
          </div>
          <small className="pitch-disclosure">The timing above is a proposed Ben Estates configuration. It remains adjustable and can run in REVIEW_ONLY mode.</small>
        </section>

        <section id="pitch-6" data-pitch-section="5" className="pitch-section pitch-nexus">
          <div className="nexus-mark"><Sparkles /><span>NEXUS LINK</span></div>
          <div className="pitch-heading"><span>06 / SMART INVENTORY</span><h2>Ben Estates at the front of Malta’s property experience</h2><p>Nexus Link adds location intelligence to the inventory Ben already owns. Visitors can compare homes by the life around them, then move directly into an enquiry or viewing flow.</p></div>
          <div className="nexus-comparison">
            <article><span>LISTING</span><h3>Property facts</h3><p>Price, layout, images and availability stay clear and familiar.</p></article>
            <Link2 />
            <article className="is-nexus"><span>SMART INVENTORY</span><h3>Life around the home</h3><p>Routes, mobility, relevant stores, wellbeing and personal priorities appear when the user asks for them.</p></article>
            <Link2 />
            <article><span>DIRECT ACTION</span><h3>Enquiry or booking</h3><p>Matched context reaches the right agent without losing the property reference.</p></article>
          </div>
          <div className="closing-grid">
            <div><b>For agents</b><p>AI prepares the listing. The agent adds the details, chooses the strongest images and focuses on the client.</p></div>
            <div><b>For Ben Estates</b><p>Direct enquiries and transactions can stay with the agency while smart inventory improves the usefulness of every listing page.</p></div>
            <div><b>For growth</b><p>Measure engagement, qualified enquiries and conversion. Expand SEO pages only where original local evidence supports them.</p></div>
          </div>
          <footer><img src="/argus-logo-wide.png" alt="Argus" /><span>operational intelligence</span><i /><img src="/logo-wide.png" alt="2906" /><span>live property use case</span><i /><b>NEXUS LINK</b><span>smart-data layer</span></footer>
        </section>
      </main>
    </CrmShell>
  )
}
