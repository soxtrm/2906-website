'use client'
// /crm/integrations/facebook — the agent's Facebook Business Page settings:
// connection, Pages and destinations, defaults, templates, optional automation
// and the publication history. Every value shown comes from the backend.
import React, { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import { fb, errorMessage, type FbPage, type FbPreferences, type FbStatus } from '@/lib/crm/facebook'
import { FacebookGlyph, PageAvatar, accentStyle, fmtWhen } from '@/components/crm/facebook/shared'
import { FacebookPublicationsPanel } from '@/components/crm/facebook/publications-panel'

const PLACEHOLDERS = ['headline', 'location', 'price', 'bedrooms', 'bathrooms', 'size', 'features', 'availability', 'description', 'cta', 'contact', 'link']

function FacebookSettings() {
  const { me } = useCrm()
  const params = useSearchParams()
  const [s, setS] = useState<FbStatus | null>(null)
  const [loadErr, setLoadErr] = useState<{ status?: number; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null)
  const [prefs, setPrefs] = useState<FbPreferences | null>(null)
  const [tpl, setTpl] = useState({ name: '', language: 'en', body: '{{headline}}\n\n📍 {{location}}\n💶 {{price}}\n🛏 {{bedrooms}}\n\n{{description}}\n\n📩 {{cta}}\n🔗 {{link}}' })

  const load = useCallback(async () => {
    try { const r = await fb.status(); setS(r); setPrefs(r.preferences); setLoadErr(null) }
    catch (e: any) { setLoadErr({ status: e?.status, message: errorMessage(e) }) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const c = params.get('connected')
    if (c === '1') setFlash({ tone: 'ok', text: 'Facebook is connected. Your Pages are listed below.' })
  }, [params])

  async function run(key: string, fn: () => Promise<FbStatus | void>, ok?: string) {
    setBusy(key); setFlash(null)
    try { const r = await fn(); if (r) { setS(r); setPrefs(r.preferences) } if (ok) setFlash({ tone: 'ok', text: ok }) }
    catch (e) { setFlash({ tone: 'bad', text: errorMessage(e) }) }
    finally { setBusy(null) }
  }
  const connect = () => run('connect', async () => { window.location.assign((await fb.connect()).url) })
  const disconnect = () => {
    if (!confirm('Disconnect Facebook? ARGUS stops publishing to your Pages immediately, including queued and automatic posts. Your publication history is kept.')) return
    run('disconnect', async () => (await fb.disconnect()).status, 'Facebook was disconnected. Nothing more will be published.')
  }

  if (loadErr) {
    return <div className="fbp fbp-card"><div className="fbp-note" data-tone={loadErr.status === 403 ? 'warn' : 'bad'}>{loadErr.status === 403 ? 'Facebook publishing is not enabled for your account yet. Ask an ARGUS administrator to switch it on.' : loadErr.message}</div></div>
  }
  if (!s || !prefs) return <div className="fbp fbp-card"><span className="fbp-faint">Loading…</span></div>
  const conn = s.connection
  const pages = s.pages
  const autoNote = !s.autoPublishAvailable ? 'Automatic publishing is switched off on this ARGUS server for now.' : null

  return (
    <div className="fbp fbp-stack" style={{ ...accentStyle(s.agent.colorHex), gap: 18, maxWidth: 1100 }}>
      {flash && <div className="fbp-note" data-tone={flash.tone} role="status">{flash.text}</div>}
      {!s.configured && <div className="fbp-note" data-tone="warn">
        Facebook publishing is not active on this server yet: the Meta app setup is unfinished.
        {me?.role === 'admin' && s.setupMissing.length > 0 && <> Missing server settings: <code>{s.setupMissing.join(', ')}</code>. See <code>docs/facebook-pages/META_SETUP.md</code>.</>}
      </div>}

      {/* connection */}
      <section className="fbp-card">
        <div className="fbp-integration">
          <div className="fbp-integration-logo"><FacebookGlyph size={28} /></div>
          <div>
            <div className="fbp-row" style={{ gap: 10 }}><h2 className="fbp-h">Facebook connection</h2>
              <span className="fbp-chip" data-tone={conn.state === 'active' ? 'ok' : conn.state === 'reconnect_required' ? 'warn' : 'muted'}>{conn.state === 'active' ? 'Connected' : conn.state === 'reconnect_required' ? 'Reconnect required' : 'Not connected'}</span></div>
            {conn.state === 'not_connected' && <p className="fbp-sub">You sign in on Facebook's own page and choose which Pages ARGUS may post to. ARGUS never sees your Facebook password.</p>}
            {conn.state !== 'not_connected' && <div className="fbp-kv">
              <span className="fbp-muted">Account<b>{conn.facebookName || 'Facebook'}</b></span>
              <span className="fbp-muted">Connected since<b>{fmtWhen(conn.connectedAt)}</b></span>
              <span className="fbp-muted">Last checked<b>{fmtWhen(conn.lastCheckedAt)}</b></span>
            </div>}
            {conn.state === 'reconnect_required' && <p className="fbp-sub" style={{ marginTop: 8 }}>{conn.reason || 'Facebook asked ARGUS to confirm your connection again.'} Nothing is published until you reconnect.</p>}
            {conn.state === 'active' && (conn.missingPermissions || []).length > 0 && <p className="fbp-sub" style={{ marginTop: 8 }}>Some permissions were not granted. Reconnect and allow ARGUS to create posts on your Pages.</p>}
          </div>
          <div className="fbp-row" style={{ justifyContent: 'flex-end' }}>
            {conn.state === 'not_connected' && <button className="fbp-btn fbp-btn-fb" disabled={!s.configured || !!busy} onClick={connect}><FacebookGlyph mono size={16} /> Connect Facebook</button>}
            {conn.state !== 'not_connected' && <>
              <button className="fbp-btn fbp-btn-fb" disabled={!s.configured || !!busy} onClick={connect}>Reconnect</button>
              <button className="fbp-btn" disabled={!!busy} onClick={() => run('refresh', fb.refresh, 'Page list refreshed.')}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh Pages'}</button>
              <button className="fbp-btn" disabled={!!busy} onClick={() => run('check', fb.check, 'Connection checked.')}>{busy === 'check' ? 'Checking…' : 'Check connection'}</button>
              <button className="fbp-btn fbp-btn-ghost fbp-btn-danger" disabled={!!busy} onClick={disconnect}>Disconnect</button>
            </>}
          </div>
        </div>
      </section>

      {/* pages */}
      {conn.state !== 'not_connected' && <section className="fbp-card fbp-stack">
        <div><h2 className="fbp-h">Business Pages</h2><p className="fbp-sub">Choose which Pages appear when you publish, and which one is selected by default.</p></div>
        {!pages.length && <div className="fbp-note">Facebook did not share any Pages with ARGUS. Reconnect and select your Business Page in the Facebook window, or check that you have a role on the Page.</div>}
        {pages.map(p => <PageRow key={p.id} p={p} busy={busy === `page${p.id}`} autoAvailable={s.autoPublishAvailable && prefs.autoPublishEnabled}
          onChange={body => run(`page${p.id}`, () => fb.updatePage(p.id, body))} />)}
      </section>}

      {/* defaults */}
      <section className="fbp-card fbp-stack">
        <div><h2 className="fbp-h">Advertisement defaults</h2><p className="fbp-sub">Used to prefill every new post. You can still change everything before publishing.</p></div>
        <div className="fbp-controls">
          <label className="fbp-stack" style={{ gap: 4 }}><span className="fbp-label">Language</span>
            <select className="fbp-select" value={prefs.language} onChange={e => setPrefs({ ...prefs, language: e.target.value as FbPreferences['language'] })}>
              <option value="en">English</option><option value="mt">Malti</option><option value="de">Deutsch</option></select></label>
          <label className="fbp-stack" style={{ gap: 4 }}><span className="fbp-label">Template</span>
            <select className="fbp-select" value={prefs.defaultTemplateId} onChange={e => setPrefs({ ...prefs, defaultTemplateId: e.target.value })}>
              {s.templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.builtIn ? '' : ' (yours)'}</option>)}</select></label>
        </div>
        <div className="fbp-row" style={{ gap: 18 }}>
          <label className="fbp-toggle"><input type="checkbox" checked={prefs.useEmojis} onChange={e => setPrefs({ ...prefs, useEmojis: e.target.checked })} /> Emojis</label>
          <label className="fbp-toggle"><input type="checkbox" checked={prefs.includeLink} onChange={e => setPrefs({ ...prefs, includeLink: e.target.checked })} /> Add the property link</label>
          <label className="fbp-toggle"><input type="checkbox" checked={prefs.includeContact} onChange={e => setPrefs({ ...prefs, includeContact: e.target.checked })} /> Add my name and public phone ({s.agent.publicPhone || 'no public phone on your profile'})</label>
        </div>
        <label className="fbp-stack" style={{ gap: 4 }}><span className="fbp-label">Call to action</span>
          <input className="fbp-input" value={prefs.callToAction} maxLength={200} placeholder="Contact us to arrange a viewing." onChange={e => setPrefs({ ...prefs, callToAction: e.target.value })} /></label>
        <div><button className="fbp-btn fbp-btn-primary" disabled={!!busy} onClick={() => run('prefs', () => fb.updatePreferences({ language: prefs.language, defaultTemplateId: prefs.defaultTemplateId, useEmojis: prefs.useEmojis, includeLink: prefs.includeLink, includeContact: prefs.includeContact, callToAction: prefs.callToAction }), 'Defaults saved.')}>Save defaults</button></div>
      </section>

      {/* automation */}
      <section className="fbp-card fbp-stack">
        <div className="fbp-row fbp-between">
          <div><h2 className="fbp-h">Automatic publishing <span className="fbp-chip" style={{ marginLeft: 6 }}>Optional</span></h2>
            <p className="fbp-sub">When a listing you list is verified in ARGUS, publish it to the Pages you mark "Automatic". Off unless you switch it on.</p></div>
          <label className="fbp-toggle"><input type="checkbox" checked={prefs.autoPublishEnabled} disabled={!!autoNote || conn.state !== 'active' || !!busy}
            onChange={e => run('auto', () => fb.updatePreferences({ autoPublishEnabled: e.target.checked }), e.target.checked ? 'Automatic publishing is on. Mark the Pages that may receive automatic posts.' : 'Automatic publishing is off. Queued automatic posts were cancelled.')} />
            Automatically publish newly verified properties</label>
        </div>
        {autoNote && <div className="fbp-note">{autoNote}</div>}
        <ul className="fbp-sub" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3 }}>
          <li>Only your own listings, verified after you switch this on, that are available and allowed on Facebook.</li>
          <li>Each listing is posted once per Page. At most {prefs.autoDailyLimit} automatic posts per Page per day, spaced at least 45 minutes apart.</li>
          <li>Unsharing, editing or renting a listing never deletes or reposts anything by itself: you decide in Facebook Publications.</li>
        </ul>
        {prefs.autoPublishEnabled && <label className="fbp-row" style={{ gap: 8 }}><span className="fbp-label">Daily limit per Page</span>
          <select className="fbp-select" style={{ width: 90 }} value={prefs.autoDailyLimit} onChange={e => run('limit', () => fb.updatePreferences({ autoDailyLimit: Number(e.target.value) }))}>
            {[1, 2, 3, 4, 5, 6, 8, 10].map(n => <option key={n} value={n}>{n}</option>)}</select></label>}
      </section>

      {/* templates */}
      <section className="fbp-card fbp-stack">
        <div><h2 className="fbp-h">My templates</h2><p className="fbp-sub">Placeholders are filled from each listing; empty ones disappear. Available: {PLACEHOLDERS.map(p => `{{${p}}}`).join(' ')}</p></div>
        {s.templates.filter(t => !t.builtIn).map(t => <div key={t.id} className="fbp-page" style={{ gridTemplateColumns: '1fr auto' }}>
          <div><div className="fbp-pagename">{t.name} <span className="fbp-faint">· {String(t.language || 'en').toUpperCase()}</span></div><div className="fbp-faint" style={{ whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{t.body}</div></div>
          <button className="fbp-btn fbp-btn-sm fbp-btn-danger" disabled={!!busy} onClick={() => { if (confirm(`Delete the template "${t.name}"?`)) run('tpl', () => fb.deleteTemplate(t.id)) }}>Delete</button>
        </div>)}
        <div className="fbp-controls">
          <input className="fbp-input" placeholder="Template name" value={tpl.name} maxLength={80} onChange={e => setTpl({ ...tpl, name: e.target.value })} aria-label="Template name" />
          <select className="fbp-select" value={tpl.language} onChange={e => setTpl({ ...tpl, language: e.target.value })} aria-label="Template language"><option value="en">English</option><option value="mt">Malti</option><option value="de">Deutsch</option></select>
        </div>
        <textarea className="fbp-textarea" style={{ minHeight: 160 }} value={tpl.body} onChange={e => setTpl({ ...tpl, body: e.target.value })} aria-label="Template text" />
        <div><button className="fbp-btn" disabled={!!busy || !tpl.name.trim() || !tpl.body.trim()} onClick={() => run('tpl', async () => { const r = await fb.addTemplate(tpl); setTpl({ ...tpl, name: '' }); return r }, 'Template saved.')}>Save template</button></div>
      </section>

      <FacebookPublicationsPanel appId={s.appId} />

      <section className="fbp-card fbp-stack">
        <h2 className="fbp-h" style={{ fontSize: 14 }}>Good to know</h2>
        <ul className="fbp-sub" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3 }}>
          <li>Posts appear as your Business Page. ARGUS adds no ARGUS branding.</li>
          <li>"Share personally" opens Facebook's own share window: you post to your profile yourself. ARGUS never posts to personal profiles.</li>
          <li>Facebook Marketplace listings are not part of this integration; Meta's Pages API does not offer them.</li>
          <li>Disconnecting stops all publishing immediately and deletes the stored Facebook credentials.</li>
        </ul>
      </section>
    </div>
  )
}

