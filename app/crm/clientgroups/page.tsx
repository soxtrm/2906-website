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
import { crmFetch, crmJson } from '@/lib/crm/api'

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
      </div>
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
  const [data, setData] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [profileDraft, setProfileDraft] = useState<any>({})
  // CG-4: ASSISTANT STEERING — an internal instruction, never sent verbatim
  // to the client (see routes/crmClientgroups.js POST .../steering).
  const [steerText, setSteerText] = useState('')
  const [steerBusy, setSteerBusy] = useState(false)
  const [steerResult, setSteerResult] = useState<any>(null)

  const load = useCallback(() => {
    crmFetch(`clientgroups/${id}`).then(d => {
      setData(d)
      setProfileDraft({
        name: d.client?.name || '', phone: d.client?.phone || '',
        budget_min: d.client?.budget_min ?? '', budget_max: d.client?.budget_max ?? '',
        bedrooms_wanted: (d.client?.bedrooms_wanted || []).join(','),
        property_types: (d.client?.property_types || []).join(', '),
        locations: (d.client?.locations || []).join(', '),
        preferred_locations: (d.client?.preferred_locations || []).join(', '),
        selected_areas: (d.client?.selected_areas || []).join(', '),
        preferred_villages: (d.client?.preferred_villages || []).join(', '),
        top_priority_villages: (d.client?.top_priority_villages || []).join(', '),
        features_wanted: (d.client?.features_wanted || []).join(', '),
        preferred_features: (d.client?.preferred_features || []).join(', '),
        top_priority_features: (d.client?.top_priority_features || []).join(', '),
        move_in_date: d.client?.move_in_date ? String(d.client.move_in_date).slice(0, 10) : '',
        duration_months: d.client?.duration_months ?? '',
        nationalities: (d.client?.nationalities || []).join(', '),
        group_size: d.client?.group_size ?? '',
        pets: d.client?.pets || '', profession: d.client?.profession || '', notes: d.client?.notes || '',
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
        locations: arr(profileDraft.locations),
        preferred_locations: arr(profileDraft.preferred_locations),
        selected_areas: arr(profileDraft.selected_areas),
        preferred_villages: arr(profileDraft.preferred_villages),
        top_priority_villages: arr(profileDraft.top_priority_villages),
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

          {/* controls */}
          <div className="flex flex-wrap gap-2">
            {s.enabled ? (
              <button className={DANGER} disabled={busy} onClick={() => action(`${id}/disable`, 'POST')}>Disable</button>
            ) : (
              <button className={PRIMARY} disabled={busy} onClick={() => action(`${id}/enable`, 'POST')}>Enable</button>
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
          <div>{statusPill(s.status)}</div>

          {/* CG-4: ASSISTANT STEERING — internal instruction channel, never
              sent verbatim to the client. Overrides normal human-silence:
              an explicit instruction here is a conscious delegation. */}
          <div className="rounded-lg border border-navy/10 p-4 bg-off-white/50">
            <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-1">Assistant steering</h3>
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

          {/* profile — full existing filter set, edits hit the match engine immediately */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Client search profile</h3>
            {!s.client_id ? (
              <p className="text-xs text-navy/40">No linked client yet — configure via reply-in-control-channel or !cadd C{s.id} first.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div><label className={LABEL}>Name</label><input className={FIELD} value={profileDraft.name} onChange={e => setProfileDraft((p: any) => ({ ...p, name: e.target.value }))} /></div>
                <div><label className={LABEL}>Phone</label><input className={FIELD} value={profileDraft.phone} onChange={e => setProfileDraft((p: any) => ({ ...p, phone: e.target.value }))} /></div>
                <div><label className={LABEL}>Budget min</label><input className={FIELD} value={profileDraft.budget_min} onChange={e => setProfileDraft((p: any) => ({ ...p, budget_min: e.target.value }))} /></div>
                <div><label className={LABEL}>Budget max</label><input className={FIELD} value={profileDraft.budget_max} onChange={e => setProfileDraft((p: any) => ({ ...p, budget_max: e.target.value }))} /></div>
                <div><label className={LABEL}>Bedrooms (comma-sep)</label><input className={FIELD} value={profileDraft.bedrooms_wanted} onChange={e => setProfileDraft((p: any) => ({ ...p, bedrooms_wanted: e.target.value }))} /></div>
                <div><label className={LABEL}>Move-in date</label><input type="date" className={FIELD} value={profileDraft.move_in_date} onChange={e => setProfileDraft((p: any) => ({ ...p, move_in_date: e.target.value }))} /></div>
                <div><label className={LABEL}>Duration (months)</label><input className={FIELD} value={profileDraft.duration_months} onChange={e => setProfileDraft((p: any) => ({ ...p, duration_months: e.target.value }))} /></div>
                <div><label className={LABEL}>Property types (comma-sep)</label><input className={FIELD} value={profileDraft.property_types} onChange={e => setProfileDraft((p: any) => ({ ...p, property_types: e.target.value }))} /></div>

                <div className="col-span-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-navy/30">Location</div>
                <div className="col-span-2"><label className={LABEL}>Locations (comma-sep)</label><input className={FIELD} value={profileDraft.locations} onChange={e => setProfileDraft((p: any) => ({ ...p, locations: e.target.value }))} /></div>
                <div className="col-span-2"><label className={LABEL}>Preferred locations (comma-sep)</label><input className={FIELD} value={profileDraft.preferred_locations} onChange={e => setProfileDraft((p: any) => ({ ...p, preferred_locations: e.target.value }))} /></div>
                <div className="col-span-2"><label className={LABEL}>Selected areas (comma-sep)</label><input className={FIELD} value={profileDraft.selected_areas} onChange={e => setProfileDraft((p: any) => ({ ...p, selected_areas: e.target.value }))} /></div>
                <div><label className={LABEL}>Preferred villages (comma-sep)</label><input className={FIELD} value={profileDraft.preferred_villages} onChange={e => setProfileDraft((p: any) => ({ ...p, preferred_villages: e.target.value }))} /></div>
                <div><label className={LABEL}>Top-priority villages (comma-sep)</label><input className={FIELD} value={profileDraft.top_priority_villages} onChange={e => setProfileDraft((p: any) => ({ ...p, top_priority_villages: e.target.value }))} /></div>

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
          </div>

          {/* matches */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Matches ({data.matches?.length || 0})</h3>
            <div className="space-y-1.5 max-h-[220px] overflow-y-auto">
              {(data.matches || []).map((m: any) => (
                <div key={m.id} className="flex items-center justify-between text-xs bg-off-white rounded px-3 py-2">
                  <span>#{m.ref} · {m.town} · {m.bedrooms}bed · €{m.price}</span>
                  <span className="text-navy/40">{m.sent_to_client ? (m.client_reaction || 'sent') : 'unsent'} · {m.match_score}pt</span>
                </div>
              ))}
              {(!data.matches || data.matches.length === 0) && <p className="text-xs text-navy/30">No matches yet.</p>}
            </div>
          </div>

          {/* recent events */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-navy/50 mb-2">Recent activity</h3>
            <div className="space-y-1 max-h-[160px] overflow-y-auto">
              {(data.events || []).map((ev: any, i: number) => (
                <div key={i} className="text-[11px] text-navy/50">
                  <span className="font-mono text-navy/30">{fmtTimeAgo(ev.created_at)}</span> — {ev.kind}{ev.reason ? ` (${ev.reason})` : ''}
                </div>
              ))}
            </div>
          </div>
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
