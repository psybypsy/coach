import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { currentWeekStart } from '../lib/week'
import { DIMENSION_ORDER, DIMENSION_CONFIGS } from '../lib/perma'
import { loadDraft, saveDraft, clearDraft, emptyAnswers, type JournalAnswers } from '../lib/journalDraft'

export const Route = createFileRoute('/app/journal')({
  component: JournalWizard,
})

// 依 DIMENSION_ORDER 找出第一個尚未填的題目，做為回來後接續的起點。
function firstUnansweredStep(answers: JournalAnswers): number {
  const idx = DIMENSION_ORDER.findIndex((k) => !answers[k].trim())
  return idx === -1 ? DIMENSION_ORDER.length - 1 : idx
}

function JournalWizard() {
  const { t, language } = useLanguage()
  const navigate = useNavigate()

  const [userId, setUserId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [answers, setAnswers] = useState<JournalAnswers>(emptyAnswers())
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const weekStart = currentWeekStart()
  const currentKey = DIMENSION_ORDER[step]
  const dim = DIMENSION_CONFIGS[currentKey]

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid || cancelled) return
      const draft = loadDraft(uid, weekStart)
      setUserId(uid)
      setAnswers(draft)
      setStep(firstUnansweredStep(draft))
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [weekStart])

  // 每次答案變動就自動存草稿。
  useEffect(() => {
    if (ready && userId) saveDraft(userId, weekStart, answers)
  }, [answers, ready, userId, weekStart])

  const setCurrent = (value: string) => {
    setAnswers((prev) => ({ ...prev, [currentKey]: value }))
  }

  const currentFilled = answers[currentKey].trim().length > 0
  const isLast = step === DIMENSION_ORDER.length - 1

  const handleNext = () => {
    if (!currentFilled) return
    setStep((s) => Math.min(s + 1, DIMENSION_ORDER.length - 1))
  }

  const handleBack = () => {
    setStep((s) => Math.max(s - 1, 0))
  }

  const handlePublish = async () => {
    if (!userId) return
    const allFilled = DIMENSION_ORDER.every((k) => answers[k].trim())
    if (!allFilled) {
      setError(t('請先完成全部 5 題再發布。'))
      return
    }
    setSubmitting(true)
    setError(null)

    // 1) 寫入 5 列 perma_entries（個人報告 / AI 週分析沿用）。
    const entries = DIMENSION_ORDER.map((k) => ({
      user_id: userId,
      dimension: k,
      content: answers[k].trim(),
      is_public: true,
      input_method: 'text',
    }))
    const { error: entriesError } = await supabase.from('perma_entries').insert(entries)
    if (entriesError) {
      setSubmitting(false)
      setError(t('發布失敗，請再試一次。'))
      return
    }

    // 2) 寫入 1 列 journal_posts（社群牆的一則週記合併貼文，同一週可多則）。
    const { error: postError } = await supabase.from('journal_posts').insert({
      user_id: userId,
      week_start: weekStart,
      p_content: answers.P.trim(),
      e_content: answers.E.trim(),
      r_content: answers.R.trim(),
      m_content: answers.M.trim(),
      a_content: answers.A.trim(),
      is_public: true,
    })
    setSubmitting(false)
    if (postError) {
      setError(t('發布失敗，請再試一次。'))
      return
    }

    clearDraft(userId, weekStart)
    void navigate({ to: '/app/home' })
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
      <div className="mx-auto max-w-md space-y-5">
        {/* 五題進度 */}
        <div className="flex items-center gap-2">
          {DIMENSION_ORDER.map((k, i) => (
            <div key={k} className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-muted'}`} />
          ))}
        </div>
        <p className="text-xs font-semibold text-muted-foreground">
          {t('第 {n} 題，共 5 題', { n: step + 1 })}
        </p>

        <div>
          <div className={`font-heading text-sm ${dim.textColor}`}>
            {language === 'en' ? dim.sublabel : `${dim.label} · ${dim.sublabel}`}
          </div>
          <h1 className="font-heading mt-1 text-xl text-foreground">{t(dim.question)}</h1>
        </div>

        <textarea
          value={answers[currentKey]}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder={t('寫下你的想法')}
          rows={8}
          autoFocus
          className="w-full rounded-xl border border-border bg-card p-5 text-base leading-relaxed text-foreground shadow-soft outline-none placeholder:text-muted-foreground focus:border-primary"
        />

        {error && <p className="text-sm leading-relaxed text-rust">{error}</p>}

        <div className="flex items-center gap-3">
          {step > 0 && (
            <button
              onClick={handleBack}
              className="flex h-12 flex-1 items-center justify-center rounded-lg border border-border bg-card text-base font-semibold text-foreground-soft transition hover:bg-muted active:scale-[0.98]"
            >
              {t('上一題')}
            </button>
          )}
          {isLast ? (
            <button
              onClick={() => void handlePublish()}
              disabled={submitting || !currentFilled}
              className="flex h-12 flex-[2] items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? t('發布中…') : t('發布到社群')}
            </button>
          ) : (
            <button
              onClick={handleNext}
              disabled={!currentFilled}
              className="flex h-12 flex-[2] items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
            >
              {t('下一題')}
            </button>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground">{t('系統會自動保存草稿')}</p>
      </div>
    </div>
  )
}
