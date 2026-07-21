import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { currentWeekStart, addDays } from '../lib/week'
import { DIMENSION_ORDER, DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/coach')({
  component: CoachDashboard,
})

interface MemberRow {
  id: string
  display_name: string
  weekCount: number
  lastEntryAt: string | null
}

function CoachDashboard() {
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [totalThisWeek, setTotalThisWeek] = useState(0)
  const [dimDist, setDimDist] = useState<Record<DimensionKey, number>>({ P: 0, E: 0, R: 0, M: 0, A: 0 })
  const [loading, setLoading] = useState(true)

  const weekStart = currentWeekStart()
  const weekEnd = addDays(weekStart, 6)

  useEffect(() => {
    void guardAndLoad()
  }, [])

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

    const [{ data: profileRows }, { data: weekEntries }, { data: recentEntries }] = await Promise.all([
      supabase.from('profiles').select('id,display_name').eq('role', 'member').order('display_name'),
      supabase
        .from('perma_entries')
        .select('id,user_id,dimension')
        .gte('created_at', `${weekStart}T00:00:00`)
        .lte('created_at', `${weekEnd}T23:59:59`),
      supabase
        .from('perma_entries')
        .select('user_id,created_at')
        .order('created_at', { ascending: false })
        .limit(500),
    ])

    const weekCountByUser: Record<string, number> = {}
    const dist: Record<DimensionKey, number> = { P: 0, E: 0, R: 0, M: 0, A: 0 }
    for (const e of weekEntries ?? []) {
      weekCountByUser[e.user_id] = (weekCountByUser[e.user_id] ?? 0) + 1
      if (e.dimension in dist) dist[e.dimension as DimensionKey] += 1
    }
    setDimDist(dist)
    setTotalThisWeek((weekEntries ?? []).length)

    const lastEntryByUser: Record<string, string> = {}
    for (const e of recentEntries ?? []) {
      if (!lastEntryByUser[e.user_id]) lastEntryByUser[e.user_id] = e.created_at
    }

    const rows: MemberRow[] = (profileRows ?? []).map((p) => ({
      id: p.id,
      display_name: p.display_name,
      weekCount: weekCountByUser[p.id] ?? 0,
      lastEntryAt: lastEntryByUser[p.id] ?? null,
    }))
    setMembers(rows)
    setLoading(false)
  }

  if (checking) return null

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-heading mb-1 text-xl text-foreground">{t('教練儀表板')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {weekStart} – {weekEnd}
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      ) : (
        <>
          <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
              <p className="text-xs text-muted-foreground">{t('本週全群書寫')}</p>
              <p className="font-heading mt-1 text-2xl text-foreground">{totalThisWeek}</p>
            </div>
            <div className="col-span-2 rounded-xl border border-border bg-card p-4 shadow-soft sm:col-span-2">
              <p className="mb-2 text-xs text-muted-foreground">{t('五維度分布')}</p>
              <div className="flex items-end gap-3">
                {DIMENSION_ORDER.map((key) => {
                  const dim = DIMENSION_CONFIGS[key]
                  const max = Math.max(1, ...Object.values(dimDist))
                  const height = 8 + (dimDist[key] / max) * 40
                  return (
                    <div key={key} className="flex flex-col items-center gap-1">
                      <div
                        className={`w-6 rounded-t ${dim.bgMed}`}
                        style={{ height: `${height}px` }}
                      />
                      <span className={`text-[11px] font-semibold ${dim.textColor}`}>
                        {language === 'en' ? key : dim.label.slice(0, 1)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{dimDist[key]}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card shadow-soft">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">{t('成員')}</th>
                  <th className="px-4 py-3 font-medium">{t('本週篇數')}</th>
                  <th className="px-4 py-3 font-medium">{t('最近書寫')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b border-border last:border-0 hover:bg-muted">
                    <td className="px-4 py-3">
                      <Link to="/app/coach/member/$id" params={{ id: m.id }} className="font-medium text-foreground hover:text-primary">
                        {m.display_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-foreground-soft">{m.weekCount}</td>
                    <td className="px-4 py-3 text-foreground-soft">
                      {m.lastEntryAt ? new Date(m.lastEntryAt).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-TW') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
