'use client'
// ============================================================================
// /clientgroups — CLIENTGROUPS 3/7: the operative dashboard for every
// WA CLIENT ASSISTANT-managed conversation.
//
// Data + controls come from /api/crm/clientgroups/* (routes/crmClientgroups.js),
// which reuses services/clientAssistant.js and services/matchEngine.js
// verbatim — no parallel model here either, this page is a thin view over
// the same backend state CG-1/CG-2/CG-6 already built and proved.
//
// Reuses the SAME shell/design tokens as the rest of the CRM (CrmShell,
// Pill, NAVY/gold) rather than inventing a second visual language.
// ============================================================================
import { useEffect, useMemo, useState, useCallback } from 'react'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { crmFetch, crmJson, crmGet } from '@/lib/crm/api'
import { LocationSelector, type LocationSelectorValue } from '@/components/location-selector'
import { NextIntlClientProvider } from 'next-intl'

// LocationSelector calls useTranslations('locations') -- the /crm route tree
// has no [locale] i18n provider (it's internal/English-only, see
// app/crm/layout.tsx). Rather than fork the shared component or drag i18n
// into the whole CRM, wrap just this one usage with the same 'locations'
// strings messages/en.json already carries for the public add-client form --
// the canonical locality dataset this page reuses per Kev's explicit ask.
const LOCATIONS_MESSAGES = {
  locations: {
    any: 'Any', anyInMalta: 'Any in Malta', anyIn: 'Any in {area}',
    keyAreas: 'Areas', narrowerSearch: 'Or narrow your search:',
    priorityHint: 'Single tap = preferred (blue). Double tap = top priority (gold).',
    loading: 'Loading locations…', loadingVillages: 'Loading villages…',
    topPriority: 'top priority', preferred: 'preferred', clearAll: 'Clear all',
  },
}

const FIELD =
  'w-full px-3 py-2 bg-off-white border-0 rounded text-sm text-navy ' +
  'placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-gold/50'
const LABEL = 'block text-[10px] font-semibold uppercase tracking-[0.12em] text-navy/40 mb-1.5'
const PRIMARY =
  'px-3 py-2 rounded bg-navy text-white text-xs font-semibold hover:bg-navy-light ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
const GHOST = 'px-3 py-2 rounded text-xs text-navy/50 hover:text-navy transition-colors border border-navy/10'
const DANGER = 'px-3 py-2 rounded text-xs text-red-600 hover:bg-red-50 transition-colors border border-red-200'

type Clientgroup = {
  id: number; shortCode: string; chatId: string; session: string; clientId: string | null
  label: string; agent: string | null; enabled: boolean; status: string; autoMode: boolean
  engagementState: string | null; hasQueuedAction: boolean
  lastClientMessageAt: string | null; lastHumanMessageAt: string | null; lastAssistantMessageAt: string | null
  unansweredFollowupCount: number; lastAction: string | null; lastActionAt: string | null
  escalatedAt: string | null; escalationReason: string | null
  assignedAgentId: number | null; collaboratorAgentIds: number[]
  pauseUntil: string | null; deliveryFormat: string; dailyTarget: string
  triggerMinHours: number; triggerMaxHours: number
  nextEvalWindowStart: string | null; nextEvalWindowEnd: string | null
  search: {
    budgetMin: number | null; budgetMax: number | null; bedroomsWanted: number[] | null
    locations: string[] | null; moveInDate: string | null; pets: string | null
    nationalities: string[] | null; groupSize: number | null; notes: string | null
  }
  matches: { total: number; unsent: number; sent: number; liked: number; rejected: number }
  createdAt: string; updatedAt: string
}

// ── status pill colours (own small map, same shape as ui.tsx's AVAIL/VIEW) ──
const STATUS_MAP: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  ARMED:                { bg: '#DCFCE7', text: '#15803D', dot: '#22C55E', label: 'Armed' },
  ENABLED_UNCONFIGURED: { bg: '#FEF9C3', text: '#A16207', dot: '#EAB308', label: 'Waiting for config' },
  HUMAN_ACTIVE:         { bg: '#DBEAFE', text: '#1D4ED8', dot: '#3B82F6', label: 'Human active' },
  PAUSED:                { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: 'Paused' },
  DISABLED:              { bg: '#FEE2E2', text: '#B91C1C', dot: '#EF4444', label: 'Disabled' },
}
function statusPill(status: string) {
  const s = STATUS_MAP[status] || { bg: '#F3F4F6', text: '#6B7280', dot: '#9CA3AF', label: status }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, background: s.bg, color: s.text, fontSize: 10, fontWeight: 700 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot }} />{s.label}
    </span>
  )
}
function fmtTimeAgo(iso: string | null) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}
function fmtMoney(n: number | null) { return n == null ? null : `€${Number(n).toLocaleString()}` }

