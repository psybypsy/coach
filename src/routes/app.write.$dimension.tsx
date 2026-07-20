import { useState } from 'react'
import { createFileRoute, useNavigate, notFound } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/write/$dimension')({
  beforeLoad: ({ params }) => {
    if (!(params.dimension in DIMENSION_CONFIGS)) {
      throw notFound()
    }
  },
  component: WritePage,
})

function WritePage() {
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const { dimension } = Route.useParams()
  const dim = DIMENSION_CONFIGS[dimension as DimensionKey]

  const [content, setContent] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const trimmed = content.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)

    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      setSubmitting(false)
      return
    }

    const { error } = await supabase.from('perma_entries').insert({
      user_id: userId,
      dimension,
      content: trimmed,
      is_public: isPublic,
      input_method: 'text',
    })

    setSubmitting(false)
    if (error) {
      setError(t('發布失敗，請再試一次。'))
      return
    }
    void navigate({ to: '/app/home' })
  }

  return (
    <div className="bg-page min-h-screen px-6 py-10">
      <div className="mx-auto max-w-md space-y-5">
        <div className={`font-heading text-sm ${dim.textColor}`}>
          {language === 'en' ? dim.sublabel : `${dim.label} · ${dim.sublabel}`}
        </div>
        <h1 className="font-heading text-xl text-foreground">{t(dim.question)}</h1>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('寫下你的想法')}
          rows={8}
          className="w-full rounded-3xl border border-border bg-card p-5 text-base leading-relaxed text-foreground shadow-soft outline-none placeholder:text-muted-foreground focus:border-primary"
        />

        <div className="rounded-2xl bg-card p-4 shadow-soft">
          <div className="flex gap-2">
            <button
              onClick={() => setIsPublic(true)}
              className={`flex-1 rounded-full px-4 py-2 text-sm font-bold transition ${
                isPublic ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {t('發布到社群')}
            </button>
            <button
              onClick={() => setIsPublic(false)}
              className={`flex-1 rounded-full px-4 py-2 text-sm font-bold transition ${
                !isPublic ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {t('只留給自己')}
            </button>
          </div>
          <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">
            {t('你的教練可以看到所有書寫內容')}
          </p>
        </div>

        {error && <p className="text-sm leading-relaxed text-rust">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={submitting || !content.trim()}
          className="flex h-14 w-full items-center justify-center rounded-full bg-primary text-base font-extrabold text-primary-foreground shadow-soft transition active:scale-[0.98] disabled:opacity-50"
        >
          {submitting ? t('發布中…') : t('發布')}
        </button>
      </div>
    </div>
  )
}
