import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import type { EmailOtpType } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export const Route = createFileRoute('/auth/callback')({
  component: AuthCallbackPage,
})

const ALLOWED_TYPES = new Set<EmailOtpType>([
  'email',
  'invite',
  'magiclink',
  'recovery',
  'signup',
  'email_change',
])

function AuthCallbackPage() {
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const query = new URLSearchParams(window.location.search)
      const tokenHash = query.get('token_hash')
      const rawType = query.get('type')

      if (tokenHash && rawType && ALLOWED_TYPES.has(rawType as EmailOtpType)) {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: rawType as EmailOtpType,
        })
        if (verifyError) {
          if (!cancelled) setError('登录链接已失效或已使用，请向管理员索取新链接。')
          return
        }
      } else {
        // 兼容 Supabase 原生 implicit Magic Link（access_token 放在 URL hash）。
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
        const accessToken = hash.get('access_token')
        const refreshToken = hash.get('refresh_token')
        if (accessToken && refreshToken) {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
          if (sessionError) {
            if (!cancelled) setError('无法建立登录状态，请向管理员索取新链接。')
            return
          }
        }
      }

      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (!data.session) {
        setError('登录链接无效，请向管理员索取新链接。')
        return
      }
      window.location.replace('/app/home')
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-soft">
        {error ? (
          <>
            <h1 className="font-heading text-xl text-foreground">登录失败</h1>
            <p className="mt-3 text-sm text-destructive">{error}</p>
            <a href="/login" className="mt-5 inline-block text-sm font-semibold text-primary underline">
              返回登录页面
            </a>
          </>
        ) : (
          <>
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <h1 className="font-heading mt-4 text-xl text-foreground">正在安全登录…</h1>
            <p className="mt-2 text-sm text-muted-foreground">验证完成后会自动进入系统。</p>
          </>
        )}
      </div>
    </main>
  )
}
