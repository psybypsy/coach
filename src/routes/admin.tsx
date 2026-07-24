import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { DIMENSION_CONFIGS, DIMENSION_ORDER, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/admin')({
  beforeLoad: ({ context }) => {
    if (!context.session) throw redirect({ to: '/login' })
  },
  component: AdminPage,
})

type AdminTab = 'overview' | 'members' | 'entries' | 'comments' | 'reports'

interface ProfileRow {
  id: string
  display_name: string
  role: 'member' | 'coach'
  created_at: string
}

interface MemberIdentityRow {
  user_id: string
  email: string | null
  display_name: string
  role: 'member' | 'coach'
  joined_at: string
  last_sign_in_at: string | null
}

interface EntryRow {
  id: string
  user_id: string
  dimension: DimensionKey
  content: string
  is_public: boolean
  input_method: 'text' | 'voice'
  created_at: string
  profiles: Pick<ProfileRow, 'display_name' | 'role'> | null
}

interface CommentRow {
  id: string
  entry_id: string
  user_id: string
  content: string
  created_at: string
  profiles: Pick<ProfileRow, 'display_name' | 'role'> | null
}

interface LikeRow {
  entry_id: string
  user_id: string
}

interface WordCount {
  label: string
  count: number
}

interface ReviewContent {
  emotions?: WordCount[]
  keywords?: WordCount[]
  dimension_dist?: Partial<Record<DimensionKey, number>>
  narrative?: Record<string, string[] | undefined>
}

interface ReviewRow {
  id: string
  user_id: string
  period_start: string
  entry_count: number
  content: ReviewContent
  created_at: string
  profiles: Pick<ProfileRow, 'display_name' | 'role'> | null
}

interface MemberView extends ProfileRow {
  email: string | null
  lastSignInAt: string | null
  totalEntries: number
  weekEntries: number
  lastEntryAt: string | null
  activeWeekStreak: number
}

interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

const PAGE_SIZE = 1000

async function fetchEveryRow<T>(
  pageLoader: (from: number, to: number) => Promise<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await pageLoader(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

function startOfWeek(date = new Date()) {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7))
  return result
}

function weekKey(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value
  return startOfWeek(date).toISOString().slice(0, 10)
}

function countActiveWeekStreak(entries: EntryRow[]) {
  const activeWeeks = new Set(entries.map((entry) => weekKey(entry.created_at)))
  let cursor = startOfWeek()
  let streak = 0
  while (activeWeeks.has(cursor.toISOString().slice(0, 10))) {
    streak += 1
    cursor = new Date(cursor)
    cursor.setDate(cursor.getDate() - 7)
  }
  return streak
}

function formatDate(value: string | null, withTime = false) {
  if (!value) return '尚無紀錄'
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(new Date(value))
}

