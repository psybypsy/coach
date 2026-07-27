import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_ORDER, DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/baseline')({
  component: BaselinePage,
})

// 起始分數回想的日期：2026/07/17（五）在台東當天。
export const BASELINE_REFERENCE_DATE = '2026-07-17'

// 每個面向要學員回想的提問（跟每週書寫的題目不同：這裡問的是「當時的狀態」）。
const BASELINE_PROMPTS: Record<DimensionKey, string> = {
  P: '當天你感受到的正向情緒有多少？',
  E: '當天你有多投入在正在做的事情裡？',
  R: '當天你和身邊的人連結得有多緊密？',
  M: '當天你有多感覺到自己做的事是有意義的？',
  A: '當天你有多感覺到自己完成了什麼？',
}

const DEFAULT_SCORE = 5

function BaselinePage() {
  const { t, language } = useLanguage()
  const navigate = useNavigate()

  const [userId, setUserId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [scores, setScores] = useState<Record<DimensionKey, number>>({
    P: DEFAULT_SCORE,
    E: DEFAULT_SCORE,
    R: DEFAULT_SCORE,
    M: DEFAULT_SCORE,
    A: DEFAULT_SCORE,
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid || cancelled) return
      // 已經填過就不再讓他填一次（起始分數只填一次）。
      const { data: existing } = await supabase
        .from('baseline_scores')
        .select('user_id')
        .eq('user_id', uid)
        .maybeSingle()
      if (cancelled) return
      if (existing) {
        void navigate({ to: '/app/home', replace: true })
        return
      }
      setUserId(uid)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [navigate])

  const referenceDateLabel =
    language === 'en'
      ? 'Friday, 17 July 2026, in Taitung'
      : '2026 年 7 月 17 日（五）在台東'

  const handleSubmit = async () => {
    if (!userId) return
    setSubmitting(true)
    setError(null)

    const { error: insertError } = await supabase.from('baseline_scores').insert({
      user_id: userId,
      p: scores.P,
      e: scores.E,
      r: scores.R,
      m: scores.M,
      a: scores.A,
      reference_date: BASELINE_REFERENCE_DATE,
    })

    if (insertError) {
      console.error('Baseline insert error:', insertError.message)
      setError(t('儲存失敗，請稍後再試一次。'))
      setSubmitting(false)
      return
    }
    void navigate({ to: '/app/home', replace: true })
  }

  if (!ready) {
    return (
      <div className="mx-auto max-w-md px-6 py-10">
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      </div>
    )
  }

  return (
    <div className="bg-page min-h-screen px-6 py-10">
      <div className="mx-auto max-w-md space-y-6">
        <div className="space-y-2">
          <h1 className="font-heading text-xl text-foreground">{t('開始之前，先回想一下')}</h1>
          <p className="text-sm leading-relaxed text-foreground-soft">
            {t('請回想{date}的那一天，當時你在這五個面向的感受大概各是幾分？', {
              date: referenceDateLabel,
            })}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('這是你的起點。之後每一週的記錄都會跟它對照，讓你看見自己的變化。')}
          </p>
        </div>

        <div className="space-y-4">
          {DIMENSION_ORDER.map((k) => {
            const dim = DIMENSION_CONFIGS[k]
            return (
              <div key={k} className="rounded-xl border border-border bg-card p-4 shadow-soft">
                <div className="flex items-baseline justify-between gap-3">
                  <div className={`font-heading text-sm ${dim.textColor}`}>
                    {language === 'en' ? dim.sublabel : `${dim.label} · ${dim.sublabel}`}
                  </div>
                  <span className="font-heading text-xl tabular-nums text-foreground">{scores[k]}</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {t(BASELINE_PROMPTS[k])}
                </p>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={scores[k]}
                  onChange={(e) => setScores((prev) => ({ ...prev, [k]: Number(e.target.value) }))}
                  aria-label={dim.sublabel}
                  className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                />
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>0</span>
                  <span>10</span>
                </div>
              </div>
            )
          })}
        </div>

        {error && <p className="text-sm leading-relaxed text-rust">{error}</p>}

        <button
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="flex h-12 w-full items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
        >
          {submitting ? t('儲存中…') : t('儲存並開始第一次記錄')}
        </button>

        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          {t('送出後就不能修改了，憑當時的印象填就好，不用太精準。')}
        </p>
      </div>
    </div>
  )
}
