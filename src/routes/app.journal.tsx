import { useEffect, useState, type ReactNode } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { currentWeekStart } from '../lib/week'
import { DIMENSION_ORDER, DIMENSION_CONFIGS } from '../lib/perma'
import { loadDraft, saveDraft, clearDraft, emptyAnswers, type JournalAnswers } from '../lib/journalDraft'
import { generateEnergyAlias } from '../lib/energyAlias'
import { requestWeeklyReport } from '../lib/memberReport'

export const Route = createFileRoute('/app/journal')({
  component: JournalWizard,
})

type Visibility = 'public' | 'anonymous' | 'private'

// 5 題問答結束後的「選擇發布方式」步驟。
const PUBLISH_STEP = DIMENSION_ORDER.length

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
  const [visibility, setVisibility] = useState<Visibility>('public')
  const [anonAlias, setAnonAlias] = useState('')

  const weekStart = currentWeekStart()
  // step 到達 PUBLISH_STEP 時已經沒有對應題目，夾在最後一題避免 index 越界。
  const currentKey = DIMENSION_ORDER[Math.min(step, DIMENSION_ORDER.length - 1)]
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
  const isLastQuestion = step === DIMENSION_ORDER.length - 1
  const isPublishStep = step === PUBLISH_STEP

  const handleNext = () => {
    if (!currentFilled) return
    setStep((s) => (s === DIMENSION_ORDER.length - 1 ? PUBLISH_STEP : s + 1))
  }

  const handleBack = () => {
    setStep((s) => (s === PUBLISH_STEP ? DIMENSION_ORDER.length - 1 : Math.max(s - 1, 0)))
  }

  const selectVisibility = (v: Visibility) => {
    setVisibility(v)
    if (v === 'anonymous' && !anonAlias) {
      setAnonAlias(generateEnergyAlias(language))
    }
  }

  const rerollAlias = () => setAnonAlias(generateEnergyAlias(language))

  const handlePublish = async () => {
    if (!userId) return
    const allFilled = DIMENSION_ORDER.every((k) => answers[k].trim())
    if (!allFilled) {
      setError(t('請先完成全部 5 題再發布。'))
      return
    }
    setSubmitting(true)
    setError(null)

    try {
      const isPublic = visibility !== 'private'

      // 1) 寫入 5 列 perma_entries（個人報告 / AI 週分析沿用）。
      const entries = DIMENSION_ORDER.map((k) => ({
        user_id: userId,
        dimension: k,
        content: answers[k].trim(),
        is_public: isPublic,
        input_method: 'text',
      }))
      const { error: entriesError } = await supabase.from('perma_entries').insert(entries)
      if (entriesError) {
        throw new Error(`Failed to save entries: ${entriesError.message}`)
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
        is_public: isPublic,
        visibility,
        anon_alias: visibility === 'anonymous' ? anonAlias : null,
      })
      if (postError) {
        throw new Error(`Failed to save post: ${postError.message}`)
      }

      clearDraft(userId, weekStart)
      // 觸發本週報告生成後就先去社群（分析要跑約半分鐘，不讓使用者空等）。
      // 失敗不影響發布本身——報告完成後會自動出現在「我的報告」，也會自動寄信；
      // 萬一真的沒觸發成功，「我的報告」頁面有補救按鈕。
      void requestWeeklyReport(weekStart)
      void navigate({ to: '/app/community' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('Publish error:', message)
      setError(t('發布失敗，請再試一次。'))
    } finally {
      setSubmitting(false)
    }
  }

  if (!ready) {
    return (
      <div className="mx-auto max-w-md px-6 py-10">
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      </div>
    )
  }

  if (isPublishStep) {
    const publishLabel = submitting ? t('發布中…') : t('結束今天練習')

    return (
      <div className="bg-page min-h-screen px-6 py-10">
        <div className="mx-auto max-w-md space-y-5">
          <div>
            <h1 className="font-heading text-xl text-foreground">{t('恭喜完成本次練習！')}</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('選擇發布方式')}</p>
          </div>

          <div className="flex flex-col gap-3">
            <VisibilityOption
              icon="🌤️"
              selected={visibility === 'public'}
              onClick={() => selectVisibility('public')}
              title={t('發布到社群')}
              // Nudge：鼓勵文案 + 發光光暈 + 推薦標籤，鼓勵大家公開分享、彼此回饋。
              description={t(
                '鼓勵你把這週的感受分享到社群。你寫下的一段話，可能正好是夥伴今天需要的鼓勵；也歡迎到社群為別人留下回饋。',
              )}
              recommended
              badge={t('推薦')}
            />
            <VisibilityOption
              icon="🌿"
              selected={visibility === 'anonymous'}
              onClick={() => selectVisibility('anonymous')}
              title={t('匿名發布到社群')}
              description={t('會用一個自然系代號顯示，其他成員看不到你的真實姓名')}
            >
              {visibility === 'anonymous' && (
                <div className="mt-3 flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                  <span className="text-sm font-semibold text-foreground">
                    {t('你的能量代號')}：{anonAlias}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      rerollAlias()
                    }}
                    className="text-xs font-semibold text-primary hover:underline"
                  >
                    {t('換一個')}
                  </button>
                </div>
              )}
            </VisibilityOption>
            <VisibilityOption
              icon="🔒"
              selected={visibility === 'private'}
              onClick={() => selectVisibility('private')}
              title={t('僅自己可見')}
              description={t('不會出現在社群動態，只有你自己看得到')}
            />
          </div>

          {error && <p className="text-sm leading-relaxed text-rust">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              onClick={handleBack}
              className="flex h-12 flex-1 items-center justify-center rounded-lg border border-border bg-card text-base font-semibold text-foreground-soft transition hover:bg-muted active:scale-[0.98]"
            >
              {t('上一題')}
            </button>
            <button
              onClick={() => void handlePublish()}
              disabled={submitting}
              className="flex h-12 flex-[2] items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
            >
              {publishLabel}
            </button>
          </div>
        </div>
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
          <button
            onClick={handleNext}
            disabled={!currentFilled}
            className="flex h-12 flex-[2] items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
          >
            {isLastQuestion ? t('下一步') : t('下一題')}
          </button>
        </div>

        <p className="text-center text-xs text-muted-foreground">{t('系統會自動保存草稿')}</p>
      </div>
    </div>
  )
}

function VisibilityOption({
  icon,
  title,
  description,
  selected,
  onClick,
  children,
  recommended = false,
  badge,
}: {
  icon: string
  title: string
  description: string
  selected: boolean
  onClick: () => void
  children?: ReactNode
  // recommended：我們想鼓勵的選項，加上持續的柔和光暈讓它在三張卡中先被看到。
  recommended?: boolean
  badge?: string
}) {
  // 用 div 而非 button：內容裡（匿名選項）還有一顆「換一個」按鈕，button 不能巢狀 button。
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={`w-full cursor-pointer rounded-xl border p-4 text-left transition ${
        recommended ? 'animate-nudge-glow' : ''
      } ${
        selected
          ? 'border-primary bg-primary-soft/40 shadow-soft'
          : recommended
            ? 'border-gold/50 bg-card hover:bg-muted'
            : 'border-border bg-card hover:bg-muted'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="text-xl leading-none">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-heading text-base text-foreground">{title}</p>
            {badge && (
              <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold-deep">
                ✨ {badge}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <span
          className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
            selected ? 'border-primary bg-primary' : 'border-border'
          }`}
        >
          {selected && <span className="h-2 w-2 rounded-full bg-primary-foreground" />}
        </span>
      </div>
      {children}
    </div>
  )
}
