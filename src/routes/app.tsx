import { useEffect, useState } from 'react'
import { createFileRoute, redirect, Outlet, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { LanguageSwitcherCompact } from '../components/LanguageSwitcher'
import { BRAND } from '../lib/brand'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: '/login' })
    }
  },
  component: AppShell,
})

function AppShell() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [role, setRole] = useState<'member' | 'coach' | null>(null)
  const onWelcome = pathname.startsWith('/app/welcome')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const userId = userData.user?.id
      if (!userId) return
      const { data } = await supabase
        .from('profiles')
        .select('role, has_set_name')
        .eq('id', userId)
        .single()
      if (cancelled) return
      setRole((data?.role as 'member' | 'coach') ?? 'member')
      // 首次登入尚未設定名字 → 導去歡迎頁設定；設定過就不再出現。
      if (data && !data.has_set_name && !pathname.startsWith('/app/welcome')) {
        void navigate({ to: '/app/welcome' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pathname, navigate])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
  }

  const NAV_ITEMS = [
    { to: '/app/home' as const, label: t('書寫') },
    { to: '/app/community' as const, label: t('社群') },
    { to: '/app/report' as const, label: t('個人幸福報告') },
    { to: '/app/settings' as const, label: t('設定') },
    ...(role === 'coach' ? [{ to: '/app/coach' as const, label: t('教練儀表板') }] : []),
  ]

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-5">
          <span className="font-heading text-sm font-semibold text-foreground">{BRAND.name}</span>
          {!onWelcome && (
            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.to)
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      active
                        ? 'bg-primary-soft text-primary'
                        : 'text-foreground-soft hover:bg-muted'
                    }`}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          )}
          <div className="flex items-center gap-3">
            <LanguageSwitcherCompact />
            <button
              onClick={handleSignOut}
              className="text-xs font-medium text-muted-foreground underline"
            >
              {t('登出')}
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
