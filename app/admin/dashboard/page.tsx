'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { adminApi, type DailyStats } from '@/lib/admin-api'

// ── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({
  label, value, sub, accent, href,
}: {
  label: string
  value: number | string
  sub?: string
  accent: string
  href?: string
}) {
  const inner = (
    <div className={`bg-white/5 rounded-xl p-5 border border-white/5 flex flex-col gap-1 transition-colors ${href ? 'hover:bg-white/10 cursor-pointer' : ''}`}>
      <p className="text-xs text-white/50 uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold ${accent}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {sub && <p className="text-xs text-white/30 mt-1">{sub}</p>}
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}

// ── Stat Row ──────────────────────────────────────────────────────────────────
function StatRow({ label, today, yesterday, week }: {
  label: string
  today: number
  yesterday: number
  week: number
}) {
  return (
    <div className="grid grid-cols-4 gap-2 py-2 border-b border-white/5 last:border-0 text-sm">
      <span className="text-white/60">{label}</span>
      <span className="text-white font-medium text-right">{today.toLocaleString()}</span>
      <span className="text-white/50 text-right">{yesterday.toLocaleString()}</span>
      <span className="text-[#B8953F] text-right">{week.toLocaleString()}</span>
    </div>
  )
}

// ── Quick Action Button ───────────────────────────────────────────────────────
function ActionBtn({ href, label, icon, color }: {
  href: string; label: string; icon: string; color: string
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${color} text-sm font-medium transition-colors hover:opacity-80`}
    >
      <span className="text-lg leading-none">{icon}</span>
      {label}
    </Link>
  )
}

// ── Custom Tooltip for Chart ──────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  const d = new Date(label as string)
  const fmt = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return (
    <div className="bg-[#1a2235] border border-white/10 rounded-lg px-3 py-2 text-xs space-y-1">
      <p className="text-white/50 mb-1">{fmt}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</p>
      ))}
    </div>
  )
}

// ── Refresh Indicator ─────────────────────────────────────────────────────────
function RefreshDot({ countdown }: { countdown: number }) {
  return (
    <span className="text-xs text-white/30 flex items-center gap-1.5">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-green-500"
        style={{ opacity: countdown < 10 ? 0.5 : 1 }}
      />
      refreshes in {countdown}s
    </span>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [data, setData]       = useState<DailyStats | null>(null)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(true)
  const [countdown, setCountdown] = useState(60)

  const load = useCallback(() => {
    adminApi.dailyStats()
      .then(d => { setData(d); setError(''); setLoading(false); setCountdown(60) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    const tick = setInterval(() => setCountdown(c => (c <= 1 ? 60 : c - 1)), 1000)
    return () => clearInterval(tick)
  }, [])

  // Chart day label: "Mon", "Tue", etc.
  const chartData = (data?.chart ?? []).map(r => ({
    ...r,
    label: new Date(r.day).toLocaleDateString('en-GB', { weekday: 'short' }),
  }))

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-white mb-6">Overview</h1>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white/5 rounded-xl p-5 animate-pulse h-24" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-white mb-4">Overview</h1>
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    )
  }

  if (!data) return null
  const { today, yesterday, this_week, pipeline, performance } = data

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Overview</h1>
        <RefreshDot countdown={countdown} />
      </div>

      {/* ── Top KPI Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Today's Submissions"
          value={today.form_submissions + today.new_clients}
          sub={`${today.form_submissions} form · ${today.new_clients} WA`}
          accent="text-blue-400"
          href="/admin/dashboard/crm/clients"
        />
        <KpiCard
          label="Active Pipeline"
          value={pipeline.hot_leads}
          sub={`${pipeline.pending_matches} pending matches`}
          accent="text-green-400"
          href="/admin/dashboard/crm/clients"
        />
        <KpiCard
          label="Needs Response"
          value={pipeline.needs_response}
          sub="replied in last 7 days"
          accent="text-orange-400"
          href="/admin/dashboard/crm/owners"
        />
        <KpiCard
          label="Week Outreach"
          value={this_week.outreach_sent}
          sub={`${this_week.replies_received} replies`}
          accent="text-[#B8953F]"
        />
      </div>

      {/* ── Middle Row: Stats Table + Quick Actions ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Activity Table */}
        <div className="lg:col-span-2 bg-white/5 rounded-xl p-5 border border-white/5">
          <h2 className="text-sm font-medium text-white mb-4">Activity</h2>
          <div className="grid grid-cols-4 gap-2 mb-2">
            <span className="text-xs text-white/30 uppercase tracking-wide">Metric</span>
            <span className="text-xs text-white/30 uppercase tracking-wide text-right">Today</span>
            <span className="text-xs text-white/30 uppercase tracking-wide text-right">Yesterday</span>
            <span className="text-xs text-white/30 uppercase tracking-wide text-right">This Week</span>
          </div>
          <StatRow label="Form Submissions" today={today.form_submissions}    yesterday={yesterday.form_submissions}    week={this_week.form_submissions} />
          <StatRow label="New Clients"       today={today.new_clients}         yesterday={yesterday.new_clients}         week={this_week.new_clients} />
          <StatRow label="New Properties"    today={today.new_properties}      yesterday={yesterday.new_properties}      week={this_week.new_properties} />
          <StatRow label="Outreach Sent"     today={today.outreach_sent}       yesterday={yesterday.outreach_sent}       week={this_week.outreach_sent} />
          <StatRow label="Replies Received"  today={today.replies_received}    yesterday={yesterday.replies_received}    week={this_week.replies_received} />
          <StatRow label="Scraper Leads"     today={today.scraper_leads}       yesterday={yesterday.scraper_leads}       week={this_week.scraper_leads} />
        </div>

        {/* Quick Actions + Performance */}
        <div className="flex flex-col gap-4">

          {/* Quick Actions */}
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <h2 className="text-sm font-medium text-white mb-3">Quick Actions</h2>
            <div className="flex flex-col gap-2">
              <ActionBtn
                href="/admin/dashboard/crm/clients"
                label="New Clients"
                icon="🤝"
                color="border-blue-500/30 text-blue-300 bg-blue-500/5"
              />
              <ActionBtn
                href="/admin/dashboard/crm/owners"
                label="Hot Leads"
                icon="🔥"
                color="border-orange-500/30 text-orange-300 bg-orange-500/5"
              />
              <ActionBtn
                href="/admin/dashboard/crm/warm"
                label="Warm Contacts"
                icon="💬"
                color="border-green-500/30 text-green-300 bg-green-500/5"
              />
            </div>
          </div>

          {/* Performance */}
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <h2 className="text-sm font-medium text-white mb-3">Performance (30d)</h2>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-white/50">WA Reply Rate</span>
                  <span className="text-white">{performance.reply_rate_whatsapp}%</span>
                </div>
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 rounded-full"
                    style={{ width: `${Math.min(performance.reply_rate_whatsapp, 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-white/50">Conversion Rate</span>
                  <span className="text-white">{performance.conversion_rate}%</span>
                </div>
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#B8953F] rounded-full"
                    style={{ width: `${Math.min(performance.conversion_rate, 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-white/50">Pending Matches</span>
                  <span className="text-white">{pipeline.pending_matches}</span>
                </div>
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-purple-500 rounded-full"
                    style={{ width: `${Math.min(pipeline.pending_matches * 5, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── 7-Day Bar Chart ── */}
      <div className="bg-white/5 rounded-xl p-5 border border-white/5">
        <h2 className="text-sm font-medium text-white mb-5">Last 7 Days</h2>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="label"
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Bar dataKey="clients"    name="Clients"    fill="#60a5fa" radius={[2, 2, 0, 0]} />
            <Bar dataKey="properties" name="Properties" fill="#34d399" radius={[2, 2, 0, 0]} />
            <Bar dataKey="outreach"   name="Outreach"   fill="#B8953F" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <div className="flex gap-5 mt-3 justify-center">
          {[['Clients', '#60a5fa'], ['Properties', '#34d399'], ['Outreach', '#B8953F']].map(([l, c]) => (
            <span key={l} className="flex items-center gap-1.5 text-xs text-white/40">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: c }} />
              {l}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
