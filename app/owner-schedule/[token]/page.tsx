'use client'

import { use, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, Clock3, Sparkles, X } from 'lucide-react'
import { maltaToIso } from '@/lib/crm/booking'

type RequestRow = { id:number; startsAt:string; durationMin:number; status:string; decision:string; round:number; justification:string|null; profile:{ groupType:string|null; country:string|null; job:string|null; people:number|null } }
type View = { property:{ref:string;town:string|null;type:string|null}; bookings:RequestRow[]; windows:{id:number;start:string;end:string}[]; horizonDays:number }
const TZ='Europe/Malta'
const fmtDay = new Intl.DateTimeFormat('en-GB',{timeZone:TZ,weekday:'short',day:'numeric',month:'short'})
const fmtWhen = new Intl.DateTimeFormat('en-GB',{timeZone:TZ,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})

export default function OwnerSchedulePage({ params }:{params:Promise<{token:string}>}) {
  const { token } = use(params)
  const [data,setData]=useState<View|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const [tab,setTab]=useState<'requests'|'times'>('requests'), [duration,setDuration]=useState<10|20>(20)
  const [day,setDay]=useState(0), [selected,setSelected]=useState<Set<string>>(new Set()), [saved,setSaved]=useState(false)
  const days=useMemo(()=>Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()+i);return d}),[])
  const load=()=>fetch(`/api/owner-schedule/${encodeURIComponent(token)}`,{cache:'no-store'}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error);setData(j)}).catch(e=>setError(e.message))
  useEffect(()=>{load()},[token])
  async function decide(id:number,decision:'accept'|'decline'){
    setBusy(true);setError('')
    try{const r=await fetch(`/api/owner-schedule/${encodeURIComponent(token)}/requests/${id}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision})});const j=await r.json();if(!r.ok)throw new Error(j.error);await load();if(decision==='decline')setTab('times')}
    catch(e:any){setError(e.message)}finally{setBusy(false)}
  }
  function keyFor(d:Date,h:number,m:number){const y=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),da=String(d.getDate()).padStart(2,'0');return maltaToIso(`${y}-${mo}-${da}`,`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)}
  const slots=useMemo(()=>{const a:string[]=[];for(let h=8;h<20;h++)for(let m=0;m<60;m+=duration)a.push(keyFor(days[day],h,m));return a},[day,duration,days])
  async function save(){setBusy(true);setError('');try{const ranges=[...selected].map(start=>({start,end:new Date(new Date(start).getTime()+duration*60000).toISOString()}));const r=await fetch(`/api/owner-schedule/${encodeURIComponent(token)}/availability`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ranges})});const j=await r.json();if(!r.ok)throw new Error(j.error);setSaved(true);setSelected(new Set());await load()}catch(e:any){setError(e.message)}finally{setBusy(false)}}
  if(!data)return <main className="min-h-screen bg-[#07141b] text-[#f7f1df] grid place-items-center p-6"><div>{error||'Opening your schedule…'}</div></main>
  const pending=data.bookings.filter(b=>b.status==='pending')
  return <main className="min-h-screen bg-[#07141b] text-[#f7f1df] px-4 py-8 sm:px-8">
    <div className="mx-auto max-w-3xl">
      <header className="border-b border-[#c8a96b]/25 pb-6">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[.24em] text-[#c8a96b]"><Sparkles className="h-3 w-3"/>2906 · Smart scheduling</div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Viewing schedule</h1>
        <p className="mt-2 text-sm text-white/55">#{data.property.ref} · {data.property.town||'Malta'} · one live page for every request</p>
      </header>
      <div className="my-5 grid grid-cols-2 rounded-xl bg-white/[.05] p-1">
        {(['requests','times'] as const).map(x=><button key={x} onClick={()=>setTab(x)} className={`rounded-lg px-3 py-3 text-sm font-semibold transition ${tab===x?'bg-[#f4edda] text-[#07141b]':'text-white/55'}`}>{x==='requests'?`Requests · ${pending.length}`:'Mark my times'}</button>)}
      </div>
      {error&&<div className="mb-4 rounded-xl border border-rose-300/30 bg-rose-300/10 p-3 text-sm text-rose-100">{error}</div>}
      {tab==='requests'?<section className="space-y-3">
        {!pending.length&&<div className="rounded-2xl border border-white/10 p-8 text-center text-white/50">No request needs your answer.</div>}
        {pending.map((r,i)=>{const p=[r.profile.groupType,r.profile.people?`${r.profile.people} people`:null,r.profile.country,r.profile.job].filter(Boolean);return <article key={r.id} className="rounded-2xl border border-white/10 bg-white/[.045] p-5">
          <div className="flex items-start justify-between gap-4"><div><div className="text-[10px] uppercase tracking-[.18em] text-[#c8a96b]">{i?'Back-to-back request':'Booking request'}</div><h2 className="mt-2 text-xl font-semibold">{fmtWhen.format(new Date(r.startsAt))}</h2><p className="mt-1 text-sm text-white/50">{r.durationMin} min{p.length?` · ${p.join(' · ')}`:''}</p></div><Clock3 className="h-5 w-5 text-[#c8a96b]"/></div>
          {r.justification&&<p className="mt-4 border-l border-[#c8a96b] pl-3 text-sm text-white/70">Agent note: {r.justification}</p>}
          <div className="mt-5 grid grid-cols-2 gap-2"><button disabled={busy} onClick={()=>decide(r.id,'decline')} className="flex items-center justify-center gap-2 rounded-xl border border-white/15 py-3 text-sm"><X className="h-4 w-4"/>No</button><button disabled={busy} onClick={()=>decide(r.id,'accept')} className="flex items-center justify-center gap-2 rounded-xl bg-[#d3b574] py-3 text-sm font-bold text-[#07141b]"><Check className="h-4 w-4"/>Confirm</button></div>
        </article>})}
      </section>:<section className="rounded-2xl border border-white/10 bg-white/[.045] p-4 sm:p-6">
        <div className="flex items-center justify-between gap-4"><div><div className="text-[10px] uppercase tracking-[.18em] text-[#c8a96b]">Next 7 days</div><h2 className="mt-1 text-xl font-semibold">When can you open the property?</h2></div><CalendarDays className="h-5 w-5 text-[#c8a96b]"/></div>
        <div className="mt-5 flex gap-2 overflow-x-auto pb-2">{days.map((d,i)=><button key={i} onClick={()=>setDay(i)} className={`min-w-[86px] rounded-xl px-3 py-3 text-xs ${day===i?'bg-[#f4edda] text-[#07141b]':'bg-white/[.06] text-white/65'}`}>{fmtDay.format(d)}</button>)}</div>
        <div className="mt-4 flex items-center gap-2 text-xs text-white/55">Slot length {[20,10].map(n=><button key={n} onClick={()=>{setDuration(n as 10|20);setSelected(new Set())}} className={`rounded-full px-3 py-1.5 ${duration===n?'bg-[#d3b574] text-[#07141b]':'bg-white/[.07]'}`}>{n} min</button>)}</div>
        <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6">{slots.map(s=>{const active=selected.has(s);return <button key={s} onClick={()=>setSelected(prev=>{const n=new Set(prev);active?n.delete(s):n.add(s);return n})} className={`rounded-lg py-2 text-xs ${active?'bg-[#d3b574] font-bold text-[#07141b]':'bg-white/[.06] text-white/65'}`}>{new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit'}).format(new Date(s))}</button>})}</div>
        <button disabled={busy||!selected.size} onClick={save} className="mt-5 w-full rounded-xl bg-[#f4edda] py-3.5 text-sm font-bold text-[#07141b] disabled:opacity-30">{saved?'Times updated':`Save ${selected.size||''} slot${selected.size===1?'':'s'}`}</button>
      </section>}
    </div>
  </main>
}
