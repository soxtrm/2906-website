'use client'
// Publish to Facebook — four steps inside ARGUS: Page → Photos → Review → Publish.
// The draft comes from the listing's own data (server-side). Nothing reaches
// Facebook before the agent presses "Publish now" on the confirmation step, and
// success is shown only once Meta has returned the post.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { fb, errorMessage, newRequestId, personalShareUrl, TYPE_LABEL, type FbDraft, type FbError, type FbPage, type FbPublication, type FbStatus } from '@/lib/crm/facebook'
import { FacebookGlyph, StateChip, CrmLink, PageAvatar, accentStyle, listingTitle, copyText, fmtWhen } from './shared'

type Step = 1 | 2 | 3 | 4
const STEPS = ['Page', 'Photos', 'Review', 'Publish']
const FINAL = ['published', 'failed', 'reconnect_required', 'needs_review', 'cancelled', 'removed']

export function PublishToFacebookDialog({ propertyId, open, onOpenChange, onDone }: { propertyId: number; open: boolean; onOpenChange: (o: boolean) => void; onDone?: (p: FbPublication) => void }) {
  const [status, setStatus] = useState<FbStatus | null>(null)
  const [draft, setDraft] = useState<FbDraft | null>(null)
  const [loadErr, setLoadErr] = useState<{ message: string; kind?: string } | null>(null)
  const [step, setStep] = useState<Step>(1)
  const [pageId, setPageId] = useState<number | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [edited, setEdited] = useState(false)
  const [opts, setOpts] = useState({ templateId: 'classic', language: 'en' as 'en' | 'mt' | 'de', emojis: true, contact: false, link: true, cta: '' })
  const [regen, setRegen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pub, setPub] = useState<FbPublication | null>(null)
  const [error, setError] = useState<FbError | null>(null)
  const [dupes, setDupes] = useState<FbPublication[] | null>(null)
  const [slow, setSlow] = useState(false)
  const requestId = useRef<string>('')
  const dragFrom = useRef<number | null>(null)

  const reset = useCallback(() => {
    setStatus(null); setDraft(null); setLoadErr(null); setStep(1); setPageId(null); setSelected([]); setMessage(''); setEdited(false)
    setPub(null); setError(null); setDupes(null); setSlow(false); requestId.current = ''
  }, [])

  useEffect(() => {
    if (!open) return
    reset()
    let cancelled = false
    ;(async () => {
      try {
        const s = await fb.status()
        if (cancelled) return
        setStatus(s)
        if (!s.configured || s.connection.state !== 'active') return
        const d = await fb.draft(propertyId)
        if (cancelled) return
        setDraft(d)
        setMessage(d.message)
        setOpts({ templateId: d.templateId, language: d.language, emojis: d.emojis, contact: d.includeContact, link: d.includeLink, cta: s.preferences.callToAction || '' })
        setSelected(d.imagesAllowed ? d.images.slice(0, d.maxImages).map(i => i.url) : [])
        const usable = s.pages.filter(p => p.canPublish)
        setPageId((usable.find(p => p.isDefault) || usable.find(p => p.enabled) || usable[0] || null)?.id ?? null)
      } catch (e) {
        if (!cancelled) setLoadErr({ message: errorMessage(e), kind: (e as FbError)?.data?.kind })
      }
    })()
    return () => { cancelled = true }
  }, [open, propertyId, reset])

  const pages = useMemo(() => (status?.pages || []).filter(p => p.status !== 'disconnected'), [status])
  const page = pages.find(p => p.id === pageId) || null
  const thumbs = useMemo(() => new Map((draft?.images || []).map(i => [i.url, i.thumbnail || i.url])), [draft])
  const type = selected.length > 1 ? 'multi_photo' : selected.length === 1 ? 'photo' : opts.link && draft?.link ? 'link' : 'text'
  const title = draft ? listingTitle(draft.property) : 'Listing'

  async function regenerate(next = opts) {
    if (edited && !confirm('Replace your edited text with a freshly generated advertisement?')) return
    setRegen(true)
    try {
      const d = await fb.draft(propertyId, { templateId: next.templateId, language: next.language, emojis: next.emojis, contact: next.contact, link: next.link, cta: next.cta || undefined })
      setDraft(d); setMessage(d.message); setEdited(false)
    } catch (e) { alert(errorMessage(e)) } finally { setRegen(false) }
  }
  const setOpt = <K extends keyof typeof opts>(k: K, v: (typeof opts)[K]) => { const next = { ...opts, [k]: v }; setOpts(next); if (k !== 'cta') regenerate(next) }

  function toggleImage(url: string) {
    setSelected(cur => cur.includes(url) ? cur.filter(u => u !== url) : cur.length >= (draft?.maxImages || 10) ? cur : [...cur, url])
  }
  function move(i: number, to: number) {
    setSelected(cur => { if (to < 0 || to >= cur.length) return cur; const n = [...cur]; const [x] = n.splice(i, 1); n.splice(to, 0, x); return n })
  }

  async function publish(confirmDuplicate = false) {
    if (!draft || !page) return
    if (!requestId.current) requestId.current = newRequestId()
    setBusy(true); setError(null)
    try {
      const r = await fb.publish({ propertyId, pageRowId: page.id, message, images: selected, includeLink: opts.link, idempotencyKey: requestId.current, confirmDuplicate, language: opts.language, templateId: opts.templateId })
      setDupes(null)
      setPub(r.publication)
    } catch (e) {
      const fe = e as FbError
      if (fe?.data?.kind === 'duplicate') setDupes(fe.data.existing || [])
      else setError(fe)
    } finally { setBusy(false) }
  }

  // Follow the publication until Meta has answered.
  useEffect(() => {
    if (!pub || FINAL.includes(pub.state)) return
    const started = Date.now()
    const t = setInterval(async () => {
      try {
        const r = await fb.publication(pub.id)
        setPub(r.publication)
        if (FINAL.includes(r.publication.state)) { clearInterval(t); onDone?.(r.publication) }
      } catch { /* keep following */ }
      if (Date.now() - started > 45_000) setSlow(true)
    }, 1500)
    return () => clearInterval(t)
  }, [pub, onDone])

  async function retry() {
    if (!pub) return
    setBusy(true)
    try { setPub((await fb.retry(pub.id, pub.state === 'needs_review' && confirm('Did you check your Facebook Page? Publish again only if the post is not there.'))).publication) }
    catch (e) { alert(errorMessage(e)) } finally { setBusy(false) }
  }
  function backToEdit() { setPub(null); setError(null); requestId.current = ''; setStep(3) }

  const canNext = step === 1 ? !!page?.canPublish : step === 2 ? true : step === 3 ? message.trim().length > 0 : false

  // ── body ──────────────────────────────────────────────────────────────────
  let body: React.ReactNode
  let foot: React.ReactNode = null
  if (loadErr) {
    body = <div className="fbp-note" data-tone="bad">{loadErr.kind === 'not_entitled' ? 'Facebook publishing is not enabled for your account yet. Ask an ARGUS administrator to switch it on.' : loadErr.message}</div>
  } else if (!status) {
    body = <div className="fbp-row" style={{ justifyContent: 'center', padding: 40 }}><div className="fbp-spinner" aria-label="Loading" /></div>
  } else if (!status.configured) {
    body = <div className="fbp-note" data-tone="warn">Facebook publishing is not set up on this ARGUS server yet. An administrator needs to finish the Meta app setup first.</div>
  } else if (status.connection.state !== 'active') {
    body = <div className="fbp-stack">
      <div className="fbp-note" data-tone="warn">{status.connection.state === 'reconnect_required' ? 'Your Facebook connection needs to be renewed before you can publish.' : 'Connect your Facebook account once, then publish any of your listings in a few clicks.'}</div>
      <div><CrmLink href="/integrations/facebook" className="fbp-btn fbp-btn-fb"><FacebookGlyph mono size={16} /> {status.connection.state === 'reconnect_required' ? 'Reconnect Facebook' : 'Connect Facebook'}</CrmLink></div>
    </div>
  } else if (!draft) {
    body = <div className="fbp-row" style={{ justifyContent: 'center', padding: 40 }}><div className="fbp-spinner" aria-label="Preparing the advertisement" /></div>
  } else if (draft.blockers.length) {
    body = <div className="fbp-stack">{draft.blockers.map(b => <div key={b.code} className="fbp-note" data-tone="warn">{b.message}</div>)}</div>
  } else if (pub) {
    body = <Outcome pub={pub} page={page} title={title} slow={slow} appId={status.appId} />
    foot = <>
      <span className="fbp-faint">{pub.trigger === 'manual' ? 'Saved to Facebook Publications' : ''}</span>
      <div className="fbp-row">
        {pub.canRetry && <button className="fbp-btn" onClick={backToEdit}>Back to edit</button>}
        {pub.canRetry && pub.state !== 'reconnect_required' && <button className="fbp-btn fbp-btn-primary" disabled={busy} onClick={retry}>Try again</button>}
        {pub.state === 'reconnect_required' && <CrmLink href="/integrations/facebook" className="fbp-btn fbp-btn-fb">Reconnect Facebook</CrmLink>}
        <button className="fbp-btn" onClick={() => onOpenChange(false)}>Close</button>
      </div>
    </>
  } else {
    body = <>
      {step === 1 && <div className="fbp-stack">
        <p className="fbp-sub" style={{ margin: 0 }}>Choose where this advertisement appears. Only Pages you manage and that allow posting are selectable.</p>
        <div className="fbp-stack" role="radiogroup" aria-label="Facebook Page">
          {pages.map(p => <PageOption key={p.id} p={p} selected={p.id === pageId} onSelect={() => p.canPublish && setPageId(p.id)} />)}
        </div>
        <CrmLink href="/integrations/facebook" className="fbp-faint">Manage Pages and defaults</CrmLink>
      </div>}
      {step === 2 && <div className="fbp-stack">
        {!draft.imagesAllowed ? <div className="fbp-note" data-tone="warn">{draft.imagesReason}</div>
          : !draft.images.length ? <div className="fbp-note">This listing has no photos yet. You can publish a text post with the link.</div>
          : <>
            <div className="fbp-row fbp-between"><p className="fbp-sub" style={{ margin: 0 }}>Select up to {draft.maxImages} photos. The first one is the cover.</p>
              <div className="fbp-row"><button className="fbp-btn fbp-btn-sm" onClick={() => setSelected(draft.images.slice(0, draft.maxImages).map(i => i.url))}>Select all</button><button className="fbp-btn fbp-btn-sm" onClick={() => setSelected([])}>None</button></div></div>
            {selected.length > 0 && <div>
              <div className="fbp-label" style={{ marginBottom: 6 }}>Order · drag or use the arrows</div>
              <div className="fbp-order">
                {selected.map((u, i) => (
                  <div key={u} className="fbp-order-item" draggable onDragStart={() => { dragFrom.current = i }} onDragOver={e => e.preventDefault()} onDrop={() => { if (dragFrom.current != null) move(dragFrom.current, i); dragFrom.current = null }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={thumbs.get(u)} alt={`Photo ${i + 1}${i === 0 ? ' (cover)' : ''}`} />
                    <div className="fbp-row">
                      <button className="fbp-btn fbp-btn-sm fbp-btn-ghost" aria-label={`Move photo ${i + 1} left`} disabled={i === 0} onClick={() => move(i, i - 1)}>←</button>
                      {i === 0 ? <span className="fbp-cover-tag">COVER</span> : <button className="fbp-btn fbp-btn-sm fbp-btn-ghost" style={{ fontSize: 10 }} title="Make this the cover photo" onClick={() => move(i, 0)}>Cover</button>}
                      <button className="fbp-btn fbp-btn-sm fbp-btn-ghost" aria-label={`Move photo ${i + 1} right`} disabled={i === selected.length - 1} onClick={() => move(i, i + 1)}>→</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>}
            <div className="fbp-grid-imgs">
              {draft.images.map((im, i) => {
                const pos = selected.indexOf(im.url)
                return <button key={im.url} className="fbp-img" aria-pressed={pos >= 0} aria-label={`Photo ${i + 1}${pos >= 0 ? `, selected as number ${pos + 1}` : ''}`} onClick={() => toggleImage(im.url)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={im.thumbnail || im.url} alt="" loading="lazy" />
                  {pos >= 0 && <span className="fbp-badge">{pos + 1}</span>}
                  {pos === 0 && <span className="fbp-cover">COVER</span>}
                </button>
              })}
            </div>
            <span className="fbp-faint">{selected.length} of {draft.images.length} selected{selected.length >= draft.maxImages ? ` · maximum ${draft.maxImages}` : ''}</span>
          </>}
      </div>}
      {step === 3 && <div className="fbp-review">
        <div className="fbp-stack">
          <div className="fbp-controls">
            <label className="fbp-stack" style={{ gap: 4 }}><span className="fbp-label">Template</span>
              <select className="fbp-select" value={opts.templateId} disabled={regen} onChange={e => setOpt('templateId', e.target.value)}>
                {status.templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.builtIn ? '' : ' (yours)'}</option>)}
              </select></label>
            <label className="fbp-stack" style={{ gap: 4 }}><span className="fbp-label">Language</span>
              <select className="fbp-select" value={opts.language} disabled={regen} onChange={e => setOpt('language', e.target.value as 'en' | 'mt' | 'de')}>
                <option value="en">English</option><option value="mt">Malti</option><option value="de">Deutsch</option>
              </select></label>
          </div>
          <div className="fbp-row" style={{ gap: 18 }}>
            <label className="fbp-toggle"><input type="checkbox" checked={opts.emojis} disabled={regen} onChange={e => setOpt('emojis', e.target.checked)} /> Emojis</label>
            <label className="fbp-toggle"><input type="checkbox" checked={opts.link} disabled={regen || !draft.link} onChange={e => setOpt('link', e.target.checked)} /> Property link</label>
            <label className="fbp-toggle"><input type="checkbox" checked={opts.contact} disabled={regen} onChange={e => setOpt('contact', e.target.checked)} /> My contact details</label>
          </div>
          <label className="fbp-stack" style={{ gap: 4 }}><span className="fbp-label">Call to action</span>
            <div className="fbp-row" style={{ flexWrap: 'nowrap' }}>
              <input className="fbp-input" value={opts.cta} maxLength={200} placeholder="Contact us to arrange a viewing." onChange={e => setOpts(o => ({ ...o, cta: e.target.value }))} />
              <button className="fbp-btn fbp-btn-sm" disabled={regen} onClick={() => regenerate()}>Apply</button>
            </div></label>
          <label className="fbp-stack" style={{ gap: 4 }}><span className="fbp-row fbp-between"><span className="fbp-label">Advertisement text</span><span className="fbp-faint">{message.length} characters{edited ? ' · edited' : ''}</span></span>
            <textarea className="fbp-textarea" value={message} onChange={e => { setMessage(e.target.value); setEdited(true) }} aria-label="Advertisement text" /></label>
          <span className="fbp-faint">Only the locality is published, never the street or the owner's details. Text is checked again before it is sent.</span>
        </div>
        <Preview page={page} message={message} images={selected.map(u => thumbs.get(u) || u)} link={type === 'link' ? draft.link : null} />
      </div>}
      {step === 4 && <div className="fbp-stack">
        <dl className="fbp-confirm">
          <dt>Property</dt><dd>{title}{draft.property.ref ? ` · ${draft.property.ref}` : ''}</dd>
          <dt>Facebook Page</dt><dd>{page?.name}</dd>
          <dt>Photos</dt><dd>{selected.length || 'None'}</dd>
          <dt>Publication</dt><dd>{TYPE_LABEL[type]}{opts.link && draft.link ? ' with property link' : ''}</dd>
        </dl>
        {dupes && <div className="fbp-note" data-tone="warn">
          This property is already on {page?.name}{dupes[0]?.publishedAt ? ` (published ${fmtWhen(dupes[0].publishedAt)})` : ''}. Publishing again creates a second post.
          {dupes[0]?.permalinkUrl && <> <a href={dupes[0].permalinkUrl} target="_blank" rel="noreferrer">Open the existing post</a>.</>}
        </div>}
        {error && <div className="fbp-note" data-tone="bad">{errorMessage(error)}</div>}
        <span className="fbp-faint">The post is published on Facebook as your Page. You can edit or delete it later from Facebook Publications.</span>
      </div>}
    </>
    foot = <>
      <button className="fbp-btn" onClick={() => (step === 1 ? onOpenChange(false) : setStep((step - 1) as Step))}>{step === 1 ? 'Cancel' : 'Back'}</button>
      {step < 4 ? <button className="fbp-btn fbp-btn-primary" disabled={!canNext || regen} onClick={() => setStep((step + 1) as Step)}>Next</button>
        : dupes ? <button className="fbp-btn fbp-btn-primary" disabled={busy} onClick={() => publish(true)}>{busy ? 'Publishing…' : 'Publish again anyway'}</button>
        : <button className="fbp-btn fbp-btn-fb" disabled={busy || !page} onClick={() => publish(false)}><FacebookGlyph mono size={16} /> {busy ? 'Publishing…' : 'Publish now'}</button>}
    </>
  }

  const showSteps = !!(draft && !draft.blockers.length && !pub && status?.connection.state === 'active')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fbp fbp-dialog" style={accentStyle(status?.agent.colorHex)}>
        <div className="fbp-dialog-head">
          <div className="fbp-row" style={{ gap: 10 }}><FacebookGlyph size={22} />
            <div><DialogTitle className="fbp-h">Publish to Facebook</DialogTitle>
              <DialogDescription className="fbp-sub">{draft ? `${title}${draft.property.ref ? ` · ${draft.property.ref}` : ''}` : 'Business Page advertisement'}</DialogDescription></div></div>
          {showSteps && <ol className="fbp-steps" aria-label="Steps">
            {STEPS.map((s, i) => <li key={s} data-n={i + 1} data-state={i + 1 === step ? 'current' : i + 1 < step ? 'done' : 'todo'} aria-current={i + 1 === step ? 'step' : undefined}><span>{s}</span></li>)}
          </ol>}
        </div>
        <div className="fbp-dialog-body">{body}</div>
        {foot && <div className="fbp-dialog-foot">{foot}</div>}
      </DialogContent>
    </Dialog>
  )
}

function PageOption({ p, selected, onSelect }: { p: FbPage; selected: boolean; onSelect: () => void }) {
  return (
    <div className="fbp-page" data-selected={selected} data-disabled={!p.canPublish} role="radio" aria-checked={selected} aria-disabled={!p.canPublish} tabIndex={p.canPublish ? 0 : -1}
      onClick={onSelect} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect() } }} style={{ cursor: p.canPublish ? 'pointer' : 'not-allowed' }}>
      <PageAvatar url={p.pictureUrl} name={p.name} />
      <div><div className="fbp-pagename">{p.name}</div>
        <div className="fbp-faint">{p.canPublish ? [p.isDefault && 'Default', p.category].filter(Boolean).join(' · ') || 'Ready to publish' : p.statusReason}</div></div>
      <span className="fbp-chip" data-tone={p.canPublish ? (selected ? 'busy' : 'ok') : 'warn'}>{p.canPublish ? (selected ? 'Selected' : 'Can publish') : 'No posting access'}</span>
    </div>
  )
}