function PageRow({ p, busy, autoAvailable, onChange }: { p: FbPage; busy: boolean; autoAvailable: boolean; onChange: (b: Partial<{ enabled: boolean; isDefault: boolean; autoPublish: boolean }>) => void }) {
  return (
    <div className="fbp-page" data-selected={p.isDefault} data-disabled={!p.canPublish}>
      <PageAvatar url={p.pictureUrl} name={p.name} />
      <div><div className="fbp-pagename">{p.name}{p.isDefault && <span className="fbp-chip" data-tone="busy" style={{ marginLeft: 8 }}>Default</span>}</div>
        <div className="fbp-faint">{p.canPublish ? (p.category || 'Ready to publish') : p.statusReason}</div></div>
      <div className="fbp-row" style={{ gap: 14 }}>
        {p.canPublish ? <>
          <label className="fbp-toggle"><input type="checkbox" checked={p.enabled} disabled={busy} onChange={e => onChange({ enabled: e.target.checked })} /> Destination</label>
          <label className="fbp-toggle"><input type="radio" name="fbp-default" checked={p.isDefault} disabled={busy} onChange={() => onChange({ isDefault: true })} /> Default</label>
          {autoAvailable && <label className="fbp-toggle"><input type="checkbox" checked={p.autoPublish} disabled={busy || !p.enabled} onChange={e => onChange({ autoPublish: e.target.checked })} /> Automatic</label>}
        </> : <span className="fbp-chip" data-tone="warn">{p.status === 'removed' ? 'No longer available' : 'No posting access'}</span>}
      </div>
    </div>
  )
}

export default function Page() {
  return (
    <CrmProvider>
      <CrmShell title="Facebook Business Pages" subtitle="Integrations">
        <Suspense fallback={null}><FacebookSettings /></Suspense>
      </CrmShell>
    </CrmProvider>
  )
}