function downloadCsv(filename: string, rows: Array<Record<string, string | number | boolean | null>>) {
  if (rows.length === 0) return
  const headers = Object.keys(rows[0])
  const safeCell = (value: string | number | boolean | null) => {
    const raw = value == null ? '' : String(value)
    const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
    return `"${guarded.replace(/"/g, '""')}"`
  }
  const csv = [headers.map(safeCell).join(','), ...rows.map((row) => headers.map((key) => safeCell(row[key])).join(','))].join('\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function AdminPage() {
  const [roleState, setRoleState] = useState<'checking' | 'allowed' | 'denied'>('checking')
  const [activeTab, setActiveTab] = useState<AdminTab>('overview')
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [identities, setIdentities] = useState<MemberIdentityRow[]>([])
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [comments, setComments] = useState<CommentRow[]>([])
  const [likes, setLikes] = useState<LikeRow[]>([])
  const [reviews, setReviews] = useState<ReviewRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [emailUnavailable, setEmailUnavailable] = useState(false)
  const [query, setQuery] = useState('')
  const [dimensionFilter, setDimensionFilter] = useState<'all' | DimensionKey>('all')
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'public' | 'private'>('all')
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)

  useEffect(() => {
    void loadAdminData()
  }, [])

  async function loadAdminData() {
    setLoading(true)
    setError(null)

    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      setRoleState('denied')
      setLoading(false)
      return
    }

    const { data: currentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()

    if (profileError || currentProfile?.role !== 'coach') {
      setRoleState('denied')
      setLoading(false)
      return
    }

    setRoleState('allowed')

    try {
      const [profileRows, entryRows, commentRows, likeRows, reviewRows, identityResult] = await Promise.all([
        fetchEveryRow<ProfileRow>(async (from, to) => {
          const result = await supabase.from('profiles').select('id,display_name,role,created_at').order('created_at', { ascending: true }).range(from, to)
          return { data: result.data as ProfileRow[] | null, error: result.error }
        }),
        fetchEveryRow<EntryRow>(async (from, to) => {
          const result = await supabase.from('perma_entries').select('id,user_id,dimension,content,is_public,input_method,created_at,profiles(display_name,role)').order('created_at', { ascending: false }).range(from, to)
          return { data: result.data as unknown as EntryRow[] | null, error: result.error }
        }),
        fetchEveryRow<CommentRow>(async (from, to) => {
          const result = await supabase.from('comments').select('id,entry_id,user_id,content,created_at,profiles(display_name,role)').order('created_at', { ascending: false }).range(from, to)
          return { data: result.data as unknown as CommentRow[] | null, error: result.error }
        }),
        fetchEveryRow<LikeRow>(async (from, to) => {
          const result = await supabase.from('likes').select('entry_id,user_id').range(from, to)
          return { data: result.data as LikeRow[] | null, error: result.error }
        }),
        fetchEveryRow<ReviewRow>(async (from, to) => {
          const result = await supabase.from('weekly_reviews').select('id,user_id,period_start,entry_count,content,created_at,profiles(display_name,role)').order('period_start', { ascending: false }).range(from, to)
          return { data: result.data as unknown as ReviewRow[] | null, error: result.error }
        }),
        supabase.rpc('admin_list_members'),
      ])

      setProfiles(profileRows)
      setEntries(entryRows)
      setComments(commentRows)
      setLikes(likeRows)
      setReviews(reviewRows)

      if (identityResult.error) {
        setIdentities([])
        setEmailUnavailable(true)
      } else {
        setIdentities((identityResult.data ?? []) as MemberIdentityRow[])
        setEmailUnavailable(false)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '資料載入失敗，請稍後再試。')
    } finally {
      setLoading(false)
    }
  }

  const members = useMemo<MemberView[]>(() => {
    const currentWeek = startOfWeek().getTime()
    return profiles.map((profile) => {
      const memberEntries = entries.filter((entry) => entry.user_id === profile.id)
      const identity = identities.find((row) => row.user_id === profile.id)
      return {
        ...profile,
        email: identity?.email ?? null,
        lastSignInAt: identity?.last_sign_in_at ?? null,
        totalEntries: memberEntries.length,
        weekEntries: memberEntries.filter((entry) => new Date(entry.created_at).getTime() >= currentWeek).length,
        lastEntryAt: memberEntries[0]?.created_at ?? null,
        activeWeekStreak: countActiveWeekStreak(memberEntries),
      }
    })
  }, [profiles, entries, identities])

  const filteredMembers = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return members
    return members.filter((member) => `${member.display_name} ${member.email ?? ''}`.toLowerCase().includes(needle))
  }, [members, query])

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (dimensionFilter !== 'all' && entry.dimension !== dimensionFilter) return false
      if (visibilityFilter === 'public' && !entry.is_public) return false
      if (visibilityFilter === 'private' && entry.is_public) return false
      return !needle || `${entry.profiles?.display_name ?? ''} ${entry.content}`.toLowerCase().includes(needle)
    })
  }, [entries, query, dimensionFilter, visibilityFilter])

  const filteredComments = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return comments
    return comments.filter((comment) => `${comment.profiles?.display_name ?? ''} ${comment.content}`.toLowerCase().includes(needle))
  }, [comments, query])

  const selectedMember = members.find((member) => member.id === selectedMemberId) ?? null

  if (roleState === 'checking') return <AdminLoading />
  if (roleState === 'denied') return <AccessDenied />

  const navItems: Array<{ id: AdminTab; label: string; count?: number; icon: IconName }> = [
    { id: 'overview', label: '營運總覽', icon: 'grid' },
    { id: 'members', label: '成員管理', count: members.length, icon: 'users' },
    { id: 'entries', label: '書寫紀錄', count: entries.length, icon: 'document' },
    { id: 'comments', label: '留言內容', count: comments.length, icon: 'message' },
    { id: 'reports', label: '每週報告', count: reviews.length, icon: 'chart' },
  ]

  return (
    <div className="min-h-screen bg-[#f5f2ec] text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col md:flex-row">
        <aside className="bg-[#272321] px-4 py-5 text-white md:sticky md:top-0 md:flex md:h-screen md:w-64 md:flex-col md:px-5 md:py-7">
          <div className="flex items-center justify-between md:block">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-white/45">PSY by PSY</p>
              <h1 className="mt-2 font-heading text-xl">教練管理後台</h1>
              <p className="mt-1 text-xs text-white/50">Coach workspace</p>
            </div>
            <Link to="/app/home" className="rounded-lg border border-white/15 px-3 py-2 text-xs text-white/75 md:hidden">
              返回前台
            </Link>
          </div>

          <nav className="no-scrollbar mt-5 flex gap-2 overflow-x-auto md:mt-9 md:flex-col md:overflow-visible" aria-label="後台功能">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id)
                  setQuery('')
                }}
                className={`flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition md:w-full ${
                  activeTab === item.id ? 'bg-white text-[#272321]' : 'text-white/65 hover:bg-white/10 hover:text-white'
                }`}
              >
                <AdminIcon name={item.icon} />
                <span className="font-semibold">{item.label}</span>
                {item.count != null && <span className="ml-auto text-xs opacity-55">{item.count}</span>}
              </button>
            ))}
          </nav>

          <div className="mt-5 hidden border-t border-white/10 pt-5 md:mt-auto md:block">
            <Link to="/app/home" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
              <AdminIcon name="arrow" />
              返回使用者頁面
            </Link>
            <button onClick={() => void supabase.auth.signOut()} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
              <AdminIcon name="logout" />
              登出
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
          <AdminHeader
            tab={activeTab}
            query={query}
            setQuery={setQuery}
            loading={loading}
            onRefresh={() => void loadAdminData()}
          />

          {error && (
            <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              無法載入完整資料：{error}
            </div>
          )}
          {emailUnavailable && (activeTab === 'overview' || activeTab === 'members') && (
            <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AdminIcon name="info" />
              <p>會員 email 尚未開放給教練後台。請先在 Supabase 套用 <code className="font-semibold">supabase/admin.sql</code>；其他資料不受影響。</p>
            </div>
          )}

          {loading ? (
            <AdminSectionLoading />
          ) : (
            <>
              {activeTab === 'overview' && <Overview members={members} entries={entries} comments={comments} likes={likes} onSelectMember={setSelectedMemberId} />}
              {activeTab === 'members' && <Members members={filteredMembers} entries={entries} onSelectMember={setSelectedMemberId} />}
              {activeTab === 'entries' && (
                <Entries
                  entries={filteredEntries}
                  dimensionFilter={dimensionFilter}
                  setDimensionFilter={setDimensionFilter}
                  visibilityFilter={visibilityFilter}
                  setVisibilityFilter={setVisibilityFilter}
                />
              )}
              {activeTab === 'comments' && <Comments comments={filteredComments} entries={entries} />}
              {activeTab === 'reports' && <Reports reviews={reviews} />}
            </>
          )}
        </main>
      </div>

      {selectedMember && (
        <MemberDrawer
          member={selectedMember}
          entries={entries.filter((entry) => entry.user_id === selectedMember.id)}
          reviews={reviews.filter((review) => review.user_id === selectedMember.id)}
          onClose={() => setSelectedMemberId(null)}
        />
      )}
    </div>
  )
}