function Preview({ page, message, images, link }: { page: FbPage | null; message: string; images: string[]; link: string | null }) {
  const shown = images.slice(0, 4)
  const textRef = useRef<HTMLDivElement>(null)
  const [clamped, setClamped] = useState(false)
  useEffect(() => { const el = textRef.current; if (el) setClamped(el.scrollHeight > el.clientHeight + 2) }, [message])
  return (
    <div className="fbp-stack" style={{ gap: 6 }}>
      <span className="fbp-label">Preview</span>
      <div className="fbp-preview" aria-label="Facebook post preview">
        <div className="fbp-preview-head"><PageAvatar url={page?.pictureUrl} name={page?.name || 'Page'} size={40} />
          <div><div className="fbp-preview-name">{page?.name || 'Your Page'}</div><div className="fbp-preview-meta">Just now · 🌐</div></div></div>
        <div className="fbp-preview-text" ref={textRef} data-clamped={clamped}>{message || ' '}</div>
        {shown.length > 0 && <div className="fbp-mosaic" data-n={shown.length}>
          {shown.map((u, i) => i === 3 && images.length > 4
            // eslint-disable-next-line @next/next/no-img-element
            ? <div key={u} className="fbp-more"><img src={u} alt="" /><span>+{images.length - 3}</span></div>
            // eslint-disable-next-line @next/next/no-img-element
            : <img key={u} src={u} alt="" />)}
        </div>}
        {link && <div className="fbp-linkcard">{(() => { try { return new URL(link).hostname } catch { return link } })()}</div>}
        <div className="fbp-preview-actions"><span>Like</span><span>Comment</span><span>Share</span></div>
      </div>
      <span className="fbp-faint">Facebook decides the final layout and the link preview.</span>
    </div>
  )
}

