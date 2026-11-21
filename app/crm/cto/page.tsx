'use client'
// /crm/cto — NEXUS CTO Cockpit (2026-11-21). Admin only (CRM login). Shows the generated status report
// (docs/cto/NEXUS_CTO_STATUS.json, built from live evidence by ops/cto/cto-report.cjs), the launch-readiness
// board, live health of the main endpoints and direct test entry points. Nothing private is shown here.
import { useEffect, useMemo, useState } from 'react'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'
import report from '@/docs/cto/NEXUS_CTO_STATUS.json'

type Feature = { product: string; feature: string; founder: string; status: string; userTest: string; blocker: string; workstream: string; tests: string; verifiedAt: string; limits: string; next: string; paths: string[] }
type Product = { name: string; url: string; milestone: string; deployment?: { deployment?: string; commit?: string; deployedAt?: string } | null; backendRelease?: string; release?: string; features: Feature[] }
type Health = { at: string; build: { commit: string | null; branch: string | null; deployment: string | null }; checks: { name: string; url: string; status: number; ms: number }[] }

export default function Page() { return <CrmProvider><CrmShell title="CTO Cockpit" subtitle="What is actually built, live and verified — generated from deployments, tests and live checks"><Cockpit /></CrmShell></CrmProvider> }

const TONE: Record<string, string> = { VERIFIED: '#1d7a4a', LIVE: '#2f6fd6', STAGED: '#7a5af5', IN_PROGRESS: '#b7791f', BLOCKED: '#c2410c', FAILED: '#d93f5c', NOT_STARTED: '#6b7280' }
const chip = (s: string): React.CSSProperties => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 800, letterSpacing: '.02em', color: '#fff', background: TONE[s] || '#6b7280', whiteSpace: 'nowrap' })
const TESTS: { product: string; label: string; href: string; how: string }[] = [
  { product: 'NEXUS Marketplace', label: 'Listing 2906-9765 with the NEXUS chat', href: 'https://nexusstudios.one/marketplace/home/2906-9765', how: 'Open the listing, read the details, open the chat panel (do not send in production; the staging journey covers sending).' },
  { product: 'NEXUS Marketplace', label: 'Marketplace grid', href: 'https://nexusstudios.one/marketplace', how: '5 columns on a wide screen, open a card, scroll from anywhere.' },
  { product: 'NEXUS Rooms', label: 'Rooms category', href: 'https://nexusstudios.one/marketplace/rooms', how: 'Shows the honest empty state until an owner adds rooms. Synthetic 3-bedroom + Room 2 request: staging only.' },
  { product: 'NEXUS Deal Room', label: 'Deal Rooms (CRM)', href: '/crm/deal-rooms', how: 'Open deals appear when a client asks for a viewing. Synthetic journey: staging only.' },
  { product: 'NEXUS Sync', label: 'Owner app', href: 'https://nexussync.one/owner', how: 'Sign in with a staging test owner only (never a real owner account).' },
  { product: 'Benestates Work', label: 'Health (no tenant data)', href: 'https://benestates.work/api/ben/work-health', how: 'Configuration yes/no only.' },
]

