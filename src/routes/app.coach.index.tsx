import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { currentWeekStart, addDays } from '../lib/week'
import { DIMENSION_ORDER, DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/coach/')({
  component: CoachDashboard,
})

interface MemberRow {
  id: string
  display_name: string
  totalCount: number
  weekCount: number
  lastEntryAt: string | null
}

function CoachDashboard() {
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [totalAll, setTotalAll] = useState(0)
  const [totalThisWeek, setTotalThisWeek] = useState(0)
  const [dimDist, setDimDist] = useState<Record<DimensionKey, number>>({ P: 0, E: 0, R: 0, M: 0, A: 0 })
  const [loading, setLoading] = useState(true)

  const weekStart = currentWeekStart()
  const weekEnd = addDays(weekStart, 6)

  useEffect(() => {
    void guardAndLoad()
  }, [])

  // #4/#5 即時更新：成員一發布書寫、或有新成員加入，儀表板即時重撈；
  // 另外在切回分頁 / 視窗聚焦時也重撈，作為 realtime 未啟用時的保底。
  useEffect(() => {
    if (checking) return
    const reload = () => {
      void load()
    }
    const channel = supabase
      .channel('coach-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'perma_entries' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'journal_posts' }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, reload)
      .subscribe()
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      void supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [checking])

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

    // 全部指標改以 journal_posts（每次週記＝1 列）為真實來源，且一律以「全部歷史」為主、
    // 「本週」為輔——教練一打開儀表板，最先看到的應該是累計進度，不是本週還沒交的 0。
    // 不加 limit：500 筆上限會低估開課較久的梯次。
    const [{ data: profileRows }, { data: allPosts }] = await Promise.all([
      supabase.from('profiles').select('id,display_name').eq('role', 'member').order('display_name'),
      supabase
        .from('journal_posts')
        .select('user_id,created_at,p_content,e_content,r_content,m_content,a_content')
        .order('created_at', { ascending: false }),
    ])

    // 只統計「成員」的書寫（排除教練自己等非成員），全群數字才正確。
    const memberIds = new Set((profileRows ?? []).map((p) => p.id))
    const len = (s: string | null) => (s ?? '').replace(/\s/g, '').length

    // created_at 是 timestamptz，PostgREST 一律回 UTC；weekStart／weekEnd 則是本機（UTC+8）
    // 的日期。直接把兩者當字串比會整整差 8 小時——台灣時間週一 00:00–07:59 寫的那幾篇，
    // UTC 還停在週日，會被算進上一週（而週一早上正是最常補寫週記的時段）。
    // 先用不帶 Z 的字串建 Date（會依本機時區解析），再 toISOString() 換成同一個 UTC 瞬間。
    const weekStartUtc = new Date(`${weekStart}T00:00:00`).toISOString()
    const weekEndUtc = new Date(`${weekEnd}T23:59:59.999`).toISOString()
    const isThisWeek = (createdAt: string) => createdAt >= weekStartUtc && createdAt <= weekEndUtc

    const totalCountByUser: Record<string, number> = {}
    const weekCountByUser: Record<string, number> = {}
    const lastEntryByUser: Record<string, string> = {}
    const dist: Record<DimensionKey, number> = { P: 0, E: 0, R: 0, M: 0, A: 0 }
    let totalAllMembers = 0
    let totalThisWeekMembers = 0
    for (const p of allPosts ?? []) {
      if (!memberIds.has(p.user_id)) continue
      totalAllMembers += 1
      totalCountByUser[p.user_id] = (totalCountByUser[p.user_id] ?? 0) + 1
      if (!lastEntryByUser[p.user_id]) lastEntryByUser[p.user_id] = p.created_at
      // 五維度分布看全部歷史的字數量（因為每篇都必填 5 題，用「篇數」永遠是平的）。
      dist.P += len(p.p_content)
      dist.E += len(p.e_content)
      dist.R += len(p.r_content)
      dist.M += len(p.m_content)
      dist.A += len(p.a_content)
      if (isThisWeek(p.created_at)) {
        totalThisWeekMembers += 1
        weekCountByUser[p.user_id] = (weekCountByUser[p.user_id] ?? 0) + 1
      }
    }
    setDimDist(dist)
    setTotalThisWeek(totalThisWeekMembers)
    setTotalAll(totalAllMembers)

    const rows: MemberRow[] = (profileRows ?? []).map((p) => ({
      id: p.id,
      display_name: p.display_name,
      totalCount: totalCountByUser[p.id] ?? 0,
      weekCount: weekCountByUser[p.id] ?? 0,
      lastEntryAt: lastEntryByUser[p.id] ?? null,
    }))
    // 有在書寫的學員排最前面，教練一進來就看得到；還沒寫的其次，測試帳號墊底。
    // 同一組內維持原本依姓名的順序（sort 是穩定排序）。
    const isTestAccount = (name: string) => /test|測試/i.test(name)
    const rank = (m: MemberRow) => (isTestAccount(m.display_name ?? '') ? 2 : m.totalCount > 0 ? 0 : 1)
    rows.sort((x, y) => rank(x) - rank(y))
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
              <p className="text-xs text-muted-foreground">{t('全群總篇數')}</p>
              <p className="font-heading mt-1 text-2xl text-foreground">{totalAll}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('本週')} {totalThisWeek}
              </p>
            </div>
            <div className="col-span-2 rounded-xl border border-border bg-card p-4 shadow-soft sm:col-span-2">
              <p className="mb-2 text-xs text-muted-foreground">
                {t('五維度分布')}（{t('累計')}・{t('字數')}）
              </p>
              <div className="flex items-end justify-center gap-5">
                {DIMENSION_ORDER.map((key) => {
                  const dim = DIMENSION_CONFIGS[key]
                  const max = Math.max(1, ...Object.values(dimDist))
                  const height = 8 + (dimDist[key] / max) * 40
                  return (
                    <div key={key} className="flex w-14 flex-col items-center gap-1">
                      <div
                        className={`w-6 rounded-t ${dim.bgMed}`}
                        style={{ height: `${height}px` }}
                      />
                      <span className={`text-center text-[11px] font-semibold leading-tight ${dim.textColor}`}>
                        {language === 'en' ? dim.sublabel : dim.label}
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
                  <th className="px-4 py-3 font-medium">{t('總篇數')}</th>
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
                    <td className="px-4 py-3 text-foreground-soft">{m.totalCount}</td>
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
