import { useEffect, useState, type ReactNode } from 'react'
import { createFileRoute, redirect, Outlet, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { LanguageSwitcherCompact } from '../components/LanguageSwitcher'
import { BRAND } from '../lib/brand'
import { currentWeekStart } from '../lib/week'
import { nextReminderAt } from '../lib/journalStats'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: '/login' })
    }
  },
  component: AppShell,
})

type Panel = 'none' | 'menu' | 'notif'

function AppShell() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [displayName, setDisplayName] = useState('')
  const [panel, setPanel] = useState<Panel>('none')
  const onWelcome = pathname.startsWith('/app/welcome')
  // 教練後台不顯示成員導覽（PERMA Self-Reflection / 社群），避免點了跳到成員介面又回不來。
  const onCoach = pathname.startsWith('/app/coach')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const userId = userData.user?.id
      if (!userId) return
      const { data } = await supabase
        .from('profiles')
        .select('display_name, has_set_name')
        .eq('id', userId)
        .single()
      if (cancelled) return
      setDisplayName(data?.display_name ?? '')
      // 首次登入尚未設定名字 → 導去歡迎頁設定；設定過就不再出現。
      if (data && !data.has_set_name && !pathname.startsWith('/app/welcome')) {
        void navigate({ to: '/app/welcome' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pathname, navigate])

  // 換頁時收起彈出面板。
  useEffect(() => {
    setPanel('none')
  }, [pathname])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
  }

  const NAV_ITEMS = [
    { to: '/app/home' as const, label: t('PERMA Self-Reflection') },
    { to: '/app/community' as const, label: t('社群') },
  ]

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="relative border-b border-border">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-5">
          <span className="font-heading text-sm font-semibold text-foreground">{BRAND.name}</span>

          {!onWelcome ? (
            <div className="flex items-center gap-1">
              <IconButton label={t('重新整理')} onClick={() => window.location.reload()}>
                <RefreshIcon />
              </IconButton>
              <NotificationBell
                open={panel === 'notif'}
                onToggle={() => setPanel((p) => (p === 'notif' ? 'none' : 'notif'))}
              />
              <IconButton
                label={t('選單')}
                onClick={() => setPanel((p) => (p === 'menu' ? 'none' : 'menu'))}
              >
                <MenuIcon />
              </IconButton>
            </div>
          ) : (
            <button onClick={handleSignOut} className="text-xs font-medium text-muted-foreground underline">
              {t('登出')}
            </button>
          )}
        </div>

        {!onWelcome && !onCoach && (
          <nav className="mx-auto -mt-1 flex max-w-4xl items-center gap-1 overflow-x-auto px-5 pb-2">
            {NAV_ITEMS.map((item) => {
              const active = pathname.startsWith(item.to)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    active ? 'bg-primary-soft text-primary' : 'text-foreground-soft hover:bg-muted'
                  }`}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        )}

        {/* 選單面板：改名字、語言、登出 */}
        {panel === 'menu' && (
          <>
            <button
              aria-label={t('關閉')}
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setPanel('none')}
            />
            <div className="absolute right-4 top-[calc(100%-0.25rem)] z-50 w-60 rounded-xl border border-border bg-card p-2 shadow-lg">
              {displayName && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('目前登入')} · <span className="font-semibold text-foreground">{displayName}</span>
                </div>
              )}
              <Link
                to="/app/settings"
                className="block rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
              >
                {t('編輯名字')}
              </Link>
              <div className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-foreground">
                <span>{t('語言')}</span>
                <LanguageSwitcherCompact />
              </div>
              <button
                onClick={handleSignOut}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-rust transition hover:bg-muted"
              >
                {t('登出')}
              </button>
            </div>
          </>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-foreground-soft transition hover:bg-muted"
    >
      {children}
    </button>
  )
}

// 通知鈴鐺：每週會依「上次書寫的星期幾、固定 21:00、隔一週」寄 Email 提醒
// 邀請回來記錄。到期且本週還沒寫就在鈴鐺上顯示紅點。
function NotificationBell({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t, language } = useLanguage()
  const [nextAt, setNextAt] = useState<Date | null>(null)
  const [due, setDue] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid) return
      const { data } = await supabase
        .from('journal_posts')
        .select('created_at, week_start')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled || !data) return
      const next = nextReminderAt(data.created_at)
      setNextAt(next)
      const wroteThisWeek = data.week_start === currentWeekStart()
      setDue(Date.now() >= next.getTime() && !wroteThisWeek)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const formatNext = (d: Date) =>
    d.toLocaleString(language === 'en' ? 'en-US' : 'zh-TW', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: language === 'en',
    })

  return (
    <div className="relative">
      <IconButton label={t('通知')} onClick={onToggle}>
        <span className="relative">
          <BellIcon />
          {due && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-rust" />}
        </span>
      </IconButton>

      {open && (
        <>
          <button aria-label={t('關閉')} className="fixed inset-0 z-40 cursor-default" onClick={onToggle} />
          <div className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-72 rounded-xl border border-border bg-card p-4 shadow-lg">
            <p className="font-heading text-sm text-foreground">{t('每週回顧提醒')}</p>
            <p className="mt-1 text-xs leading-relaxed text-foreground-soft">
              {t('每週我們會在你固定的時間寄 Email 提醒你，回來記錄這週的 PERMA Self-Reflection。')}
            </p>

            {due && (
              <div className="mt-3 rounded-lg bg-primary-soft px-3 py-2">
                <p className="text-xs font-semibold text-primary">{t('是時候寫這週的回顧了！')}</p>
                <Link to="/app/journal" className="mt-1 inline-block text-xs font-semibold text-primary underline">
                  {t('開始記錄')}
                </Link>
              </div>
            )}

            {nextAt && (
              <p className="mt-3 text-xs text-muted-foreground">
                {t('下次提醒')}：{formatNext(nextAt)}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function RefreshIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}

function MenuIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}
