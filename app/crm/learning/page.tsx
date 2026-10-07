'use client'

import { useCallback, useEffect, useState } from 'react'
import { BrainCircuit, CheckCircle2, ShieldCheck, TriangleAlert } from 'lucide-react'
import { crmFetch } from '@/lib/crm/api'
import { CrmProvider, CrmShell, useCrm } from '@/lib/crm/ui'

type Metric = { field_name: string; decisions: number; corrections: number }
type Pattern = { error_taxonomy: string; count: number }
type Version = { model_name: string; prompt_version: string; decisions: number; corrections: number }
type Example = { id: number; property_ref?: string; flow: string; field_name: string; model_output: unknown; final_human_value: unknown; error_taxonomy?: string; created_at: string }
type Data = {
  windowDays: number
  totals: { total: number; reviewed: number; corrected: number; avg_confidence: number | null }
  fields: Metric[]; patterns: Pattern[]; versions: Version[]; examples: Example[]
  modes: { mode: string; count: number }[]; draftDesk: { import_status: string; count: number }[]
}

const panel = 'rounded-2xl border border-white/10 bg-white/[.035] p-4'
const small = 'text-[10px] font-bold uppercase tracking-[.16em] text-white/40'
const value = (v: unknown) => v == null ? 'UNKNOWN' : typeof v === 'string' ? v : JSON.stringify(v)
const rate = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : '—'

function Learning() {
  const { me } = useCrm()
  const [data, setData] = useState<Data | null>(null)
  const [days, setDays] = useState(30)
  const [error, setError] = useState('')
  const load = useCallback(() => crmFetch(`admin/learning-ledger?days=${days}`).then(setData).catch(e => setError(e?.message || 'Could not load learning data')), [days])
  useEffect(() => { load() }, [load])
  if (me && me.role !== 'admin') return <CrmShell title="Learning Desk" dark><p className="p-6 text-sm text-white/45">Admins only.</p></CrmShell>
  const max = Math.max(1, ...(data?.fields.map(x => x.corrections) || [1]))
  return <CrmShell title="Learning Desk" subtitle="Human-confirmed corrections, failure patterns and automation readiness" dark>
    <main className="min-h-screen bg-[#080d18] p-4 text-white md:p-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div><p className={small}>ARGUS CONTROL</p><h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold"><BrainCircuit className="text-[#b8953f]"/>Learning ledger</h1><p className="mt-1 text-xs text-white/45">Only human-confirmed final values become target truth.</p></div>
        <select value={days} onChange={e => setDays(Number(e.target.value))} className="rounded-xl border border-white/10 bg-[#121a2a] px-3 py-2 text-xs"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
      </header>
      {error ? <div className="rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">{error}</div> : !data ? <p className="text-sm text-white/40">Loading learning evidence…</p> : <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[['Decisions logged', data.totals.total], ['Human reviewed', data.totals.reviewed], ['Corrections', data.totals.corrected], ['Correction rate', rate(data.totals.corrected, data.totals.reviewed)]].map(([label,n]) => <div key={String(label)} className={panel}><p className={small}>{label}</p><strong className="mt-2 block text-3xl">{n}</strong></div>)}
        </section>
        <section className="mt-3 grid gap-3 lg:grid-cols-[1.2fr_.8fr]">
          <div className={panel}><p className={small}>Most corrected fields</p><div className="mt-4 space-y-3">{data.fields.length ? data.fields.map(f => <div key={f.field_name}><div className="mb-1 flex justify-between text-xs"><span>{f.field_name.replaceAll('_',' ')}</span><span className="text-white/45">{f.corrections}/{f.decisions} · {rate(f.corrections,f.decisions)}</span></div><div className="h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-gradient-to-r from-[#b8953f] to-[#f2597a]" style={{width:`${Math.max(4,f.corrections/max*100)}%`}}/></div></div>) : <p className="text-sm text-white/35">Corrections appear here as reviewers edit drafts.</p>}</div></div>
          <div className={panel}><p className={small}>Recurring failures</p><div className="mt-3 space-y-2">{data.patterns.map(p => <div key={p.error_taxonomy} className="flex items-center justify-between rounded-xl bg-white/[.035] px-3 py-2 text-xs"><span className="flex items-center gap-2"><TriangleAlert size={14} className="text-amber-300"/>{p.error_taxonomy.replaceAll('_',' ')}</span><b>{p.count}</b></div>)}</div></div>
        </section>
        <section className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className={panel}><p className={small}>Draft desk</p><div className="mt-3 space-y-2">{data.draftDesk.map(x => <div key={x.import_status} className="flex justify-between text-xs"><span>{x.import_status.replaceAll('_',' ')}</span><b>{x.count}</b></div>)}</div></div>
          <div className={panel}><p className={small}>Model / prompt comparison</p><div className="mt-3 space-y-2">{data.versions.map(x => <div key={`${x.model_name}-${x.prompt_version}`} className="rounded-xl bg-white/[.035] p-3 text-xs"><b>{x.model_name}</b><p className="truncate text-white/40">{x.prompt_version}</p><p className="mt-1">{x.decisions} decisions · {rate(x.corrections,x.decisions)} corrected</p></div>)}</div></div>
          <div className={panel}><p className={small}>Automation boundary</p><div className="mt-3 space-y-3 text-xs"><p className="flex gap-2"><ShieldCheck size={16} className="text-sky-300"/><span><b>SHADOW</b><br/><span className="text-white/40">New extraction and next-action policies.</span></span></p><p className="flex gap-2"><TriangleAlert size={16} className="text-amber-300"/><span><b>ASSIST</b><br/><span className="text-white/40">Draft correction, publishing and relationship actions.</span></span></p><p className="flex gap-2"><CheckCircle2 size={16} className="text-emerald-300"/><span><b>AUTO WITHIN RULES</b><br/><span className="text-white/40">Existing deterministic gates and proven low-risk jobs.</span></span></p></div></div>
        </section>
        <section className={`${panel} mt-3`}><p className={small}>Recent before / after evidence</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[720px] text-left text-xs"><thead className="text-white/35"><tr><th className="pb-2">Entity</th><th>Field</th><th>Model/import</th><th>Human final</th><th>Error</th><th>Time</th></tr></thead><tbody>{data.examples.map(x => <tr key={x.id} className="border-t border-white/[.06]"><td className="py-3">{x.property_ref || `${x.flow}:${x.id}`}</td><td>{x.field_name}</td><td className="max-w-44 truncate text-rose-200">{value(x.model_output)}</td><td className="max-w-44 truncate text-emerald-200">{value(x.final_human_value)}</td><td className="text-white/45">{x.error_taxonomy || '—'}</td><td className="text-white/35">{new Date(x.created_at).toLocaleString()}</td></tr>)}</tbody></table>{!data.examples.length ? <p className="py-4 text-white/35">No human-reviewed examples in this window yet.</p> : null}</div></section>
      </>}
    </main>
  </CrmShell>
}

export default function Page(){return <CrmProvider><Learning/></CrmProvider>}
