import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'

export const Route = createFileRoute('/app/settings')({
  component: SettingsPage,
})

// 密碼下限。Supabase 預設只要求 6 碼，這裡拉到 8——密碼登入是給收不到
// 驗證碼的學員用的長期憑證，不像驗證碼是單次使用。
const MIN_PASSWORD = 8

// 個人設定：隨時修改顯示名字（社群貼文會同步顯示最新名字）、設定登入密碼。
function SettingsPage() {
  const { t } = useLanguage()
  const [userId, setUserId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 登入密碼：設定後就能在登入頁用 email + 密碼登入，完全不必收信。
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwSaved, setPwSaved] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)

  const savePassword = async () => {
    if (pw.length < MIN_PASSWORD) {
      setPwError(t('密碼至少要 8 個字元。'))
      return
    }
    if (pw !== pw2) {
      setPwError(t('兩次輸入的密碼不一樣。'))
      return
    }
    setPwSaving(true)
    setPwError(null)
    setPwSaved(false)
    const { error: pwUpdateError } = await supabase.auth.updateUser({ password: pw })
    setPwSaving(false)
    if (pwUpdateError) {
      setPwError(t('設定失敗，請再試一次。密碼太簡單或曾經外洩過都會被拒絕。'))
      return
    }
    setPw('')
    setPw2('')
    setPwSaved(true)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid) return
      const { data } = await supabase.from('profiles').select('display_name').eq('id', uid).single()
      if (cancelled) return
      setUserId(uid)
      setName(data?.display_name ?? '')
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed || !userId) return
    setSaving(true)
    setError(null)
    setSaved(false)
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ display_name: trimmed, has_set_name: true })
      .eq('id', userId)
    setSaving(false)
    if (updateError) {
      setError(t('儲存失敗，請再試一次。'))
      return
    }
    setSaved(true)
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
        <h1 className="font-heading text-2xl text-foreground">{t('個人資料')}</h1>

        <div className="rounded-xl border border-border bg-card p-6 shadow-soft">
          <label htmlFor="name" className="mb-1.5 block text-sm font-semibold text-foreground">
            {t('你的名字')}
          </label>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            {t('這個名字會顯示在社群的貼文上。')}
          </p>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setSaved(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave()
            }}
            className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {error && <p className="mt-2 text-sm text-rust">{error}</p>}
          {saved && <p className="mt-2 text-sm text-primary">{t('已儲存')}</p>}
        </div>

        <button
          onClick={() => void handleSave()}
          disabled={saving || !name.trim()}
          className="flex h-12 w-full items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
        >
          {saving ? t('儲存中…') : t('儲存')}
        </button>

        {/* 登入密碼：設定後就多一條不必收信的登入路徑，驗證碼那條仍然可用。
            用 <form> 才會觸發密碼管理器的「要不要儲存密碼」提示。 */}
        <form
          className="rounded-xl border border-border bg-card p-6 shadow-soft"
          onSubmit={(e) => {
            e.preventDefault()
            void savePassword()
          }}
        >
          <h2 className="mb-1.5 text-sm font-semibold text-foreground">{t('登入密碼')}</h2>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            {t('設定密碼後，登入頁就能用 email + 密碼直接登入，不必等驗證碼信。原本的驗證碼登入仍然可以用。')}
          </p>

          {/* 密碼管理器要靠這個隱藏欄位把密碼對應到正確的帳號 */}
          <input type="email" name="email" autoComplete="username" className="hidden" readOnly value="" />

          <label htmlFor="pw" className="mb-1.5 block text-xs font-semibold text-foreground">
            {t('新密碼')}
          </label>
          <input
            id="pw"
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => {
              setPw(e.target.value)
              setPwSaved(false)
              setPwError(null)
            }}
            className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none focus:border-primary"
          />
          {/* 長度規則要一直看得到。只在按下去之後才說「至少 8 個字元」是死路——
              按鈕本身就是被長度擋住的，使用者根本按不下去，也就永遠看不到那則訊息。 */}
          <p className={`mb-3 mt-1.5 text-xs ${pw && pw.length < MIN_PASSWORD ? 'text-rust' : 'text-muted-foreground'}`}>
            {t('至少 8 個字元')}
            {pw && pw.length < MIN_PASSWORD ? `（${t('目前')} ${pw.length}）` : ''}
          </p>

          <label htmlFor="pw2" className="mb-1.5 block text-xs font-semibold text-foreground">
            {t('再輸入一次')}
          </label>
          <input
            id="pw2"
            type="password"
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => {
              setPw2(e.target.value)
              setPwSaved(false)
              setPwError(null)
            }}
            className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none focus:border-primary"
          />

          {pwError && <p className="mt-2 text-sm text-rust">{pwError}</p>}
          {pwSaved && <p className="mt-2 text-sm text-primary">{t('密碼已設定，下次可以直接用密碼登入')}</p>}

          {/* 只在「還沒填完」或「儲存中」時停用。長度與兩次一致的檢查交給 savePassword()，
              這樣按下去一定會得到明確理由，不會出現「按鈕灰掉但不知道為什麼」。 */}
          <button
            type="submit"
            disabled={pwSaving || !pw || !pw2}
            className="mt-4 flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow active:scale-[0.98] disabled:opacity-50"
          >
            {pwSaving ? t('設定中…') : t('設定密碼')}
          </button>
        </form>
      </div>
    </div>
  )
}
