import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { mdToHtml } from '../lib/mdToHtml'
import { COACH_VIZ_CSS } from '../lib/coachVizCss'
import { downloadReportPdf } from '../lib/exportPdf'
import { CHART_DEFS, ReportChart, type BaselineScores } from '../components/ReportChart'
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    const el = document.getElementById('member-report-doc')
    if (!el) return
    setDownloading(true)
    try {
      await downloadReportPdf(el, 'PERMA-Review.pdf')
    } finally {
      setDownloading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid) {
        if (!cancelled) setLoading(false)
        return
      }
      const [{ data: rows }, { data: profile }] = await Promise.all([
        supabase
          .from('member_reports')
          .select('id, week_start, week_number, body_md, charts, sessions, baseline, created_at')
          .eq('user_id', uid)
          .order('week_number', { ascending: false }),
        supabase.from('profiles').select('display_name').eq('id', uid).single(),
      ])
      if (cancelled) return
      const list = (rows as MemberReport[] | null) ?? []
      setReports(list)
      setSelectedId(list[0]?.id ?? null)
      setDisplayName(profile?.display_name ?? '')
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const selected = reports.find((r) => r.id === selectedId) ?? null

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-8">
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      </div>
    )
  }

  if (reports.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-heading mb-2 text-xl text-foreground">{t('我的報告')}</h1>
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

      {/* 週次切換：最新的排最前面 */}
      {reports.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {reports.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                r.id === selectedId
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-foreground-soft hover:bg-muted'
              }`}
            >
              {t('第 {n} 週', { n: r.week_number })}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="mb-4 flex justify-end">
          <button
            onClick={() => void handleDownload()}
            disabled={downloading}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground-soft transition hover:bg-muted disabled:opacity-50"
          >
            {downloading ? t('產生中…') : t('下載 PDF')}
          </button>
        </div>
      )}

      {selected && (
        <div className="cv-doc" id="member-report-doc">
          <div className="cv-doc-head">
            <div className="cv-doc-title">{t('個人福祉回顧')}</div>
            <div className="cv-doc-meta">
              {displayName}　·　{t('第 {n} 週', { n: selected.week_number })}　·
              {formatDate(selected.created_at, language)}
            </div>
          </div>

          <div dangerouslySetInnerHTML={{ __html: mdToHtml(selected.body_md) }} />

          {CHART_DEFS.some((c) => selected.charts?.[c.key]) && (
            <div className="cv-doc-charts">
              {CHART_DEFS.filter((c) => selected.charts?.[c.key]).map((c, idx) => (
                <div key={c.key} className="cv-doc-chart">
                  {idx === 0 && <h2 className="cv-doc-chart-h">{t('情緒歷程一覽')}</h2>}
                  <div className="cv-slbl">
                    <span>{t(c.title)}</span>
                  </div>
                  <ReportChart chartKey={c.key} sessions={selected.sessions} baseline={selected.baseline} />
                </div>
              ))}
            </div>
          )}

          <div className="cv-doc-sign">{t('教練　陳郁敏')}</div>
        </div>
      )}
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
