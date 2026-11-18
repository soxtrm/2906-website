'use client'
// Preview data layer. Every change goes through engine.ts, exactly like the
// backend will. Swap `buildDemo` for the owner API (docs/owner-workspace) and
// the pages keep working: they only use this hook.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { act, modeSwitchCheck, revokedBy, effectiveDistribution, type Action } from './engine'
import { buildDemo, type Demo } from './fixtures'
import type { AvailabilityRule, Distribution, OperatingMode, Property, RoomStatus } from './model'

type Toast = { id: number; text: string; tone: 'ok' | 'warn' | 'err' }

interface Store extends Demo {
  toasts: Toast[]
  say: (text: string, tone?: Toast['tone']) => void
  decide: (requestId: string, a: Action, actor?: 'owner' | 'agent' | 'tenant') => boolean
  addRule: (r: Omit<AvailabilityRule, 'id'>) => void
  removeRule: (id: string) => void
  addExtra: (propertyId: number, date: string, start: string, end: string) => void
  removeExtra: (id: string) => void
  blockDay: (propertyId: number, date: string) => void
  unblockDay: (propertyId: number, date: string) => void
  setRoomStatus: (propertyId: number, roomId: string, status: RoomStatus) => void
  setRoomPhoto: (propertyId: number, roomId: string, url: string) => void
  setMode: (propertyId: number, mode: OperatingMode) => { ok: boolean; reasons: string[] }
  setPrice: (propertyId: number, price: number) => void
  setHidePrice: (propertyId: number, agencies: boolean) => void
  setDistribution: (propertyId: number, next: { inherit: boolean; override: Distribution }) => void
  setListing: (propertyId: number, listing: Property['listing']) => void
  setDefaults: (d: Distribution) => void
  sendMessage: (threadId: string, text: string) => void
  readThread: (threadId: string) => void
  reset: () => void
}

