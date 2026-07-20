import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { LanguageSwitcherCompact } from '../components/LanguageSwitcher'

export const Route = createFileRoute('/app')({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: '/login' })
    }
  },
  component: AppShell,
})

function AppShell() {
  const { t, language } = useLanguage()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-5">
        <span className="font-heading text-base text-foreground">
          {language === 'en' ? 'Tan Yee Ming' : '陳郁敏'}
        </span>
        <div className="flex items-center gap-3">
          <LanguageSwitcherCompact />
          <button
            onClick={handleSignOut}
            className="text-xs font-semibold text-muted-foreground underline"
          >
            {t('登出')}
          </button>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
