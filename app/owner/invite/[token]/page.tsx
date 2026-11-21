'use client'
// /invite/<token> on nexussync.one: accept or decline an invitation to look after an owner's homes.
import { use } from 'react'
import { InviteAccept } from '@/components/owner/live-people-docs'

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  return <InviteAccept token={token} />
}
