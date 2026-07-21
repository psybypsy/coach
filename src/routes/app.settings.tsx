import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'

export const Route = createFileRoute('/app/settings')({
  component: SettingsPage,
})

// 個人設定：隨時修改顯示名字（社群貼文會同步顯示最新名字）。
function SettingsPage() {
  const { t } = useLanguage()
  const [userId, setUserId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        <h1 className="font-heading text-2xl text-foreground">{t('設定')}</h1>

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
      </div>
    </div>
  )
}
