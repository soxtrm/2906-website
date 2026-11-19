'use client'
// Preview data layer. Every change goes through engine.ts, exactly like the
// backend will. Swap `buildDemo` for the owner API (docs/owner-workspace) and
// the pages keep working: they only use this hook.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { act, modeSwitchCheck, revokedBy, effectiveDistribution, recipients, type Action } from './engine'
import { buildDemo, type Demo } from './fixtures'
import { MODE_LABEL, MODE_PERIOD, type DocumentItem, type OwnerProfile, type OfferTerms, type AvailabilityRule, type Distribution, type OperatingMode, type Property, type RoomStatus } from './model'
import { extractWishes, mergeWishes, type Wish } from './wishes'

export interface NewProperty {
  propertyType: string; town: string; address: string; bedrooms: number; bathrooms: number; sizeSqm?: number
  offers: { mode: OperatingMode; price: number; terms?: OfferTerms }[]; availableFrom?: string; furnished: string; features: string[]
  description: string; photos: string[]
}

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
  sendMessage: (threadId: string, text: string, propertyId?: number | null) => void
  removeWish: (key: string, propertyId: number | null) => void
  syncAgencies: (propertyId: number) => void
  addWish: (label: string, polarity: 'plus' | 'minus', propertyId: number | null) => void
  addDocument: (d: { title: string; kind: DocumentItem['kind']; propertyId: number; dataUrl?: string; fileName?: string }) => string
  shareDocument: (docId: string, agencies: string[]) => void
  sendDocument: (docId: string) => void
  setNotify: (n: Partial<OwnerProfile['notify']>) => void
  removeDelegate: (name: string) => void
  setProfile: (p: Partial<Pick<OwnerProfile, 'name' | 'photo' | 'phone' | 'email' | 'languages' | 'mainContact'>>) => void
  updateDelegate: (name: string, p: Partial<OwnerProfile['delegates'][number]>) => void
  addDelegate: (d: OwnerProfile['delegates'][number]) => void
  updateRule: (id: string, start: string, end: string) => void
  updateExtra: (id: string, start: string, end: string) => void
  addProperty: (p: NewProperty) => number
  readThread: (threadId: string) => void
  reset: () => void
}