// "Next evaluation: tomorrow 11:40-14:10" -- a WINDOW, never a promised exact
// time (the assistant may still decide WAIT when that check actually fires).
function fmtEvalWindow(start: string | null, end: string | null) {
  if (!start || !end) return null
  const s = new Date(start), e = new Date(end)
  const now = new Date()
  const dayLabel = (d: Date) => {
    const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86400000)
    if (days === 0) return 'today'
    if (days === 1) return 'tomorrow'
    return d.toLocaleDateString(undefined, { weekday: 'short' })
  }
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = s.toDateString() === e.toDateString()
  return sameDay ? `${dayLabel(s)} ${t(s)}–${t(e)}` : `${dayLabel(s)} ${t(s)} – ${dayLabel(e)} ${t(e)}`
}
function fmtDateTime(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
function toDatetimeLocalValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── nationality flags ───────────────────────────────────────────────────
// Deliberately a CURATED whitelist, not "any 2-letter string -> flag": a
// real production data-quality bug (client_assistant_state.nationalities
// occasionally holds corrupted 2-char chunks of a longer word instead of a
// real code, e.g. {se,rb,ia} instead of "Serbian" -- likely an upstream
// extraction bug, out of scope here) means blindly flag-emoji-ing every
// array entry would render wrong flags for those corrupted rows. Only
// entries matching a real, expected-for-this-market code render a flag;
// anything else is silently skipped rather than guessed at.
const KNOWN_NATIONALITY_CODES = new Set([
  'mt','it','fr','de','es','pt','nl','be','lu','ie','gb','se','no','fi','dk',
  'ch','at','pl','cz','sk','hu','ro','bg','gr','hr','si','ee','lv','lt',
  'ru','ua','tr','il','lb','eg','ma','tn','za','ng','gh','ke',
  'us','ca','au','nz','in','cn','jp','kr','ph','th','vn','id','pk','bd',
  'sa','ae','qa','kw','bh','jo','sy','iq','ir','af','al','ba','rs','mk',
])
function flagEmoji(code: string) {
  const c = code.trim().toUpperCase()
  if (c.length !== 2) return null
  return String.fromCodePoint(...[...c].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65))
}
function nationalityFlags(codes: string[] | null | undefined) {
  if (!codes?.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of codes) {
    const c = String(raw || '').trim().toLowerCase()
    if (!KNOWN_NATIONALITY_CODES.has(c) || seen.has(c)) continue
    seen.add(c)
    const f = flagEmoji(c)
    if (f) out.push(f)
    if (out.length >= 3) break
  }
  return out
}

// ── card ─────────────────────────────────────────────────────────────────
function ClientgroupCard({ cg, onOpen }: { cg: Clientgroup; onOpen: () => void }) {
  const searchBits: string[] = []
  if (cg.search.budgetMin || cg.search.budgetMax) {
    searchBits.push(`${fmtMoney(cg.search.budgetMin) || '?'}–${fmtMoney(cg.search.budgetMax) || '?'}`)
  }
  if (cg.search.bedroomsWanted?.length) searchBits.push(`${cg.search.bedroomsWanted.join('/')} bed`)
  if (cg.search.locations?.length) searchBits.push(cg.search.locations.slice(0, 2).join(', '))
  const flags = nationalityFlags(cg.search.nationalities)

  return (
    <div onClick={onOpen} className="cursor-pointer bg-white rounded-lg border border-navy/8 hover:border-gold/40 hover:shadow-md transition-all p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold text-navy text-sm flex items-center gap-1.5">
            {flags.length > 0 && <span title="Nationality">{flags.join(' ')}</span>}
            {cg.label}
          </div>
          <div className="text-[10px] text-navy/40 font-mono mt-0.5">{cg.shortCode} · {cg.session}</div>
        </div>
        {statusPill(cg.status)}
      </div>
      <div className="flex items-center gap-3 mt-2 text-[11px] text-navy/50">
        <span>{cg.enabled ? (cg.autoMode ? '🟢 Auto ON' : '🟡 Manual only') : '⚫ Off'}</span>
        {cg.agent && <span>· {cg.agent}</span>}
        {cg.collaboratorAgentIds?.length > 0 && <span title="Shared with collaborators">· +{cg.collaboratorAgentIds.length}</span>}
      </div>
      {cg.status === 'PAUSED' && cg.pauseUntil && (
        <div className="text-[10px] text-navy/40 mt-1">Paused until {fmtDateTime(cg.pauseUntil)}</div>
      )}
      {cg.status !== 'PAUSED' && cg.enabled && cg.autoMode && fmtEvalWindow(cg.nextEvalWindowStart, cg.nextEvalWindowEnd) && (
        <div className="text-[10px] text-navy/30 mt-1">Next evaluation: {fmtEvalWindow(cg.nextEvalWindowStart, cg.nextEvalWindowEnd)}</div>
      )}
      {searchBits.length > 0 && (
        <div className="text-[11px] text-navy/60 mt-2 truncate">{searchBits.join(' · ')}</div>
      )}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-navy/5">
        <span className="text-[10px] text-navy/40">Last activity {fmtTimeAgo(cg.lastClientMessageAt || cg.lastAssistantMessageAt || cg.lastHumanMessageAt || cg.updatedAt)}</span>
        <span className="text-[10px] font-semibold text-navy/60">
          {cg.matches.total} match{cg.matches.total === 1 ? '' : 'es'}
          {cg.matches.unsent > 0 && <span className="text-gold ml-1">· {cg.matches.unsent} new</span>}
          {cg.hasQueuedAction && <span className="text-blue-500 ml-1">· queued</span>}
        </span>
      </div>
    </div>
  )
}

