import { useState } from 'react'
import { createFileRoute, useNavigate, notFound } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { useVoiceInput } from '../lib/useVoiceInput'
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
  const [usedVoice, setUsedVoice] = useState(false)

  const voice = useVoiceInput((text) => {
    setUsedVoice(true)
    setContent((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
  })

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
      input_method: usedVoice ? 'voice' : 'text',
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

        <div className="relative">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              voice.status === 'transcribing' ? t('辨識中…') : t('寫下你的想法')
            }
            rows={8}
            className="w-full rounded-xl border border-border bg-card p-5 pr-16 text-base leading-relaxed text-foreground shadow-soft outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          <button
            type="button"
            onClick={() => (voice.status === 'recording' ? voice.stop() : voice.start())}
            disabled={voice.status === 'transcribing'}
            aria-label={t('語音輸入')}
            aria-pressed={voice.status === 'recording'}
            className={`absolute bottom-4 right-4 flex h-11 w-11 items-center justify-center rounded-full shadow-soft transition active:scale-95 disabled:opacity-50 ${
              voice.status === 'recording'
                ? 'bg-rust text-white'
                : 'bg-primary text-primary-foreground'
            }`}
          >
            {voice.status === 'transcribing' ? <SpinnerIcon /> : <MicIcon />}
          </button>
        </div>

        {voice.status === 'recording' && (
          <p className="text-xs font-semibold text-rust">{t('錄音中，再按一次結束')}</p>
        )}
        {voice.error && <p className="text-xs text-rust">{voice.error}</p>}

        <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
          <div className="flex gap-2">
            <button
              onClick={() => setIsPublic(true)}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                isPublic ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {t('發布到社群')}
            </button>
            <button
              onClick={() => setIsPublic(false)}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition ${
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
          className="flex h-12 w-full items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
        >
          {submitting ? t('發布中…') : t('發布')}
        </button>
      </div>
    </div>
  )
}

function MicIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
    </svg>
  )
}

function SpinnerIcon() {
  return <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
}
