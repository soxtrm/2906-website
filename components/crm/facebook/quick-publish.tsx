'use client'
// One click: publish this listing on the agent's own Facebook Page.
//
// The click uses what the agent already set up on the Facebook integration screen: the default Page, the
// default template and wording, and the listing's own photos in ranked order. Nothing is asked unless it has
// to be: no Page connected yet, several Pages and no default chosen, or the listing is already on that Page.
// The backend validates everything again and owns every token; this file only talks to /api/crm/facebook-pages.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { crmPath } from '@/components/crm/group-navigation'
import { fb, errorMessage, newRequestId, type FbError, type FbPage, type FbPublication, type FbStatus } from '@/lib/crm/facebook'
import { FacebookGlyph } from './shared'

const FINAL = ['published', 'failed', 'reconnect_required', 'needs_review', 'cancelled', 'removed']
const FB_BLUE = '#1877F2'

// The integration status is the same for every listing on the page. It is fetched on the first click, kept
// while it is usable, and fetched again whenever the agent may have changed it (not connected, no Page).
let cached: { at: number; value: FbStatus } | null = null
async function loadStatus(force = false): Promise<FbStatus> {
  if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached.value
  const value = await fb.status()
  const usable = value.configured && value.connection.state === 'active' && value.pages.some(p => p.canPublish)
  cached = usable ? { at: Date.now(), value } : null
  return value
}
export function forgetFacebookStatus() { cached = null }

type Notice =
  | { kind: 'busy'; text: string }
  | { kind: 'ok'; text: string; href?: string | null }
  | { kind: 'err'; text: string }
  | { kind: 'connect'; text: string }
  | { kind: 'choose'; pages: FbPage[] }
  | { kind: 'duplicate'; text: string; page: FbPage }

function pickPage(s: FbStatus): { page: FbPage | null; choose: FbPage[] } {
  const usable = s.pages.filter(p => p.canPublish && p.enabled !== false)
  const def = usable.find(p => p.isDefault)
  if (def) return { page: def, choose: [] }
  if (usable.length === 1) return { page: usable[0], choose: [] }
  return { page: null, choose: usable }
}