// ── detail sheet ─────────────────────────────────────────────────────────
function DetailSheet({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { me } = useCrm()
  const [data, setData] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [profileDraft, setProfileDraft] = useState<any>({})
  // CG-4: ASSISTANT STEERING — an internal instruction, never sent verbatim
  // to the client (see routes/crmClientgroups.js POST .../steering).
  const [steerText, setSteerText] = useState('')
  const [steerBusy, setSteerBusy] = useState(false)
  const [steerResult, setSteerResult] = useState<any>(null)
  // Assign/reassign — admin-only, mirrors routes/crmClientgroups.js
  // PATCH .../assign. Reuses the same /board-access roster the CRM already
  // fetches for the Board Access page rather than a second agents lookup.
  const [agentRoster, setAgentRoster] = useState<{ id: number; name: string | null; username: string }[]>([])
  const [assignBusy, setAssignBusy] = useState(false)
  // CLIENTGROUPS -- START FLOW: "Pause Until" date/time input, and the
  // Assigned Agent(s)/settings state below. Kept local to this sheet, saved
  // explicitly (no autosave-on-keystroke) -- same pattern as profileDraft.
  const [pauseUntilInput, setPauseUntilInput] = useState('')
  const [collaboratorIds, setCollaboratorIds] = useState<number[]>([])
  const [collabBusy, setCollabBusy] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<any>({})
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [matchFilter, setMatchFilter] = useState<'all' | 'unsent' | 'sent' | 'liked' | 'rejected'>('all')
  const [matchBusyId, setMatchBusyId] = useState<number | null>(null)
  useEffect(() => {
    if (me?.role !== 'admin') return
    crmFetch('board-access').then(d => setAgentRoster(d.agents || [])).catch(() => {})
  }, [me?.role])

  async function assignAgent(agentId: number | null) {
    setAssignBusy(true); setErr(null)
    try {
      await crmJson(`clientgroups/${id}/assign`, 'PATCH', { agent_id: agentId })
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not assign this clientgroup')
    } finally { setAssignBusy(false) }
  }

  const load = useCallback(() => {
    crmFetch(`clientgroups/${id}`).then(d => {
      setData(d)
      setProfileDraft({
        name: d.client?.name || '', phone: d.client?.phone || '',
        budget_min: d.client?.budget_min ?? '', budget_max: d.client?.budget_max ?? '',
        bedrooms_wanted: (d.client?.bedrooms_wanted || []).join(','),
        property_types: (d.client?.property_types || []).join(', '),
        // CLIENTGROUPS -- structured, canonical values (village/area codes),
        // not free text -- kept as real arrays, driven by <LocationSelector>
        // below, never hand-typed (avoids "Sliema"/"sliema"/typo duplicates).
        selected_areas: (d.client?.selected_areas || []) as string[],
        preferred_villages: (d.client?.preferred_villages || []) as string[],
        top_priority_villages: (d.client?.top_priority_villages || []) as string[],
        features_wanted: (d.client?.features_wanted || []).join(', '),
        preferred_features: (d.client?.preferred_features || []).join(', '),
        top_priority_features: (d.client?.top_priority_features || []).join(', '),
        move_in_date: d.client?.move_in_date ? String(d.client.move_in_date).slice(0, 10) : '',
        duration_months: d.client?.duration_months ?? '',
        nationalities: (d.client?.nationalities || []).join(', '),
        group_size: d.client?.group_size ?? '',
        pets: d.client?.pets || '', profession: d.client?.profession || '', notes: d.client?.notes || '',
      })
      setCollaboratorIds(d.state?.collaborator_agent_ids || [])
      setSettingsDraft({
        delivery_format: d.state?.delivery_format || 'gallery',
        daily_target: d.state?.daily_target || 'dynamic',
        trigger_min_hours: d.state?.trigger_min_hours ?? 18,
        trigger_max_hours: d.state?.trigger_max_hours ?? 22,
        daily_property_limit: d.state?.daily_property_limit ?? 3,
        gallery_daily_limit: d.state?.gallery_daily_limit ?? 2,
        link_daily_limit: d.state?.link_daily_limit ?? 3,
      })
    }).catch(e => setErr(e?.data?.error || e?.message || 'Failed to load'))
  }, [id])
  useEffect(() => { load() }, [load])

  async function action(path: string, method: string, body?: any) {
    setBusy(true); setErr(null)
    try {
      await crmJson(`clientgroups/${path}`, method, body || {})
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Action failed')
    } finally { setBusy(false) }
  }

  async function pauseUntil() {
    if (!pauseUntilInput) return
    setBusy(true); setErr(null)
    try {
      await crmJson(`clientgroups/${id}/pause`, 'POST', { until: new Date(pauseUntilInput).toISOString() })
      setPauseUntilInput('')
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not pause until that time')
    } finally { setBusy(false) }
  }

  async function saveSettings() {
    setSettingsBusy(true); setErr(null)
    try {
      await crmJson(`clientgroups/${id}/settings`, 'PATCH', {
        delivery_format: settingsDraft.delivery_format,
        daily_target: settingsDraft.daily_target,
        trigger_min_hours: Number(settingsDraft.trigger_min_hours),
        trigger_max_hours: Number(settingsDraft.trigger_max_hours),
        daily_property_limit: Number(settingsDraft.daily_property_limit),
        gallery_daily_limit: Number(settingsDraft.gallery_daily_limit),
        link_daily_limit: Number(settingsDraft.link_daily_limit),
      })
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not save settings')
    } finally { setSettingsBusy(false) }
  }

  async function toggleCollaborator(agentId: number) {
    const next = collaboratorIds.includes(agentId)
      ? collaboratorIds.filter(a => a !== agentId)
      : [...collaboratorIds, agentId]
    setCollaboratorIds(next)
    setCollabBusy(true); setErr(null)
    try {
      await crmJson(`clientgroups/${id}/collaborators`, 'PATCH', { agent_ids: next })
      onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not update collaborators')
    } finally { setCollabBusy(false) }
  }

  // ── CLIENTGROUPS -- DASHBOARD MATCH ACTIONS: Gallery / Send Link / Mark
  // Sent / Copy Link, all through the same backend primitive automatic sends
  // use (shared dedup + shared daily cap) ────────────────────────────────
  // The backend now answers IMMEDIATELY ({ok:true, queued:true}) and does the
  // actual WhatsApp send (image downloads + WAHA upload) in the background —
  // it used to await the whole thing inline, which for a multi-photo gallery
  // routinely outran the dashboard proxy's own request timeout and left the
  // button spinning forever with no result ever coming back (2026-09-04 fix).
  // A fast, honest rejection (gate/daily-cap) still comes back synchronously
  // and is shown right away; a queued send instead gets a short delayed
  // refresh so the card flips to SENT once it actually lands, without the
  // agent having to manually reload.
  async function sendMatch(propertyId: number, kind: 'send-gallery' | 'send-link') {
    setMatchBusyId(propertyId); setErr(null)
    try {
      const r = await crmJson(`clientgroups/${id}/matches/${propertyId}/${kind}`, 'POST', {})
      if (r.ok === false) {
        setErr(r.reason === 'daily_cap_reached' || r.reason === 'daily_cap_would_exceed'
          ? `This clientgroup's daily property limit (${data?.state?.daily_property_limit ?? 3}) is already reached today.`
          : r.reason === 'format_cap_reached'
          ? `This clientgroup's ${r.format || ''} limit for today is already reached.`
          : (r.reason || 'Send failed'))
        setMatchBusyId(null)
        load(); onChanged()
        return
      }
      // queued — keep the SENDING… indicator up and poll shortly after.
      setTimeout(() => { load(); onChanged() }, 4000)
      setTimeout(() => { setMatchBusyId(curr => curr === propertyId ? null : curr); load(); onChanged() }, 9000)
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Send failed')
      setMatchBusyId(null)
    }
  }

  async function markSent(propertyId: number) {
    setMatchBusyId(propertyId); setErr(null)
    try {
      await crmJson(`clientgroups/${id}/matches/${propertyId}/mark-sent`, 'POST', {})
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not mark as sent')
    } finally { setMatchBusyId(null) }
  }

  // Kev, 2026-09-04: a fresh clientgroup used to sit at MATCHES (0) until the
  // next scheduled proactive check, which can be almost a day out. This is
  // the manual escape hatch — pure compute, never sends anything.
  const [matchNowBusy, setMatchNowBusy] = useState(false)
  async function matchNow() {
    setMatchNowBusy(true); setErr(null)
    try {
      await crmJson(`clientgroups/${id}/match-now`, 'POST', {})
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not find matches')
    } finally { setMatchNowBusy(false) }
  }

  async function openOrCopyLink(propertyId: number, mode: 'open' | 'copy') {
    setMatchBusyId(propertyId); setErr(null)
    try {
      const r = await crmGet(`clientgroups/${id}/matches/${propertyId}/link`)
      if (mode === 'open') window.open(r.url, '_blank', 'noopener')
      else await navigator.clipboard.writeText(r.url)
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Could not get link')
    } finally { setMatchBusyId(null) }
  }

  async function saveProfile() {
    const arr = (s: string) => s ? s.split(',').map((x: string) => x.trim()).filter(Boolean) : []
    const numOrNull = (s: string) => s === '' || s == null ? null : Number(s)
    setBusy(true); setErr(null)
    try {
      await crmJson(`clientgroups/${id}/profile`, 'PATCH', {
        name: profileDraft.name || null,
        phone: profileDraft.phone || null,
        budget_min: numOrNull(profileDraft.budget_min),
        budget_max: numOrNull(profileDraft.budget_max),
        bedrooms_wanted: profileDraft.bedrooms_wanted
          ? profileDraft.bedrooms_wanted.split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n))
          : [],
        property_types: arr(profileDraft.property_types),
        // locations/preferred_locations have no editable UI any more (see
        // the removed free-text inputs above) — deliberately omitted here so
        // saving the profile can never silently blank out a value that may
        // have been set some other way (e.g. Gemini extraction via !cadd).
        selected_areas: profileDraft.selected_areas || [],
        preferred_villages: profileDraft.preferred_villages || [],
        top_priority_villages: profileDraft.top_priority_villages || [],
        features_wanted: arr(profileDraft.features_wanted),
        preferred_features: arr(profileDraft.preferred_features),
        top_priority_features: arr(profileDraft.top_priority_features),
        move_in_date: profileDraft.move_in_date || null,
        duration_months: numOrNull(profileDraft.duration_months),
        nationalities: arr(profileDraft.nationalities),
        group_size: numOrNull(profileDraft.group_size),
        pets: profileDraft.pets || null,
        profession: profileDraft.profession || null,
        notes: profileDraft.notes || null,
      })
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Save failed')
    } finally { setBusy(false) }
  }

  async function sendSteering() {
    if (!steerText.trim() || steerBusy) return
    setSteerBusy(true); setErr(null)
    try {
      const d = await crmJson(`clientgroups/${id}/steering`, 'POST', { text: steerText })
      setSteerResult(d)
      setSteerText('')
      load(); onChanged()
    } catch (e: any) {
      setErr(e?.data?.error || e?.message || 'Steering instruction failed')
    } finally { setSteerBusy(false) }
  }

  if (!data) {
    return (
      <>
        <div onClick={onClose} className="fixed inset-0 z-[199] bg-navy/20 backdrop-blur-[3px]" />
        <div className="fixed z-[200] bg-white shadow-2xl rounded-xl p-6 inset-x-4 top-1/2 -translate-y-1/2 sm:inset-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-[520px] text-sm text-navy/50">
          {err ? err : 'Loading…'}
        </div>
      </>
    )
  }

  const s = data.state
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-[199] bg-navy/20 backdrop-blur-[3px]" />
      <div className="fixed z-[200] bg-white shadow-2xl flex flex-col inset-x-0 bottom-0 rounded-t-2xl max-h-[90vh] sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[600px] sm:rounded-xl sm:max-h-[88vh]">
        <div className="flex items-start justify-between px-5 sm:px-6 pt-5 pb-4 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-navy tracking-tight">C{s.id} · {data.client?.name || s.client_title || 'Unconfigured'}</h2>
            <p className="text-xs text-navy/40 mt-0.5">{s.chat_id} · {s.session}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded flex items-center justify-center bg-off-white text-navy/40 hover:text-navy">✕</button>
        </div>

        <div className="px-5 sm:px-6 py-5 overflow-y-auto grow space-y-5">
          {err && <div className="rounded bg-red-50 text-red-700 text-xs px-3 py-2">{err}</div>}

          {/* controls — Start / Pause / Pause Until / Resume / Stop
              (Kev's exact vocabulary) over the existing enabled/status/
              auto_mode/pause_until state (no lifecycle change, just the
              dashboard vocabulary + the auto-resume Pause Until adds). */}
          <div className="flex flex-wrap gap-2">
            {s.enabled ? (
              <button className={DANGER} disabled={busy} onClick={() => action(`${id}/stop`, 'POST')}>Stop</button>
            ) : (
              <button className={PRIMARY} disabled={busy} onClick={() => action(`${id}/start`, 'POST')}>Start automation</button>
            )}
            {s.status === 'PAUSED' ? (
              <button className={GHOST} disabled={busy} onClick={() => action(`${id}/resume`, 'POST')}>Resume</button>
            ) : (
              <button className={GHOST} disabled={busy || !s.enabled} onClick={() => action(`${id}/pause`, 'POST')}>Pause</button>
            )}
            <button className={GHOST} disabled={busy} onClick={() => action(`${id}/auto-mode`, 'PATCH', { value: !s.auto_mode })}>
              Auto mode: {s.auto_mode ? 'ON' : 'OFF'}
            </button>
            {s.pending_job_id && (
              <button className={DANGER} disabled={busy} onClick={() => action(`${id}/queue`, 'DELETE')}>Cancel queued action</button>
            )}
          </div>

          {/* Pause Until — auto-returns to RUNNING/ARMED once the clock
              passes (evaluateProactiveOpportunity's own expiry check), no
              separate "resume reminder" needed. */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="datetime-local"
              className={FIELD + ' max-w-[220px]'}
              value={pauseUntilInput}
              onChange={e => setPauseUntilInput(e.target.value)}
              disabled={busy}
            />
            <button className={GHOST} disabled={busy || !pauseUntilInput} onClick={pauseUntil}>Pause until…</button>
            {s.status === 'PAUSED' && s.pause_until && (
              <span className="text-[11px] text-navy/40">Currently paused until {fmtDateTime(s.pause_until)} (auto-resumes)</span>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {statusPill(s.status)}
            {s.engagement_state && (
              <span className="text-[10px] text-navy/40 uppercase tracking-wide">Engagement: {s.engagement_state}</span>
            )}
            {s.enabled && s.status !== 'PAUSED' && fmtEvalWindow(s.next_eval_window_start, s.next_eval_window_end) && (
              <span className="text-[10px] text-navy/40">Next evaluation: {fmtEvalWindow(s.next_eval_window_start, s.next_eval_window_end)}</span>
            )}
          </div>

          {/* Assign agent (primary) + Collaborators (additional agents who
              can act on this SAME clientgroup — Kev's explicit "not separate
              dashboards with duplicated state" requirement: both write the
              one shared client_assistant_state row) — admin-only. */}
          {me?.role === 'admin' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className={LABEL + ' mb-0'}>Primary agent</label>
                <select
                  className={FIELD + ' max-w-[220px]'}
                  disabled={assignBusy}
                  value={s.assigned_agent_id ?? ''}
                  onChange={e => assignAgent(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">— Unassigned —</option>
                  {agentRoster.map(a => (
                    <option key={a.id} value={a.id}>{a.name || a.username}</option>
                  ))}
                </select>
              </div>
              {agentRoster.length > 0 && (
                <div>
                  <label className={LABEL}>Additional collaborators</label>
                  <div className="flex flex-wrap gap-1.5">
                    {agentRoster.filter(a => a.id !== s.assigned_agent_id).map(a => {
                      const active = collaboratorIds.includes(a.id)
                      return (
                        <button
                          key={a.id}
                          type="button"
                          disabled={collabBusy}
                          onClick={() => toggleCollaborator(a.id)}
                          className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                            active ? 'bg-navy text-white border-navy' : 'bg-white text-navy/60 border-gray-200 hover:border-navy/40'
                          }`}
                        >
                          {a.name || a.username}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Delivery settings — Gallery/Link/Auto, daily target, adaptive
              trigger interval range. Gallery stays the default/preferred
              format; the hard 10/day ceiling is enforced server-side
              regardless of what's configured here. */}
          <div className="rounded-lg border border-navy/10 p-4 bg-off-white/50">
            <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-3">Delivery &amp; timing</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>Delivery format</label>
                <select className={FIELD} value={settingsDraft.delivery_format || 'gallery'}
                  onChange={e => setSettingsDraft((p: any) => ({ ...p, delivery_format: e.target.value }))}>
                  <option value="gallery">Gallery (photos + intro)</option>
                  <option value="link">Link</option>
                  <option value="auto">Auto</option>
                </select>
              </div>
              <div>
                <label className={LABEL}>Daily target (soft description)</label>
                <select className={FIELD} value={settingsDraft.daily_target || 'dynamic'}
                  onChange={e => setSettingsDraft((p: any) => ({ ...p, daily_target: e.target.value }))}>
                  <option value="dynamic">Dynamic</option>
                  <option value="1-2">1–2</option>
                  <option value="2-3">2–3</option>
                  <option value="2-4">2–4</option>
                  <option value="3-4">3–4</option>
                </select>
              </div>
              <div>
                <label className={LABEL}>Trigger interval min (hours)</label>
                <input type="number" min={1} max={72} className={FIELD} value={settingsDraft.trigger_min_hours ?? ''}
                  onChange={e => setSettingsDraft((p: any) => ({ ...p, trigger_min_hours: e.target.value }))} />
              </div>
              <div>
                <label className={LABEL}>Trigger interval max (hours)</label>
                <input type="number" min={1} max={72} className={FIELD} value={settingsDraft.trigger_max_hours ?? ''}
                  onChange={e => setSettingsDraft((p: any) => ({ ...p, trigger_max_hours: e.target.value }))} />
              </div>
              <div>
                <label className={LABEL}>Daily property limit (hard, max 10)</label>
                <input type="number" min={1} max={10} className={FIELD} value={settingsDraft.daily_property_limit ?? ''}
                  onChange={e => setSettingsDraft((p: any) => ({ ...p, daily_property_limit: e.target.value }))} />
              </div>
              <div>
                <label className={LABEL}>Gallery limit (hard, max 10)</label>
                <input type="number" min={1} max={10} className={FIELD} value={settingsDraft.gallery_daily_limit ?? ''}
                  onChange={e => setSettingsDraft((p: any) => ({ ...p, gallery_daily_limit: e.target.value }))} />
              </div>
              <div>
                <label className={LABEL}>Link limit (hard, max 10)</label>
                <input type="number" min={1} max={10} className={FIELD} value={settingsDraft.link_daily_limit ?? ''}
                  onChange={e => setSettingsDraft((p: any) => ({ ...p, link_daily_limit: e.target.value }))} />
              </div>
            </div>
            <p className="text-[10px] text-navy/40 mt-2">A range, not a fixed schedule — the assistant picks a natural point inside it based on engagement and available matches, always inside 08:00–20:00 Malta time. The three limits below are hard ceilings shared by manual and automatic sends alike — raise them for an urgent 1–2 day search, lower them for a relaxed one.</p>
            {data.usageToday && (
              <p className="text-[11px] font-semibold text-navy/70 mt-2">
                Today: {data.usageToday.total}/{data.usageToday.dailyLimit} · Gallery: {data.usageToday.gallery}/{data.usageToday.galleryLimit} · Links: {data.usageToday.link}/{data.usageToday.linkLimit}
              </p>
            )}
            <button className={PRIMARY + ' mt-2'} disabled={settingsBusy} onClick={saveSettings}>Save delivery settings</button>
          </div>

          {/* matches — CLIENTGROUPS DASHBOARD MATCH ACTIONS: Gallery/Send
              Link/Open/Copy Link/Mark Sent, all going through the SAME
              backend delivery primitive automatic sends use (shared dedup +
              shared 10/day ceiling with the assistant's own proactive
              sends). Moved to the TOP of the sheet and given more vertical
              room (2026-09-04, Kev's explicit ask) — steering/profile/events
              below are collapsed by default so Matches is what you actually
              see when a clientgroup opens. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50">Matches ({data.matches?.length || 0})</h3>
              <div className="flex items-center gap-2">
                <button disabled={matchNowBusy} onClick={matchNow}
                  title="Run the matching engine right now instead of waiting for the next scheduled check"
                  className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gold/10 text-gold border border-gold/30 hover:bg-gold/20 disabled:opacity-40 transition-colors">
                  {matchNowBusy ? 'Searching…' : 'Find Matches Now'}
                </button>
                <div className="flex gap-1">
                {(['all', 'unsent', 'sent', 'liked', 'rejected'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setMatchFilter(f)}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                      matchFilter === f ? 'bg-navy text-white' : 'bg-off-white text-navy/40 hover:text-navy'
                    }`}
                  >{f}</button>
                ))}
                </div>
              </div>
            </div>
            <div className="space-y-1.5 max-h-[520px] overflow-y-auto">
              {(data.matches || [])
                .filter((m: any) => {
                  if (matchFilter === 'all') return true
                  if (matchFilter === 'unsent') return !m.sent_to_client
                  if (matchFilter === 'sent') return !!m.sent_to_client
                  if (matchFilter === 'liked') return m.client_reaction === 'liked'
                  if (matchFilter === 'rejected') return m.client_reaction === 'rejected'
                  return true
                })
                .map((m: any) => {
                  const isBusy = matchBusyId === m.property_id
                  return (
                    <div key={m.id} className="bg-off-white rounded px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-navy">#{m.ref} · {m.town || '?'} · {m.bedrooms ?? '?'}bed · €{m.price ?? '?'}</span>
                        <span className="text-navy/40 shrink-0">{m.match_score}pt</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-1.5">
                        <div className="text-[10px] uppercase tracking-wide">
                          {m.sent_to_client ? (
                            <span className="text-green-600 font-semibold">
                              SENT{m.sent_via ? ` · ${m.sent_via}` : ''}
                              {m.sent_at && <span className="text-navy/30 font-normal normal-case ml-1">{fmtDateTime(m.sent_at)}</span>}
                              {m.client_reaction && <span className="text-navy/40 font-normal normal-case ml-1">· {m.client_reaction}</span>}
                            </span>
                          ) : isBusy ? (
                            <span className="text-blue-500 font-semibold">SENDING…</span>
                          ) : (
                            <span className="text-navy/40 font-semibold">UNSENT</span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <button disabled={isBusy} onClick={() => sendMatch(m.property_id, 'send-gallery')}
                            className="px-2 py-1 rounded bg-navy text-white text-[10px] font-semibold hover:bg-navy-light disabled:opacity-40">
                            {isBusy ? '…' : 'Gallery'}
                          </button>
                          <button disabled={isBusy} onClick={() => sendMatch(m.property_id, 'send-link')}
                            className="px-2 py-1 rounded border border-navy/20 text-navy text-[10px] font-semibold hover:bg-white disabled:opacity-40">
                            Send Link
                          </button>
                          <button disabled={isBusy} onClick={() => openOrCopyLink(m.property_id, 'open')}
                            title="Open listing" className="px-2 py-1 rounded text-navy/50 text-[10px] hover:text-navy">
                            Open
                          </button>
                          <button disabled={isBusy} onClick={() => openOrCopyLink(m.property_id, 'copy')}
                            title="Copy link" className="px-2 py-1 rounded text-navy/50 text-[10px] hover:text-navy">
                            ⧉
                          </button>
                          {!m.sent_to_client && (
                            <button disabled={isBusy} onClick={() => markSent(m.property_id)}
                              title="Already shared this manually outside the tool" className="px-2 py-1 rounded text-navy/30 text-[10px] hover:text-navy/60">
                              Mark Sent
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              {(!data.matches || data.matches.length === 0) && <p className="text-xs text-navy/30">No matches yet.</p>}
            </div>
          </div>

          {/* CG-4: ASSISTANT STEERING — internal instruction channel, never
              sent verbatim to the client. Overrides normal human-silence:
              an explicit instruction here is a conscious delegation.
              Collapsed by default (2026-09-04, Kev's explicit ask — Matches
              above is what this sheet should lead with). */}
          <details className="rounded-lg border border-navy/10 bg-off-white/50">
            <summary className="cursor-pointer select-none px-4 py-3 text-xs font-bold uppercase tracking-wide text-navy/50">Assistant steering</summary>
            <div className="px-4 pb-4">
            <p className="text-[10px] text-navy/40 mb-2 leading-relaxed">
              Internal instruction only — never sent to the client as-is. The assistant translates it into a natural message when appropriate, and will act even if you recently wrote in this chat yourself (explicit delegation overrides normal human-silence).
            </p>
            <textarea
              className={FIELD}
              rows={2}
              placeholder='e.g. "Continue from here, send two similar modern options." / "Wait until tomorrow." / "Take over from here."'
              value={steerText}
              onChange={e => setSteerText(e.target.value)}
              disabled={steerBusy || !s.client_id}
            />
            <button className={PRIMARY + ' mt-2'} disabled={steerBusy || !steerText.trim() || !s.client_id} onClick={sendSteering}>
              {steerBusy ? 'Thinking…' : 'Send instruction'}
            </button>
            {!s.client_id && <p className="text-[10px] text-navy/30 mt-1">No linked client yet — configure the profile first.</p>}

            {steerResult && (
              <div className={`mt-3 rounded px-3 py-2.5 text-xs ${steerResult.executed === false ? 'bg-amber-50 text-amber-800' : 'bg-green-50 text-green-800'}`}>
                <div className="font-semibold uppercase text-[10px] tracking-wide mb-1">
                  {steerResult.intent} · {steerResult.executed === false ? 'BLOCKED' : 'EXECUTED'}
                </div>
                <div>{steerResult.planSummary}</div>
                {steerResult.blockReason && <div className="mt-1 italic">{steerResult.blockReason}</div>}
                {steerResult.clientMessage && (
                  <div className="mt-1.5 pt-1.5 border-t border-black/5">
                    <span className="text-[10px] uppercase tracking-wide opacity-60">Sent to client:</span> {steerResult.clientMessage}
                  </div>
                )}
              </div>
            )}
            </div>
          </details>

          {/* profile — full existing filter set, edits hit the match engine
              immediately. Collapsed by default, same reasoning as steering
              above. */}
          <details>
            <summary className="cursor-pointer select-none text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Client search profile</summary>
            {!s.client_id ? (
              <p className="text-xs text-navy/40">No linked client yet — configure via reply-in-control-channel or !cadd C{s.id} first.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div><label className={LABEL}>Name</label><input className={FIELD} value={profileDraft.name} onChange={e => setProfileDraft((p: any) => ({ ...p, name: e.target.value }))} /></div>
                <div><label className={LABEL}>Phone</label><input className={FIELD} value={profileDraft.phone} onChange={e => setProfileDraft((p: any) => ({ ...p, phone: e.target.value }))} /></div>
                <div><label className={LABEL}>Budget min</label><input className={FIELD} value={profileDraft.budget_min} onChange={e => setProfileDraft((p: any) => ({ ...p, budget_min: e.target.value }))} /></div>
                <div><label className={LABEL}>Budget max</label><input className={FIELD} value={profileDraft.budget_max} onChange={e => setProfileDraft((p: any) => ({ ...p, budget_max: e.target.value }))} /></div>
                <div><label className={LABEL}>Bedrooms (comma-sep)</label><input className={FIELD} value={profileDraft.bedrooms_wanted} onChange={e => setProfileDraft((p: any) => ({ ...p, bedrooms_wanted: e.target.value }))} /></div>
                <div><label className={LABEL}>Move-in date</label><input type="date" className={FIELD} value={profileDraft.move_in_date} onChange={e => setProfileDraft((p: any) => ({ ...p, move_in_date: e.target.value }))} /></div>
                <div><label className={LABEL}>Duration (months)</label><input className={FIELD} value={profileDraft.duration_months} onChange={e => setProfileDraft((p: any) => ({ ...p, duration_months: e.target.value }))} /></div>
                <div><label className={LABEL}>Property types (comma-sep)</label><input className={FIELD} value={profileDraft.property_types} onChange={e => setProfileDraft((p: any) => ({ ...p, property_types: e.target.value }))} /></div>

                <div className="col-span-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-navy/30">Location</div>
                {/* CLIENTGROUPS fix (2026-09-04): dropped the free-text
                    "Locations"/"Preferred locations" comma-sep inputs Kev
                    called out as still impractical — the canonical selector
                    below is the one real source of truth now; matchEngine.js
                    already merges locations/preferred_locations into the
                    same scoring tier as preferred_villages, so an empty pair
                    here changes nothing about match quality. */}
                {/* CLIENTGROUPS -- canonical, searchable multi-select (Kev's
                    explicit ask): reuses the SAME areas/villages dataset and
                    component the public add-client form already uses, so
                    "Sliema"/"sliema"/typo variants can't happen here and the
                    Match Engine (services/matchEngine.js's scoreLocation)
                    already reads these exact columns directly. */}
                <div className="col-span-2 rounded-lg border border-navy/10 p-3 bg-off-white/40">
                  <NextIntlClientProvider locale="en" messages={LOCATIONS_MESSAGES}>
                    <LocationSelector
                      value={{
                        selectedAreas: profileDraft.selected_areas || [],
                        preferredVillages: profileDraft.preferred_villages || [],
                        topPriorityVillages: profileDraft.top_priority_villages || [],
                      }}
                      onChange={(val: LocationSelectorValue) => setProfileDraft((p: any) => ({
                        ...p,
                        selected_areas: val.selectedAreas,
                        preferred_villages: val.preferredVillages,
                        top_priority_villages: val.topPriorityVillages,
                      }))}
                    />
                  </NextIntlClientProvider>
                </div>

                <div className="col-span-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-navy/30">Property features</div>
                <div className="col-span-2"><label className={LABEL}>Features wanted (comma-sep)</label><input className={FIELD} value={profileDraft.features_wanted} onChange={e => setProfileDraft((p: any) => ({ ...p, features_wanted: e.target.value }))} /></div>
                <div><label className={LABEL}>Preferred features (comma-sep)</label><input className={FIELD} value={profileDraft.preferred_features} onChange={e => setProfileDraft((p: any) => ({ ...p, preferred_features: e.target.value }))} /></div>
                <div><label className={LABEL}>Top-priority features (comma-sep)</label><input className={FIELD} value={profileDraft.top_priority_features} onChange={e => setProfileDraft((p: any) => ({ ...p, top_priority_features: e.target.value }))} /></div>

                <div className="col-span-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-navy/30">Client</div>
                <div><label className={LABEL}>Nationalities (comma-sep)</label><input className={FIELD} value={profileDraft.nationalities} onChange={e => setProfileDraft((p: any) => ({ ...p, nationalities: e.target.value }))} /></div>
                <div><label className={LABEL}>Group size</label><input className={FIELD} value={profileDraft.group_size} onChange={e => setProfileDraft((p: any) => ({ ...p, group_size: e.target.value }))} /></div>
                <div><label className={LABEL}>Pets</label><input className={FIELD} value={profileDraft.pets} onChange={e => setProfileDraft((p: any) => ({ ...p, pets: e.target.value }))} /></div>
                <div><label className={LABEL}>Profession</label><input className={FIELD} value={profileDraft.profession} onChange={e => setProfileDraft((p: any) => ({ ...p, profession: e.target.value }))} /></div>
                <div className="col-span-2"><label className={LABEL}>Notes</label><textarea className={FIELD} rows={2} value={profileDraft.notes} onChange={e => setProfileDraft((p: any) => ({ ...p, notes: e.target.value }))} /></div>
                <div className="col-span-2"><button className={PRIMARY} disabled={busy} onClick={saveProfile}>Save profile</button></div>
              </div>
            )}
          </details>

          {/* recent events — collapsed by default, same reasoning as above. */}
          <details>
            <summary className="cursor-pointer select-none text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Recent activity</summary>
            <div className="space-y-1 max-h-[160px] overflow-y-auto pt-2">
              {(data.events || []).map((ev: any, i: number) => (
                <div key={i} className="text-[11px] text-navy/50">
                  <span className="font-mono text-navy/30">{fmtTimeAgo(ev.created_at)}</span> — {ev.kind}{ev.reason ? ` (${ev.reason})` : ''}
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    </>
  )
}

// ── page ─────────────────────────────────────────────────────────────────
function ClientgroupsInner() {
  const { me } = useCrm()
  const [rows, setRows] = useState<Clientgroup[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    crmFetch('clientgroups').then(d => setRows(d.clientgroups || [])).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!q.trim()) return rows
    const needle = q.toLowerCase()
    return rows.filter(r => r.label.toLowerCase().includes(needle) || (r.agent || '').toLowerCase().includes(needle))
  }, [rows, q])

  return (
    <CrmShell title="Clientgroups" subtitle={`${rows.length} managed conversation${rows.length === 1 ? '' : 's'}`}>
      <div className="mb-4">
        <input className={FIELD + ' max-w-xs'} placeholder="Search by label or agent…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {loading ? (
        <p className="text-sm text-navy/40">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-navy/40">No clientgroups {me?.role === 'admin' ? 'yet' : 'assigned to you yet'}.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(cg => <ClientgroupCard key={cg.id} cg={cg} onOpen={() => setOpenId(cg.id)} />)}
        </div>
      )}
      {openId != null && <DetailSheet id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </CrmShell>
  )
}

export default function ClientgroupsPage() {
  return <CrmProvider><ClientgroupsInner /></CrmProvider>
}
