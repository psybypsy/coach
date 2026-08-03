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
// 兩種登入方式並存：
//   code     —— 寄 6 位數驗證碼（預設，不必記密碼）
//   password —— email + 密碼，完全不碰 email
// 密碼這條路是給「公司郵件閘道會攔截或延遲放行」的學員用的：信收不到就登入不了，
// 而報告信被擋是另一件事（見 docs/email-deliverability-plan.html），不能靠登入方式解決。
type Mode = 'code' | 'password'

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
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [mode, setMode] = useState<Mode>('code')
  const [password, setPassword] = useState('')

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
            ? '此 email 不在允許名單內，請確認是否為 Yee Ming Tan 教練邀請的信箱，或聯繫教練確認。'
            : '寄送失敗，請確認 email 格式後再試一次。',
        ),
      )
      return
    }
    saveEmailToHistory(trimmed)
    setCode('')
    setStep('sent')
  }

  // Email + 密碼登入。完全不寄信，所以對方公司的郵件閘道擋不到。
  // 學員的密碼有兩個來源：自己登入後在「個人資料」設定，或由教練用
  // backend/tools/set_member_password.py 預先設好、以 email 以外的管道交付。
  const signInWithPassword = async () => {
    const trimmed = email.trim()
    if (!trimmed || !password) return
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.signInWithPassword({ email: trimmed, password })
    setLoading(false)
    if (error) {
      // Supabase 對「密碼錯」與「這個帳號根本沒設過密碼」回同一個錯誤，
      // 分不出來，所以訊息要同時把後者的解法講出來，否則沒設過密碼的人會卡死。
      setError(t('email 或密碼錯誤。如果你還沒設定過密碼，請改用驗證碼登入，之後到「個人資料」設定密碼。'))
      return
    }
    saveEmailToHistory(trimmed)
    // 用整頁導轉而非 router navigate，確保 session 已寫入 storage 才進 app。
    window.location.href = '/app/home'
  }

  // 輸入信中的 6 位數驗證碼登入。
  // 這條路徑很重要：使用者在手機的 Gmail／Outlook App 裡點登入連結時，
  // 會開在 App 的內建瀏覽器，session 就存進那個 webview，之後自己開
  // Safari／Chrome 進網站當然沒有登入紀錄，於是「每次都要重點一次連結」。
  // 改用驗證碼，登入就會完成在使用者現在這個瀏覽器，session 才留得住。
  const verifyCode = async () => {
    const token = code.trim()
    if (token.length < 6 || !email.trim()) return
    setVerifying(true)
    setError(null)

    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: 'email',
    })
    setVerifying(false)
    if (error) {
      setError(t('驗證碼有誤，請確認後重試。'))
      return
    }
    // 用整頁導轉而非 router navigate，確保 session 已寫入 storage 才進 app。
    window.location.href = '/app/home'
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
            // 用真正的 <form>：手機與桌面的密碼管理器要看到 form 才會提示儲存與自動填入，
            // 這正是密碼登入「打開網站按一下就進去」的關鍵，拆成裸 input 就不會觸發。
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (mode === 'password') void signInWithPassword()
                else void sendLink(email)
              }}
            >
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-semibold text-foreground">
                  {t('你的 email')}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                />
              </div>

              {mode === 'password' && (
                <div>
                  <label htmlFor="password" className="mb-1.5 block text-sm font-semibold text-foreground">
                    {t('密碼')}
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                  />
                </div>
              )}

              {savedEmails.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t('最近使用的 email')}</p>
                  <div className="flex flex-wrap gap-2">
                    {savedEmails.map((e) => (
                      <button
                        key={e}
                        type="button"
                        // 密碼模式下只把 email 填進去（還要輸入密碼）；驗證碼模式下直接寄出。
                        onClick={() => (mode === 'password' ? setEmail(e) : void sendLink(e))}
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
                type="submit"
                disabled={loading || !email.trim() || (mode === 'password' && !password)}
                className="flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
              >
                {mode === 'password'
                  ? loading
                    ? t('登入中…')
                    : t('登入')
                  : loading
                    ? t('寄送中…')
                    : t('寄送登入連結')}
              </button>

              <div className="border-t border-border pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === 'password' ? 'code' : 'password')
                    setError(null)
                    setPassword('')
                  }}
                  className="block w-full text-center text-xs font-semibold text-muted-foreground underline"
                >
                  {mode === 'password' ? t('改用 email 驗證碼登入') : t('改用密碼登入')}
                </button>
                <p className="mt-2 text-center text-xs leading-relaxed text-muted-foreground">
                  {mode === 'password'
                    ? t('沒設定過密碼？先用驗證碼登入一次，再到「個人資料」設定密碼。')
                    : t('只有邀請名單內的 email 才能登入')}
                </p>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2 text-center">
                <p className="font-heading text-lg text-foreground">{t('信件已寄出')}</p>
                <p className="text-sm leading-relaxed text-foreground-soft">
                  {t('已寄送登入連結至')} <span className="font-semibold text-foreground">{email}</span>
                </p>
              </div>

              {/* 驗證碼優先：在目前這個瀏覽器完成登入，之後就會一直保持登入。 */}
              <div className="space-y-2">
                <label htmlFor="code" className="block text-sm font-semibold text-foreground">
                  {t('輸入信中的 6 位數驗證碼')}
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && void verifyCode()}
                  autoFocus
                  className="h-12 w-full rounded-lg border border-border bg-background px-4 text-center text-lg font-semibold tracking-[0.4em] text-foreground outline-none placeholder:tracking-[0.4em] placeholder:text-muted-foreground focus:border-primary"
                />
                <button
                  onClick={() => void verifyCode()}
                  disabled={verifying || code.length < 6}
                  className="flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
                >
                  {verifying ? t('驗證中…') : t('確認驗證碼')}
                </button>
                <p className="text-center text-xs leading-relaxed text-muted-foreground">
                  {t('用驗證碼登入，之後直接開網站就會自動保持登入，不必再收信。')}
                </p>
              </div>

              <div className="border-t border-border pt-3">
                <p className="text-center text-xs leading-relaxed text-muted-foreground">
                  {t('也可以直接點信中的登入連結。沒收到嗎？請確認垃圾郵件夾，或稍後再試一次。')}
                </p>
              </div>

              {error && <p className="text-center text-sm leading-relaxed text-rust">{error}</p>}

              <button
                onClick={() => {
                  setStep('email')
                  setError(null)
                  setCode('')
                }}
                className="block w-full text-center text-xs font-semibold text-muted-foreground underline"
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
