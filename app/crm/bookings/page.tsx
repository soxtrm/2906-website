'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowUpRight, CalendarCheck2, CalendarDays, CheckCircle2, Clock3,
  Copy, Home, MapPin, RefreshCw, Sparkles, Users,
} from 'lucide-react'
import { CrmProvider, CrmShell } from '@/lib/crm/ui'
import { crmFetch } from '@/lib/crm/api'
import { BookingDialog } from '@/components/crm/booking-dialog'
import { Calendar } from '@/components/ui/calendar'
import { type Booking, STATUS_LABEL, dayLabel, maltaDayKey, time12, timeLabel } from '@/lib/crm/booking'

type WindowRow = {
  id: number
  propertyId: number
  ref: string
  town: string | null
  kind: 'window' | 'from_date'
  start: string | null
  end: string | null
  fromDate: string | null
  evidence: string | null
}

type Feeds = { mine: string; team: string | null; webcal: string }
type BookingData = { bookings: Booking[]; windows: WindowRow[] }

const CARD = 'rounded-2xl border border-white/10 bg-[#121A29] shadow-[0_18px_50px_rgba(0,0,0,.18)]'
const DIM = 'text-[#9AA4B8]'
const FAINT = 'text-[#687288]'

function dayKeyFromDate(date: Date) {
  return maltaDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).toISOString())
}

function windowDayKey(window: WindowRow) {
  if (window.start) return maltaDayKey(window.start)
  return window.fromDate ? String(window.fromDate).slice(0, 10) : null
}