function Outcome({ pub, page, title, slow, appId }: { pub: FbPublication; page: FbPage | null; title: string; slow: boolean; appId: string | null }) {
  const [copied, setCopied] = useState(false)
  if (pub.state === 'published') {
    const share = pub.link ? personalShareUrl(appId, pub.link) : null
    return <div className="fbp-success" role="status">
      <div className="fbp-success-mark" aria-hidden>✓</div>
      <div><div className="fbp-h">Successfully published</div>
        <p className="fbp-sub">{title} is now on {pub.pageName || page?.name} · {fmtWhen(pub.publishedAt)}{pub.propertyRef ? ` · ${pub.propertyRef}` : ''}</p></div>
      <div className="fbp-row" style={{ justifyContent: 'center' }}>
        {pub.permalinkUrl ? <a className="fbp-btn fbp-btn-fb" href={pub.permalinkUrl} target="_blank" rel="noreferrer"><FacebookGlyph mono size={16} /> Open Facebook post</a>
          : <span className="fbp-faint">Facebook has not returned the post link yet. Use "Check status" in Facebook Publications in a moment.</span>}
        {pub.permalinkUrl && <button className="fbp-btn" onClick={async () => setCopied(await copyText(pub.permalinkUrl!))}>{copied ? 'Copied' : 'Copy post link'}</button>}
        {share && <a className="fbp-btn" href={share} target="_blank" rel="noreferrer">Share on my personal profile</a>}
      </div>
    </div>
  }
  if (!FINAL.includes(pub.state)) {
    return <div className="fbp-success" role="status" aria-live="polite">
      <div className="fbp-spinner" aria-hidden />
      <div><div className="fbp-h">{pub.state === 'reconciling' ? 'Confirming with Facebook…' : pub.state === 'queued' && pub.nextAttemptAt && new Date(pub.nextAttemptAt).getTime() > Date.now() + 5000 ? 'Waiting for Facebook' : 'Publishing to Facebook…'}</div>
        <p className="fbp-sub">{pub.error?.message || (pub.publicationType === 'multi_photo' ? `Uploading ${pub.images.length} photos, then creating the post.` : 'Creating the post.')}</p>
        {slow && <p className="fbp-sub">This is taking longer than usual. You can close this window: the result appears in Facebook Publications.</p>}</div>
    </div>
  }
  return <div className="fbp-stack" role="alert">
    <div className="fbp-row"><StateChip state={pub.state} label={pub.stateLabel} /><span className="fbp-h">{pub.state === 'needs_review' ? 'Please check your Page' : 'Not published'}</span></div>
    <div className="fbp-note" data-tone={pub.state === 'needs_review' || pub.state === 'reconnect_required' ? 'warn' : 'bad'}>{pub.error?.message || 'Facebook did not publish this post.'}</div>
  </div>
}
