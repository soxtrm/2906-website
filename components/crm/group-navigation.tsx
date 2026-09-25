'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function crmPath(path: string, pathname: string) {
  return pathname === '/crm' || pathname.startsWith('/crm/') ? `/crm${path === '/' ? '' : path}` : path
}

export function GroupNavigation() {
  const pathname = usePathname() || '/'
  const normalized = pathname.replace(/^\/crm(?=\/|$)/, '') || '/'
  return <nav className="crm-group-tabs" aria-label="Conversation dashboards">
    {[['/clientgroups', 'Clientgroups'], ['/ownergroups', 'Ownergroups']].map(([path, label]) =>
      <Link key={path} href={crmPath(path, pathname)} aria-current={normalized.startsWith(path) ? 'page' : undefined}>{label}</Link>)}
  </nav>
}

export function GroupStats({ items }: { items: { label: string; value: number }[] }) {
  return <div className="crm-group-stats">{items.map(item => <div className="crm-group-stat" key={item.label}>
    <strong>{item.value}</strong><span>{item.label}</span>
  </div>)}</div>
}