function AdminHeader({ tab, query, setQuery, loading, onRefresh }: { tab: AdminTab; query: string; setQuery: (value: string) => void; loading: boolean; onRefresh: () => void }) {
  const headings: Record<AdminTab, { title: string; description: string }> = {
    overview: { title: '營運總覽', description: '掌握成員參與度與本週書寫狀況' },
    members: { title: '成員管理', description: '查看每位成員的書寫、登入與週報紀錄' },
    entries: { title: '書寫紀錄', description: '包含公開與只留給自己的所有 PERMA 書寫' },
    comments: { title: '留言內容', description: '查看社群中成員輸入的所有留言' },
    reports: { title: '每週報告', description: '查看每位成員已產生的 AI 幸福報告' },
  }
  const showSearch = tab === 'members' || tab === 'entries' || tab === 'comments'

  return (
    <header className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="mb-1 text-xs font-bold uppercase tracking-[0.18em] text-[#9a6d48]">Administration</p>
        <h2 className="font-heading text-2xl font-semibold tracking-tight text-[#272321] sm:text-3xl">{headings[tab].title}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{headings[tab].description}</p>
      </div>
      <div className="flex items-center gap-2">
        {showSearch && (
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#ded8cf] bg-white px-3 shadow-sm lg:w-64">
            <AdminIcon name="search" />
            <span className="sr-only">搜尋</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋姓名或內容" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </label>
        )}
        <button onClick={onRefresh} disabled={loading} aria-label="重新整理" className="flex h-10 items-center gap-2 rounded-xl border border-[#ded8cf] bg-white px-3.5 text-sm font-semibold text-[#514943] shadow-sm transition hover:border-[#b8aea3] disabled:opacity-50">
          <AdminIcon name="refresh" />
          <span className="hidden sm:inline">重新整理</span>
        </button>
      </div>
    </header>
  )
}

