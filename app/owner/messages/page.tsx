'use client'
import { ArgusChat } from '@/components/owner/chat'
import { WishesPanel } from '@/components/owner/wishes-panel'

export default function Messages() {
  return (
    <>
      <div className="ow-head"><div>
        <h1>Chat</h1>
        <p className="ow-muted ow-chatpage-intro">Everything agents and clients ask reaches you here through ARGUS Main, with the name of who is asking.</p>
      </div></div>
      <div className="ow-dash">
        <ArgusChat className="ow-dash-chat tall" />
        <div className="ow-dash-side"><WishesPanel /></div>
      </div>
    </>
  )
}
