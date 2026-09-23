'use client'
// ============================================================================
// /bookings — the team's viewing diary (Kev, 2026-09-23, booking engine).
// "Man muss perfekten Overview haben": every booked slot across every
// listing, grouped by Malta day, who is going where and when — so agents can
// send clients together — plus every owner-confirmed viewing window that still
// has free slots. Backend: GET /api/crm/schedule-board/bookings (every board
// agent, same auth as the board). Calendar subscribe links for Google /
// Apple / Outlook come from GET schedule-board/calendar-feed.
// Coordination only: nothing here scores or penalises a no-show.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CrmProvider, CrmShell } from '@/lib/crm/ui'
import { crmFetch } from '@/lib/crm/api'
import { type Booking, STATUS_LABEL, dayLabel, maltaDayKey, time12, timeLabel } from '@/lib/crm/booking'

type WindowRow = {
  id: number; propertyId: number; ref: string; town: string | null; kind: 'window' | 'from_date'
  start: string | null; end: string | null; fromDate: string | null; evidence: string | null
}
type Feeds = { mine: string; team: string | null; webcal: string }

const CARD = 'rounded-xl bg-[#141B29] border border-white/10'
const DIM = 'text-[#8B93A6]'
const FAINT = 'text-[#5C6478]'

function BookingsInner() {
  const [scope, setScope] = useState<'all' | 'me'>('all')
  const [days, setDays] = useState(14)
  const [data, setData] = useState<{ bookings: Booking[]; windows: WindowRow[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [feeds, setFeeds] = useState<Feeds | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(() => {
    const from = new Date(Date.now() - 2 * 3600000)
    const to = new Date(from.getTime() + days * 86400000)
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
    if (scope === 'me') q.set('agent', 'me')
    crmFetch(`schedule-board/bookings?${q}`).then(d => { setData(d); setErr(null) }).catch(e => setErr(e?.message || 'Could not load bookings'))
  }, [scope, days])
  useEffect(() => { load() }, [load])
  useEffect(() => { crmFetch('schedule-board/calendar-feed').then(setFeeds).catch(() => {}) }, [])

  const byDay = useMemo(() => {
    const m = new Map<string, Booking[]>()
    for (const b of data?.bookings || []) {
      const key = b.startsAt ? maltaDayKey(b.startsAt) : (b.date || 'undated')
      m.set(key, [...(m.get(key) || []), b])
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [data])

  const copy = (label: string, url: string) => {
    navigator.clipboard?.writeText(url); setCopied(label); setTimeout(() => setCopied(null), 1500)
  }

  const total = data?.bookings.length || 0
  return (
    <CrmShell title="Bookings" subtitle={`${total} upcoming · next ${days} days · Malta time`} dark>
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6 text-[#EDEAE1]">
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'me'] as const).map(k => (
            <button key={k} onClick={() => setScope(k)} data-scope={k}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${scope === k ? 'bg-[#E8B931] text-[#151C2C]' : 'bg-white/5 text-[#8B93A6] hover:text-white'}`}>
              {k === 'all' ? 'Whole team' : 'Mine'}
            </button>
          ))}
          {[7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${days === d ? 'bg-white/15 text-white' : 'bg-white/5 text-[#8B93A6] hover:text-white'}`}>
              {d} days
            </button>
          ))}
        </div>

        {err && <div className="text-sm text-red-400">{err}</div>}

        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            {!data && !err && <div className={DIM}>Loading…</div>}
            {data && !byDay.length && <div className={`${CARD} p-5 text-sm ${DIM}`}>No bookings in this period.</div>}
            {byDay.map(([day, list]) => (
              <div key={day} className={CARD} data-booking-day={day}>
                <div className="px-4 py-2.5 border-b border-white/10 text-sm font-bold">
                  {list[0].startsAt ? dayLabel(list[0].startsAt) : day}
                  <span className={`ml-2 text-xs font-normal ${FAINT}`}>{list.length} booking{list.length === 1 ? '' : 's'}</span>
                </div>
                <div className="divide-y divide-white/5">
                  {list.map(b => (
                    <div key={b.id} className="px-4 py-2.5 flex items-center gap-3" data-overview-booking={b.id}>
                      <div className="w-14 shrink-0 text-sm font-semibold tabular-nums">
                        {b.startsAt ? timeLabel(b.startsAt) : (b.time || '—')}
                        {b.durationMin && <div className={`text-[10px] font-normal ${FAINT}`}>{b.durationMin} min</div>}
                      </div>
                      <span className="w-2 h-8 rounded-full shrink-0" style={{ background: b.agent.colorHex || '#64748b' }} />
                      <div className="grow min-w-0">
                        <div className="text-sm truncate">
                          <b>{b.agent.name || 'Agent'}</b>
                          <span className={DIM}> · </span>
                          <Link href={`/schedule-board?ref=${b.ref}`} className="text-[#E8B931] hover:underline">#{b.ref}</Link>
                          {b.town && <span className={DIM}> · {b.town}</span>}
                        </div>
                        <div className={`text-xs truncate ${DIM}`}>
                          {b.appointmentLabel}
                          {b.party.label ? ` · ${b.party.label}` : b.party.ref ? ` · ${b.party.ref}` : ''}
                          {b.party.size ? ` (${b.party.size})` : ''}
                        </div>
                      </div>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded ${
                        b.status === 'confirmed' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                        {STATUS_LABEL[b.status] || b.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <div className={`${CARD} p-4`}>
              <div className="text-xs font-bold uppercase tracking-wider text-[#E8B931] mb-3">Bookings possible</div>
              {!data?.windows.length && <div className={`text-xs ${DIM}`}>No owner-confirmed viewing times right now.</div>}
              <div className="space-y-2">
                {data?.windows.map(w => (
                  <Link key={w.id} href={`/schedule-board?ref=${w.ref}`} className="block rounded-lg bg-white/5 hover:bg-white/10 px-3 py-2" data-overview-window={w.id}>
                    <div className="text-sm font-semibold">#{w.ref}{w.town ? <span className={DIM}> · {w.town}</span> : null}</div>
                    <div className={`text-xs ${DIM}`}>
                      {w.kind === 'window' && w.start && w.end
                        ? `${dayLabel(w.start)} · ${time12(w.start)}–${time12(w.end)}`
                        : `Viewings from ${w.fromDate ? dayLabel(String(w.fromDate).slice(0, 10) + 'T12:00:00Z') : '?'}`}
                    </div>
                    {w.evidence && <div className={`text-[11px] italic truncate ${FAINT}`}>“{w.evidence}”</div>}
                  </Link>
                ))}
              </div>
            </div>

            <div className={`${CARD} p-4`}>
              <div className="text-xs font-bold uppercase tracking-wider text-[#8B93A6] mb-2">Your calendar</div>
              <div className={`text-xs ${DIM} mb-3`}>
                Subscribe once in Google Calendar (“From URL”), Apple Calendar or Outlook — every booking, move and cancellation follows automatically.
              </div>
              {feeds && (
                <div className="space-y-2">
                  <button onClick={() => copy('mine', feeds.mine)} className="w-full text-left rounded-lg bg-white/5 hover:bg-white/10 px-3 py-2 text-xs" data-feed-mine>
                    {copied === 'mine' ? 'Copied ✓' : 'Copy my viewings feed'}
                  </button>
                  <a href={feeds.webcal} className="block rounded-lg bg-white/5 hover:bg-white/10 px-3 py-2 text-xs">Open in Apple / Outlook (webcal)</a>
                  {feeds.team && (
                    <button onClick={() => copy('team', feeds.team!)} className="w-full text-left rounded-lg bg-white/5 hover:bg-white/10 px-3 py-2 text-xs">
                      {copied === 'team' ? 'Copied ✓' : 'Copy whole-team feed (admin)'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </CrmShell>
  )
}

export default function BookingsPage() {
  return <CrmProvider><BookingsInner /></CrmProvider>
}