function Overview({ members, entries, comments, likes, onSelectMember }: { members: MemberView[]; entries: EntryRow[]; comments: CommentRow[]; likes: LikeRow[]; onSelectMember: (id: string) => void }) {
  const weekStart = startOfWeek().getTime()
  const weekEntries = entries.filter((entry) => new Date(entry.created_at).getTime() >= weekStart)
  const participatingMembers = new Set(weekEntries.filter((entry) => members.find((member) => member.id === entry.user_id)?.role === 'member').map((entry) => entry.user_id)).size
  const regularMembers = members.filter((member) => member.role === 'member')
  const publicRate = entries.length ? Math.round((entries.filter((entry) => entry.is_public).length / entries.length) * 100) : 0
  const dimensions = DIMENSION_ORDER.map((key) => ({ key, count: weekEntries.filter((entry) => entry.dimension === key).length }))
  const maxDimensionCount = Math.max(1, ...dimensions.map((item) => item.count))
  const recentMembers = [...members].sort((a, b) => (b.lastEntryAt ? new Date(b.lastEntryAt).getTime() : 0) - (a.lastEntryAt ? new Date(a.lastEntryAt).getTime() : 0)).slice(0, 6)

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="正式成員" value={regularMembers.length} helper={`另有 ${members.filter((member) => member.role === 'coach').length} 位教練`} icon="users" tone="brown" />
        <MetricCard label="本週書寫" value={weekEntries.length} helper={`累積 ${entries.length} 篇`} icon="document" tone="blue" />
        <MetricCard label="本週參與" value={`${participatingMembers}/${regularMembers.length}`} helper={regularMembers.length ? `${Math.round((participatingMembers / regularMembers.length) * 100)}% 成員有書寫` : '尚無成員'} icon="activity" tone="green" />
        <MetricCard label="公開分享率" value={`${publicRate}%`} helper={`${comments.length} 則留言 · ${likes.length} 次按讚`} icon="eye" tone="rose" />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-[#e2dcd3] bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-6 flex items-start justify-between">
            <div>
              <h3 className="font-heading text-base font-semibold text-[#332d29]">本週 PERMA 分布</h3>
              <p className="mt-1 text-xs text-muted-foreground">依本週所有成員書寫篇數統計</p>
            </div>
            <span className="rounded-full bg-[#f1ece5] px-3 py-1 text-xs font-semibold text-[#796758]">共 {weekEntries.length} 篇</span>
          </div>
          <div className="space-y-4">
            {dimensions.map(({ key, count }) => {
              const dim = DIMENSION_CONFIGS[key]
              return (
                <div key={key} className="grid grid-cols-[88px_1fr_28px] items-center gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#514943]"><span className={`h-2.5 w-2.5 rounded-full ${dim.bgMed}`} />{dim.label}</div>
                  <div className="h-2 overflow-hidden rounded-full bg-[#eeeae4]"><div className={`h-full rounded-full bg-gradient-to-r ${dim.gradientBar}`} style={{ width: `${(count / maxDimensionCount) * 100}%` }} /></div>
                  <span className="text-right text-sm font-bold text-[#514943]">{count}</span>
                </div>
              )
            })}
          </div>
        </div>

        <ActivityChart entries={entries} />
      </section>

      <section className="overflow-hidden rounded-2xl border border-[#e2dcd3] bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-[#eeeae4] px-5 py-4 sm:px-6">
          <div><h3 className="font-heading text-base font-semibold text-[#332d29]">最近書寫成員</h3><p className="mt-1 text-xs text-muted-foreground">點選成員可查看完整紀錄</p></div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="bg-[#faf8f4] text-xs text-muted-foreground"><tr><th className="px-6 py-3 font-semibold">成員</th><th className="px-4 py-3 font-semibold">本週</th><th className="px-4 py-3 font-semibold">累積書寫</th><th className="px-4 py-3 font-semibold">連續週數</th><th className="px-4 py-3 font-semibold">最後書寫</th><th className="px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-[#eeeae4]">
              {recentMembers.map((member) => <MemberTableRow key={member.id} member={member} onSelect={onSelectMember} />)}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function ActivityChart({ entries }: { entries: EntryRow[] }) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (6 - index))
    const next = new Date(date)
    next.setDate(next.getDate() + 1)
    return { date, count: entries.filter((entry) => { const time = new Date(entry.created_at).getTime(); return time >= date.getTime() && time < next.getTime() }).length }
  })
  const max = Math.max(1, ...days.map((day) => day.count))

  return (
    <div className="rounded-2xl border border-[#e2dcd3] bg-[#302b28] p-5 text-white shadow-sm sm:p-6">
      <h3 className="font-heading text-base font-semibold">近七日書寫趨勢</h3>
      <p className="mt-1 text-xs text-white/45">每日新增書寫篇數</p>
      <div className="mt-7 flex h-44 items-end justify-between gap-2">
        {days.map((day) => (
          <div key={day.date.toISOString()} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
            <span className="text-xs font-semibold text-white/70">{day.count}</span>
            <div className="w-full max-w-9 rounded-t-lg bg-[#c99d76] transition-all" style={{ height: `${Math.max(day.count ? 12 : 3, (day.count / max) * 112)}px`, opacity: day.count ? 1 : 0.25 }} />
            <span className="text-[10px] text-white/45">{new Intl.DateTimeFormat('zh-TW', { weekday: 'short' }).format(day.date)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Members({ members, entries, onSelectMember }: { members: MemberView[]; entries: EntryRow[]; onSelectMember: (id: string) => void }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[#e2dcd3] bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-[#eeeae4] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div><h3 className="font-heading text-base font-semibold text-[#332d29]">全部成員</h3><p className="mt-1 text-xs text-muted-foreground">共 {members.length} 位符合搜尋條件</p></div>
        <button onClick={() => downloadCsv('members.csv', members.map((member) => ({ 姓名: member.display_name, Email: member.email, 角色: member.role, 本週書寫: member.weekEntries, 累積書寫: member.totalEntries, 最後書寫: member.lastEntryAt, 最後登入: member.lastSignInAt })))} className="flex items-center justify-center gap-2 rounded-lg border border-[#ded8cf] px-3 py-2 text-xs font-semibold text-[#514943] hover:bg-[#faf8f4]"><AdminIcon name="download" />匯出 CSV</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="bg-[#faf8f4] text-xs text-muted-foreground"><tr><th className="px-6 py-3 font-semibold">成員</th><th className="px-4 py-3 font-semibold">Email</th><th className="px-4 py-3 font-semibold">本週</th><th className="px-4 py-3 font-semibold">累積</th><th className="px-4 py-3 font-semibold">連續週數</th><th className="px-4 py-3 font-semibold">最後書寫</th><th className="px-4 py-3" /></tr></thead>
          <tbody className="divide-y divide-[#eeeae4]">
            {members.map((member) => (
              <tr key={member.id} className="transition hover:bg-[#fcfaf7]">
                <td className="px-6 py-4"><MemberName member={member} /></td>
                <td className="px-4 py-4 text-sm text-[#625a54]">{member.email ?? '—'}</td>
                <td className="px-4 py-4 font-semibold">{member.weekEntries}</td>
                <td className="px-4 py-4">{member.totalEntries}</td>
                <td className="px-4 py-4">{member.activeWeekStreak} 週</td>
                <td className="px-4 py-4 text-muted-foreground">{formatDate(member.lastEntryAt)}</td>
                <td className="px-4 py-4"><button onClick={() => onSelectMember(member.id)} className="rounded-lg bg-[#f1ece5] px-3 py-1.5 text-xs font-semibold text-[#685648] hover:bg-[#e8dfd4]">查看</button></td>
              </tr>
            ))}
            {members.length === 0 && <EmptyTable colSpan={7} label="找不到符合條件的成員" />}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[#eeeae4] px-6 py-3 text-xs text-muted-foreground">共載入 {entries.length} 篇書寫，包含公開與私人內容。</p>
    </section>
  )
}

function Entries({ entries, dimensionFilter, setDimensionFilter, visibilityFilter, setVisibilityFilter }: { entries: EntryRow[]; dimensionFilter: 'all' | DimensionKey; setDimensionFilter: (value: 'all' | DimensionKey) => void; visibilityFilter: 'all' | 'public' | 'private'; setVisibilityFilter: (value: 'all' | 'public' | 'private') => void }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[#e2dcd3] bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-[#eeeae4] px-5 py-4 xl:flex-row xl:items-center xl:justify-between sm:px-6">
        <div><h3 className="font-heading text-base font-semibold text-[#332d29]">全部書寫</h3><p className="mt-1 text-xs text-muted-foreground">目前顯示 {entries.length} 篇</p></div>
        <div className="flex flex-wrap gap-2">
          <select value={dimensionFilter} onChange={(event) => setDimensionFilter(event.target.value as 'all' | DimensionKey)} className="h-9 rounded-lg border border-[#ded8cf] bg-white px-3 text-xs font-semibold outline-none focus:border-[#9a6d48]">
            <option value="all">全部維度</option>{DIMENSION_ORDER.map((key) => <option key={key} value={key}>{DIMENSION_CONFIGS[key].label}</option>)}
          </select>
          <select value={visibilityFilter} onChange={(event) => setVisibilityFilter(event.target.value as 'all' | 'public' | 'private')} className="h-9 rounded-lg border border-[#ded8cf] bg-white px-3 text-xs font-semibold outline-none focus:border-[#9a6d48]">
            <option value="all">全部隱私設定</option><option value="public">公開到社群</option><option value="private">只留給自己</option>
          </select>
          <button onClick={() => downloadCsv('perma-entries.csv', entries.map((entry) => ({ 成員: entry.profiles?.display_name ?? '', 維度: DIMENSION_CONFIGS[entry.dimension].label, 內容: entry.content, 公開: entry.is_public, 輸入方式: entry.input_method, 建立時間: entry.created_at })))} className="flex h-9 items-center gap-2 rounded-lg border border-[#ded8cf] px-3 text-xs font-semibold text-[#514943] hover:bg-[#faf8f4]"><AdminIcon name="download" />匯出 CSV</button>
        </div>
      </div>
      <div className="divide-y divide-[#eeeae4]">
        {entries.map((entry) => {
          const dim = DIMENSION_CONFIGS[entry.dimension]
          return (
            <article key={entry.id} className="px-5 py-5 transition hover:bg-[#fcfaf7] sm:px-6">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="font-semibold text-[#332d29]">{entry.profiles?.display_name ?? '未知成員'}</span>
                <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${dim.bgLight} ${dim.textColor}`}>{dim.label} · {entry.dimension}</span>
                <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${entry.is_public ? 'bg-emerald-50 text-emerald-800' : 'bg-stone-100 text-stone-600'}`}>{entry.is_public ? '公開到社群' : '只留給自己'}</span>
                <span className="rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800">{entry.input_method === 'voice' ? '語音輸入' : '文字輸入'}</span>
                <time className="ml-auto text-xs text-muted-foreground">{formatDate(entry.created_at, true)}</time>
              </div>
              <p className="whitespace-pre-wrap text-[15px] leading-7 text-[#514943]">{entry.content}</p>
            </article>
          )
        })}
        {entries.length === 0 && <div className="px-6 py-14 text-center text-sm text-muted-foreground">找不到符合條件的書寫</div>}
      </div>
    </section>
  )
}

function Comments({ comments, entries }: { comments: CommentRow[]; entries: EntryRow[] }) {
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]))
  return (
    <section className="overflow-hidden rounded-2xl border border-[#e2dcd3] bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-[#eeeae4] px-5 py-4 sm:px-6"><div><h3 className="font-heading text-base font-semibold text-[#332d29]">全部留言</h3><p className="mt-1 text-xs text-muted-foreground">目前顯示 {comments.length} 則</p></div></div>
      <div className="divide-y divide-[#eeeae4]">
        {comments.map((comment) => {
          const entry = entryMap.get(comment.entry_id)
          return (
            <article key={comment.id} className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(150px,0.25fr)_1fr_auto] sm:px-6">
              <div><p className="text-sm font-semibold text-[#332d29]">{comment.profiles?.display_name ?? '未知成員'}</p><time className="mt-1 block text-xs text-muted-foreground">{formatDate(comment.created_at, true)}</time></div>
              <div><p className="whitespace-pre-wrap text-sm leading-6 text-[#514943]">{comment.content}</p>{entry && <p className="mt-2 line-clamp-2 rounded-lg bg-[#faf8f4] px-3 py-2 text-xs leading-5 text-muted-foreground">回覆書寫：{entry.content}</p>}</div>
              {entry && <span className={`h-fit rounded-md px-2 py-1 text-[11px] font-bold ${DIMENSION_CONFIGS[entry.dimension].bgLight} ${DIMENSION_CONFIGS[entry.dimension].textColor}`}>{DIMENSION_CONFIGS[entry.dimension].label}</span>}
            </article>
          )
        })}
        {comments.length === 0 && <div className="px-6 py-14 text-center text-sm text-muted-foreground">目前沒有留言</div>}
      </div>
    </section>
  )
}

function Reports({ reviews }: { reviews: ReviewRow[] }) {
  return (
    <div className="space-y-4">
      {reviews.map((review) => <ReviewCard key={review.id} review={review} />)}
      {reviews.length === 0 && <div className="rounded-2xl border border-[#e2dcd3] bg-white px-6 py-14 text-center text-sm text-muted-foreground shadow-sm">目前還沒有已產生的每週報告</div>}
    </div>
  )
}

function ReviewCard({ review }: { review: ReviewRow }) {
  const [expanded, setExpanded] = useState(false)
  const narrativeLines = Object.values(review.content.narrative ?? {}).flatMap((lines) => lines ?? [])
  return (
    <article className="rounded-2xl border border-[#e2dcd3] bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-heading text-base font-semibold text-[#332d29]">{review.profiles?.display_name ?? '未知成員'}</h3><span className="rounded-full bg-[#f1ece5] px-2.5 py-1 text-[11px] font-semibold text-[#685648]">{review.entry_count} 篇書寫</span></div><p className="mt-1 text-xs text-muted-foreground">週期開始：{formatDate(review.period_start)}</p></div>
        <button onClick={() => setExpanded((value) => !value)} className="flex items-center gap-2 self-start rounded-lg border border-[#ded8cf] px-3 py-2 text-xs font-semibold text-[#514943] hover:bg-[#faf8f4]">{expanded ? '收合內容' : '查看完整報告'}<AdminIcon name="chevron" /></button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {(review.content.emotions ?? []).map((word) => <span key={`emotion-${word.label}`} className="rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-800">{word.label} · {word.count}</span>)}
        {(review.content.keywords ?? []).map((word) => <span key={`keyword-${word.label}`} className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">{word.label} · {word.count}</span>)}
      </div>
      {expanded && (
        <div className="mt-5 border-t border-[#eeeae4] pt-5">
          <div className="mb-5 grid gap-2 sm:grid-cols-5">{DIMENSION_ORDER.map((key) => <div key={key} className={`rounded-xl p-3 ${DIMENSION_CONFIGS[key].bgLight}`}><p className={`text-xs font-bold ${DIMENSION_CONFIGS[key].textColor}`}>{DIMENSION_CONFIGS[key].label}</p><p className="mt-1 text-xl font-semibold text-[#332d29]">{review.content.dimension_dist?.[key] ?? 0}</p></div>)}</div>
          <ul className="space-y-2">{narrativeLines.map((line, index) => <li key={`${line}-${index}`} className="flex gap-2 text-sm leading-6 text-[#514943]"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#b3825e]" />{line}</li>)}</ul>
        </div>
      )}
    </article>
  )
}

function MemberDrawer({ member, entries, reviews, onClose }: { member: MemberView; entries: EntryRow[]; reviews: ReviewRow[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/35" role="dialog" aria-modal="true" aria-label={`${member.display_name} 的完整紀錄`} onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-[#f8f5ef] shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-[#e2dcd3] bg-white/95 px-5 py-5 backdrop-blur sm:px-7">
          <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#9a6d48]">Member profile</p><h2 className="mt-1 font-heading text-2xl font-semibold text-[#302b28]">{member.display_name}</h2><p className="mt-1 text-sm text-muted-foreground">{member.email ?? '尚未取得 email'}</p></div>
          <button onClick={onClose} aria-label="關閉" className="rounded-full border border-[#ded8cf] bg-white p-2 text-[#514943] hover:bg-[#faf8f4]"><AdminIcon name="close" /></button>
        </header>
        <div className="space-y-6 p-5 sm:p-7">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SmallStat label="本週書寫" value={member.weekEntries} /><SmallStat label="累積書寫" value={member.totalEntries} /><SmallStat label="連續週數" value={member.activeWeekStreak} /><SmallStat label="週報數" value={reviews.length} />
          </section>
          <section><h3 className="mb-3 font-heading text-base font-semibold text-[#332d29]">書寫時間軸</h3><div className="space-y-3">{entries.map((entry) => <article key={entry.id} className="rounded-xl border border-[#e2dcd3] bg-white p-4 shadow-sm"><div className="mb-2 flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${DIMENSION_CONFIGS[entry.dimension].bgLight} ${DIMENSION_CONFIGS[entry.dimension].textColor}`}>{DIMENSION_CONFIGS[entry.dimension].label}</span><span className="text-[11px] font-semibold text-muted-foreground">{entry.is_public ? '公開到社群' : '只留給自己'} · {entry.input_method === 'voice' ? '語音' : '文字'}</span><time className="ml-auto text-[11px] text-muted-foreground">{formatDate(entry.created_at, true)}</time></div><p className="whitespace-pre-wrap text-sm leading-6 text-[#514943]">{entry.content}</p></article>)}{entries.length === 0 && <p className="rounded-xl border border-dashed border-[#d9d1c8] p-6 text-center text-sm text-muted-foreground">尚無書寫紀錄</p>}</div></section>
          <section><h3 className="mb-3 font-heading text-base font-semibold text-[#332d29]">每週 AI 報告</h3><div className="space-y-3">{reviews.map((review) => <ReviewCard key={review.id} review={review} />)}{reviews.length === 0 && <p className="rounded-xl border border-dashed border-[#d9d1c8] p-6 text-center text-sm text-muted-foreground">尚無每週報告</p>}</div></section>
        </div>
      </div>
    </div>
  )
}

function MetricCard({ label, value, helper, icon, tone }: { label: string; value: string | number; helper: string; icon: IconName; tone: 'brown' | 'blue' | 'green' | 'rose' }) {
  const tones = { brown: 'bg-amber-50 text-amber-900', blue: 'bg-blue-50 text-blue-900', green: 'bg-emerald-50 text-emerald-900', rose: 'bg-rose-50 text-rose-900' }
  return <div className="rounded-2xl border border-[#e2dcd3] bg-white p-5 shadow-sm"><div className={`mb-5 flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone]}`}><AdminIcon name={icon} /></div><p className="text-xs font-semibold text-muted-foreground">{label}</p><p className="mt-1 font-heading text-3xl font-semibold tracking-tight text-[#302b28]">{value}</p><p className="mt-1 text-xs text-muted-foreground">{helper}</p></div>
}

function SmallStat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-[#e2dcd3] bg-white p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold text-[#302b28]">{value}</p></div>
}

function MemberName({ member }: { member: MemberView }) {
  const initials = member.display_name.trim().slice(0, 2) || '—'
  return <div className="flex items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#ebe2d8] text-xs font-bold text-[#705a49]">{initials}</span><div><p className="font-semibold text-[#332d29]">{member.display_name || '未命名成員'}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{member.role === 'coach' ? '教練' : '成員'}</p></div></div>
}

function MemberTableRow({ member, onSelect }: { member: MemberView; onSelect: (id: string) => void }) {
  return <tr className="transition hover:bg-[#fcfaf7]"><td className="px-6 py-4"><MemberName member={member} /></td><td className="px-4 py-4 font-semibold">{member.weekEntries}</td><td className="px-4 py-4">{member.totalEntries}</td><td className="px-4 py-4">{member.activeWeekStreak} 週</td><td className="px-4 py-4 text-muted-foreground">{formatDate(member.lastEntryAt)}</td><td className="px-4 py-4"><button onClick={() => onSelect(member.id)} className="rounded-lg bg-[#f1ece5] px-3 py-1.5 text-xs font-semibold text-[#685648] hover:bg-[#e8dfd4]">查看</button></td></tr>
}

function EmptyTable({ colSpan, label }: { colSpan: number; label: string }) {
  return <tr><td colSpan={colSpan} className="px-6 py-14 text-center text-sm text-muted-foreground">{label}</td></tr>
}

function AdminLoading() {
  return <div className="flex min-h-screen items-center justify-center bg-[#f5f2ec]"><div className="text-center"><div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-[#9a6d48] border-t-transparent" /><p className="mt-4 text-sm text-muted-foreground">正在確認管理權限…</p></div></div>
}

function AdminSectionLoading() {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-40 animate-pulse rounded-2xl border border-[#e2dcd3] bg-white/70" />)}</div>
}

function AccessDenied() {
  return <div className="flex min-h-screen items-center justify-center bg-[#f5f2ec] px-6"><div className="w-full max-w-md rounded-2xl border border-[#e2dcd3] bg-white p-8 text-center shadow-sm"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#f1ece5] text-[#705a49]"><AdminIcon name="lock" /></div><h1 className="mt-5 font-heading text-2xl font-semibold text-[#302b28]">這是教練專用頁面</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">目前登入的帳號沒有管理者權限。如需使用後台，請改用教練帳號登入。</p><Link to="/app/home" className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-[#302b28] px-5 text-sm font-semibold text-white">返回使用者頁面</Link></div></div>
}

type IconName = 'grid' | 'users' | 'document' | 'message' | 'chart' | 'arrow' | 'logout' | 'search' | 'refresh' | 'info' | 'download' | 'activity' | 'eye' | 'chevron' | 'close' | 'lock'

function AdminIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>,
    message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />,
    chart: <><path d="M3 3v18h18" /><path d="m7 16 4-5 4 3 5-7" /></>,
    arrow: <><path d="m15 18-6-6 6-6" /><path d="M9 12h12" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    refresh: <><path d="M20 7h-5V2" /><path d="M20 7a9 9 0 1 0 1 8" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <><path d="M6 6l12 12M18 6 6 18" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  }
  return <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
