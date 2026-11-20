'use client'
// Preview data layer. Every change goes through engine.ts, exactly like the
// backend will. Swap `buildDemo` for the owner API (docs/owner-workspace) and
// the pages keep working: they only use this hook.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { act, modeSwitchCheck, revokedBy, effectiveDistribution, recipients, type Action } from './engine'
import { buildDemo, buildEmpty, type Demo } from './fixtures'
import { MODE_LABEL, MODE_PERIOD, type Room, type DocumentItem, type OwnerProfile, type OfferTerms, type AvailabilityRule, type Distribution, type OperatingMode, type Property, type RoomStatus } from './model'
import { extractWishes, mergeWishes, type Wish } from './wishes'
import { acceptWaVerify, backfill, checkCode, matchOwner, normalizePhone, waToken, type CodeState, type OwnerDetails, type WaPending } from './identity'
import { sync, liveProperties, type Answer, type LiveAccount, type LiveListing, type LiveMessage, type LiveOwner, type LiveViewing } from './live'

// A home ARGUS confirmed for this owner, in the workspace's own shape. ARGUS stays
// the source; changes go back as owner events for an agent to approve.
function fromArgus(l: LiveListing, today: string, defaults: Property['distribution']['override']): Property {
  const f = l.facts
  const sale = !f.rent && !!f.sale
  const mode: OperatingMode = sale ? 'sale' : 'long_let'
  const price = (sale ? f.sale : f.rent) || 0
  return {
    id: l.sourcePropertyId, ref: l.ref, name: `${f.type || 'Home'} in ${f.locality || 'Malta'}`, address: f.locality || '', town: f.locality || '',
    photos: f.photos.length ? f.photos : ['/link-marketplace/assets/valletta-old-bakery-street.webp'],
    mode, modeHistory: [{ mode, from: today }], bedrooms: f.bedrooms ?? 0, bathrooms: f.bathrooms ?? 0,
    listing: 'live', offers: [{ id: `o${l.sourcePropertyId}`, mode, price, period: MODE_PERIOD[mode], active: true, hidePriceFor: [] }],
    rooms: [], availableFrom: f.availableFrom || undefined, lastConfirmedAt: today, updatedAt: `${today}T00:00`,
    distribution: { inherit: true, override: defaults }, channels: [], propertyType: f.type || undefined, features: f.amenities,
    argus: { externalId: l.externalId, ref: l.ref },
  }
}
const liveMsg = (m: LiveMessage) => ({
  id: `L${m.id}`, from: (m.from === 'owner' ? 'owner' : 'argus') as 'owner' | 'argus', at: String(m.at).slice(0, 16), text: m.text, propertyId: m.propertyId ?? undefined,
  sender: m.from === 'owner' ? undefined : { kind: (m.sender.kind === 'agent' ? 'agent' : 'system') as 'agent' | 'system', name: m.sender.name || undefined, agency: m.sender.org || undefined },
})

async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
}

export interface NewProperty {
  propertyType: string; town: string; address: string; bedrooms: number; bathrooms: number; sizeSqm?: number
  offers: { mode: OperatingMode; price: number; terms?: OfferTerms }[]; availableFrom?: string; furnished: string; features: string[]
  description: string; photos: string[]
}

type Toast = { id: number; text: string; tone: 'ok' | 'warn' | 'err' }

