import { useEffect, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { mdToHtml } from '../lib/mdToHtml'
import { COACH_VIZ_CSS } from '../lib/coachVizCss'
import { downloadReportPdf } from '../lib/exportPdf'
import { CHART_DEFS, ReportChart, type BaselineScores } from '../components/ReportChart'
import { requestWeeklyReport } from '../lib/memberReport'
import { programWeekNumber, needsCoachReview } from '../lib/week'
import type { SessionScore } from '../lib/coachViz'

export const Route = createFileRoute('/app/report')({
  component: ReportPage,
})

// 學員版報告：內容與排版沿用教練後台的「客戶交付版」，由 member_reports 讀出
// （見遷移 008）。第 4、8 週的報告要教練確認後才會出現在這裡。
interface MemberReport {
  id: string
  week_start: string
  week_number: number
  body_md: string
  charts: Record<string, boolean>
  sessions: SessionScore[]
  baseline: BaselineScores | null
  created_at: string
}

function ReportPage() {
  const { t, language } = useLanguage()
  const [loading, setLoading] = useState(true)
  const [reports, setReports] = useState<MemberReport[]>([])
  // 每一週各自可收合，像教練後台的區塊一樣；預設只展開最新一週。
  const [openIds, setOpenIds] = useState<string[]>([])
  const [displayName, setDisplayName] = useState('')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  // 有寫週記、卻還沒有對應報告的週次（最新的排前面）。
  // 正常情況下報告會在發布當下自動產生，這裡是萬一自動觸發失敗時的補救管道，
  // 不是預期中每次都要用到的步驟。
  const [missingWeeks, setMissingWeeks] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  // 缺報告時先安靜地自動輪詢一段時間（報告很可能正在背景產生中），
  // 不需要使用者自己按或重新整理；輪詢逾時才顯示手動補救按鈕。
  const [autoChecking, setAutoChecking] = useState(false)
  const [pollTimedOut, setPollTimedOut] = useState(false)
  const pollAttempts = useRef(0)

  const handleGenerate = async () => {
    const week = missingWeeks[0]
    if (!week) return
    setGenerating(true)
    setGenError(null)
    const ok = await requestWeeklyReport(week)
    if (ok) {
      await load()
    } else {
      setGenError(t('產生報告時發生問題，請稍後再試一次。'))
    }
    setGenerating(false)
  }

  const handleDownload = async (reportId: string) => {
    const el = document.getElementById(`member-report-doc-${reportId}`)
    if (!el) return
    setDownloadingId(reportId)
    try {
      await downloadReportPdf(el, 'PERMA-Review.pdf')
    } finally {
      setDownloadingId(null)
    }
  }

  function toggleOpen(id: string) {
    setOpenIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  async function load() {
    const { data: userData } = await supabase.auth.getUser()
    const uid = userData.user?.id
    if (!uid) {
      setLoading(false)
      return
    }
    const [{ data: rows }, { data: profile }, { data: posts }] = await Promise.all([
      supabase
        .from('member_reports')
        .select('id, week_start, week_number, body_md, charts, sessions, baseline, created_at')
        .eq('user_id', uid)
        .order('week_number', { ascending: false }),
      supabase.from('profiles').select('display_name').eq('id', uid).single(),
      supabase.from('journal_posts').select('week_start').eq('user_id', uid),
    ])

    const list = (rows as MemberReport[] | null) ?? []
    setReports(list)
    // 只展開最新一週；如果使用者已經手動展開過其他週次，保留那些狀態不動。
    setOpenIds((prev) => (prev.length > 0 ? prev : list[0] ? [list[0].id] : []))
    setDisplayName(profile?.display_name ?? '')

    // 有週記卻沒報告的週次。注意 member_reports 對學員只看得到 published，
    // 所以第 4、8 週的草稿在這裡也會被算成「缺少」——那是教練還沒發布，
    // 不該讓學員自己觸發，因此排除掉。
    const doneWeeks = new Set(list.map((r) => r.week_start))
    const journalWeeks = [...new Set(((posts as { week_start: string }[] | null) ?? []).map((p) => p.week_start))]
    const missing = journalWeeks
      .filter((w) => !doneWeeks.has(w) && programWeekNumber(w) >= 1 && !needsCoachReview(programWeekNumber(w)))
      .sort((a, b) => b.localeCompare(a))
    setMissingWeeks(missing)
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  // 有缺報告的週次時，每 5 秒重查一次（純讀取，不呼叫 AI、不花錢），
  // 最多輪詢 90 秒；報告在這段時間內自動出現就直接顯示，不逾時不會出現按鈕。
  const hasMissing = missingWeeks.length > 0
  useEffect(() => {
    if (!hasMissing || pollTimedOut) {
      setAutoChecking(false)
      return
    }
    pollAttempts.current = 0
    setAutoChecking(true)
    const MAX_ATTEMPTS = 18
    const id = window.setInterval(() => {
      pollAttempts.current += 1
      if (pollAttempts.current >= MAX_ATTEMPTS) {
        window.clearInterval(id)
        setAutoChecking(false)
        setPollTimedOut(true)
        return
      }
      void load()
    }, 5000)
    return () => window.clearInterval(id)
  }, [hasMissing, pollTimedOut])

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-8">
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      </div>
    )
  }

  // 有週記待產生報告時的面板：安靜的補救入口，不是預期中的必經步驟。
  const generatePanel = missingWeeks.length > 0 && (
    <div className="mb-5 rounded-xl border border-gold/45 bg-gold/10 p-5 text-center">
      {autoChecking && !pollTimedOut ? (
        // 安靜輪詢中：不需要使用者按任何東西，報告出現時這個區塊會自動消失。
        <div className="flex items-center justify-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm leading-relaxed text-foreground-soft">
            {t('第 {n} 週的報告正在自動產生中，通常一分鐘內完成。', {
              n: programWeekNumber(missingWeeks[0]),
            })}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-foreground-soft">
            {t('你第 {n} 週的記錄還沒產生報告。', { n: programWeekNumber(missingWeeks[0]) })}
          </p>
          <button
            onClick={() => void handleGenerate()}
            disabled={generating}
            className="mt-3 inline-flex h-11 items-center justify-center rounded-lg bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow disabled:opacity-50"
          >
            {generating ? t('產生中，大約需要一分鐘…') : t('產生我的報告')}
          </button>
          {generating && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('請先不要關閉這個頁面。')}</p>
          )}
          {genError && <p className="mt-2 text-sm leading-relaxed text-rust">{genError}</p>}
        </>
      )}
    </div>
  )

  if (reports.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-heading mb-2 text-xl text-foreground">{t('我的報告')}</h1>
        {generatePanel}
        {missingWeeks.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-6 text-center shadow-soft">
            <p className="text-sm leading-relaxed text-foreground-soft">
              {t('完成本週的 PERMA 記錄後，這裡就會出現你的個人報告。')}
            </p>
            <Link
              to="/app/journal"
              className="mt-4 inline-flex h-11 items-center justify-center rounded-lg bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-glow"
            >
              {t('開始記錄')}
            </Link>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <style>{COACH_VIZ_CSS}</style>

      <h1 className="font-heading mb-1 text-xl text-foreground">{t('我的報告')}</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        {t('每次完成記錄後，這裡會多一份屬於你的回顧。')}
      </p>

      {generatePanel}

      {/* 全部週次都在這一頁，各自可收合展開——不用切換分頁。 */}
      <div className="flex flex-col gap-3">
        {reports.map((r, idx) => {
          const open = openIds.includes(r.id)
          return (
            <article key={r.id} className="cv-block">
              <button
                type="button"
                className="cv-block-hd w-full text-left"
                onClick={() => toggleOpen(r.id)}
              >
                <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
                  ▶
                </span>
                <span className="cv-block-title">
                  {t('第 {n} 週', { n: r.week_number })}　·　{formatDate(r.created_at, language)}
                </span>
                {idx === 0 && <span className="cv-block-tag">{t('最新')}</span>}
              </button>
              {open && (
                <div className="cv-block-body">
                  <div className="mb-4 flex justify-end">
                    <button
                      onClick={() => void handleDownload(r.id)}
                      disabled={downloadingId === r.id}
                      className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground-soft transition hover:bg-muted disabled:opacity-50"
                    >
                      {downloadingId === r.id ? t('產生中…') : t('下載 PDF')}
                    </button>
                  </div>

                  <div className="cv-doc" id={`member-report-doc-${r.id}`}>
                    <div className="cv-doc-head">
                      <div className="cv-doc-title">{t('個人福祉回顧')}</div>
                      <div className="cv-doc-meta">
                        {displayName}　·　{t('第 {n} 週', { n: r.week_number })}　·
                        {formatDate(r.created_at, language)}
                      </div>
                    </div>

                    <div dangerouslySetInnerHTML={{ __html: mdToHtml(r.body_md) }} />

                    {CHART_DEFS.some((c) => r.charts?.[c.key]) && (
                      <div className="cv-doc-charts">
                        {CHART_DEFS.filter((c) => r.charts?.[c.key]).map((c, i) => (
                          <div key={c.key} className="cv-doc-chart">
                            {i === 0 && <h2 className="cv-doc-chart-h">{t('情緒歷程一覽')}</h2>}
                            <div className="cv-slbl">
                              <span>{t(c.title)}</span>
                            </div>
                            <ReportChart chartKey={c.key} sessions={r.sessions} baseline={r.baseline} />
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="cv-doc-sign">{t('教練　Yee Ming Tan')}</div>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}

function formatDate(iso: string, language: string): string {
  return new Date(iso).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-TW', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
