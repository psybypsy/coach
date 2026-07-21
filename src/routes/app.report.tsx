import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { currentWeekStart, addDays } from '../lib/week'
import { DIMENSION_ORDER, DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/report')({
  component: ReportPage,
})

const API_BASE = import.meta.env.VITE_API_BASE as string

interface WordCount {
  label: string
  count: number
}

interface ReviewContent {
  emotions: WordCount[]
  keywords: WordCount[]
  dimension_dist: Record<DimensionKey, number>
  narrative: {
    accuracy?: string[]
    surprise?: string[]
    awareness?: string[]
    insight?: string[]
  }
}

interface ReviewRow {
  id: string
  period_start: string
  entry_count: number
  content: ReviewContent
}

function ReportPage() {
  const { t, language } = useLanguage()
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [review, setReview] = useState<ReviewRow | null>(null)
  const [prevReview, setPrevReview] = useState<ReviewRow | null>(null)
  const [entryCount, setEntryCount] = useState(0)
  const [message, setMessage] = useState<string | null>(null)

  const weekStart = currentWeekStart()
  const weekEnd = addDays(weekStart, 6)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      setLoading(false)
      return
    }

    const [{ data: current }, { data: prev }, { count }] = await Promise.all([
      supabase.from('weekly_reviews').select('*').eq('user_id', userId).eq('period_start', weekStart).maybeSingle(),
      supabase
        .from('weekly_reviews')
        .select('*')
        .eq('user_id', userId)
        .eq('period_start', addDays(weekStart, -7))
        .maybeSingle(),
      supabase
        .from('perma_entries')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', `${weekStart}T00:00:00`)
        .lte('created_at', `${weekEnd}T23:59:59`),
    ])

    setReview((current as unknown as ReviewRow) ?? null)
    setPrevReview((prev as unknown as ReviewRow) ?? null)
    setEntryCount(count ?? 0)
    setLoading(false)
  }

  async function handleGenerate() {
    setGenerating(true)
    setMessage(null)
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) {
      setGenerating(false)
      return
    }

    try {
      const resp = await fetch(`${API_BASE}/api/weekly-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ period_start: weekStart }),
      })
      if (resp.ok) {
        const data = (await resp.json()) as ReviewRow
        setReview(data)
      } else if (resp.status === 409) {
        const body = (await resp.json()) as { detail?: string }
        setMessage(body.detail?.includes('不足') ? t('這週還沒有足夠的書寫') : t('分析將於本週日產生'))
      } else {
        setMessage(t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setGenerating(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-8">
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="font-heading mb-1 text-xl text-foreground">{t('本週個人幸福報告')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {weekStart} – {weekEnd}
      </p>

      {!review ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center shadow-soft">
          <p className="text-sm text-foreground-soft">
            {entryCount < 2
              ? t('這週還沒有足夠的書寫')
              : t('已經有 {n} 篇書寫，繼續保持').replace('{n}', String(entryCount))}
          </p>
          {entryCount < 2 && (
            <p className="mt-1 text-xs text-muted-foreground">{t('至少寫滿 2 篇，本週日就能看到分析')}</p>
          )}
          {message && <p className="mt-3 text-xs text-rust">{message}</p>}
          <button
            onClick={() => void handleGenerate()}
            disabled={generating || entryCount < 2}
            className="mt-4 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
          >
            {generating ? t('產生中…') : t('產生報告')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="rounded-xl border border-border bg-card p-6 shadow-soft">
            <h2 className="mb-4 font-heading text-sm text-foreground-soft">{t('PERMA 五維度分布')}</h2>
            <PermaRadar dist={review.content.dimension_dist} language={language} />
          </section>

          <section className="rounded-xl border border-border bg-card p-6 shadow-soft">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-heading text-sm text-foreground-soft">{t('情緒詞彙')}</h2>
              {prevReview && (
                <EmotionGrowth current={review.content.emotions.length} previous={prevReview.content.emotions.length} />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {review.content.emotions.map((e) => (
                <span
                  key={e.label}
                  className="rounded-full bg-primary-soft px-3 py-1 text-sm font-medium text-primary"
                >
                  {e.label} · {e.count}
                </span>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-6 shadow-soft">
            <h2 className="mb-4 font-heading text-sm text-foreground-soft">{t('關鍵詞文字雲')}</h2>
            <WordCloud words={review.content.keywords} />
          </section>

          <section className="rounded-xl border border-border bg-card p-6 shadow-soft">
            <h2 className="mb-4 font-heading text-sm text-foreground-soft">{t('本週回饋')}</h2>
            <NarrativeSection title={t('準確觀察')} lines={review.content.narrative.accuracy} />
            <NarrativeSection title={t('意外發現')} lines={review.content.narrative.surprise} />
            <NarrativeSection title={t('自我覺察')} lines={review.content.narrative.awareness} />
            <NarrativeSection title={t('洞察與行動')} lines={review.content.narrative.insight} />
          </section>
        </div>
      )}
    </div>
  )
}

function EmotionGrowth({ current, previous }: { current: number; previous: number }) {
  const diff = current - previous
  if (diff === 0) return null
  return (
    <span className={`text-xs font-semibold ${diff > 0 ? 'text-emerald-700' : 'text-muted-foreground'}`}>
      {diff > 0 ? '▲' : '▼'} {Math.abs(diff)}
    </span>
  )
}

function NarrativeSection({ title, lines }: { title: string; lines?: string[] }) {
  if (!lines || lines.length === 0) return null
  return (
    <div className="mb-4 last:mb-0">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-1">
        {lines.map((line, i) => (
          <li key={i} className="text-sm leading-relaxed text-foreground">
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}

function WordCloud({ words }: { words: WordCount[] }) {
  if (words.length === 0) return null
  const max = Math.max(...words.map((w) => w.count))
  const min = Math.min(...words.map((w) => w.count))
  const scale = (count: number) => {
    if (max === min) return 16
    return 13 + ((count - min) / (max - min)) * 15
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {words.map((w) => (
        <span
          key={w.label}
          style={{ fontSize: `${scale(w.count)}px` }}
          className="font-heading font-semibold text-primary"
        >
          {w.label}
        </span>
      ))}
    </div>
  )
}

function PermaRadar({ dist, language }: { dist: Record<DimensionKey, number>; language: string }) {
  const size = 220
  const center = size / 2
  const radius = size / 2 - 32
  const max = Math.max(1, ...DIMENSION_ORDER.map((k) => dist[k] ?? 0))

  const points = DIMENSION_ORDER.map((key, i) => {
    const angle = (Math.PI * 2 * i) / DIMENSION_ORDER.length - Math.PI / 2
    const value = (dist[key] ?? 0) / max
    const x = center + Math.cos(angle) * radius * value
    const y = center + Math.sin(angle) * radius * value
    return `${x},${y}`
  }).join(' ')

  return (
    <div className="flex justify-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {[0.33, 0.66, 1].map((r) => (
          <polygon
            key={r}
            points={DIMENSION_ORDER.map((_, i) => {
              const angle = (Math.PI * 2 * i) / DIMENSION_ORDER.length - Math.PI / 2
              const x = center + Math.cos(angle) * radius * r
              const y = center + Math.sin(angle) * radius * r
              return `${x},${y}`
            }).join(' ')}
            fill="none"
            stroke="var(--border)"
            strokeWidth="1"
          />
        ))}
        <polygon points={points} fill="var(--primary)" fillOpacity="0.18" stroke="var(--primary)" strokeWidth="2" />
        {DIMENSION_ORDER.map((key, i) => {
          const angle = (Math.PI * 2 * i) / DIMENSION_ORDER.length - Math.PI / 2
          const labelRadius = radius + 18
          const x = center + Math.cos(angle) * labelRadius
          const y = center + Math.sin(angle) * labelRadius
          const dim = DIMENSION_CONFIGS[key]
          return (
            <text
              key={key}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="text-[11px] font-semibold"
              fill="var(--foreground-soft)"
            >
              {language === 'en' ? key : dim.label}
            </text>
          )
        })}
      </svg>
    </div>
  )
}
