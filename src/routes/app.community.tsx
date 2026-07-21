import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'

export const Route = createFileRoute('/app/community')({
  component: CommunityPage,
})

interface EntryProfile {
  display_name: string
  role: 'member' | 'coach'
}

interface Entry {
  id: string
  user_id: string
  dimension: DimensionKey
  content: string
  created_at: string
  profiles: EntryProfile | null
}

interface CommentRow {
  id: string
  entry_id: string
  user_id: string
  content: string
  created_at: string
  profiles: EntryProfile | null
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
  const [entries, setEntries] = useState<Entry[]>([])
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

    const { data: entryRows } = await supabase
      .from('perma_entries')
      .select('id,user_id,dimension,content,created_at,profiles(display_name,role)')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(50)

    const list = (entryRows ?? []) as unknown as Entry[]
    setEntries(list)

    const entryIds = list.map((e) => e.id)
    if (entryIds.length > 0) {
      const [{ data: likeRows }, { data: commentRows }] = await Promise.all([
        supabase.from('likes').select('entry_id,user_id').in('entry_id', entryIds),
        supabase
          .from('comments')
          .select('id,entry_id,user_id,content,created_at,profiles(display_name,role)')
          .in('entry_id', entryIds)
          .order('created_at', { ascending: true }),
      ])

      const counts: Record<string, number> = {}
      const mine: Record<string, boolean> = {}
      for (const row of likeRows ?? []) {
        counts[row.entry_id] = (counts[row.entry_id] ?? 0) + 1
        if (row.user_id === uid) mine[row.entry_id] = true
      }
      setLikeCounts(counts)
      setLikedByMe(mine)

      const grouped: Record<string, CommentRow[]> = {}
      for (const row of (commentRows ?? []) as unknown as CommentRow[]) {
        grouped[row.entry_id] = grouped[row.entry_id] ?? []
        grouped[row.entry_id].push(row)
      }
      setComments(grouped)
    }

    setLoading(false)
  }

  async function toggleLike(entryId: string) {
    if (!userId) return
    const alreadyLiked = likedByMe[entryId]
    setLikedByMe((prev) => ({ ...prev, [entryId]: !alreadyLiked }))
    setLikeCounts((prev) => ({ ...prev, [entryId]: (prev[entryId] ?? 0) + (alreadyLiked ? -1 : 1) }))

    if (alreadyLiked) {
      await supabase.from('likes').delete().eq('entry_id', entryId).eq('user_id', userId)
    } else {
      await supabase.from('likes').insert({ entry_id: entryId, user_id: userId })
    }
  }

  async function submitComment(entryId: string) {
    const text = (drafts[entryId] ?? '').trim()
    if (!text || !userId) return
    setDrafts((prev) => ({ ...prev, [entryId]: '' }))

    const { data } = await supabase
      .from('comments')
      .insert({ entry_id: entryId, user_id: userId, content: text })
      .select('id,entry_id,user_id,content,created_at,profiles(display_name,role)')
      .single()

    if (data) {
      setComments((prev) => ({
        ...prev,
        [entryId]: [...(prev[entryId] ?? []), data as unknown as CommentRow],
      }))
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="font-heading mb-6 text-xl text-foreground">{t('社群動態')}</h1>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('目前還沒有人發布書寫')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {entries.map((entry) => {
            const dim = DIMENSION_CONFIGS[entry.dimension]
            return (
              <article key={entry.id} className="rounded-xl border border-border bg-card p-5 shadow-soft">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {entry.profiles?.display_name ?? '—'}
                    </span>
                    {entry.profiles?.role === 'coach' && (
                      <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                        {t('教練')}
                      </span>
                    )}
                    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${dim.textColor} ${dim.bgLight}`}>
                      {language === 'en' ? dim.sublabel : dim.label}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(entry.created_at, language)}
                  </span>
                </div>

                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                  {entry.content}
                </p>

                <div className="mt-4 flex items-center gap-4 border-t border-border pt-3">
                  <button
                    onClick={() => void toggleLike(entry.id)}
                    className={`flex items-center gap-1.5 text-sm font-medium transition ${
                      likedByMe[entry.id] ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <HeartIcon filled={!!likedByMe[entry.id]} />
                    {likeCounts[entry.id] ?? 0}
                  </button>
                  <span className="text-sm text-muted-foreground">
                    {t('留言')} · {(comments[entry.id] ?? []).length}
                  </span>
                </div>

                {(comments[entry.id] ?? []).length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {(comments[entry.id] ?? []).map((c) => (
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
                    value={drafts[entry.id] ?? ''}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [entry.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitComment(entry.id)
                    }}
                    placeholder={t('寫下留言…')}
                    className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                  />
                  <button
                    onClick={() => void submitComment(entry.id)}
                    disabled={!(drafts[entry.id] ?? '').trim()}
                    className="rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
                  >
                    {t('送出')}
                  </button>
                </div>
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
