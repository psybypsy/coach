import { useEffect, useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { LanguageSwitcherCompact } from '../components/LanguageSwitcher'
import { BRAND, coachName } from '../lib/brand'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.session) {
      throw redirect({ to: '/app/home' })
    }
  },
  component: LoginPage,
})

type Step = 'email' | 'sent'

function getSavedEmails(): string[] {
  try {
    const saved = localStorage.getItem('savedEmails')
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

function saveEmailToHistory(email: string) {
  try {
    const saved = getSavedEmails()
    if (!saved.includes(email)) {
      saved.unshift(email)
      if (saved.length > 5) saved.pop()
      localStorage.setItem('savedEmails', JSON.stringify(saved))
    }
  } catch {
    // ignore
  }
}

function LoginPage() {
  const { t, language } = useLanguage()
  const [email, setEmail] = useState('')
  const [step, setStep] = useState<Step>('email')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedEmails] = useState(getSavedEmails())

  useEffect(() => {
    const description = readAuthErrorFromUrl()
    if (description) {
      setError(t('登入連結已失效或發生錯誤，請重新輸入 email 再試一次。'))
      window.history.replaceState(null, '', window.location.pathname)
    }
    // 若本機已有有效 session（登入過且未登出），直接進入 app、跳過登入頁。
    // 用 getSession（讀 localStorage、即時、不發網路請求）而非 getUser。
    void (async () => {
      const { data } = await supabase.auth.getSession()
      if (data.session) {
        window.location.href = '/app/home'
      }
    })()
  }, [t])

  const sendLink = async (targetEmail: string) => {
    const trimmed = targetEmail.trim()
    if (!trimmed) return
    setEmail(trimmed)
    setLoading(true)
    setError(null)

    // 送出前先確認本機有沒有 session（例如剛在別的分頁登入過）。
    const { data } = await supabase.auth.getSession()
    if (data.session?.user.email === trimmed) {
      window.location.href = '/app/home'
      return
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/app/home`,
      },
    })
    setLoading(false)
    if (error) {
      setError(
        t(
          error.status === 500
            ? '此 email 不在允許名單內，請確認是否為 Yee Ming Tan 老師邀請的信箱，或聯繫老師確認。'
            : '寄送失敗，請確認 email 格式後再試一次。',
        ),
      )
      return
    }
    saveEmailToHistory(trimmed)
    setStep('sent')
  }

  function readAuthErrorFromUrl(): string | null {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const params = new URLSearchParams(hash)
    const description = params.get('error_description')
    if (!description) return null
    return decodeURIComponent(description.replace(/\+/g, ' '))
  }

  return (
    <div className="bg-page relative flex min-h-screen flex-col items-center justify-center px-6">
      <LanguageSwitcherCompact className="fixed right-4 top-[calc(env(safe-area-inset-top)+1rem)]" />

      <div className="w-full max-w-sm space-y-6">
        {/* 品牌：Ipsen Taiwan 為主，教練名稱為輔 */}
        <div className="space-y-1.5 text-center">
          <h1 className="font-heading text-3xl text-foreground">{BRAND.name}</h1>
          <p className="text-foreground-soft text-sm">
            {coachName(language)} · {t('職場幸福感書寫')}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-soft">
          {step === 'email' ? (
            <div className="space-y-4">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-semibold text-foreground">
                  {t('你的 email')}
                </label>
                <input
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void sendLink(email)}
                  className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                />
              </div>

              {savedEmails.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t('最近使用的 email')}</p>
                  <div className="flex flex-wrap gap-2">
                    {savedEmails.map((e) => (
                      <button
                        key={e}
                        type="button"
                        onClick={() => void sendLink(e)}
                        disabled={loading}
                        className="rounded-full border border-border bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-primary-soft disabled:opacity-50"
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {error && <p className="text-sm leading-relaxed text-rust">{error}</p>}

              <button
                onClick={() => void sendLink(email)}
                disabled={loading || !email.trim()}
                className="flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
              >
                {loading ? t('寄送中…') : t('寄送登入連結')}
              </button>

              <p className="text-center text-xs leading-relaxed text-muted-foreground">
                {t('只有邀請名單內的 email 才能登入')}
              </p>
            </div>
          ) : (
            <div className="space-y-3 text-center">
              <p className="font-heading text-lg text-foreground">{t('連結已寄出')}</p>
              <p className="text-sm leading-relaxed text-foreground-soft">
                {t('已寄送登入連結至')} <span className="font-semibold text-foreground">{email}</span>
                <br />
                {t('沒收到嗎？請確認垃圾郵件夾，或稍後再試一次。')}
              </p>
              <button
                onClick={() => {
                  setStep('email')
                  setError(null)
                }}
                className="text-xs font-semibold text-muted-foreground underline"
              >
                {t('重新輸入 email')}
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          {BRAND.name}
        </p>
      </div>
    </div>
  )
}
