'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'

const NAV = [
  { href: '/admin/dashboard', label: 'Overview', icon: '▤' },
  { href: '/admin/dashboard/properties', label: 'Properties', icon: '🏠' },
  { href: '/admin/dashboard/crm/owners', label: 'Owners', icon: '👤' },
  { href: '/admin/dashboard/crm/clients', label: 'Clients', icon: '🤝' },
  { href: '/admin/dashboard/crm/warm', label: 'Warm Contacts', icon: '🔥' },
  { href: '/admin/dashboard/matches', label: 'Matches', icon: '🔗' },
]

const ADMIN_NAV = [
  { href: '/admin/dashboard/content', label: 'Website Content', icon: '✏️' },
  { href: '/admin/dashboard/users', label: 'Users', icon: '⚙️' },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [role, setRole] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('admin_token')
    if (!token) { router.replace('/admin'); return }
    setRole(localStorage.getItem('admin_role'))
    setEmail(localStorage.getItem('admin_email'))
  }, [router])

  function logout() {
    localStorage.removeItem('admin_token')
    localStorage.removeItem('admin_role')
    localStorage.removeItem('admin_email')
    router.replace('/admin')
  }

  const allNav = role === 'admin' ? [...NAV, ...ADMIN_NAV] : NAV

  const Sidebar = () => (
    <aside className="w-56 shrink-0 bg-[#111827] border-r border-white/5 flex flex-col h-full">
      <div className="px-5 py-5 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-[#B8953F] flex items-center justify-center text-white font-bold text-sm">2</div>
          <span className="font-bold text-white">2906 Admin</span>
        </div>
      </div>

      <nav className="flex-1 py-4 px-3 space-y-0.5 overflow-y-auto">
        {allNav.map(item => {
          const active = pathname === item.href || (item.href !== '/admin/dashboard' && pathname.startsWith(item.href))
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active ? 'bg-[#B8953F]/20 text-[#B8953F] font-medium' : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="px-4 py-4 border-t border-white/5">
        <p className="text-xs text-white/40 truncate mb-2">{email}</p>
        <p className="text-xs text-[#B8953F] capitalize mb-3">{role}</p>
        <button
          onClick={logout}
          className="w-full text-left text-xs text-white/40 hover:text-white transition-colors"
        >
          Sign out →
        </button>
      </div>
    </aside>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-col h-full">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="fixed inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <div className="relative z-50 flex flex-col h-full">
            <Sidebar />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile topbar */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-white/5 bg-[#111827]">
          <button onClick={() => setSidebarOpen(true)} className="text-white/60 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="font-semibold text-white text-sm">2906 Admin</span>
        </div>

        <main className="flex-1 overflow-y-auto bg-[#0f1623] p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
