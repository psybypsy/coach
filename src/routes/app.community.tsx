import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { programWeek, weekStreak } from '../lib/journalStats'
import { DIMENSION_ORDER, DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'
import { generateEnergyAlias } from '../lib/energyAlias'

const API_BASE = import.meta.env.VITE_API_BASE as string

export const Route = createFileRoute('/app/community')({
  component: CommunityPage,
})

interface EntryProfile {
  display_name: string
  role: 'member' | 'coach'
}

type Visibility = 'public' | 'anonymous' | 'private'

interface Post {
  id: string
  user_id: string
  week_start: string
  p_content: string
  e_content: string
  r_content: string
  m_content: string
  a_content: string
  created_at: string
  is_public: boolean
  visibility: Visibility
  anon_alias: string | null
  profiles: EntryProfile | null
}

interface CommentRow {
  id: string
  post_id: string
  user_id: string
  content: string
  created_at: string
  profiles: EntryProfile | null
}

// 每位作者的完整發文歷史（算第幾週 / 之幾次 / 連續幾週用）。
interface HistRow {
  user_id: string
  week_start: string
  created_at: string
}

interface PostMeta {
  week: number // 第幾週（以作者最早的週為第 1 週，跳週照算）
  occurrence: number // 該週的第幾次
  streak: number // 連續幾週
}

type Answers = Record<DimensionKey, string>

function answersFrom(post: Post): Answers {
  return {
    P: post.p_content,
    E: post.e_content,
    R: post.r_content,
    M: post.m_content,
    A: post.a_content,
  }
}

function computeMeta(post: Post, hist: HistRow[]): PostMeta {
  const userHist = hist.filter((h) => h.user_id === post.user_id)
  const weekStarts = [...new Set(userHist.map((h) => h.week_start))]
  const week = programWeek(weekStarts.length ? weekStarts : [post.week_start], post.week_start)

  const inWeek = userHist
    .filter((h) => h.week_start === post.week_start)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  const idx = inWeek.findIndex((h) => h.created_at === post.created_at)
  const occurrence = idx === -1 ? 1 : idx + 1

  const streak = weekStreak(weekStarts, post.week_start)
  return { week, occurrence, streak }
}

function formatDateTime(iso: string, language: string): string {
  const d = new Date(iso)
  if (language === 'en') {
    const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    return `${date} · ${time}`
  }
  const date = d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
  const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date} · ${time}`
}

type SortOrder = 'newest' | 'oldest'
type Tab = 'all' | 'mine'

function CommunityPage() {
  const { t, language } = useLanguage()
  const [userId, setUserId] = useState<string | null>(null)
  const [isCoach, setIsCoach] = useState(false)
  const [posts, setPosts] = useState<Post[]>([])
  const [hist, setHist] = useState<HistRow[]>([])
  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({})
  const [likedByMe, setLikedByMe] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<Record<string, CommentRow[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<SortOrder>('newest')
  const [tab, setTab] = useState<Tab>('all')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Answers>({ P: '', E: '', R: '', M: '', A: '' })
  const [savingEdit, setSavingEdit] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  // Supabase 免費方案閒置後第一個請求可能要 30 秒以上（實測過 35 秒），Safari 也有
  // 多分頁搶 auth lock 卡住的情況。沒有逾時的話畫面會永遠停在「載入中…」，看起來像壞掉。
  function withTimeout<T>(work: Promise<T>, ms = 25000): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ])
  }

  async function load() {
    setLoading(true)
    setLoadError(null)
    try {
      await withTimeout(fetchAll())
    } catch (err) {
      console.error('社群動態載入失敗', err)
      setLoadError(err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error')
    } finally {
      setLoading(false)
    }
  }

  async function fetchAll() {
    const { data: userData } = await supabase.auth.getUser()
    const uid = userData.user?.id ?? null
    setUserId(uid)

    // 教練視角：教練要能在社群直接看到每位學員每週寫的內容並回覆，所以不套 is_public
    // 過濾（資料庫的 read journal_posts policy 本來就允許 is_coach() 讀全部）。
    let coach = false
    if (uid) {
      const { data: me } = await supabase.from('profiles').select('role').eq('id', uid).single()
      coach = me?.role === 'coach'
    }
    setIsCoach(coach)

    // 公開/匿名貼文大家都看得到；「僅自己與教練可見」的貼文只有作者自己與教練看得到。
    let postQuery = supabase
      .from('journal_posts')
      .select(
        'id,user_id,week_start,p_content,e_content,r_content,m_content,a_content,created_at,is_public,visibility,anon_alias,profiles(display_name,role)',
      )
    if (!coach) {
      postQuery = uid ? postQuery.or(`is_public.eq.true,user_id.eq.${uid}`) : postQuery.eq('is_public', true)
    }
    // 教練是把這裡當跟進清單用的，50 筆在整梯次跑幾週後會看不到較早的學員貼文。
    const { data: postRows } = await postQuery
      .order('created_at', { ascending: false })
      .limit(coach ? 300 : 50)

    const list = (postRows ?? []) as unknown as Post[]
    setPosts(list)

    const authorIds = [...new Set(list.map((p) => p.user_id))]
    if (authorIds.length > 0) {
      const { data: histRows } = await supabase
        .from('journal_posts')
        .select('user_id,week_start,created_at')
        .in('user_id', authorIds)
      setHist((histRows ?? []) as unknown as HistRow[])
    }

    const postIds = list.map((p) => p.id)
    if (postIds.length > 0) {
      const [{ data: likeRows }, { data: commentRows }] = await Promise.all([
        supabase.from('post_likes').select('post_id,user_id').in('post_id', postIds),
        supabase
          .from('post_comments')
          .select('id,post_id,user_id,content,created_at,profiles(display_name,role)')
          .in('post_id', postIds)
          .order('created_at', { ascending: true }),
      ])

      const counts: Record<string, number> = {}
      const mine: Record<string, boolean> = {}
      for (const row of likeRows ?? []) {
        counts[row.post_id] = (counts[row.post_id] ?? 0) + 1
        if (row.user_id === uid) mine[row.post_id] = true
      }
      setLikeCounts(counts)
      setLikedByMe(mine)

      const grouped: Record<string, CommentRow[]> = {}
      for (const row of (commentRows ?? []) as unknown as CommentRow[]) {
        grouped[row.post_id] = grouped[row.post_id] ?? []
        grouped[row.post_id].push(row)
      }
      setComments(grouped)
    }
  }

  const visiblePosts = useMemo(() => {
    // 社群貼文：只顯示公開/匿名的貼文（教練另外看得到「僅自己與教練可見」的）；
    // 我的貼文：不論公開與否都顯示自己的貼文。
    const base =
      tab === 'mine'
        ? posts.filter((p) => p.user_id === userId)
        : isCoach
          ? posts
          : posts.filter((p) => p.is_public)
    return [...base].sort((a, b) =>
      sort === 'newest' ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at),
    )
  }, [posts, tab, userId, sort, isCoach])

  async function toggleLike(postId: string) {
    if (!userId) return
    const alreadyLiked = likedByMe[postId]
    setLikedByMe((prev) => ({ ...prev, [postId]: !alreadyLiked }))
    setLikeCounts((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) + (alreadyLiked ? -1 : 1) }))

    if (alreadyLiked) {
      await supabase.from('post_likes').delete().eq('post_id', postId).eq('user_id', userId)
    } else {
      await supabase.from('post_likes').insert({ post_id: postId, user_id: userId })
    }
  }

  async function submitComment(postId: string) {
    const text = (drafts[postId] ?? '').trim()
    if (!text || !userId) return
    setDrafts((prev) => ({ ...prev, [postId]: '' }))

    const { data } = await supabase
      .from('post_comments')
      .insert({ post_id: postId, user_id: userId, content: text })
      .select('id,post_id,user_id,content,created_at,profiles(display_name,role)')
      .single()

    if (data) {
      const row = data as unknown as CommentRow
      setComments((prev) => ({
        ...prev,
        [postId]: [...(prev[postId] ?? []), row],
      }))
      if (isCoach) void notifyAuthor(row.id)
    }
  }

  // 教練留言後寄 email 通知學員回來看。刻意不擋 UI、也不顯示錯誤——留言本身已經寫進
  // 資料庫了，通知信寄不出去不該讓教練以為留言失敗（後端會記 log）。
  async function notifyAuthor(commentId: string) {
    if (!API_BASE) return
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) return
      await fetch(`${API_BASE}/api/coach/comment-notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ comment_id: commentId }),
      })
    } catch {
      // 通知是附加價值，失敗就算了。
    }
  }

  function startEdit(post: Post) {
    setMenuOpenId(null)
    setEditingId(post.id)
    setEditDraft(answersFrom(post))
  }

  async function saveEdit(postId: string) {
    if (!DIMENSION_ORDER.every((k) => editDraft[k].trim())) return
    setSavingEdit(true)
    await supabase
      .from('journal_posts')
      .update({
        p_content: editDraft.P.trim(),
        e_content: editDraft.E.trim(),
        r_content: editDraft.R.trim(),
        m_content: editDraft.M.trim(),
        a_content: editDraft.A.trim(),
      })
      .eq('id', postId)
    setSavingEdit(false)
    setEditingId(null)
    await load()
  }

  async function deletePost(postId: string) {
    setMenuOpenId(null)
    if (!window.confirm(t('確定要刪除這則貼文嗎？此動作無法復原。'))) return
    await supabase.from('journal_posts').delete().eq('id', postId)
    await load()
  }

  // 貼文發布後仍可從「更多」選單改發布方式；沿用原本的能量代號（若之前沒有才臨時生成一個）。
  async function changeVisibility(post: Post, next: Visibility) {
    setMenuOpenId(null)
    if (post.visibility === next) return
    const anonAlias = next === 'anonymous' ? post.anon_alias || generateEnergyAlias(language) : post.anon_alias
    await supabase
      .from('journal_posts')
      .update({ visibility: next, is_public: next !== 'private', anon_alias: anonAlias })
      .eq('id', post.id)
    await load()
  }

  const visibilityOptions: { value: Visibility; title: string; desc: string }[] = [
    { value: 'public', title: t('發布到社群'), desc: t('你的名字會顯示在社群貼文上') },
    { value: 'anonymous', title: t('匿名發布到社群'), desc: t('以能量代號匿名出現在社群動態，教練仍看得到你的名字') },
    { value: 'private', title: t('僅自己與教練可見'), desc: t('不會出現在社群動態，只有你和教練看得到') },
  ]

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-heading text-xl text-foreground">{t('社群動態')}</h1>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('排序')}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOrder)}
            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground"
          >
            <option value="newest">{t('最新')}</option>
            <option value="oldest">{t('最早')}</option>
          </select>
        </label>
      </div>

      {/* 分頁：社群貼文 / 我的貼文 */}
      <div className="mb-6 inline-flex rounded-full border border-border bg-card p-1">
        {(['all', 'mine'] as Tab[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              tab === key ? 'bg-primary text-primary-foreground' : 'text-foreground-soft hover:text-foreground'
            }`}
          >
            {key === 'all' ? t('社群貼文') : t('我的貼文')}
          </button>
        ))}
      </div>

      {isCoach && tab === 'all' && (
        <div className="mb-5 rounded-xl border border-primary/30 bg-primary-soft px-4 py-3">
          <p className="text-sm font-semibold text-primary">{t('教練視角')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground-soft">
            {t('你看得到所有學員的書寫（含匿名與「僅自己與教練可見」），並可以直接在下方留言回覆。')}
          </p>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      ) : loadError ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">
            {loadError === 'timeout' ? t('載入逾時') : t('載入失敗')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {loadError === 'timeout'
              ? t('伺服器閒置後第一次連線會比較久，通常再試一次就好。')
              : t('請檢查網路連線後再試一次。')}
          </p>
          <button
            onClick={() => void load()}
            className="mt-3 h-9 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary-glow"
          >
            {t('重新載入')}
          </button>
        </div>
      ) : visiblePosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tab === 'mine' ? t('你還沒有發布任何書寫') : t('目前還沒有人發布書寫')}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {visiblePosts.map((post) => {
            const meta = computeMeta(post, hist)
            const isMine = post.user_id === userId
            // 匿名貼文對其他學員隱藏真實姓名/頭像，改用能量代號；作者自己與教練仍看得到
            // 真實身分（發布說明就是這樣寫的，教練要能針對本人跟進）。
            const isAnonymousToOthers = post.visibility === 'anonymous' && !isMine && !isCoach
            const name = isAnonymousToOthers
              ? post.anon_alias || t('神秘旅人')
              : (post.profiles?.display_name ?? '—')
            const avatarGlyph = isAnonymousToOthers ? '🌿' : name.trim().charAt(0).toUpperCase() || '—'
            const visibilityLabel =
              post.visibility === 'private'
                ? t('僅自己與教練可見')
                : post.visibility === 'anonymous'
                  ? isCoach && !isMine
                    ? t('匿名（僅教練可見真實身分）')
                    : t('匿名')
                  : null
            const isEditing = editingId === post.id
            return (
              <article key={post.id} className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                <header className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground-soft">
                      {avatarGlyph}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-foreground">{name}</span>
                        {post.profiles?.role === 'coach' && !isAnonymousToOthers && (
                          <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                            {t('教練')}
                          </span>
                        )}
                        {(isMine || isCoach) && visibilityLabel && (
                          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground-soft">
                            {visibilityLabel}
                          </span>
                        )}
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground-soft">
                          {t('第 {n} 週之 {m}', { n: meta.week, m: meta.occurrence })}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDateTime(post.created_at, language)}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700">
                      🔥 {t('連續 {n} 週', { n: meta.streak })}
                    </span>
                    {isMine && !isEditing && (
                      <div className="relative">
                        <button
                          type="button"
                          aria-label={t('更多')}
                          onClick={() => setMenuOpenId((id) => (id === post.id ? null : post.id))}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-foreground-soft transition hover:bg-muted"
                        >
                          <MoreIcon />
                        </button>
                        {menuOpenId === post.id && (
                          <>
                            <button
                              aria-label={t('關閉')}
                              className="fixed inset-0 z-40 cursor-default"
                              onClick={() => setMenuOpenId(null)}
                            />
                            <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-border bg-card p-1 shadow-lg">
                              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {t('隱私設定')}
                              </p>
                              {visibilityOptions.map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() => void changeVisibility(post, opt.value)}
                                  className="flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left transition hover:bg-muted"
                                >
                                  <span>
                                    <span className="block text-sm font-medium text-foreground">{opt.title}</span>
                                    <span className="block text-xs text-muted-foreground">{opt.desc}</span>
                                  </span>
                                  {post.visibility === opt.value && (
                                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                  )}
                                </button>
                              ))}
                              <div className="my-1 border-t border-border" />
                              <button
                                onClick={() => startEdit(post)}
                                className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-foreground transition hover:bg-muted"
                              >
                                {t('編輯')}
                              </button>
                              <button
                                onClick={() => void deletePost(post.id)}
                                className="block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-rust transition hover:bg-muted"
                              >
                                {t('刪除貼文')}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </header>

                {isEditing ? (
                  // 編輯模式：5 面向可改
                  <div className="mt-4 flex flex-col gap-2.5">
                    {DIMENSION_ORDER.map((key) => {
                      const dim = DIMENSION_CONFIGS[key]
                      return (
                        <div key={key} className={`rounded-lg border-l-[3px] ${dim.borderSolid} ${dim.bgLight} px-4 py-3`}>
                          <div className={`mb-1 text-[11px] font-semibold uppercase tracking-wide ${dim.textColor}`}>
                            {language === 'en' ? dim.sublabel : `${dim.label} · ${dim.sublabel}`}
                          </div>
                          <textarea
                            value={editDraft[key]}
                            onChange={(e) => setEditDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                            rows={3}
                            className="w-full resize-y rounded-md border border-border bg-card p-2 text-[15px] leading-relaxed text-foreground outline-none focus:border-primary"
                          />
                        </div>
                      )
                    })}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className="h-10 flex-1 rounded-lg border border-border bg-card text-sm font-semibold text-foreground-soft transition hover:bg-muted"
                      >
                        {t('取消')}
                      </button>
                      <button
                        onClick={() => void saveEdit(post.id)}
                        disabled={savingEdit || !DIMENSION_ORDER.every((k) => editDraft[k].trim())}
                        className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition hover:bg-primary-glow disabled:opacity-50"
                      >
                        {savingEdit ? t('儲存中…') : t('儲存')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* PERMA 五面向：分層色 */}
                    <div className="mt-4 flex flex-col gap-2.5">
                      {DIMENSION_ORDER.map((key) => {
                        const dim = DIMENSION_CONFIGS[key]
                        const text = answersFrom(post)[key]
                        if (!text.trim()) return null
                        return (
                          <div key={key} className={`rounded-lg border-l-[3px] ${dim.borderSolid} ${dim.bgLight} px-4 py-3`}>
                            <div className={`text-[11px] font-semibold uppercase tracking-wide ${dim.textColor}`}>
                              {language === 'en' ? dim.sublabel : `${dim.label} · ${dim.sublabel}`}
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                              {text}
                            </p>
                          </div>
                        )
                      })}
                    </div>

                    <div className="mt-4 flex items-center gap-4 border-t border-border pt-3">
                      <button
                        onClick={() => void toggleLike(post.id)}
                        className={`flex items-center gap-1.5 text-sm font-medium transition ${
                          likedByMe[post.id] ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <HeartIcon filled={!!likedByMe[post.id]} />
                        {likeCounts[post.id] ?? 0}
                      </button>
                      <span className="text-sm text-muted-foreground">
                        {t('留言')} · {(comments[post.id] ?? []).length}
                      </span>
                    </div>

                    {(comments[post.id] ?? []).length > 0 && (
                      <ul className="mt-3 flex flex-col gap-2">
                        {(comments[post.id] ?? []).map((c) => {
                          const fromCoach = c.profiles?.role === 'coach'
                          return (
                            <li
                              key={c.id}
                              className={`rounded-lg px-3 py-2 text-sm ${
                                fromCoach ? 'bg-primary-soft' : 'bg-muted'
                              }`}
                            >
                              <span className="mr-1.5 font-semibold text-foreground">
                                {c.profiles?.display_name ?? '—'}
                              </span>
                              {fromCoach && (
                                <span className="mr-1.5 rounded-md bg-primary px-1.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
                                  {t('教練')}
                                </span>
                              )}
                              <span className="text-foreground-soft">{c.content}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}

                    <div className="mt-3 flex gap-2">
                      <input
                        value={drafts[post.id] ?? ''}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [post.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void submitComment(post.id)
                        }}
                        placeholder={isCoach ? t('以教練身分回覆…') : t('寫下留言…')}
                        className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                      />
                      <button
                        onClick={() => void submitComment(post.id)}
                        disabled={!(drafts[post.id] ?? '').trim()}
                        className="rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
                      >
                        {t('送出')}
                      </button>
                    </div>
                  </>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  )
}