function Cockpit() {
  const { me } = useCrm()
  const [health, setHealth] = useState<Health | null>(null)
  const [only, setOnly] = useState<string>('all')
  useEffect(() => { if (me?.role === 'admin') fetch('/api/cto/health', { cache: 'no-store' }).then(r => r.json()).then(setHealth).catch(() => {}) }, [me?.role])
  const products = report.products as unknown as Record<string, Product>
  const features = useMemo(() => Object.values(products).flatMap(p => p.features.map(f => ({ ...f, productName: p.name }))), [products])
  if (!me) return <p style={{ opacity: .6 }}>Loading…</p>
  if (me.role !== 'admin') return <p>The CTO Cockpit is for administrators.</p>
  const card: React.CSSProperties = { background: 'var(--crm-card)', border: '1px solid var(--crm-border)', borderRadius: 16, padding: 14, minWidth: 0 }
  const shown = only === 'all' ? features : features.filter(f => f.status === only)
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <p style={{ margin: 0, opacity: .75, fontSize: 13 }}>Report generated {new Date(report.generatedAt).toLocaleString('en-GB', { timeZone: 'Europe/Malta' })} · repo {report.repository.branch} @ {report.repository.head}{health ? ` · served by ${health.build.commit ? `build ${health.build.commit}` : health.build.deployment || 'unknown build'}` : ''}. Machine-readable: <a href="https://github.com/soxtrm/2906-website/blob/claude/argus-crm-release-20261120/docs/cto/NEXUS_CTO_STATUS.json" style={{ color: 'inherit', fontWeight: 700 }}>NEXUS_CTO_STATUS.json</a></p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
        {Object.entries(products).map(([k, p]) => {
          const c = p.features.reduce((m: Record<string, number>, f) => (m[f.status] = (m[f.status] || 0) + 1, m), {})
          const live = health?.checks.find(h => p.url.startsWith(h.url) || h.url.startsWith(p.url))
          return (
            <div key={k} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}><b>{p.name}</b>{live && <small style={{ color: live.status >= 200 && live.status < 400 ? '#1d7a4a' : '#d93f5c', fontWeight: 800 }}>{live.status || 'down'} · {live.ms} ms</small>}</div>
              <a href={p.url} style={{ fontSize: 12.5, opacity: .75, color: 'inherit' }}>{p.url.replace('https://', '')}</a>
              <p style={{ margin: '8px 0 4px', fontSize: 12.5 }}>{p.backendRelease ? `Backend release ${p.backendRelease}` : p.release ? `Release ${p.release}` : p.deployment?.commit ? `Build ${p.deployment.commit} · ${p.deployment.deployedAt?.slice(0, 16).replace('T', ' ')}` : 'Release: see backend packages'}</p>
              <p style={{ margin: '0 0 8px', fontSize: 12.5, opacity: .8 }}>{p.milestone}</p>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{Object.entries(c).map(([s, n]) => <span key={s} style={chip(s)}>{n} {s}</span>)}</div>
            </div>
          )
        })}
      </div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}><b style={{ fontSize: 16 }}>Launch-readiness board</b>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{['all', 'VERIFIED', 'LIVE', 'IN_PROGRESS', 'BLOCKED', 'NOT_STARTED'].map(s => <button key={s} onClick={() => setOnly(s)} style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--crm-border)', background: only === s ? 'var(--crm-text, #111)' : 'transparent', color: only === s ? 'var(--crm-bg, #fff)' : 'inherit', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>{s === 'all' ? 'All' : s}</button>)}</div></div>
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ textAlign: 'left', opacity: .7 }}>{['Product', 'Feature', 'Founder requirement', 'Status', 'User-facing test', 'Blocker', 'Next'].map(h => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--crm-border)' }}>{h}</th>)}</tr></thead>
            <tbody>{shown.map((f, i) => <tr key={i} style={{ verticalAlign: 'top' }}>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--crm-border)', whiteSpace: 'nowrap' }}>{f.productName}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--crm-border)', fontWeight: 700 }}>{f.feature}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--crm-border)', opacity: .85 }}>{f.founder}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--crm-border)' }}><span style={chip(f.status)}>{f.status}</span>{f.verifiedAt && <div style={{ fontSize: 11, opacity: .6, marginTop: 3 }}>{f.verifiedAt}</div>}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--crm-border)' }}>{f.userTest || '–'}{f.tests && <div style={{ fontSize: 11, opacity: .6 }}>{f.tests}</div>}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--crm-border)', color: f.blocker ? '#c2410c' : 'inherit' }}>{f.blocker || '–'}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid var(--crm-border)' }}>{f.next || '–'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <div style={card}><b>Direct test entry points</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 8, fontSize: 13.5 }}>{TESTS.map(t => <li key={t.href}><a href={t.href} target={t.href.startsWith('http') ? '_blank' : undefined} rel="noopener" style={{ color: 'inherit', fontWeight: 700 }}>{t.product}: {t.label}</a><div style={{ opacity: .7, fontSize: 12.5 }}>{t.how}</div></li>)}</ul></div>
        <div style={card}><b>Live checks</b>{!health ? <p style={{ opacity: .6 }}>Checking…</p> : <table style={{ width: '100%', fontSize: 13, marginTop: 8 }}><tbody>{health.checks.map(h => <tr key={h.url}><td style={{ padding: '3px 0' }}>{h.name}</td><td style={{ fontWeight: 800, color: h.status >= 200 && h.status < 400 ? '#1d7a4a' : '#d93f5c' }}>{h.status || 'down'}</td><td style={{ opacity: .7, textAlign: 'right' }}>{h.ms} ms</td></tr>)}</tbody></table>}
          <p style={{ fontSize: 12, opacity: .65, marginBottom: 0 }}>A 200 only says the endpoint answers. Feature status comes from the end-to-end tests above.</p></div>
      </div>
    </div>
  )
}