export function QuickFacebookButton({
  propertyId, refLabel, noFb, variant = 'icon', size = 14, style, className, onDone,
}: {
  propertyId: number; refLabel?: string | null; noFb?: boolean
  variant?: 'icon' | 'button'; size?: number; style?: React.CSSProperties; className?: string
  onDone?: (p: FbPublication) => void
}) {
  const pathname = usePathname() || '/'
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const requestId = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current) clearTimeout(timer.current) } }, [])

  const label = `#${refLabel || propertyId}`
  const show = useCallback((n: Notice | null, autoHideMs = 0) => {
    if (!alive.current) return
    if (timer.current) clearTimeout(timer.current)
    setNotice(n)
    if (n && autoHideMs) timer.current = setTimeout(() => { if (alive.current) setNotice(cur => (cur === n ? null : cur)) }, autoHideMs)
  }, [])

  const watch = useCallback(async (first: FbPublication, page: FbPage) => {
    let pub = first
    for (let i = 0; i < 40 && alive.current && !FINAL.includes(pub.state); i++) {
      await new Promise(r => setTimeout(r, i < 5 ? 1500 : 3000))
      try { pub = (await fb.publication(pub.id)).publication } catch { /* keep waiting */ }
    }
    if (!alive.current) return
    if (pub.state === 'published') {
      show({ kind: 'ok', text: `${label} is live on ${page.name}.`, href: pub.permalinkUrl }, 12000)
      onDone?.(pub)
    } else if (FINAL.includes(pub.state)) {
      if (pub.state === 'reconnect_required') forgetFacebookStatus()
      show({ kind: pub.state === 'reconnect_required' ? 'connect' : 'err', text: pub.error?.message || `Facebook did not accept the post for ${label} (${pub.stateLabel || pub.state}).` })
    } else {
      show({ kind: 'ok', text: `${label} is queued for ${page.name}. It will appear on the Page shortly.` }, 9000)
      onDone?.(pub)
    }
  }, [label, onDone, show])

  const publish = useCallback(async (opts: { page?: FbPage; confirmDuplicate?: boolean } = {}) => {
    if (busy) return
    setBusy(true)
    show({ kind: 'busy', text: `Preparing ${label} for Facebook…` })
    let used: FbPage | null = opts.page || null
    try {
      const s = await loadStatus()
      if (!s.configured) { show({ kind: 'err', text: 'Facebook publishing is not set up on this system yet.' }, 8000); return }
      if (s.connection.state !== 'active') {
        show({ kind: 'connect', text: s.connection.state === 'reconnect_required' ? 'Your Facebook connection needs to be renewed before you can post.' : 'Connect your Facebook Page once, then every listing posts with one click.' })
        return
      }
      let page = opts.page || null
      if (!page) {
        const picked = pickPage(s)
        if (!picked.page && !picked.choose.length) { show({ kind: 'connect', text: 'None of your Facebook Pages can be posted to yet. Open the Facebook settings to check the Page permissions.' }); return }
        if (!picked.page) { show({ kind: 'choose', pages: picked.choose }); return }
        page = picked.page
      }
      used = page
      const d = await fb.draft(propertyId)
      if (d.blockers.length) { show({ kind: 'err', text: d.blockers[0].message }, 9000); return }
      if (!requestId.current) requestId.current = newRequestId()
      show({ kind: 'busy', text: `Posting ${label} to ${page.name}…` })
      const r = await fb.publish({
        propertyId, pageRowId: page.id, message: d.message,
        images: d.imagesAllowed ? d.images.slice(0, d.maxImages).map(i => i.url) : [],
        includeLink: d.includeLink, idempotencyKey: requestId.current, confirmDuplicate: opts.confirmDuplicate === true,
        language: d.language, templateId: d.templateId,
      })
      requestId.current = ''
      await watch(r.publication, page)
    } catch (e) {
      const err = e as FbError
      const kind = err?.data?.kind
      // already on this Page: ask once, keep the same request id out of it so the confirmed post is a new request
      if (kind === 'duplicate' && used) { requestId.current = ''; show({ kind: 'duplicate', text: errorMessage(e), page: used }); return }
      if (kind === 'auth' || kind === 'permission' || kind === 'not_entitled') forgetFacebookStatus()
      if (kind === 'auth') { show({ kind: 'connect', text: errorMessage(e) }); return }
      requestId.current = ''
      show({ kind: 'err', text: errorMessage(e, `Could not post ${label} to Facebook.`) }, 10000)
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [busy, label, propertyId, show, watch])

  async function choose(page: FbPage, remember: boolean) {
    if (remember) { try { const s = await fb.updatePage(page.id, { isDefault: true }); cached = { at: Date.now(), value: s } } catch { /* the post still goes out */ } }
    publish({ page })
  }

  const title = noFb
    ? 'Marked "no Facebook": the owner does not want it advertised there'
    : 'Post this listing on your Facebook Page'
  const settingsHref = crmPath('/integrations/facebook', pathname)

  return (
    <>
      <button type="button" data-fb-quick-publish={refLabel || propertyId} className={className}
        disabled={noFb || busy} title={title} aria-label={title}
        onClick={e => { e.stopPropagation(); e.preventDefault(); publish() }}
        style={variant === 'icon'
          ? { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, padding: 6, background: 'none', border: 'none', cursor: noFb ? 'not-allowed' : busy ? 'wait' : 'pointer', opacity: noFb ? 0.35 : busy ? 0.6 : 1, lineHeight: 0, flexShrink: 0, ...style }
          : { display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 34, padding: '0 12px', borderRadius: 9, border: `1px solid ${FB_BLUE}`, background: FB_BLUE, color: '#FFF', fontSize: 12.5, fontWeight: 600, cursor: noFb ? 'not-allowed' : busy ? 'wait' : 'pointer', opacity: noFb ? 0.45 : busy ? 0.7 : 1, ...style }}>
        <FacebookGlyph size={size} mono={variant === 'button'} />
        {variant === 'button' && <span>{busy ? 'Posting…' : 'Post to Facebook'}</span>}
      </button>
      {notice && typeof document !== 'undefined' && createPortal(
        <QuickNotice notice={notice} label={label} settingsHref={settingsHref}
          onClose={() => show(null)}
          onChoose={choose}
          onConfirmDuplicate={page => publish({ page, confirmDuplicate: true })} />,
        document.body)}
    </>
  )
}

function QuickNotice({ notice, label, settingsHref, onClose, onChoose, onConfirmDuplicate }: {
  notice: Notice; label: string; settingsHref: string; onClose: () => void
  onChoose: (p: FbPage, remember: boolean) => void; onConfirmDuplicate: (p: FbPage) => void
}) {
  const [remember, setRemember] = useState(true)
  const tone = notice.kind === 'ok' ? '#0E7A45' : notice.kind === 'err' ? '#B3261E' : '#1C2333'
  const box: React.CSSProperties = {
    position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 2147483000,
    width: 'min(440px, calc(100vw - 24px))', background: '#FFF', color: '#1C2333', borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,.28)', border: '1px solid rgba(0,0,0,.08)', padding: '14px 16px',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize: 13.5, lineHeight: 1.45,
  }
  const btn = (primary: boolean): React.CSSProperties => ({
    minHeight: 36, padding: '0 14px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: primary ? `1px solid ${FB_BLUE}` : '1px solid rgba(0,0,0,.15)', background: primary ? FB_BLUE : '#FFF', color: primary ? '#FFF' : '#1C2333',
    textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  })
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div role={notice.kind === 'err' ? 'alert' : 'status'} aria-live="polite" style={box} onClick={stop} onMouseDown={stop} data-fb-quick-notice={notice.kind}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ marginTop: 1, flexShrink: 0 }}><FacebookGlyph size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {notice.kind === 'choose' ? (
            <>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Which Page should {label} go on?</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {notice.pages.map(p => (
                  <button key={p.id} type="button" onClick={() => onChoose(p, remember)} style={{ ...btn(false), justifyContent: 'flex-start', width: '100%' }}>{p.name}</button>
                ))}
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 12.5 }}>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                Always use the Page I pick, without asking again
              </label>
            </>
          ) : (
            <div style={{ color: tone, fontWeight: notice.kind === 'busy' ? 500 : 600, overflowWrap: 'anywhere' }}>{notice.text}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: notice.kind === 'busy' ? 0 : 10, flexWrap: 'wrap' }}>
            {notice.kind === 'ok' && notice.href && <a href={notice.href} target="_blank" rel="noopener noreferrer" style={btn(true)}>View the post</a>}
            {notice.kind === 'connect' && <a href={settingsHref} target="_blank" rel="noopener" style={btn(true)} onClick={() => { forgetFacebookStatus(); onClose() }}>Open Facebook settings</a>}
            {notice.kind === 'duplicate' && <button type="button" style={btn(true)} onClick={() => onConfirmDuplicate(notice.page)}>Post again</button>}
            {notice.kind !== 'busy' && <button type="button" style={btn(false)} onClick={onClose}>{notice.kind === 'duplicate' || notice.kind === 'choose' ? 'Cancel' : 'Close'}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
