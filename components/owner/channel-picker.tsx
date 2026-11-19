'use client'
// How ARGUS Main reaches the owner. WhatsApp is the default, but SMS, email or
// "only in SYNC" work just as well: the conversation is the same, only the
// way it is delivered changes, and replies come back into the same chat.
import { Mail, MessageCircle, MessageSquare, Smartphone } from 'lucide-react'
import { CHANNEL_LABEL, type Channel } from '@/lib/owner/model'
import { useOwner } from '@/lib/owner/store'

const ICON = { whatsapp: MessageCircle, sms: MessageSquare, email: Mail, app: Smartphone }
const HINT: Record<Channel, string> = {
  whatsapp: 'Messages and buttons arrive on WhatsApp',
  sms: 'Short texts with a link to answer',
  email: 'One email per request, reply by email',
  app: 'Nothing is sent; you check SYNC',
}

export function ChannelPicker({ onPick }: { onPick?: (c: Channel) => void }) {
  const s = useOwner()
  const cur = s.profile.notify.channel || 'whatsapp'
  return (
    <div className="ow-channel-pick" role="radiogroup" aria-label="How ARGUS reaches you">
      {(Object.keys(CHANNEL_LABEL) as Channel[]).map(c => {
        const Icon = ICON[c]
        return (
          <button type="button" role="radio" aria-checked={cur === c} key={c} data-ch={c}
            onClick={() => { s.setNotify({ channel: c, whatsapp: c === 'whatsapp', email: c === 'email' }); onPick?.(c) }}>
            <Icon size={20} /><b>{CHANNEL_LABEL[c]}</b><small>{HINT[c]}</small>
          </button>
        )
      })}
    </div>
  )
}