const Ctx = createContext<Store | null>(null)
const KEY = 'argus_owner_preview_v1'

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Demo>(() => buildDemo())
  const [toasts, setToasts] = useState<Toast[]>([])
  const loaded = useRef(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) { const saved = JSON.parse(raw) as Demo; if (saved.today === data.today) setData(saved) }
    } catch { /* fresh demo */ }
    loaded.current = true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loaded.current) try { localStorage.setItem(KEY, JSON.stringify(data)) } catch { /* private mode */ } }, [data])

  const say = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, text, tone }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200)
  }, [])

  const patchProp = (id: number, fn: (p: Property) => Property) =>
    setData(d => ({ ...d, properties: d.properties.map(p => (p.id === id ? { ...fn(p), updatedAt: `${d.today}T${new Date().toTimeString().slice(0, 5)}` } : p)) }))

  const store: Store = useMemo(() => ({
    ...data, toasts, say,
    decide(requestId, a, actor = 'owner') {
      const r = data.requests.find(x => x.id === requestId)
      if (!r) return false
      const res = act(r, a, { all: data.requests, rules: data.rules, exceptions: data.exceptions, now: data.now, actor })
      if (!res.ok) { say(res.error, 'err'); return false }
      setData(d => ({ ...d, requests: d.requests.map(x => (x.id === requestId ? res.request : x)) }))
      const words: Record<string, string> = {
        accept: 'Viewing confirmed. The requester has been told.',
        decline: 'Declined. The requester has been told politely.',
        propose: 'New time sent. You will see their answer here.',
        ask: 'Question sent. ARGUS Main will bring back the answer.',
        cancel: 'Viewing cancelled. Everyone involved has been told.',
        accept_proposal: 'They accepted your new time. Viewing confirmed.',
        answer: 'Answer received.', complete: 'Marked as done.',
      }
      say(words[a.type])
      return true
    },
    addRule(r) { setData(d => ({ ...d, rules: [...d.rules, { ...r, id: `w${Date.now()}` }] })); say('Viewing hours saved.') },
    removeRule(id) { setData(d => ({ ...d, rules: d.rules.filter(r => r.id !== id) })); say('Viewing hours removed.') },
    addExtra(propertyId, date, start, end) { setData(d => ({ ...d, exceptions: [...d.exceptions, { id: `x${Date.now()}`, propertyId, date, kind: 'extra', start, end }] })); say('Extra viewing time saved for that day.') },
    removeExtra(id) { setData(d => ({ ...d, exceptions: d.exceptions.filter(e => e.id !== id) })); say('Extra time removed.') },
    blockDay(propertyId, date) { setData(d => ({ ...d, exceptions: [...d.exceptions, { id: `x${Date.now()}`, propertyId, date, kind: 'blocked' }] })); say('Day blocked. No new requests can land on it.') },
    unblockDay(propertyId, date) { setData(d => ({ ...d, exceptions: d.exceptions.filter(e => !(e.propertyId === propertyId && e.date === date && e.kind === 'blocked')) })); say('Day open again.') },
    setRoomStatus(propertyId, roomId, status) {
      patchProp(propertyId, p => ({ ...p, rooms: p.rooms.map(r => (r.id === roomId ? { ...r, status } : r)) }))
      say(status === 'inactive' ? 'Room hidden from new requests.' : 'Room is open for requests again.')
    },
    setRoomPhoto(propertyId, roomId, url) {
      patchProp(propertyId, p => ({ ...p, rooms: p.rooms.map(r => (r.id === roomId ? { ...r, photo: url } : r)) }))
      say('Photo added to the room.')
    },
    setMode(propertyId, mode) {
      const p = data.properties.find(x => x.id === propertyId)!
      const checks = modeSwitchCheck(p, mode, data.requests, data.today)
      const blocks = checks.filter(c => c.level === 'block').map(c => c.text)
      if (blocks.length) return { ok: false, reasons: blocks }
      patchProp(propertyId, x => ({
        ...x, mode,
        modeHistory: [...x.modeHistory.map(h => (h.to ? h : { ...h, to: data.today })), { mode, from: data.today }],
        offers: x.offers.some(o => o.mode === mode)
          ? x.offers.map(o => ({ ...o, active: o.mode === mode }))
          : [...x.offers.map(o => ({ ...o, active: false })), { id: `o${Date.now()}`, mode, price: x.offers[0]?.price || 0, period: mode === 'shortlet' ? 'night' : mode === 'sale' ? 'total' : 'month', active: true, hidePriceFor: [] }],
      }))
      say('Offer changed. Photos, history and identity stay the same.')
      return { ok: true, reasons: checks.map(c => c.text) }
    },
    setPrice(propertyId, price) {
      patchProp(propertyId, p => ({ ...p, offers: p.offers.map(o => (o.active ? { ...o, price } : o)) }))
      say('Price updated on every channel that shows it.')
    },
    setHidePrice(propertyId, agencies) {
      patchProp(propertyId, p => ({ ...p, offers: p.offers.map(o => (o.active ? { ...o, hidePriceFor: agencies ? ['agencies'] : [] } : o)) }))
      say(agencies ? 'Agencies now see "price on request".' : 'Agencies see the price again.')
    },
    setDistribution(propertyId, next) {
      const p = data.properties.find(x => x.id === propertyId)!
      const before = effectiveDistribution(data.profile, p)
      const after = next.inherit ? data.profile.defaults : next.override
      const gone = revokedBy(before, after, data.agencies, data.today)
      patchProp(propertyId, x => ({
        ...x, distribution: next,
        channels: [
          ...x.channels.filter(c => !gone.some(g => (g.agencyId || g.channel) === (c.agencyId || c.channel))),
          ...gone.map(g => ({ channel: g.channel, agencyId: g.agencyId, state: 'delisting' as const, since: `${data.today}T12:00` })),
        ],
      }))
      say(gone.length ? `Saved. ${gone.length} channel${gone.length > 1 ? 's are' : ' is'} being asked to take it down.` : 'Sharing saved.')
    },
    setDefaults(def) {
      setData(d => ({ ...d, profile: { ...d.profile, defaults: def } }))
      const n = data.properties.filter(p => p.distribution.inherit).length
      say(`Defaults saved. ${n} propert${n === 1 ? 'y follows' : 'ies follow'} them.`)
    },
    setListing(propertyId, listing) { patchProp(propertyId, p => ({ ...p, listing })); say(listing === 'live' ? 'Listing is live.' : listing === 'paused' ? 'Listing paused. Nobody new can request it.' : 'Listing is private.') },
    sendMessage(threadId, text) {
      setData(d => ({ ...d, threads: d.threads.map(t => (t.id === threadId ? { ...t, messages: [...t.messages,
        { id: `m${Date.now()}`, from: 'owner', at: `${d.today}T${new Date().toTimeString().slice(0, 5)}`, text },
        { id: `m${Date.now() + 1}`, from: 'argus', at: `${d.today}T${new Date().toTimeString().slice(0, 5)}`, text: t.with === 'ARGUS Main' ? 'Noted. If this changes a viewing, use the buttons on the request so everyone gets the same update.' : `Passed on to ${t.with}. Your phone number stays private.` },
      ] } : t)) }))
    },
    readThread(threadId) { setData(d => ({ ...d, threads: d.threads.map(t => (t.id === threadId ? { ...t, unread: 0 } : t)) })) },
    reset() { try { localStorage.removeItem(KEY) } catch { /* */ } setData(buildDemo()); say('Demo data reset.') },
  }), [data, toasts, say]) // eslint-disable-line react-hooks/exhaustive-deps

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

export function useOwner() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useOwner outside OwnerProvider')
  return s
}
