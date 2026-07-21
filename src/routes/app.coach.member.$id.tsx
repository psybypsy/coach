import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/coach/member/$id')({
  component: MemberDetailPage,
})

interface EntryRow {
  id: string
  dimension: DimensionKey
  content: string
  is_public: boolean
  created_at: string
}

interface ReviewRow {
  id: string
  period_start: string
  entry_count: number
}

function MemberDetailPage() {
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const { id } = Route.useParams()
  const [checking, setChecking] = useState(true)
  const [name, setName] = useState('')
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [reviews, setReviews] = useState<ReviewRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void guardAndLoad()
  }, [id])

  async function guardAndLoad() {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) return
    const { data: me } = await supabase.from('profiles').select('role').eq('id', userId).single()
    if (me?.role !== 'coach') {
      void navigate({ to: '/app/home' })
      return
    }
    setChecking(false)
    await load()
  }

  async function load() {
    setLoading(true)
    const [{ data: profile }, { data: entryRows }, { data: reviewRows }] = await Promise.all([
      supabase.from('profiles').select('display_name').eq('id', id).single(),
      supabase
        .from('perma_entries')
        .select('id,dimension,content,is_public,created_at')
        .eq('user_id', id)
        .order('created_at', { ascending: false }),
      supabase
        .from('weekly_reviews')
        .select('id,period_start,entry_count')
        .eq('user_id', id)
        .order('period_start', { ascending: false }),
    ])
    setName(profile?.display_name ?? '')
    setEntries((entryRows as unknown as EntryRow[]) ?? [])
    setReviews((reviewRows as unknown as ReviewRow[]) ?? [])
    setLoading(false)
  }

  if (checking) return null

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <Link to="/app/coach" className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground">
        ← {t('教練儀表板')}
      </Link>
      <h1 className="font-heading mb-6 text-xl text-foreground">{name}</h1>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      ) : (
        <>
          {reviews.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('個人幸福報告')}</h2>
              <div className="flex flex-wrap gap-2">
                {reviews.map((r) => (
                  <span key={r.id} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground-soft">
                    {r.period_start} · {r.entry_count} {t('本篇書寫')}
                  </span>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('書寫時間軸')}</h2>
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('目前還沒有人發布書寫')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {entries.map((e) => {
                  const dim = DIMENSION_CONFIGS[e.dimension]
                  return (
                    <article key={e.id} className="rounded-xl border border-border bg-card p-4 shadow-soft">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${dim.textColor} ${dim.bgLight}`}>
                            {language === 'en' ? dim.sublabel : dim.label}
                          </span>
                          {!e.is_public && (
                            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                              {t('私人')}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(e.created_at).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-TW')}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{e.content}</p>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