interface Store extends Demo {
  /** true only for the demo with Maria (link with ?demo=1); real owners start empty */
  demo: boolean
  /** the real SYNC account and what ARGUS shares with it (empty in the demo) */
  live: { account: LiveAccount | null; owner: LiveOwner | null; ready: boolean; viewings: LiveViewing[] }
  refreshLive: () => Promise<LiveAccount | null>
  /** run a SYNC action, refresh what ARGUS shares, and say how it went */
  liveDo: <T = Record<string, unknown>>(op: string, body?: Record<string, unknown>, okText?: string) => Promise<Answer<T>>
  setDemo: (on: boolean) => void
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
  signUp: (email: string, password: string, name?: string) => Promise<boolean>
  signIn: (email: string, password: string) => Promise<boolean>
  signUpWith: (provider: 'facebook' | 'google' | 'apple') => boolean
  signOut: () => void
  sendCode: (phone: string) => string | null
  confirmCode: (code: string) => { ok: boolean; reason?: string; homes?: number }
  startWaVerify: () => string
  receiveWa: (fromPhone: string, text: string) => { ok: boolean; reason?: string; homes?: number }
  waPending: WaPending | null
  setDetails: (d: Partial<OwnerDetails>) => void
  pickAgency: (id: string, on: boolean, name: string) => void
  pickMany: (ids: string[]) => void
  setOpenGroups: (g: Partial<{ freelancers: boolean; others: boolean }>) => void
  codeSentTo: string | null
  setProfile: (p: Partial<Pick<OwnerProfile, 'name' | 'photo' | 'phone' | 'email' | 'languages' | 'mainContact'>>) => void
  updateDelegate: (name: string, p: Partial<OwnerProfile['delegates'][number]>) => void
  addDelegate: (d: OwnerProfile['delegates'][number]) => void
  updateRule: (id: string, start: string, end: string) => void
  updateProperty: (id: number, patch: Partial<Pick<Property, 'name' | 'address' | 'town' | 'bedrooms' | 'bathrooms' | 'sizeSqm' | 'availableFrom' | 'description' | 'features' | 'furnished' | 'propertyType'>>) => void
  setPhotos: (id: number, photos: string[]) => void
  tagPhoto: (id: number, url: string, roomId: string | null) => void
  updateRoom: (id: number, roomId: string, patch: Partial<Room>) => void
  setRoomPhotos: (id: number, roomId: string, photos: string[]) => void
  addRoom: (id: number) => void
  removeRoom: (id: number, roomId: string) => boolean
  updateExtra: (id: string, start: string, end: string) => void
  addProperty: (p: NewProperty) => number
  readThread: (threadId: string) => void
  reset: () => void
}

