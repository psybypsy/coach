import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_ORDER, DIMENSION_CONFIGS } from '../lib/perma'

export const Route = createFileRoute('/app/home')({
  component: HomePage,
})

interface Profile {
  display_name: string
  role: 'member' | 'coach'
}

function HomePage() {
  const { t, language } = useLanguage()
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const { data: userData } = await supabase.auth.getUser()
      const userId = userData.user?.id
      if (!userId) return
      const { data } = await supabase
        .from('profiles')
        .select('display_name, role')
        .eq('id', userId)
        .single()
      if (!cancelled) setProfile(data)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="bg-page min-h-screen px-6 py-10">
      <div className="mx-auto max-w-md">
        <p className="text-foreground-soft text-sm">
          {profile ? `${language === 'en' ? 'Hi, ' : '嗨，'}${profile.display_name}` : (language === 'en' ? 'Hi' : '嗨')}
          {profile?.role === 'coach' && (
            <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-bold text-foreground">
              {language === 'en' ? 'Coach' : '教練'}
            </span>
          )}
        </p>
        <h1 className="font-heading mb-8 mt-1 text-2xl text-foreground">{t('今天想寫哪個維度？')}</h1>

        <div className="grid gap-4">
          {DIMENSION_ORDER.map((key) => {
            const dim = DIMENSION_CONFIGS[key]
            return (
              <Link
                key={key}
                to="/app/write/$dimension"
                params={{ dimension: key }}
                className={`rounded-3xl border ${dim.borderLight} ${dim.bgLight} p-5 shadow-soft transition active:scale-[0.98]`}
              >
                <div className={`font-heading text-sm ${dim.textColor} mb-1`}>
                  {language === 'en' ? dim.sublabel : `${dim.label} · ${dim.sublabel}`}
                </div>
                <div className="text-sm text-foreground">{t(dim.question)}</div>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