const Ctx = createContext<Store | null>(null)
const KEY = 'argus_owner_preview_v4'

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
          : [...x.offers.map(o => ({ ...o, active: false })), { id: `o${Date.now()}`, mode, price: x.offers[0]?.price || 0, period: MODE_PERIOD[mode], active: true, hidePriceFor: [] }],
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
    sendMessage(threadId, text, propertyId = null) {
      const at = `${data.today}T${new Date().toTimeString().slice(0, 5)}`
      const forAll = /(all|every) (my |of my )?(properties|flats|apartments|places)/i.test(text)
      const scope = forAll ? null : propertyId
      const found = extractWishes(text)
      const fresh: Wish[] = [...found.wishes].sort((a, b) => (a.polarity === b.polarity ? 0 : a.polarity === 'plus' ? -1 : 1)).map((w, i) => ({ ...w, id: `ws${Date.now()}${i}`, propertyId: scope, at }))
      const place = scope === null ? 'all your properties' : data.properties.find(p => p.id === scope)?.name || 'this property'
      const parts: string[] = []
      if (fresh.length) parts.push(`Noted for ${place}: ${fresh.map(w => `${w.polarity === 'plus' ? '+' : '−'} ${w.label}`).join(', ')}.`)
      if (found.protectedRemark) parts.push('One part I cannot keep: nationality, origin or religion may not be used to choose tenants, so ARGUS does not record or filter by it. Everything else is saved.')
      const reply = parts.join(' ') || 'Got it. If this changes a viewing, use the buttons on the request so everyone gets the same update.'
      setData(d => ({
        ...d,
        wishes: mergeWishes(d.wishes, fresh),
        threads: d.threads.map(t => (t.id === threadId ? { ...t, messages: [...t.messages,
          { id: `m${Date.now()}`, from: 'owner', propertyId: scope ?? undefined, at, text },
          { id: `m${Date.now() + 1}`, from: 'argus', sender: { kind: 'system' }, propertyId: scope ?? undefined, at, text: reply },
        ] } : t)),
      }))
    },
    syncAgencies(propertyId) {
      const p = data.properties.find(x => x.id === propertyId)!
      const reach = recipients(effectiveDistribution(data.profile, p), data.agencies, data.today)
      const ids = [...new Set(reach.filter(r => r.agencyId).map(r => r.agencyId!))]
      if (!ids.length) { say('This home is not shared with any agency yet. Switch agencies on first.', 'warn'); return }
      const at = `${data.today}T${new Date().toTimeString().slice(0, 5)}`
      setData(d => ({ ...d, agencySync: { ...d.agencySync, [propertyId]: ids.map(agencyId => ({ agencyId, at })) } }))
      say(`Sent into ${ids.length} agenc${ids.length === 1 ? 'y' : 'ies'}: their ARGUS and walkie-talkie now have ${p.name}.`)
    },
    addWish(label, polarity, propertyId) {
      const clean = label.trim().replace(/\s+/g, ' ')
      if (!clean) return
      // the same check as for chat messages: protected characteristics are never stored
      const probe = extractWishes(clean)
      if (probe.protectedRemark) { say('Nationality, origin or religion cannot be used to choose tenants, so this is not saved.', 'warn'); return }
      const key = probe.wishes[0]?.key || `own:${clean.toLowerCase()}`
      const at = `${data.today}T${new Date().toTimeString().slice(0, 5)}`
      setData(d => ({ ...d, wishes: mergeWishes(d.wishes, [{ id: `ws${Date.now()}`, key, polarity, label: clean, propertyId, quote: clean, at }]) }))
      say(`Added: ${polarity === 'plus' ? '+' : '−'} ${clean}`)
    },
    addDocument(n) {
      const id = `d${Date.now()}`
      setData(d => ({ ...d, documents: [{ id, propertyId: n.propertyId, title: n.title, kind: n.kind, addedAt: d.today, sharedWith: [], dataUrl: n.dataUrl, fileName: n.fileName }, ...d.documents] }))
      say('Document saved. Only you can see it until you share it.')
      return id
    },
    shareDocument(docId, agencies) {
      setData(d => ({ ...d, documents: d.documents.map(x => (x.id === docId ? { ...x, sharedWith: agencies } : x)) }))
      say(agencies.length ? `Shared with ${agencies.join(', ')}. They see it in their ARGUS.` : 'No longer shared. Only you can see it.')
    },
    sendDocument(docId) {
      const doc = data.documents.find(x => x.id === docId)
      if (!doc) return
      const t = data.threads.find(x => x.with === 'ARGUS Main') || data.threads[0]
      const at = `${data.today}T${new Date().toTimeString().slice(0, 5)}`
      setData(d => ({ ...d, threads: d.threads.map(th => (th.id === t.id ? { ...th, messages: [...th.messages,
        { id: `m${Date.now()}`, from: 'owner', propertyId: doc.propertyId, at, text: doc.title, attachment: { docId, title: doc.title, kind: doc.kind } },
        { id: `m${Date.now() + 1}`, from: 'argus', sender: { kind: 'system' }, propertyId: doc.propertyId, at, text: `Got "${doc.title}". It stays private until you share it with an agency (Documents → Share).` },
      ] } : th)) }))
    },
    setNotify(n) { setData(d => ({ ...d, profile: { ...d.profile, notify: { ...d.profile.notify, ...n } } })); say('Saved.') },
    setProfile(p) { setData(d => ({ ...d, profile: { ...d.profile, ...p } })); say('Profile saved.') },
    updateDelegate(name, p) { setData(d => ({ ...d, profile: { ...d.profile, delegates: d.profile.delegates.map(x => (x.name === name ? { ...x, ...p } : x)) } })); say('Saved.') },
    removeDelegate(name) { setData(d => ({ ...d, profile: { ...d.profile, delegates: d.profile.delegates.filter(x => x.name !== name) } })); say(`${name} no longer has access.`) },
    addDelegate(x) { setData(d => ({ ...d, profile: { ...d.profile, delegates: [...d.profile.delegates, x] } })); say(`${x.name} gets an invitation to sign in.`) },
    updateRule(id, start, end) { setData(d => ({ ...d, rules: d.rules.map(r => (r.id === id ? { ...r, start, end } : r)) })); say('Viewing hours changed.') },
    updateExtra(id, start, end) { setData(d => ({ ...d, exceptions: d.exceptions.map(e => (e.id === id ? { ...e, start, end } : e)) })); say('Viewing hours changed for that day.') },
    removeWish(key, propertyId) {
      setData(d => ({ ...d, wishes: d.wishes.filter(w => !(w.key === key && (propertyId === null || w.propertyId === propertyId))) }))
      say('Removed from the list.')
    },
    addProperty(n) {
      const id = Math.max(...data.properties.map(p => p.id)) + 1
      const first = n.offers[0]
      const mode: OperatingMode = first?.mode || 'long_let'
      const prop: Property = {
        id, ref: `2906-D${id}`, name: `${n.propertyType} in ${n.town}`, address: n.address || n.town, town: n.town,
        photos: n.photos.length ? n.photos : ['/link-marketplace/assets/valletta-old-bakery-street.webp'],
        mode, modeHistory: [{ mode, from: data.today }], bedrooms: n.bedrooms, bathrooms: n.bathrooms, sizeSqm: n.sizeSqm,
        listing: 'draft',
        offers: n.offers.map((o, i) => ({ id: `o${id}-${i}`, mode: o.mode, price: o.price, period: MODE_PERIOD[o.mode], active: i === 0, hidePriceFor: [], terms: o.terms })),
        rooms: [], availableFrom: n.availableFrom, lastConfirmedAt: data.today, updatedAt: `${data.today}T${new Date().toTimeString().slice(0, 5)}`,
        distribution: { inherit: true, override: data.profile.defaults }, channels: [],
      }
      setData(d => ({ ...d, properties: [...d.properties, prop] }))
      say(`Sent to ARGUS for checking: ${n.offers.map(o => MODE_LABEL[o.mode]).join(', ')}. It goes live on your channels once verified.`)
      return id
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