const Ctx = createContext<Store | null>(null)
const KEY = 'argus_owner_preview_v7'
const KEY_REAL = 'sync_owner_v1'

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  // demo only when asked for (?demo=1, remembered); everyone else starts with an empty workspace
  const [demo, setDemoState] = useState(false)
  const [data, setData] = useState<Demo>(() => buildEmpty())
  const [toasts, setToasts] = useState<Toast[]>([])
  // the code lives only in memory: in the real system it is sent to the phone and kept as a hash on the server
  const [code, setCode] = useState<CodeState | null>(null)
  const [wa, setWa] = useState<WaPending | null>(null)
  const loaded = useRef(false)
  const [live, setLive] = useState<Store['live']>({ account: null, owner: null, ready: false, viewings: [] })
  const lastMsg = useRef(0)

  const refreshLive = useCallback(async () => {
    const r = await sync<{ account: LiveAccount; owner: LiveOwner }>('me')
    if (!r.ok) {
      setLive({ account: null, owner: null, ready: true, viewings: [] })
      if (r.status === 401) setData(d => ({ ...d, account: null }))
      return null
    }
    const a = r.account
    const hasHomes = liveProperties(r.owner).length > 0
    const v = hasHomes ? await sync<{ viewings: LiveViewing[] }>('owner/viewings') : null
    setLive({ account: a, owner: r.owner, ready: true, viewings: v && v.ok ? v.viewings : [] })
    setData(d => {
      const known = new Set(d.properties.map(p => p.id))
      const fresh = liveProperties(r.owner).filter(l => !known.has(l.sourcePropertyId)).map(l => fromArgus(l, d.today, d.profile.defaults))
      return {
        ...d,
        account: { email: a.email || a.name || 'SYNC account', pwHash: '', provider: a.email ? 'email' : 'facebook', phone: a.phone?.e164.replace(/^\+/, ''), phoneConfirmed: !!a.phone?.verified, signedIn: true, linked: liveProperties(r.owner).map(l => l.sourcePropertyId) },
        profile: { ...d.profile, name: d.profile.name || a.name, phone: d.profile.phone || a.phone?.e164, email: d.profile.email || a.email || undefined },
        properties: [...d.properties, ...fresh],
      }
    })
    return a
  }, [])

  useEffect(() => {
    let isDemo = false
    try {
      const q = new URLSearchParams(location.search).get('demo')
      if (q === '1') localStorage.setItem('ow_mode', 'demo')
      if (q === '0') localStorage.removeItem('ow_mode')
      isDemo = localStorage.getItem('ow_mode') === 'demo'
    } catch { /* private mode */ }
    setDemoState(isDemo)
    try {
      const raw = localStorage.getItem(isDemo ? KEY : KEY_REAL)
      if (raw) { const saved = JSON.parse(raw) as Demo; if (!isDemo || saved.today === data.today) { setData(saved); loaded.current = true; return } }
    } catch { /* fresh */ }
    setData(isDemo ? buildDemo() : buildEmpty())
    loaded.current = true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loaded.current) try { localStorage.setItem(demo ? KEY : KEY_REAL, JSON.stringify(data)) } catch { /* private mode */ } }, [data, demo])
  useEffect(() => { if (!demo) refreshLive() }, [demo, refreshLive])
  // ARGUS Main chat: new messages from agents and ARGUS arrive here
  useEffect(() => {
    if (demo || !live.account) return
    let stop = false
    const pull = async () => {
      const r = await sync<{ messages: LiveMessage[] }>('messages', { after: lastMsg.current })
      if (stop || !r.ok || !r.messages.length) return
      lastMsg.current = Math.max(lastMsg.current, ...r.messages.map(m => m.id))
      setData(d => {
        const t1 = d.threads.find(t => t.id === 't1')
        if (!t1) return d
        const have = new Set(t1.messages.map(m => m.id))
        const add = r.messages.filter(m => !have.has(`L${m.id}`)).map(liveMsg)
        if (!add.length) return d
        const unread = add.filter(m => m.from !== 'owner').length
        return { ...d, threads: d.threads.map(t => (t.id === 't1' ? { ...t, unread: t.unread + unread, messages: [...t.messages, ...add] } : t)) }
      })
    }
    pull()
    const iv = setInterval(pull, 6000)
    return () => { stop = true; clearInterval(iv) }
  }, [demo, live.account])

  const say = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, text, tone }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200)
  }, [])

  const patchProp = (id: number, fn: (p: Property) => Property) =>
    setData(d => ({ ...d, properties: d.properties.map(p => (p.id === id ? { ...fn(p), updatedAt: `${d.today}T${new Date().toTimeString().slice(0, 5)}` } : p)) }))

  const store: Store = useMemo(() => ({
    ...data, demo, toasts, say, live, refreshLive,
    async liveDo(op, body = {}, okText) {
      const r = await sync(op, body)
      if (!r.ok) say(r.message, 'err')
      else { if (okText) say(okText); await refreshLive() }
      return r as never
    },
    setDemo(on) {
      try { if (on) localStorage.setItem('ow_mode', 'demo'); else localStorage.removeItem('ow_mode') } catch { /* */ }
      setDemoState(on); setData(on ? buildDemo() : buildEmpty())
    },
    codeSentTo: code?.phone || null, waPending: wa,
    startWaVerify() {
      const token = waToken()
      setWa({ token, createdAt: Date.now(), accountEmail: data.account?.email || '' })
      return token
    },
    receiveWa(fromPhone, text) {
      // live: this runs in the ARGUS Main WhatsApp webhook, not in the browser
      const r = acceptWaVerify(wa, fromPhone, text, Date.now())
      if (!r.ok) {
        const why = { no_token: 'Tap "Verify with WhatsApp" first.', expired: 'That took too long. Tap the button again.', mismatch: 'The message did not match. Send it exactly as prepared.', bad_number: 'That number cannot be read.' }[r.reason]
        say(why, 'err'); return { ok: false, reason: why }
      }
      const found = matchOwner(data.argusOwners, r.phone, true)
      const homes = [...new Set(found.flatMap(f => f.propertyIds))]
      setData(d => ({ ...d, account: d.account ? { ...d.account, phone: r.phone, phoneConfirmed: true, linked: homes } : d.account,
        profile: { ...d.profile, phone: `+${r.phone}`, name: d.profile.name || found[0]?.name || '' } }))
      setWa(null)
      say(homes.length ? `WhatsApp confirmed. ${homes.length} home${homes.length === 1 ? '' : 's'} found and linked to you.` : 'WhatsApp confirmed. No homes at ARGUS under this number yet; add your first one.')
      return { ok: true, homes: homes.length }
    },
    async signUp(email, password, name?: string) {
      if (!demo) {
        const r = await sync('signup', { email, password, name: name || '' })
        if (!r.ok) { say(r.message, 'err'); return false }
        await refreshLive(); say('Account created. One more step: your mobile number.')
        return true
      }
      const e = email.trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { say('Please check the email address.', 'err'); return false }
      if (data.account && data.account.email === e) { say('This email already has an account. Sign in instead.', 'warn'); return false }
      const pwHash = await sha256(`${e}:${password}`)
      setData(d => ({ ...d, account: { email: e, pwHash, signedIn: true } }))
      say('Account created. One more step: your mobile number.')
      return true
    },
    signUpWith(provider) {
      const name = { facebook: 'Facebook', google: 'Google', apple: 'Apple' }[provider]
      if (!demo) {
        if (provider === 'facebook') { window.location.href = '/api/auth/facebook/start'; return false }
        say(`${name} sign-in is coming soon. Please use e-mail or Facebook for now.`, 'warn'); return false
      }
      // preview: no provider is contacted; live: OAuth, then the same mobile + code step
      setData(d => ({ ...d, account: d.account?.provider === provider ? { ...d.account, signedIn: true } : { email: `${d.profile.name.toLowerCase()} via ${name}`, pwHash: '', provider, signedIn: true } }))
      say(data.account?.provider === provider && data.account.phoneConfirmed ? `Welcome back, ${data.profile.name}.` : `Signed in with ${name}. One more step: your mobile number.`)
      return true
    },
    async signIn(email, password) {
      if (!demo) {
        const r = await sync('login', { email, password })
        if (!r.ok) { say(r.message, 'err'); return false }
        const a = await refreshLive(); say(`Welcome back${a?.name ? `, ${a.name}` : ''}.`)
        return true
      }
      const e = email.trim().toLowerCase()
      if (!data.account || data.account.email !== e || data.account.pwHash !== await sha256(`${e}:${password}`)) { say('Email or password is not right.', 'err'); return false }
      setData(d => ({ ...d, account: { ...d.account!, signedIn: true } }))
      say(`Welcome back, ${data.profile.name}.`)
      return true
    },
    signOut() {
      if (!demo) { sync('logout'); setLive({ account: null, owner: null, ready: true, viewings: [] }); lastMsg.current = 0; setData(buildEmpty()); say('Signed out.'); return }
      setData(d => ({ ...d, account: d.account ? { ...d.account, signedIn: false } : null })); say('Signed out.')
    },
    sendCode(phone) {
      const n = normalizePhone(phone)
      if (!n) { say('Please check the number, with country code if it is not Maltese.', 'err'); return null }
      const c = String(Math.floor(100000 + Math.random() * 900000))
      setCode({ phone: n, code: c, sentAt: Date.now(), tries: 0 })
      // preview: shown on screen; live: sent by WhatsApp from ARGUS Main, SMS as fallback
      return c
    },
    confirmCode(entered) {
      const r = checkCode(code, entered, Date.now())
      if (r !== 'ok') {
        if (code && r === 'wrong') setCode({ ...code, tries: code.tries + 1 })
        const why = { wrong: 'That code is not right.', expired: 'The code has expired. Send a new one.', locked: 'Too many tries. Send a new code.', none: 'Send a code first.' }[r]
        say(why, 'err'); return { ok: false, reason: why }
      }
      const found = matchOwner(data.argusOwners, code!.phone, true)
      const homes = [...new Set(found.flatMap(f => f.propertyIds))]
      setData(d => ({ ...d, account: d.account ? { ...d.account, phone: code!.phone, phoneConfirmed: true, linked: homes } : d.account,
        profile: { ...d.profile, phone: `+${code!.phone}`, name: d.profile.name || found[0]?.name || '' } }))
      setCode(null)
      say(homes.length ? `Number confirmed. ${homes.length} home${homes.length === 1 ? '' : 's'} found and linked to you.` : 'Number confirmed. No homes at ARGUS under this number yet; add your first one.')
      return { ok: true, homes: homes.length }
    },
    pickAgency(id, on, name) {
      setData(d => ({ ...d, agencyPicks: { ...d.agencyPicks, ids: on ? [...new Set([...d.agencyPicks.ids, id])] : d.agencyPicks.ids.filter(x => x !== id) } }))
      say(on ? `${name} added. If they are not on ARGUS yet, ARGUS invites them; your homes reach them once they join.` : `${name} removed.`)
    },
    pickMany(ids) {
      setData(d => ({ ...d, agencyPicks: { ...d.agencyPicks, ids: [...new Set([...d.agencyPicks.ids, ...ids])] } }))
      say(`${ids.length} agencies added.`)
    },
    setOpenGroups(g) { setData(d => ({ ...d, agencyPicks: { ...d.agencyPicks, ...g } })); say('Saved.') },
    setDetails(next) {
      const merged = { ...data.details, ...next }
      // only empty ARGUS fields are filled from the owner side; differences go to an agent
      const { fill, conflicts } = backfill(data.argusDetails, merged)
      setData(d => ({ ...d, details: merged, argusDetails: { ...d.argusDetails, ...fill } }))
      say(conflicts.length ? `Saved. ARGUS will check ${conflicts.length} detail${conflicts.length === 1 ? '' : 's'} that differ from its records.` : 'Saved. ARGUS uses these for your contracts.')
    },
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
      if (!demo && live.account && threadId === 't1') {
        setData(d => ({ ...d, wishes: mergeWishes(d.wishes, fresh) }))
        sync<{ message: LiveMessage }>('messages/send', { text, propertyId: scope ?? undefined }).then(r => {
          if (!r.ok) { say(r.message, 'err'); return }
          lastMsg.current = Math.max(lastMsg.current, r.message.id)
          setData(d => ({ ...d, threads: d.threads.map(t => (t.id === threadId ? { ...t, messages: [...t.messages.filter(m => m.id !== `L${r.message.id}`), liveMsg(r.message),
            ...(fresh.length || found.protectedRemark ? [{ id: `m${Date.now() + 1}`, from: 'argus' as const, sender: { kind: 'system' as const }, propertyId: scope ?? undefined, at, text: reply }] : []),
          ] } : t)) }))
        })
        return
      }
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
    setNotify(n) {
      setData(d => ({ ...d, profile: { ...d.profile, notify: { ...d.profile.notify, ...n } } })); say('Saved.')
      const ch = (n as { channel?: string }).channel
      if (!demo && live.account && ch && ['whatsapp', 'sms', 'email', 'app'].includes(ch)) sync('account/update', { notifyChannel: ch })
    },
    setProfile(p) { setData(d => ({ ...d, profile: { ...d.profile, ...p } })); say('Profile saved.') },
    updateDelegate(name, p) { setData(d => ({ ...d, profile: { ...d.profile, delegates: d.profile.delegates.map(x => (x.name === name ? { ...x, ...p } : x)) } })); say('Saved.') },
    removeDelegate(name) { setData(d => ({ ...d, profile: { ...d.profile, delegates: d.profile.delegates.filter(x => x.name !== name) } })); say(`${name} no longer has access.`) },
    addDelegate(x) { setData(d => ({ ...d, profile: { ...d.profile, delegates: [...d.profile.delegates, x] } })); say(`${x.name} gets an invitation to sign in.`) },
    updateProperty(id, patch) { patchProp(id, p => ({ ...p, ...patch })); say('Saved. Every channel that shows this home gets the update.') },
    setPhotos(id, photos) {
      patchProp(id, p => ({ ...p, photos, photoRooms: Object.fromEntries(Object.entries(p.photoRooms || {}).filter(([u]) => photos.includes(u))) }))
    },
    tagPhoto(id, url, roomId) {
      patchProp(id, p => { const m = { ...(p.photoRooms || {}) }; if (roomId) m[url] = roomId; else delete m[url]; return { ...p, photoRooms: m } })
    },
    updateRoom(id, roomId, patch) { patchProp(id, p => ({ ...p, rooms: p.rooms.map(r => (r.id === roomId ? { ...r, ...patch } : r)) })) },
    setRoomPhotos(id, roomId, photos) {
      patchProp(id, p => ({ ...p, rooms: p.rooms.map(r => (r.id === roomId ? { ...r, photos, photo: photos[0] || '' } : r)) }))
    },
    addRoom(id) {
      patchProp(id, p => {
        const n = p.rooms.reduce((m, r) => Math.max(m, Number(r.id.split('-R')[1]) || 0), 0) + 1
        return { ...p, rooms: [...p.rooms, { id: `${p.id}-R${n}`, label: `Room ${n}`, photo: '', photos: [], price: p.rooms[0]?.price || 0, status: 'available' }] }
      })
      say('Room added. Give it photos and a price.')
    },
    removeRoom(id, roomId) {
      const p = data.properties.find(x => x.id === id)!
      const r = p.rooms.find(x => x.id === roomId)
      if (r?.status === 'occupied') { say('This room is let. Remove it once the tenant has moved out.', 'err'); return false }
      if (data.requests.some(q => q.roomId === roomId && (q.status === 'confirmed' || q.status === 'awaiting_owner'))) { say('This room has open viewings. Answer or cancel them first.', 'err'); return false }
      patchProp(id, x => ({ ...x, rooms: x.rooms.filter(y => y.id !== roomId) }))
      say('Room removed.')
      return true
    },
    updateRule(id, start, end) { setData(d => ({ ...d, rules: d.rules.map(r => (r.id === id ? { ...r, start, end } : r)) })); say('Viewing hours changed.') },
    updateExtra(id, start, end) { setData(d => ({ ...d, exceptions: d.exceptions.map(e => (e.id === id ? { ...e, start, end } : e)) })); say('Viewing hours changed for that day.') },
    removeWish(key, propertyId) {
      setData(d => ({ ...d, wishes: d.wishes.filter(w => !(w.key === key && (propertyId === null || w.propertyId === propertyId))) }))
      say('Removed from the list.')
    },
    addProperty(n) {
      const id = Math.max(9000, ...data.properties.map(p => p.id)) + 1
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
    reset() { try { localStorage.removeItem(demo ? KEY : KEY_REAL) } catch { /* */ } setData(demo ? buildDemo() : buildEmpty()); say(demo ? 'Demo data reset.' : 'Cleared.') },
  }), [data, demo, toasts, say, code, wa, live, refreshLive]) // eslint-disable-line react-hooks/exhaustive-deps

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

export function useOwner() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useOwner outside OwnerProvider')
  return s
}
