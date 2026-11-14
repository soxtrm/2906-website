'use client'
// Facebook Publications — every post ARGUS created for this agent, with its real
// state from the backend. Edit/delete act only on posts ARGUS created.
import React, { useCallback, useEffect, useState } from 'react'
import { fb, errorMessage, TYPE_LABEL, personalShareUrl, type FbPublication } from '@/lib/crm/facebook'
import { StateChip, fmtWhen, copyText, FacebookGlyph } from './shared'

export function FacebookPublicationsPanel({ propertyId, appId, limit = 50, refreshKey, title = 'Facebook Publications', emptyText }: { propertyId?: number; appId?: string | null; limit?: number; refreshKey?: unknown; title?: string; emptyText?: string }) {
  const [items, setItems] = useState<FbPublication[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  const [copied, setCopied] = useState<number | null>(null)

  const load = useCallback(async () => {
    try { setItems((await fb.publications({ propertyId, limit })).publications); setErr(null) }
    catch (e) { setErr((e as any)?.status === 403 ? null : errorMessage(e)); setItems(i => i || []) }
  }, [propertyId, limit])
  useEffect(() => { load() }, [load, refreshKey])
  // Keep in-flight posts current without the agent reloading.
  useEffect(() => {
    if (!items?.some(p => ['queued', 'publishing', 'reconciling'].includes(p.state))) return
    const t = setTimeout(load, 4000)
    return () => clearTimeout(t)
  }, [items, load])

  const replace = (p: FbPublication) => setItems(cur => (cur || []).map(x => (x.id === p.id ? p : x)))
  async function act(id: number, fn: () => Promise<{ publication: FbPublication }>) {
    setBusy(id)
    try { replace((await fn()).publication) } catch (e) { alert(errorMessage(e)) } finally { setBusy(null) }
  }

  if (items === null) return <div className="fbp fbp-card"><span className="fbp-faint">Loading Facebook publications…</span></div>
  return (
    <section className="fbp fbp-card fbp-stack" aria-label={title}>
      <div className="fbp-row fbp-between"><div className="fbp-row" style={{ gap: 8 }}><FacebookGlyph /><h2 className="fbp-h" style={{ fontSize: 15 }}>{title}</h2></div>
        <button className="fbp-btn fbp-btn-sm" onClick={load}>Refresh</button></div>
      {err && <div className="fbp-note" data-tone="bad">{err}</div>}
      {!items.length && <span className="fbp-faint">{emptyText || 'Nothing published yet. Use "Publish to Facebook" on any of your listings.'}</span>}
      <div className="fbp-pubs">
        {items.map(p => {
          const share = p.state === 'published' && p.link ? personalShareUrl(appId || null, p.link) : null
          return (
            <article key={p.id} className="fbp-pub">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.images[0] ? <img src={p.images[0]} alt="" loading="lazy" /> : <span className="fbp-thumb" aria-hidden />}
              <div style={{ minWidth: 0 }}>
                <div className="fbp-row" style={{ gap: 8 }}>
                  <StateChip state={p.state} label={p.stateLabel} />
                  <strong style={{ fontSize: 13.5 }}>{p.propertyRef || `Listing #${p.propertyId}`}</strong>
                  <span className="fbp-faint">→ {p.pageName || 'Facebook Page'}</span>
                </div>
                <div className="fbp-faint" style={{ marginTop: 4 }}>
                  {TYPE_LABEL[p.publicationType]}{p.trigger === 'auto_verified' ? ' · automatic' : ''}{p.replacesId ? ' · replacement' : ''}
                  {' · '}{p.publishedAt ? `Published ${fmtWhen(p.publishedAt)}` : `Created ${fmtWhen(p.createdAt)}`}
                  {p.lastCheckedAt ? ` · checked ${fmtWhen(p.lastCheckedAt)}` : ''}{p.editedAt ? ' · edited' : ''}
                </div>
                {p.error && p.state !== 'published' && <div className="fbp-note" data-tone={p.state === 'failed' ? 'bad' : 'warn'} style={{ marginTop: 8 }}>{p.error.message}</div>}
                {editing?.id === p.id && <div className="fbp-stack" style={{ marginTop: 8 }}>
                  <textarea className="fbp-textarea" style={{ minHeight: 140 }} value={editing.text} onChange={e => setEditing({ id: p.id, text: e.target.value })} aria-label="Post text" />
                  <div className="fbp-row">
                    <button className="fbp-btn fbp-btn-sm fbp-btn-primary" disabled={busy === p.id} onClick={async () => { await act(p.id, () => fb.edit(p.id, editing.text)); setEditing(null) }}>Save on Facebook</button>
                    <button className="fbp-btn fbp-btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                  <span className="fbp-faint">Only the text can be changed. To change photos, delete the post and publish a new one.</span>
                </div>}
              </div>
              <div className="fbp-pub-actions">
                {p.permalinkUrl && p.state === 'published' && <a className="fbp-btn fbp-btn-sm" href={p.permalinkUrl} target="_blank" rel="noreferrer">Open post</a>}
                {p.permalinkUrl && p.state === 'published' && <button className="fbp-btn fbp-btn-sm" onClick={async () => { if (await copyText(p.permalinkUrl!)) { setCopied(p.id); setTimeout(() => setCopied(null), 1500) } }}>{copied === p.id ? 'Copied' : 'Copy link'}</button>}
                {share && <a className="fbp-btn fbp-btn-sm" href={share} target="_blank" rel="noreferrer">Share personally</a>}
                {p.postId && <button className="fbp-btn fbp-btn-sm" disabled={busy === p.id} onClick={() => act(p.id, () => fb.checkPublication(p.id))}>Check status</button>}
                {p.canEdit && editing?.id !== p.id && <button className="fbp-btn fbp-btn-sm" onClick={() => setEditing({ id: p.id, text: p.message })}>Edit text</button>}
                {p.canRetry && <button className="fbp-btn fbp-btn-sm" disabled={busy === p.id} onClick={() => act(p.id, () => fb.retry(p.id, p.state === 'needs_review' && confirm('Check your Facebook Page first. Publish again only if the post is not there. Continue?')))}>Try again</button>}
                {p.canDelete && <button className="fbp-btn fbp-btn-sm fbp-btn-danger" disabled={busy === p.id} onClick={() => { if (confirm(`Delete this post from ${p.pageName || 'your Facebook Page'}? This cannot be undone.`)) act(p.id, () => fb.remove(p.id)) }}>Delete</button>}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