function BookingsInner() {
  const [scope, setScope] = useState<'all' | 'me'>('all')
  const [days, setDays] = useState(30)
  const [data, setData] = useState<BookingData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [feeds, setFeeds] = useState<Feeds | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<Date>(new Date())
  const [bookingProperty, setBookingProperty] = useState<{ ref: string; town: string | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    const from = new Date(Date.now() - 2 * 3600000)
    const to = new Date(from.getTime() + days * 86400000)
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
    if (scope === 'me') q.set('agent', 'me')
    crmFetch(`schedule-board/bookings?${q}`)
      .then((next: BookingData) => { setData(next); setErr(null) })
      .catch((e: Error) => setErr(e?.message || 'Could not load bookings'))
  }, [scope, days])

  useEffect(() => { load() }, [load])
  useEffect(() => { crmFetch('schedule-board/calendar-feed').then(setFeeds).catch(() => {}) }, [])

  const activeBookings = useMemo(
    () => (data?.bookings || []).filter(booking => !['cancelled', 'done', 'no_show'].includes(booking.status)),
    [data],
  )

  const bookableProperties = useMemo(() => {
    const unique = new Map<number, WindowRow>()
    for (const window of data?.windows || []) {
      const previous = unique.get(window.propertyId)
      const nextTime = window.start || window.fromDate || '9999'
      const previousTime = previous?.start || previous?.fromDate || '9999'
      if (!previous || nextTime < previousTime) unique.set(window.propertyId, window)
    }
    return [...unique.values()].sort((a, b) => {
      const aTime = a.start || a.fromDate || '9999'
      const bTime = b.start || b.fromDate || '9999'
      return aTime.localeCompare(bTime)
    })
  }, [data])

  const selectedKey = dayKeyFromDate(selectedDate)
  const dayBookings = useMemo(
    () => activeBookings.filter(booking => booking.startsAt && maltaDayKey(booking.startsAt) === selectedKey),
    [activeBookings, selectedKey],
  )
  const dayWindows = useMemo(
    () => (data?.windows || []).filter(window => {
      const key = windowDayKey(window)
      if (!key) return false
      return window.kind === 'from_date' ? key <= selectedKey : key === selectedKey
    }),
    [data, selectedKey],
  )

  const bookingDates = useMemo(
    () => activeBookings.flatMap(booking => booking.startsAt ? [new Date(booking.startsAt)] : []),
    [activeBookings],
  )
  const bookableDates = useMemo(
    () => (data?.windows || []).flatMap(window => {
      const value = window.start || (window.fromDate ? `${String(window.fromDate).slice(0, 10)}T12:00:00` : null)
      return value ? [new Date(value)] : []
    }),
    [data],
  )

  const copy = (label: string, url: string) => {
    navigator.clipboard?.writeText(url)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  const selectedLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Malta', weekday: 'long', day: 'numeric', month: 'long',
  }).format(selectedDate)

  return (
    <CrmShell
      title="Bookings"
      subtitle={`${bookableProperties.length} bookable homes · ${activeBookings.length} scheduled · Malta time`}
      dark
    >
      <div className="mx-auto max-w-7xl space-y-5 px-3 py-4 text-[#F4F1E9] sm:px-5 sm:py-6">
        <section className="relative overflow-hidden rounded-3xl border border-[#7B6CFF]/25 bg-[radial-gradient(circle_at_80%_0%,rgba(82,70,255,.28),transparent_34%),linear-gradient(135deg,#121B2C_0%,#0B1220_58%,#10172A_100%)] p-5 shadow-[0_24px_70px_rgba(0,0,0,.3)] sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-[#39D7C8]/10 blur-3xl" />
          <div className="relative flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#8F84FF]/25 bg-[#7770FF]/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.16em] text-[#BEB8FF]">
                <Sparkles className="size-3.5" /> Live viewing desk
              </div>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Book a property before a booking exists.</h2>
              <p className={`mt-2 max-w-xl text-sm leading-6 ${DIM}`}>
                Owner-confirmed viewing windows and active bookable homes stay visible. Pick a day, see what is open and book directly.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:min-w-[380px]">
              <Metric icon={Home} value={bookableProperties.length} label="Bookable" tone="mint" />
              <Metric icon={CalendarCheck2} value={activeBookings.length} label="Scheduled" tone="violet" />
              <Metric icon={Users} value={new Set(activeBookings.map(b => b.agent.id).filter(Boolean)).size} label="Agents" tone="gold" />
            </div>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-white/10 bg-white/[.035] p-1">
            {(['all', 'me'] as const).map(key => (
              <button key={key} onClick={() => setScope(key)} data-scope={key}
                className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all ${scope === key ? 'bg-[#7770FF] text-white shadow-lg shadow-[#5A50E5]/20' : 'text-[#9AA4B8] hover:bg-white/5 hover:text-white'}`}>
                {key === 'all' ? 'Whole team' : 'Mine'}
              </button>
            ))}
          </div>
          <div className="flex rounded-xl border border-white/10 bg-white/[.035] p-1">
            {[7, 14, 30].map(value => (
              <button key={value} onClick={() => setDays(value)}
                className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all ${days === value ? 'bg-white/12 text-white' : 'text-[#788398] hover:text-white'}`}>
                {value} days
              </button>
            ))}
          </div>
          <button onClick={load} className="ml-auto inline-flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[.035] text-[#9AA4B8] transition hover:-translate-y-0.5 hover:bg-white/10 hover:text-white" aria-label="Refresh bookings">
            <RefreshCw className="size-4" />
          </button>
        </div>

        {err && <div className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>}

        <div className="grid gap-5 xl:grid-cols-[370px_minmax(0,1fr)]">
          <section className={`${CARD} overflow-hidden`}>
            <div className="border-b border-white/8 px-5 py-4">
              <div className="flex items-center gap-2 font-semibold"><CalendarDays className="size-4 text-[#8F84FF]" /> Viewing calendar</div>
              <p className={`mt-1 text-xs ${DIM}`}>Violet = booking · green = property is bookable</p>
            </div>
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={date => date && setSelectedDate(date)}
              modifiers={{ hasBooking: bookingDates, bookable: bookableDates }}
              modifiersClassNames={{
                hasBooking: '!bg-[#756CFF]/25 !text-white after:absolute after:bottom-1 after:size-1 after:rounded-full after:bg-[#9C95FF]',
                bookable: 'ring-1 ring-inset ring-[#46D7A0]/55',
              }}
              className="mx-auto w-full bg-transparent p-4 [--cell-size:42px] sm:[--cell-size:44px]"
              classNames={{
                month: 'flex w-full flex-col gap-4',
                month_grid: 'w-full border-collapse',
                weekdays: 'flex w-full',
                weekday: 'flex-1 text-center text-[11px] font-medium text-[#687288]',
                week: 'mt-2 flex w-full',
                day: 'relative aspect-square h-full w-full p-0 text-center',
                today: 'rounded-lg bg-white/8 text-[#EFCF68]',
                selected: 'rounded-lg !bg-[#7770FF] !text-white',
                outside: 'text-[#465064] opacity-50',
              }}
            />
          </section>

          <section className={`${CARD} min-h-[420px] overflow-hidden`}>
            <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
              <div>
                <div className="text-lg font-bold">{selectedLabel}</div>
                <div className={`text-xs ${DIM}`}>{dayWindows.length} bookable · {dayBookings.length} scheduled</div>
              </div>
              <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-[#AFA8FF]">Malta time</div>
            </div>
            <div className="grid gap-3 p-3 sm:p-5 lg:grid-cols-2">
              {dayWindows.map((window, index) => (
                <motion.article
                  key={`window-${window.id}-${window.kind}`}
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .035 }}
                  className="group rounded-2xl border border-emerald-300/15 bg-[linear-gradient(145deg,rgba(51,211,153,.11),rgba(255,255,255,.025))] p-4 transition hover:-translate-y-0.5 hover:border-emerald-300/30"
                  data-bookable-property={window.ref}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-400/12 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300"><CheckCircle2 className="size-3" /> Bookable</div>
                      <h3 className="truncate text-base font-bold">#{window.ref}</h3>
                      <div className={`mt-1 flex items-center gap-1.5 text-xs ${DIM}`}><MapPin className="size-3.5" />{window.town || 'Malta'}</div>
                    </div>
                    <Home className="size-5 text-emerald-300/70 transition-transform group-hover:scale-110" />
                  </div>
                  <div className="mt-4 flex items-center gap-2 text-sm font-medium">
                    <Clock3 className="size-4 text-[#AFA8FF]" />
                    {window.kind === 'window' && window.start && window.end
                      ? `${time12(window.start)}–${time12(window.end)}`
                      : `Viewings from ${window.fromDate ? dayLabel(`${String(window.fromDate).slice(0, 10)}T12:00:00Z`) : 'this date'}`}
                  </div>
                  {window.evidence && <p className={`mt-2 line-clamp-2 text-xs italic ${FAINT}`}>“{window.evidence}”</p>}
                  <button onClick={() => setBookingProperty({ ref: window.ref, town: window.town })}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-3 py-2.5 text-xs font-bold text-[#08231A] shadow-[0_8px_24px_rgba(52,211,153,.16)] transition hover:-translate-y-0.5 hover:bg-emerald-300">
                    <CalendarCheck2 className="size-4" /> View slots & book
                  </button>
                </motion.article>
              ))}

              {dayBookings.map((booking, index) => (
                <motion.article key={`booking-${booking.id}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .035 }}
                  className="rounded-2xl border border-[#8F84FF]/18 bg-[#7770FF]/[.075] p-4" data-overview-booking={booking.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xl font-bold tabular-nums">{booking.startsAt ? timeLabel(booking.startsAt) : booking.time || '—'}</span>
                    <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${booking.status === 'confirmed' ? 'bg-emerald-400/12 text-emerald-300' : 'bg-amber-400/12 text-amber-300'}`}>
                      {STATUS_LABEL[booking.status] || booking.status}
                    </span>
                  </div>
                  <div className="mt-3 text-sm font-semibold">{booking.agent.name || 'Agent'} · #{booking.ref}</div>
                  <div className={`mt-1 text-xs ${DIM}`}>{booking.town || 'Malta'} · {booking.appointmentLabel}{booking.durationMin ? ` · ${booking.durationMin} min` : ''}</div>
                  {booking.party.label && <div className={`mt-2 text-xs ${DIM}`}><Users className="mr-1 inline size-3.5" />{booking.party.label}</div>}
                  {booking.ref && <button onClick={() => setBookingProperty({ ref: booking.ref!, town: booking.town })} className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#B9B3FF] hover:text-white">Open booking <ArrowUpRight className="size-3.5" /></button>}
                </motion.article>
              ))}

              {data && !dayWindows.length && !dayBookings.length && (
                <div className="col-span-full flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[.02] px-6 text-center">
                  <CalendarDays className="mb-3 size-8 text-[#687288]" />
                  <div className="font-semibold">Nothing planned for this day</div>
                  <p className={`mt-1 max-w-sm text-sm ${DIM}`}>Choose a green or violet day, or use a bookable property below to open its viewing slots.</p>
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Bookable properties</h2>
              <p className={`text-xs ${DIM}`}>Active homes with owner-confirmed viewing information</p>
            </div>
            <span className="text-xs font-semibold text-emerald-300">{bookableProperties.length} open</span>
          </div>
          {!data && !err && <div className={`${CARD} p-6 text-sm ${DIM}`}>Loading bookable properties…</div>}
          {data && !bookableProperties.length && (
            <div className={`${CARD} p-6 text-sm ${DIM}`}>No owner-confirmed viewing windows in the selected period. Active bookings will still appear in the calendar.</div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {bookableProperties.map(window => (
              <article key={`property-${window.propertyId}`} className={`${CARD} group flex items-center gap-3 p-3.5 transition hover:-translate-y-0.5 hover:border-[#8F84FF]/35`}>
                <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><Home className="size-5" /></div>
                <div className="min-w-0 grow">
                  <div className="truncate text-sm font-bold">#{window.ref} · {window.town || 'Malta'}</div>
                  <div className={`mt-1 truncate text-xs ${DIM}`}>
                    {window.start && window.end ? `${dayLabel(window.start)} · ${time12(window.start)}–${time12(window.end)}` : `Viewings from ${window.fromDate ? dayLabel(`${String(window.fromDate).slice(0, 10)}T12:00:00Z`) : 'confirmed date'}`}
                  </div>
                </div>
                <button onClick={() => setBookingProperty({ ref: window.ref, town: window.town })} aria-label={`Book ${window.ref}`} className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#7770FF] text-white transition group-hover:scale-105 group-hover:bg-[#8A82FF]"><ArrowUpRight className="size-4" /></button>
              </article>
            ))}
          </div>
        </section>

        <section className={`${CARD} p-4 sm:p-5`}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="max-w-xl">
              <div className="flex items-center gap-2 text-sm font-bold"><CalendarCheck2 className="size-4 text-[#AFA8FF]" /> Calendar sync</div>
              <p className={`mt-1 text-xs leading-5 ${DIM}`}>Subscribe once in Google Calendar, Apple Calendar or Outlook. New bookings, moves and cancellations update automatically.</p>
            </div>
            {feeds && (
              <div className="flex flex-wrap gap-2">
                <button onClick={() => copy('mine', feeds.mine)} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-semibold transition hover:bg-white/10" data-feed-mine>
                  <Copy className="size-3.5" />{copied === 'mine' ? 'Copied' : 'My calendar feed'}
                </button>
                <a href={feeds.webcal} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-semibold transition hover:bg-white/10"><CalendarDays className="size-3.5" />Apple / Outlook</a>
                {feeds.team && <button onClick={() => copy('team', feeds.team!)} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-semibold transition hover:bg-white/10">{copied === 'team' ? 'Copied' : 'Team feed'}</button>}
              </div>
            )}
          </div>
        </section>

        {notice && <div className="fixed bottom-24 left-1/2 z-[90] -translate-x-1/2 rounded-full bg-emerald-400 px-4 py-2 text-xs font-bold text-[#08231A] shadow-xl">{notice}</div>}
        {bookingProperty && (
          <BookingDialog
            refId={bookingProperty.ref}
            town={bookingProperty.town}
            onClose={() => setBookingProperty(null)}
            onDone={message => { setNotice(message); setBookingProperty(null); load(); setTimeout(() => setNotice(null), 3000) }}
            onRequest={() => { window.location.href = `/schedule-board?ref=${encodeURIComponent(bookingProperty.ref)}` }}
          />
        )}
      </div>
    </CrmShell>
  )
}

function Metric({ icon: Icon, value, label, tone }: { icon: typeof Home; value: number; label: string; tone: 'mint' | 'violet' | 'gold' }) {
  const style = tone === 'mint' ? 'text-emerald-300 bg-emerald-400/10' : tone === 'violet' ? 'text-[#B9B3FF] bg-[#7770FF]/12' : 'text-[#F2CF64] bg-[#E8B931]/10'
  return (
    <div className="rounded-2xl border border-white/8 bg-black/15 p-3 backdrop-blur-sm sm:p-4">
      <div className={`mb-2 grid size-7 place-items-center rounded-lg ${style}`}><Icon className="size-3.5" /></div>
      <div className="text-xl font-bold tabular-nums sm:text-2xl">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#788398]">{label}</div>
    </div>
  )
}

export default function BookingsPage() {
  return <CrmProvider><BookingsInner /></CrmProvider>
}
