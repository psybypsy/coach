import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { currentWeekStart } from '../lib/week'

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
  const [doneThisWeek, setDoneThisWeek] = useState<boolean | null>(null)

  const weekStart = currentWeekStart()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const userId = userData.user?.id
      if (!userId) return
      const [{ data: prof }, { data: post }] = await Promise.all([
        supabase.from('profiles').select('display_name, role').eq('id', userId).single(),
        supabase
          .from('journal_posts')
          .select('id')
          .eq('user_id', userId)
          .eq('week_start', weekStart)
          .maybeSingle(),
      ])
      if (cancelled) return
      setProfile(prof)
      setDoneThisWeek(!!post)
    })()
    return () => {
      cancelled = true
    }
  }, [weekStart])

  return (
    <div className="bg-page min-h-screen px-6 py-10">
      <div className="mx-auto max-w-md space-y-6">
        <p className="text-foreground-soft text-sm">
          {profile ? `${language === 'en' ? 'Hi, ' : '嗨，'}${profile.display_name}` : language === 'en' ? 'Hi' : '嗨'}
          {profile?.role === 'coach' && (
            <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-bold text-foreground">
              {t('教練')}
            </span>
          )}
        </p>

        {doneThisWeek === null ? (
          <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
        ) : doneThisWeek ? (
          // 本週已完成
          <div className="rounded-xl border border-border bg-card p-6 text-center shadow-soft">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft">
              <CheckIcon />
            </div>
            <h1 className="font-heading text-xl text-foreground">{t('本週書寫已完成')}</h1>
            <p className="mt-2 text-sm leading-relaxed text-foreground-soft">
              {t('你這週的 PERMA 週記已經發布到社群，下週再回來寫一次。')}
            </p>
            <div className="mt-5 flex gap-3">
              <Link
                to="/app/community"
                className="flex h-11 flex-1 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98]"
              >
                {t('看看社群')}
              </Link>
              <Link
                to="/app/report"
                className="flex h-11 flex-1 items-center justify-center rounded-lg border border-border bg-card text-sm font-semibold text-foreground-soft transition hover:bg-muted active:scale-[0.98]"
              >
                {t('個人幸福報告')}
              </Link>
            </div>
          </div>
        ) : (
          // 本週尚未書寫：呈現說明 + 開始
          <div className="space-y-6">
            <h1 className="font-heading text-2xl text-foreground">{t('本週 PERMA 書寫')}</h1>
            <div className="rounded-xl border border-border bg-card p-6 shadow-soft">
              <p className="text-[15px] leading-relaxed text-foreground-soft">
                {t(
                  '書寫是培養覺察、支持建立新習慣的有效方法。我鼓勵你透過回答這 5 個問題來練習。請每週進行一次，最好固定在每週同一天、同一時段（例如每週五下午或週一早上）。系統會協助你記錄，並在接下來的 8 週為你呈現 PERMA 進展報告。',
                )}
              </p>
            </div>
            <Link
              to="/app/journal"
              className="flex h-12 w-full items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98]"
            >
              {t('開始本週書寫')}
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg className="h-6 w-6 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
