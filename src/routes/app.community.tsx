import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_ORDER, DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/community')({
  component: CommunityPage,
})

interface EntryProfile {
  display_name: string
  role: 'member' | 'coach'
}

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

// 依維度取出貼文對應的答案。
function answerFor(post: Post, key: DimensionKey): string {
  switch (key) {
    case 'P': return post.p_content
    case 'E': return post.e_content
    case 'R': return post.r_content
    case 'M': return post.m_content
    case 'A': return post.a_content
  }
}

function formatRelativeTime(iso: string, language: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return language === 'en' ? 'just now' : '剛剛'
  if (min < 60) return language === 'en' ? `${min}m ago` : `${min} 分鐘前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return language === 'en' ? `${hr}h ago` : `${hr} 小時前`
  const day = Math.floor(hr / 24)
  if (day < 7) return language === 'en' ? `${day}d ago` : `${day} 天前`
  return new Date(iso).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-TW')
}

function CommunityPage() {
  const { t, language } = useLanguage()
  const [userId, setUserId] = useState<string | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({})
  const [likedByMe, setLikedByMe] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<Record<string, CommentRow[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    const { data: userData } = await supabase.auth.getUser()
    const uid = userData.user?.id ?? null
    setUserId(uid)

    const { data: postRows } = await supabase
      .from('journal_posts')
      .select(
        'id,user_id,week_start,p_content,e_content,r_content,m_content,a_content,created_at,profiles(display_name,role)',
      )
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(50)

    const list = (postRows ?? []) as unknown as Post[]
    setPosts(list)

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

    setLoading(false)
  }

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
      setComments((prev) => ({
        ...prev,
        [postId]: [...(prev[postId] ?? []), data as unknown as CommentRow],
      }))
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="font-heading mb-6 text-xl text-foreground">{t('社群動態')}</h1>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      ) : posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('目前還沒有人發布書寫')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {posts.map((post) => (
            <article key={post.id} className="rounded-xl border border-border bg-card p-5 shadow-soft">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {post.profiles?.display_name ?? '—'}
                  </span>
                  {post.profiles?.role === 'coach' && (
                    <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                      {t('教練')}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(post.created_at, language)}
                </span>
              </div>

              {/* PERMA 五個答案 */}
              <div className="flex flex-col gap-3">
                {DIMENSION_ORDER.map((key) => {
                  const dim = DIMENSION_CONFIGS[key]
                  const text = answerFor(post, key)
                  if (!text.trim()) return null
                  return (
                    <div key={key}>
                      <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${dim.textColor} ${dim.bgLight}`}>
                        {language === 'en' ? dim.sublabel : `${dim.label} · ${dim.sublabel}`}
                      </span>
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
                  {(comments[post.id] ?? []).map((c) => (
                    <li key={c.id} className="rounded-lg bg-muted px-3 py-2 text-sm">
                      <span className="mr-1.5 font-semibold text-foreground">
                        {c.profiles?.display_name ?? '—'}
                      </span>
                      <span className="text-foreground-soft">{c.content}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex gap-2">
                <input
                  value={drafts[post.id] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [post.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitComment(post.id)
                  }}
                  placeholder={t('寫下留言…')}
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
            </article>
          ))}
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
