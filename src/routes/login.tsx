import { useEffect, useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { LanguageSwitcherCompact } from '../components/LanguageSwitcher'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => {
    if (context.session) {
      throw redirect({ to: '/app/home' })
    }
  },
  component: LoginPage,
})

type Step = 'idle' | 'sent'

// 點擊登入連結時若連結已過期／已使用，Supabase 會把錯誤原因
// 附加在導回網址的 hash 上，例如 #error=server_error&error_description=...
function readAuthErrorFromUrl(): string | null {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  const params = new URLSearchParams(hash)
  const description = params.get('error_description')
  if (!description) return null
  return decodeURIComponent(description.replace(/\+/g, ' '))
}

function LoginPage() {
  const { t, language } = useLanguage()
  const [email, setEmail] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const description = readAuthErrorFromUrl()
    if (description) {
      setError(t('登入連結已失效或發生錯誤，請重新輸入 email 再試一次。'))
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [t])

  const handleSendLink = async () => {
    const trimmed = email.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/app/home`,
      },
    })
    setLoading(false)
    if (error) {
      // 白名單外的 email 會讓後端建立 auth 使用者時觸發 trigger 擋下，
      // 呈現為 500（而非結構化的錯誤訊息），所以用狀態碼判斷。
      setError(
        t(
          error.status === 500
            ? '此 email 不在允許名單內，請確認是否為陳郁敏老師邀請的信箱，或聯繫老師確認。'
            : '寄送失敗，請確認 email 格式後再試一次。',
        ),
      )
      return
    }
    setStep('sent')
  }

  return (
    <div className="bg-page relative flex min-h-screen flex-col items-center justify-center px-6">
      <LanguageSwitcherCompact className="fixed right-4 top-[calc(env(safe-area-inset-top)+1rem)]" />

      <div className="w-full max-w-sm space-y-6">
        {/* 以教練個人為主的品牌：名字最大、PSY by PSY 只在底部小小標註 */}
        <div className="space-y-1.5 text-center">
          <h1 className="font-heading text-3xl text-foreground">
            {language === 'en' ? 'Tan Yee Ming' : '陳郁敏'}
          </h1>
          <p className="text-foreground-soft text-sm">
            {language === 'en' ? 'Executive Coach' : '教練'} · {t('職場幸福感書寫')}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-soft">
          {step === 'idle' ? (
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
                  className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                />
              </div>

              {error && <p className="text-sm leading-relaxed text-rust">{error}</p>}

              <button
                onClick={handleSendLink}
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
                  setStep('idle')
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
          Powered by PSY by PSY
        </p>
      </div>
    </div>
  )
}
