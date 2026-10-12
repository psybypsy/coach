import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'
import {
  KEYS,
  DIM,
  DIMCOLOR,
  vColor,
  vLabel,
  type SessionScore,
  type DimKey,
} from '../lib/coachViz'
import { mdToHtml } from '../lib/mdToHtml'
import { COACH_VIZ_CSS } from '../lib/coachVizCss'
import { rasterizeExportSvgs, downloadReportPdf } from '../lib/exportPdf'
import {
  CHART_DEFS,
  ReportChart,
  makeBaselineSession,
  type BaselineScores,
} from '../components/ReportChart'

export const Route = createFileRoute('/app/coach/member/$id')({
  component: MemberDetailPage,
})

const API_BASE = import.meta.env.VITE_API_BASE as string

interface EntryRow {
  id: string
  dimension: DimensionKey
  content: string
  is_public: boolean
  created_at: string
}

interface JournalPost {
  id: string
  week_start: string
  created_at: string
  p_content: string | null
  e_content: string | null
  r_content: string | null
  m_content: string | null
  a_content: string | null
}

interface BriefBlock {
  title: string
  body: string
  include: boolean
  custom?: boolean // 由教練自訂框架生成的區塊
}

interface FwDimension {
  name: string
  look_for: string
  evidence_rule: string
}

interface Framework {
  name: string
  basis: string
  lens: string
  dimensions: FwDimension[]
  references: string[]
  note: string
}

// T0 基準點（BaselineScores）與圖表繪製都放在 components/ReportChart，
// 與學員版報告共用同一份程式碼（見遷移 005 / 007）。

interface CoachAnalysis {
  member_id: string
  based_on: number
  sessions: SessionScore[]
  blocks: BriefBlock[]
  client_charts: Record<string, boolean>
  client_text: string | null
  client_date: string | null
  // 英文分析的翻譯快取（見遷移 003）：預設英文，教練點「中文」時即時翻譯並存這裡
  translations?: Record<string, { blocks: BriefBlock[]; sessions: SessionScore[] }>
  baseline?: BaselineScores | null
  updated_at: string
}

// 學員版報告（見遷移 008）。第 4、8 週為 pending_coach 草稿，教練確認後才發布。
interface MemberReportRow {
  id: string
  week_start: string
  week_number: number
  status: 'published' | 'pending_coach'
  body_md: string
  charts: Record<string, boolean>
  sessions: SessionScore[]
  baseline: BaselineScores | null
  created_at: string
  published_at: string | null
}

// 每月（里程碑）PERMA 報告（見遷移 009）：第 4 週回顧第 1–4 週、第 8 週回顧
// 第 1–8 週，與 T0 基準比較。僅教練端閱讀，不寄給學員，不受發布流程影響。
interface MonthlyPermaReport {
  member_id: string
  milestone_week: number
  weeks_covered: number
  week_start_from: string | null
  week_start_to: string | null
  content: {
    baseline: BaselineScores | null
    sessions: SessionScore[]
    blocks: BriefBlock[]
    scope: string
    // 第 8 週才有：要寄給學員本人的 8 週回顧（人工整理後放進來），
    // 以及教練對它的回饋。重新生成月報告時後端會保留這兩欄（_MONTHLY_CURATED_KEYS）。
    client_report?: { body_md: string; updated_at?: string } | null
    coach_feedback?: CoachFeedback | null
  }
}

// message 會原文放進寄給學員的報告；note 是給整理者的備註，學員看不到。
interface CoachFeedback {
  message: string
  note: string
  updated_at: string
}

function isEightWeekReview(report: MonthlyPermaReport): boolean {
  return report.milestone_week === 8 && !!report.content?.client_report?.body_md
}

function formatWritingDate(iso: string, language: string): string {
  return new Date(iso).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-TW', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  })
}

function formatSavedTime(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language === 'en' ? 'en-US' : 'zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 已從產品移除的舊情報模組。舊資料庫列可能仍保留這些 block，
// 因此前端需同步過濾，避免它們再次出現在畫面或 Client Version。
const REMOVED_BLOCK_TITLES = new Set([
  'cross-cutting themes & patterns',
  '橫向主題與模式',
  'the unsaid',
  '未言之事',
  'coaching hypotheses',
  '教練假設',
  'worth watching',
  '值得關注',
  'session preparation',
  '會談準備',
])

function isRemovedBlock(block: BriefBlock): boolean {
  return REMOVED_BLOCK_TITLES.has(String(block.title || '').trim().toLowerCase())
}

function isLinguisticFingerprint(block: BriefBlock): boolean {
  return ['linguistic fingerprint', '語言指紋'].includes(String(block.title || '').trim().toLowerCase())
}


interface NavItem {
  id: string
  label: string
  indent?: boolean
}

// 左側章節導覽：sticky 側欄，點擊平滑捲動、依捲動位置自動高亮目前章節
function ReportNav({ items, active }: { items: NavItem[]; active: string }) {
  if (items.length === 0) return null
  return (
    <nav className="cv-toc" aria-label="report sections">
      {items.map((it) => (
        <a
          key={it.id}
          href={`#${it.id}`}
          className={`cv-toc-link ${it.indent ? 'cv-toc-sub' : ''} ${active === it.id ? 'active' : ''}`}
          onClick={(e) => {
            e.preventDefault()
            document.getElementById(it.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
        >
          {it.label}
        </a>
      ))}
    </nav>
  )
}

// #6 可收合的 section 標題（點整行展開／收合，帶旋轉三角）
function SectionHeading({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <h2
      className="mb-2 flex cursor-pointer select-none items-center gap-2 text-sm font-semibold text-foreground-soft"
      onClick={onToggle}
    >
      <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
        ▶
      </span>
      {children}
    </h2>
  )
}


function MemberDetailPage() {
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const { id } = Route.useParams()
  const [checking, setChecking] = useState(true)
  const [name, setName] = useState('')
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [posts, setPosts] = useState<JournalPost[]>([])
  const [analysis, setAnalysis] = useState<CoachAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'analyze' | 'client' | 'translate' | 'framework' | null>(null)
  // 自訂分析框架：描述 → AI 生成可編輯的框架草稿 → 用它分析
  const [fwDesc, setFwDesc] = useState('')
  const [fwDraft, setFwDraft] = useState<Framework | null>(null)
  // 教練簡報內文顯示語言：預設英文（原生生成語言）；中文為即時翻譯的快取版
  const [briefLang, setBriefLang] = useState<'en' | 'zh-TW'>('zh-TW')
  // 子項目預設全收起（外層三大區塊維持展開）：記的是「明確展開」的項目，空陣列＝全部收起
  const [openRows, setOpenRows] = useState<number[]>([])
  const [openBlocks, setOpenBlocks] = useState<number[]>([])
  const [openActionPreview, setOpenActionPreview] = useState(false)
  // 圖表模塊預設收起；展開的 key 記在這裡（#6：所有模塊都可展開／收合）
  const [openCharts, setOpenCharts] = useState<string[]>([])
  // #6 最外層三個大 section 也可展開／收合，預設全展開
  const [openSections, setOpenSections] = useState({ deep: true, client: true, timeline: true })
  const [editBlock, setEditBlock] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  // 客戶交付版可直接行內編輯（存進 coach_analyses.client_text）
  const [editClient, setEditClient] = useState(false)
  const [clientEditText, setClientEditText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  // 左側章節導覽：目前捲動到哪個章節
  const [activeNav, setActiveNav] = useState('')
  // 學員版報告（見遷移 008）：第 4、8 週產生的是草稿，要教練確認後才發布給學員
  const [memberReports, setMemberReports] = useState<MemberReportRow[]>([])
  const [editReportId, setEditReportId] = useState<string | null>(null)
  const [reportEditText, setReportEditText] = useState('')
  const [publishingReport, setPublishingReport] = useState<string | null>(null)
  // 每月（里程碑）PERMA 報告（見遷移 009）：第 4／8 週跨週回顧，僅教練閱讀
  const [monthlyReports, setMonthlyReports] = useState<MonthlyPermaReport[]>([])
  const [monthlyBusy, setMonthlyBusy] = useState(false)
  const [openMonthly, setOpenMonthly] = useState<number[]>([])
  // 月報告專用的自訂分析框架：key 用里程碑週數（4 或 8），與教練情報簡報那組
  // （fwDesc / fwDraft，單一值）分開，避免月報告的草稿互相覆蓋。
  const [monthlyFwDesc, setMonthlyFwDesc] = useState<Record<number, string>>({})
  const [monthlyFwDraft, setMonthlyFwDraft] = useState<Record<number, Framework | null>>({})
  const [monthlyFwBusy, setMonthlyFwBusy] = useState<string | null>(null)
  // 學員版 8 週回顧的教練回饋：fbSaved 是後端最後一次存下的版本，用來判斷有沒有未儲存的修改
  const [fbMessage, setFbMessage] = useState('')
  const [fbNote, setFbNote] = useState('')
  const [fbSaved, setFbSaved] = useState<CoachFeedback | null>(null)
  const [fbSaving, setFbSaving] = useState(false)
  const [fbError, setFbError] = useState(false)
  const eightWeekReview = monthlyReports.find(isEightWeekReview) ?? null
  const fbDirty = fbMessage !== (fbSaved?.message ?? '') || fbNote !== (fbSaved?.note ?? '')
  // 回饋可能寫得很長，離開頁面前提醒還沒儲存
  useEffect(() => {
    if (!fbDirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [fbDirty])
  // 報告裡的「第 N 次」依實際書寫時間編號，這裡的順序要一致
  const writings = useMemo(
    () => [...posts].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [posts],
  )
  // T0 基準點：五面向 0–10 輸入（字串以容許暫時空白），存進 coach_analyses.baseline
  const emptyBaselineDraft: Record<DimKey, string> = { P: '', E: '', R: '', M: '', A: '' }
  const [baselineDraft, setBaselineDraft] = useState<Record<DimKey, string>>(emptyBaselineDraft)
  const [savingBaseline, setSavingBaseline] = useState(false)
  // 教練一進頁就讓後端檢查縱向分析有沒有落後；落後就在背景補跑（不必按按鈕）。
  // autoAnalyzing 代表「背景正在跑」，此時前端輪詢 coach_analyses 等新結果。
  const [autoAnalyzing, setAutoAnalyzing] = useState(false)
  // 輪詢的「這一輪」序號：換成別的成員或離開頁面時遞增，讓還在跑的舊輪迴圈自己結束。
  // 少了它，從 A 切到 B 時 A 的輪詢會用舊的 id 讀回資料、把 B 的分析蓋成 A 的。
  const analysisRunRef = useRef(0)
  useEffect(
    () => () => {
      analysisRunRef.current += 1
    },
    [],
  )
  // 五項都是 0–10 的有效數字才成立；否則視為未設定（圖表不套 T0）
  const baseline = useMemo<BaselineScores | null>(() => {
    const nums = {} as BaselineScores
    for (const k of KEYS) {
      const raw = baselineDraft[k].trim()
      const n = Number(raw)
      if (raw === '' || Number.isNaN(n) || n < 0 || n > 10) return null
      nums[k] = n
    }
    return nums
  }, [baselineDraft])

  useEffect(() => {
    void guardAndLoad()
  }, [id])

  const hasDeepAnalysis = !!analysis && analysis.sessions.length > 0
  const navItems = useMemo(() => {
    const items: NavItem[] = [
      ...(eightWeekReview ? [{ id: 'sec-eight-week', label: t('8 週回顧（學員版）') }] : []),
      { id: 'sec-baseline', label: t('T0 基準點') },
      { id: 'sec-deep', label: t('教練深度分析') },
    ]
    if (hasDeepAnalysis) {
      items.push({ id: 'sec-charts', label: t('圖表'), indent: true })
      items.push({ id: 'sec-blocks', label: t('教練情報簡報'), indent: true })
      items.push({ id: 'sec-framework', label: t('自訂分析框架'), indent: true })
      items.push({ id: 'sec-client', label: t('客戶交付版') })
    }
    if (memberReports.length > 0) {
      items.push({ id: 'sec-member-reports', label: t('學員版報告') })
    }
    if (posts.length > 0) {
      items.push({ id: 'sec-monthly-reports', label: t('每月 PERMA 報告') })
    }
    items.push({ id: 'sec-timeline', label: t('書寫時間軸') })
    return items
  }, [eightWeekReview, hasDeepAnalysis, memberReports.length, posts.length, t])

  // 依捲動位置自動高亮側欄目前章節（進入視窗上方 35% 區帶即視為目前章節）
  useEffect(() => {
    const els = navItems.map((n) => document.getElementById(n.id)).filter((el): el is HTMLElement => !!el)
    if (!els.length) return
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length > 0) {
          const top = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b))
          setActiveNav(top.target.id)
        }
      },
      { rootMargin: '0px 0px -65% 0px', threshold: 0 },
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [navItems])

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
    void ensureAnalysisFresh()
  }

  // 縱向分析落後就讓後端在背景補跑，跑完自動把新結果換上——教練不必按「重新生成分析」。
  // 學員端的自動觸發（/api/member/report、Supabase webhook）有可能一次都沒跑到
  //（webhook 沒設、學員寫完就關分頁、後端當時在重啟），這是最後一道保險。
  async function ensureAnalysisFresh() {
    const run = (analysisRunRef.current += 1)
    try {
      const resp = await authFetch('/api/coach/ensure-analysis', { member_id: id })
      if (!resp.ok || analysisRunRef.current !== run) return
      const state = (await resp.json()) as { weeks: number; based_on: number; refreshing: boolean }
      if (!state.refreshing) return
      setAutoAnalyzing(true)
      // 整份縱向分析約要半分鐘；每 10 秒回讀一次，最多等 5 分鐘。
      // 逾時就放棄輪詢（分析可能仍在跑），教練重新整理或按按鈕都能拿到結果。
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 10_000))
        if (analysisRunRef.current !== run) return
        const { data } = await supabase
          .from('coach_analyses')
          .select('*')
          .eq('member_id', id)
          .maybeSingle()
        const row = (data as unknown as CoachAnalysis) ?? null
        if (row && (row.sessions?.length ?? 0) > 0 && (row.based_on ?? 0) >= state.weeks) {
          setAnalysis(row)
          setBriefLang('zh-TW') // 新內容、舊翻譯已作廢
          break
        }
      }
    } catch {
      // 純粹是保險機制，失敗不該干擾教練看頁面
    } finally {
      if (analysisRunRef.current === run) setAutoAnalyzing(false)
    }
  }

  async function load() {
    setLoading(true)
    const [
      { data: profile },
      { data: entryRows },
      { data: postRows },
      { data: analysisRow },
      { data: reportRows },
      { data: monthlyRows },
    ] = await Promise.all([
      supabase.from('profiles').select('display_name').eq('id', id).single(),
      supabase
        .from('perma_entries')
        .select('id,dimension,content,is_public,created_at')
        .eq('user_id', id)
        .order('created_at', { ascending: false }),
      supabase
        .from('journal_posts')
        .select('id,week_start,created_at,p_content,e_content,r_content,m_content,a_content')
        .eq('user_id', id)
        .order('week_start', { ascending: true }),
      supabase.from('coach_analyses').select('*').eq('member_id', id).maybeSingle(),
      supabase
        .from('member_reports')
        .select('*')
        .eq('user_id', id)
        .order('week_number', { ascending: false }),
      supabase
        .from('perma_monthly_reports')
        .select('*')
        .eq('member_id', id)
        .order('milestone_week', { ascending: true }),
    ])
    setName(profile?.display_name ?? '')
    setEntries((entryRows as unknown as EntryRow[]) ?? [])
    setPosts((postRows as unknown as JournalPost[]) ?? [])
    setMemberReports((reportRows as unknown as MemberReportRow[]) ?? [])
    const monthly = (monthlyRows as unknown as MonthlyPermaReport[]) ?? []
    setMonthlyReports(monthly)
    const feedback = monthly.find(isEightWeekReview)?.content.coach_feedback ?? null
    setFbSaved(feedback)
    setFbMessage(feedback?.message ?? '')
    setFbNote(feedback?.note ?? '')
    setFbError(false)
    const row = (analysisRow as unknown as CoachAnalysis) ?? null
    setAnalysis(row)
    const b = row?.baseline
    setBaselineDraft(
      b ? (Object.fromEntries(KEYS.map((k) => [k, String(b[k] ?? '')])) as Record<DimKey, string>) : emptyBaselineDraft,
    )
    setLoading(false)
  }

  // ── 學員版報告：第 4、8 週的草稿要教練確認後才發布 ──
  async function saveReportEdit(reportId: string) {
    const { error } = await supabase
      .from('member_reports')
      .update({ body_md: reportEditText })
      .eq('id', reportId)
    if (error) {
      setMessage(t('儲存失敗，請確認已在 Supabase 執行遷移 008'))
      return
    }
    setMemberReports((prev) =>
      prev.map((r) => (r.id === reportId ? { ...r, body_md: reportEditText } : r)),
    )
    setEditReportId(null)
    setMessage(t('已儲存報告內容'))
  }

  // 走後端而非直接改資料庫：發布的同時要把報告 email 寄給學員，
  // 而寄信需要 service_role 才讀得到對方的 email，前端做不到。
  async function publishReport(reportId: string) {
    setPublishingReport(reportId)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/publish-report', { report_id: reportId })
      if (!resp.ok) {
        setMessage(t('發布失敗，請再試一次。'))
        return
      }
      const saved = (await resp.json()) as { published_at: string; emailed?: boolean }
      setMemberReports((prev) =>
        prev.map((r) =>
          r.id === reportId
            ? { ...r, status: 'published' as const, published_at: saved.published_at }
            : r,
        ),
      )
      setMessage(saved.emailed ? t('已發布給學員，並寄出報告 email') : t('已發布給學員'))
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setPublishingReport(null)
    }
  }

  // 走後端：perma_monthly_reports 對前端只開放讀取
  async function saveFeedback() {
    setFbSaving(true)
    setFbError(false)
    try {
      const resp = await authFetch('/api/coach/monthly-reports/feedback', {
        member_id: id,
        milestone_week: 8,
        message: fbMessage,
        note: fbNote,
      })
      if (!resp.ok) {
        setFbError(true)
        return
      }
      const { coach_feedback } = (await resp.json()) as { coach_feedback: CoachFeedback }
      setFbSaved(coach_feedback)
      // 後端會去掉頭尾空白，畫面上的內容跟著對齊，才不會一存完又顯示「未儲存」
      setFbMessage(coach_feedback.message)
      setFbNote(coach_feedback.note)
      setMonthlyReports((prev) =>
        prev.map((r) => (isEightWeekReview(r) ? { ...r, content: { ...r.content, coach_feedback } } : r)),
      )
    } catch {
      setFbError(true)
    } finally {
      setFbSaving(false)
    }
  }

  async function reloadMonthlyReports() {
    const { data } = await supabase
      .from('perma_monthly_reports')
      .select('*')
      .eq('member_id', id)
      .order('milestone_week', { ascending: true })
    setMonthlyReports((data as unknown as MonthlyPermaReport[]) ?? [])
  }

  // 生成（或重新生成）第 4 週、第 8 週的跨週回顧；僅教練閱讀，不寄信
  async function generateMonthlyReports() {
    if (!baseline) {
      setMessage(t('請把 T0 的五個面向都填 0–10 的分數'))
      return
    }
    setMonthlyBusy(true)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/monthly-reports/generate', { member_id: id })
      if (resp.ok) {
        await reloadMonthlyReports()
        setOpenMonthly((prev) => Array.from(new Set([...prev, 4, 8])))
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setMonthlyBusy(false)
    }
  }

  // 月報告專用的自訂分析框架：描述 → AI 生成草稿 → 用它分析該里程碑涵蓋的週次
  async function genMonthlyFramework(milestone: number) {
    const description = (monthlyFwDesc[milestone] ?? '').trim()
    if (description.length < 4) {
      setMessage(t('請先描述你想分析什麼'))
      return
    }
    setMonthlyFwBusy(`gen-${milestone}`)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/framework/generate', { description, language })
      if (resp.ok) {
        const fw = (await resp.json()) as Partial<Framework>
        setMonthlyFwDraft((prev) => ({
          ...prev,
          [milestone]: {
            name: fw.name ?? '',
            basis: fw.basis ?? '',
            lens: fw.lens ?? '',
            dimensions: (fw.dimensions ?? []).map((d) => ({
              name: d?.name ?? '',
              look_for: d?.look_for ?? '',
              evidence_rule: d?.evidence_rule ?? '',
            })),
            references: fw.references ?? [],
            note: fw.note ?? '',
          },
        }))
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setMonthlyFwBusy(null)
    }
  }

  async function runMonthlyFrameworkAnalysis(milestone: number) {
    const draft = monthlyFwDraft[milestone]
    if (!draft) return
    const dims = draft.dimensions.filter((d) => d.name.trim())
    if (dims.length === 0) {
      setMessage(t('請至少保留一個維度'))
      return
    }
    setMonthlyFwBusy(`run-${milestone}`)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/monthly-reports/analyze-framework', {
        member_id: id,
        milestone_week: milestone,
        framework: { ...draft, dimensions: dims },
        language: 'zh-TW',
      })
      if (resp.ok) {
        await reloadMonthlyReports()
        setMonthlyFwDraft((prev) => ({ ...prev, [milestone]: null }))
        setMonthlyFwDesc((prev) => ({ ...prev, [milestone]: '' }))
        setOpenMonthly((prev) => (prev.includes(milestone) ? prev : [...prev, milestone]))
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setMonthlyFwBusy(null)
    }
  }

  function updateMonthlyFwDim(milestone: number, i: number, key: keyof FwDimension, val: string) {
    setMonthlyFwDraft((prev) => {
      const draft = prev[milestone]
      if (!draft) return prev
      return {
        ...prev,
        [milestone]: { ...draft, dimensions: draft.dimensions.map((d, j) => (j === i ? { ...d, [key]: val } : d)) },
      }
    })
  }
  function addMonthlyFwDim(milestone: number) {
    setMonthlyFwDraft((prev) => {
      const draft = prev[milestone]
      if (!draft) return prev
      return {
        ...prev,
        [milestone]: { ...draft, dimensions: [...draft.dimensions, { name: '', look_for: '', evidence_rule: '' }] },
      }
    })
  }
  function removeMonthlyFwDim(milestone: number, i: number) {
    setMonthlyFwDraft((prev) => {
      const draft = prev[milestone]
      if (!draft) return prev
      return { ...prev, [milestone]: { ...draft, dimensions: draft.dimensions.filter((_, j) => j !== i) } }
    })
  }

  // 儲存 T0 基準點：upsert coach_analyses（教練 RLS 允許 insert/update；分析未生成也可先存）
  async function saveBaseline() {
    if (!baseline) {
      setMessage(t('請把 T0 的五個面向都填 0–10 的分數'))
      return
    }
    setSavingBaseline(true)
    setMessage(null)
    const { error } = await supabase
      .from('coach_analyses')
      .upsert({ member_id: id, baseline }, { onConflict: 'member_id' })
    if (error) {
      setMessage(t('儲存失敗，請確認已在 Supabase 執行遷移 005（新增 baseline 欄）'))
    } else {
      setAnalysis((prev) => (prev ? { ...prev, baseline } : prev))
      setMessage(t('已儲存 T0 基準點'))
    }
    setSavingBaseline(false)
  }

  async function authFetch(path: string, body?: Record<string, unknown>) {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) throw new Error('未登入')
    return fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? { member_id: id, language }),
    })
  }

  async function runAnalyze() {
    setBusy('analyze')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/analyze')
      if (resp.ok) {
        setAnalysis((await resp.json()) as CoachAnalysis)
        setBriefLang('zh-TW') // 新內容、翻譯已作廢，回到原生繁中
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setBusy(null)
    }
  }

  // 切換教練簡報內文語言：繁中是原生生成語言，即時切；英文若無快取則呼叫後端翻譯一次
  async function switchBriefLang(target: 'en' | 'zh-TW') {
    if (target === 'zh-TW') {
      setBriefLang('zh-TW')
      return
    }
    if (analysis?.translations?.['en']) {
      setBriefLang('en')
      return
    }
    setBusy('translate')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/translate', { member_id: id, target: 'en' })
      if (resp.ok) {
        setAnalysis((await resp.json()) as CoachAnalysis)
        setBriefLang('en')
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setBusy(null)
    }
  }

  async function runClientReport() {
    setBusy('client')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/client-report')
      if (resp.ok) {
        setAnalysis((await resp.json()) as CoachAnalysis)
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setBusy(null)
    }
  }

  // 教練描述想分析什麼 → AI 上網找對應理論 → 生成可編輯的框架草稿
  async function genFramework() {
    const description = fwDesc.trim()
    if (description.length < 4) {
      setMessage(t('請先描述你想分析什麼'))
      return
    }
    setBusy('framework')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/framework/generate', { description, language })
      if (resp.ok) {
        const fw = (await resp.json()) as Partial<Framework>
        setFwDraft({
          name: fw.name ?? '',
          basis: fw.basis ?? '',
          lens: fw.lens ?? '',
          dimensions: (fw.dimensions ?? []).map((d) => ({
            name: d?.name ?? '',
            look_for: d?.look_for ?? '',
            evidence_rule: d?.evidence_rule ?? '',
          })),
          references: fw.references ?? [],
          note: fw.note ?? '',
        })
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setBusy(null)
    }
  }

  // 用教練確認後的框架，對成員週記生成一個情報簡報區塊，append 進既有分析
  async function runFrameworkAnalysis() {
    if (!fwDraft) return
    const dims = fwDraft.dimensions.filter((d) => d.name.trim())
    if (dims.length === 0) {
      setMessage(t('請至少保留一個維度'))
      return
    }
    setBusy('framework')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/analyze-framework', {
        member_id: id,
        framework: { ...fwDraft, dimensions: dims },
        language,
      })
      if (resp.ok) {
        setAnalysis((await resp.json()) as CoachAnalysis)
        setBriefLang('zh-TW') // 新增區塊、翻譯快取已作廢，回到原生繁中
        setFwDraft(null)
        setFwDesc('')
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('發布失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('發布失敗，請再試一次。'))
    } finally {
      setBusy(null)
    }
  }

  function updateFwDim(i: number, key: keyof FwDimension, val: string) {
    setFwDraft((prev) =>
      prev
        ? { ...prev, dimensions: prev.dimensions.map((d, j) => (j === i ? { ...d, [key]: val } : d)) }
        : prev,
    )
  }
  function addFwDim() {
    setFwDraft((prev) =>
      prev ? { ...prev, dimensions: [...prev.dimensions, { name: '', look_for: '', evidence_rule: '' }] } : prev,
    )
  }
  function removeFwDim(i: number) {
    setFwDraft((prev) => (prev ? { ...prev, dimensions: prev.dimensions.filter((_, j) => j !== i) } : prev))
  }

  function deleteBlock(i: number) {
    if (!analysis) return
    if (!window.confirm(t('確定要刪除這個區塊嗎？此動作無法復原。'))) return
    const blocks = analysis.blocks.filter((_, j) => j !== i)
    void persist({ blocks })
  }

  // 更新 coach_analyses（教練 RLS 允許）並同步本地狀態
  async function persist(patch: Partial<CoachAnalysis>) {
    if (!analysis) return
    const next = { ...analysis, ...patch }
    setAnalysis(next)
    await supabase.from('coach_analyses').update(patch).eq('member_id', id)
  }

  function toggleBlock(i: number, val: boolean) {
    if (!analysis) return
    const blocks = analysis.blocks.map((b, j) => (j === i ? { ...b, include: val } : b))
    void persist({ blocks })
  }

  function toggleChart(key: string, val: boolean) {
    if (!analysis) return
    void persist({ client_charts: { ...analysis.client_charts, [key]: val } })
  }

  // html2canvas 對 SVG 與網頁字型的載入時機較敏感。匯出前把 SVG 固定成同尺寸 PNG，
  // 避免同一份報告在不同瀏覽器／視窗寬度下發生裁切或比例漂移。
  // rasterizeExportSvgs / downloadReportPdf 已抽到 lib/exportPdf，與學員版報告共用。
  async function downloadClientPdf() {
    const source = document.getElementById('cv-print-area')
    if (!source) return
    await downloadReportPdf(source, 'Personal-Well-being-Review.pdf')
  }

  // 客戶版行內編輯：進入編輯 → 改文字 → 存回 client_text
  function startClientEdit() {
    if (!analysis?.client_text) return
    setClientEditText(analysis.client_text)
    setEditClient(true)
  }
  function saveClientEdit() {
    void persist({ client_text: clientEditText })
    setEditClient(false)
  }

  // #B 下載 Word：把客戶版 client_text（Markdown）轉成 .docx，方便教練在 Word 再修改。
  // 納入客戶版的圖表會用 html2canvas 截成圖片嵌入 Word。docx 動態載入，不進主 bundle。
  async function downloadClientWord() {
    if (!analysis?.client_text) return
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } = await import('docx')

    // 與 mdToHtml 同一個 Markdown 子集：## 標題、- 條列、** 粗體、* 斜體
    const inlineRuns = (s: string) => {
      const runs: InstanceType<typeof TextRun>[] = []
      const re = /\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(s))) {
        if (m.index > last) runs.push(new TextRun(s.slice(last, m.index)))
        if (m[1] !== undefined) runs.push(new TextRun({ text: m[1], bold: true }))
        else if (m[2] !== undefined) runs.push(new TextRun({ text: m[2], italics: true }))
        last = re.lastIndex
      }
      if (last < s.length) runs.push(new TextRun(s.slice(last)))
      if (runs.length === 0) runs.push(new TextRun(''))
      return runs
    }
    const bodyParagraphs = String(analysis.client_text || '')
      .split('\n')
      .flatMap((raw) => {
        const l = raw.trim()
        if (!l || l === '---') return [] // 空行與分隔線交給段落間距處理
        const hm = l.match(/^(#{1,3})\s+(.*)$/)
        if (hm) {
          const lvl = hm[1].length
          return [
            new Paragraph({
              children: inlineRuns(hm[2]),
              heading: lvl === 1 ? HeadingLevel.HEADING_1 : lvl === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
              spacing: { before: 240, after: 120 },
            }),
          ]
        }
        if (/^[-*]\s+/.test(l)) {
          return [new Paragraph({ children: inlineRuns(l.replace(/^[-*]\s+/, '')), bullet: { level: 0 }, spacing: { after: 80 } })]
        }
        return [new Paragraph({ children: inlineRuns(l), spacing: { after: 160 } })]
      })

    // 每張圖各自截一張圖片、各自一頁嵌入 Word（含其標題與雷達的 A/P/M/R/E 清單）。
    // 不能直接截畫面上的 SVG：部分瀏覽器會產生「尺寸正確但內容全白」的 canvas。
    // 因此先在固定寬度的離屏副本中把 SVG 光柵化，再截整個圖表。
    const chartParagraphs: InstanceType<typeof Paragraph>[] = []
    const chartEls = [...document.querySelectorAll('#cv-print-area .cv-doc-chart')] as HTMLElement[]
    if (chartEls.length) {
      const wordHost = document.createElement('div')
      // html2canvas 直接截這個副本，不能像 PDF host 一樣放到負十萬像素外，
      // 否則部分瀏覽器會回傳尺寸正確但全白的 canvas。放在畫面座標內、置於最底層即可。
      wordHost.style.cssText =
        'position:fixed;left:0;top:0;width:644px;background:#fff;z-index:-2147483647;pointer-events:none'
      document.body.appendChild(wordHost)
      try {
        const html2canvas = (await import('html2canvas')).default
        const maxW = 600 // A4 內文寬度上限（px）
        const maxH = 780 // A4 內文高度上限（px），確保一張圖不溢出到下一頁
        await document.fonts?.ready
        for (const el of chartEls) {
          const chartClone = el.cloneNode(true) as HTMLElement
          chartClone.classList.add('cv-word-export')
          wordHost.appendChild(chartClone)
          await rasterizeExportSvgs(chartClone)

          const capture = () =>
            html2canvas(chartClone, {
              scale: 2,
              backgroundColor: '#ffffff',
              useCORS: true,
              logging: false,
              foreignObjectRendering: false,
              windowWidth: 720,
            })
          const hasVisibleInk = (canvas: HTMLCanvasElement) => {
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            if (!ctx) return false
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let ink = 0
            // 每 8px 取樣；文字、框線或圖形任一存在都會遠超過 20 個非白點。
            for (let y = 0; y < canvas.height && ink <= 20; y += 8) {
              for (let x = 0; x < canvas.width && ink <= 20; x += 8) {
                const i = (y * canvas.width + x) * 4
                if (pixels[i + 3] > 20 && (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245)) ink++
              }
            }
            return ink > 20
          }

          let canvas = await capture()
          if (!hasVisibleInk(canvas)) {
            // 少數瀏覽器不繪製負 z-index 的目標；只在偵測到空白時短暫提到最上層重截。
            wordHost.style.zIndex = '2147483647'
            canvas = await capture()
            wordHost.style.zIndex = '-2147483647'
          }
          if (!hasVisibleInk(canvas)) throw new Error('Chart capture was blank')

          const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Unable to encode chart PNG'))), 'image/png'),
          )
          const buf = await blob.arrayBuffer()
          let w = Math.min(maxW, canvas.width / 2)
          let h = (canvas.height / canvas.width) * w
          if (h > maxH) {
            w = (w * maxH) / h
            h = maxH
          }
          chartParagraphs.push(
            new Paragraph({
              // 圖表區只在第一張前換頁；後續圖片依序流動，同頁放得下就接續排版。
              // Word 圖片本身不會被切成兩半，空間不足時會自動整張移到下一頁。
              pageBreakBefore: chartParagraphs.length === 0,
              spacing: { after: 180 },
              children: [new ImageRun({ type: 'png', data: buf, transformation: { width: Math.round(w), height: Math.round(h) } })],
            }),
          )
          chartClone.remove()
        }
      } catch (error) {
        console.error('Word chart export failed', error)
        // 截圖失敗就略過圖表，仍輸出文字版
      } finally {
        wordHost.remove()
      }
    }

    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 80 },
              children: [new TextRun({ text: t('個人福祉回顧'), bold: true, size: 40 })],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 320 },
              children: [new TextRun({ text: `${name}　·　${analysis.client_date ?? ''}`, size: 20, color: '54606E' })],
            }),
            ...bodyParagraphs,
            ...chartParagraphs,
            new Paragraph({
              spacing: { before: 400 },
              children: [new TextRun({ text: t('教練　Yee Ming Tan'), size: 22, color: '54606E' })],
            }),
          ],
        },
      ],
    })
    const blob = await Packer.toBlob(doc)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'Personal-Well-being-Review.docx'
    document.body.appendChild(a)
    a.click()
    // 部分瀏覽器若立即 revoke，會建立出大小正常但內容未完整寫入的檔案。
    window.setTimeout(() => {
      a.remove()
      URL.revokeObjectURL(url)
    }, 1000)
  }

  function toggleBlockOpen(i: number) {
    setOpenBlocks((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))
  }

  function toggleChartOpen(key: string) {
    setOpenCharts((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  function startEdit(i: number) {
    if (!analysis) return
    setEditBlock(i)
    setEditText(analysis.blocks[i].body)
  }

  function saveEdit() {
    if (!analysis || editBlock === null) return
    const blocks = analysis.blocks.map((b, j) => (j === editBlock ? { ...b, body: editText } : b))
    void persist({ blocks })
    setEditBlock(null)
  }


  const pendingReports = memberReports.filter((r) => r.status === 'pending_coach')

  if (checking) return null

  const visibleBlocks =
    analysis?.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => !isRemovedBlock(block)) ?? []
  const includedBlocks = visibleBlocks
    .filter(({ block }) => block.include || isLinguisticFingerprint(block))
    .map(({ block }) => block)
  const hasFutureActionsBlock =
    analysis?.blocks.some((block) =>
      ['actions for the next four weeks', '未來四週行動'].includes(String(block.title || '').trim().toLowerCase()),
    ) ?? false
  // 內文顯示語言：英文且有快取則用翻譯版，否則用原生繁中（依 index 對齊 canonical）
  const briefTr = briefLang === 'en' ? analysis?.translations?.['en'] : undefined
  const viewBlocks = briefTr?.blocks ?? analysis?.blocks ?? []
  const viewSessions = briefTr?.sessions ?? analysis?.sessions ?? []

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <style>{COACH_VIZ_CSS}</style>
      <Link to="/app/coach" className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground">
        ← {t('教練儀表板')}
      </Link>
      <h1 className="font-heading mb-6 text-xl text-foreground">{name}</h1>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      ) : (
        <div className="flex items-start gap-10">
          <ReportNav items={navItems} active={activeNav} />
          <div className="min-w-0 max-w-3xl flex-1">
          {message && (
            <p className="mb-4 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground-soft">
              {message}
            </p>
          )}

          {/* ── 學員版 8 週回顧：要寄給學員的初稿 + 歷次書寫原文 + 教練回饋，放最前面 ── */}
          {eightWeekReview && (
            <section className="mb-10" id="sec-eight-week">
              <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('8 週回顧（學員版）')}</h2>
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                {t('這是準備寄給學員本人的 8 週回顧初稿。讀完後，請在最下方「給學員的話」留一段話，會原文放進 PDF 的「教練給你的話」一節。')}
              </p>
              <article className="cv-block">
                <div className="cv-block-body">
                  <div
                    className="cv-md"
                    dangerouslySetInnerHTML={{ __html: mdToHtml(eightWeekReview.content.client_report?.body_md ?? '') }}
                  />
                </div>
              </article>

              <div className="cv-slbl" style={{ marginTop: 22 }}>
                <span>{t('{name} 寫下的文字', { name })}</span>
              </div>
              <p className="mb-2 text-xs text-muted-foreground">
                {t('報告裡的「第 N 次」對應這裡的編號，點開可以看原文。')}
              </p>
              <div className="flex flex-col gap-2">
                {writings.map((post, i) => (
                  <details key={post.id} className="cv-block cv-writing">
                    <summary className="cv-block-hd">
                      <span className="cv-caret">▶</span>
                      <span className="cv-block-title">
                        {t('第 {n} 次', { n: i + 1 })} · {formatWritingDate(post.created_at, language)}
                      </span>
                    </summary>
                    <div className="cv-block-body">
                      {KEYS.map((k) => (
                        <div key={k} className="mb-3 last:mb-0">
                          <div className="text-[11px] font-semibold" style={{ color: DIMCOLOR[k] }}>
                            {k} · {t(DIMENSION_CONFIGS[k].question)}
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                            {post[`${k.toLowerCase()}_content` as keyof JournalPost] || t('（未填）')}
                          </p>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>

              <div className="cv-slbl" style={{ marginTop: 22 }}>
                <span>{t('你的回饋')}</span>
              </div>
              <label className="mb-1 block text-xs font-semibold text-foreground-soft" htmlFor="fb-message">
                {t('給學員的話：寫給 {name}（會原文放進 PDF）', { name })}
              </label>
              <textarea
                id="fb-message"
                className="cv-textarea"
                rows={8}
                value={fbMessage}
                onChange={(e) => setFbMessage(e.target.value)}
                placeholder={t('例如：這 8 週我最想讓你記得的是……')}
              />
              <label className="mb-1 mt-3 block text-xs font-semibold text-foreground-soft" htmlFor="fb-note">
                {t('給整理者的備註（學員看不到，可留空）')}
              </label>
              <textarea
                id="fb-note"
                className="cv-textarea"
                rows={3}
                value={fbNote}
                onChange={(e) => setFbNote(e.target.value)}
                placeholder={t('例如：哪一段想修改、哪裡寫得不準確')}
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void saveFeedback()}
                  disabled={fbSaving || !fbDirty}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {fbSaving ? t('儲存中…') : t('儲存回饋')}
                </button>
                <span className="text-xs text-muted-foreground">
                  {fbError
                    ? t('儲存失敗，請再試一次。')
                    : fbDirty
                      ? t('有尚未儲存的修改')
                      : fbSaved?.updated_at
                        ? t('已儲存 · {time}', { time: formatSavedTime(fbSaved.updated_at, language) })
                        : t('還沒有留言')}
                </span>
              </div>
            </section>
          )}

          {/* ── T0 基準點（起始幸福感）：填在最前面，作為所有圖表的起點 ── */}
          <section className="mb-8" id="sec-baseline">
            <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('T0 基準點（起始幸福感）')}</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              {t('填入成員一開始（T0）的五面向幸福感分數（0–10）。填好後，下面的 valence 圖表都會以 T0 為起點；整體分數由五項自動平均。')}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              {KEYS.map((k) => (
                <label key={k} className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold" style={{ color: DIMCOLOR[k] }}>
                    {k} · {DIM[k]}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    inputMode="numeric"
                    value={baselineDraft[k]}
                    onChange={(e) => setBaselineDraft((p) => ({ ...p, [k]: e.target.value }))}
                    placeholder="0–10"
                    className="w-20 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground"
                  />
                </label>
              ))}
              <button
                onClick={saveBaseline}
                disabled={savingBaseline || !baseline}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {savingBaseline ? t('儲存中…') : t('儲存 T0 基準點')}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {baseline
                ? `${t('整體（自動平均）：')}${makeBaselineSession(baseline)!.overall > 0 ? '+' : ''}${makeBaselineSession(baseline)!.overall}`
                : t('五個面向都填 0–10 才會套用到圖表。')}
            </p>
          </section>

          {/* ── 教練深度分析 ── */}
          <section className="mb-8" id="sec-deep">
            <SectionHeading
              open={openSections.deep}
              onToggle={() => setOpenSections((p) => ({ ...p, deep: !p.deep }))}
            >
              {t('教練深度分析')}
            </SectionHeading>
            {openSections.deep && (
            <>
            <p className="mb-3 text-xs text-muted-foreground">
              {t('對每週回饋做情緒 valence 分析與情報簡報。')}
            </p>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <button
                onClick={runAnalyze}
                disabled={busy !== null || autoAnalyzing || posts.length < 1}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {busy === 'analyze' ? t('分析中…') : hasDeepAnalysis ? t('重新生成分析') : t('生成情緒分析與情報簡報')}
              </button>
              {/* 背景自動補跑中：按鈕停用，避免同一份分析被付兩次錢 */}
              {autoAnalyzing && (
                <span className="text-xs text-muted-foreground">
                  {t('偵測到新的一週，正在自動更新分析…（約半分鐘，完成後會自動顯示）')}
                </span>
              )}
              {/* 只填了 T0 基準點也會有 coach_analyses 列（based_on 預設 0），
                  拿它當「已分析」會顯示成「基於 0 週」，看起來像壞掉 —— 以 sessions 為準。 */}
              {hasDeepAnalysis && (
                <span className="text-xs text-muted-foreground">
                  {t('基於')} {analysis!.based_on} {t('週')}
                </span>
              )}
              {posts.length < 1 && (
                <span className="text-xs text-muted-foreground">{t('至少需要 1 次書寫')}</span>
              )}
              {posts.length > 0 && !hasDeepAnalysis && !autoAnalyzing && (
                <span className="text-xs text-muted-foreground">
                  {t('學員完成一週書寫後會自動生成，也可以按上方按鈕立即重跑。')}
                </span>
              )}
            </div>

            {analysis && analysis.sessions.length > 0 && (
              <>
                {/* 內文語言切換：預設繁中；點「EN」即時翻譯一次並快取，之後切換即時 */}
                <div className="mb-4 flex items-center justify-end gap-2">
                  <span className="text-xs text-muted-foreground">{t('內文語言')}</span>
                  <div className="inline-flex overflow-hidden rounded-md border border-border">
                    {(['zh-TW', 'en'] as const).map((lng) => (
                      <button
                        key={lng}
                        onClick={() => switchBriefLang(lng)}
                        disabled={busy === 'translate'}
                        className={`px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                          briefLang === lng
                            ? 'bg-primary text-primary-foreground'
                            : 'text-foreground-soft hover:bg-muted'
                        }`}
                      >
                        {lng === 'zh-TW' ? '中文' : busy === 'translate' ? t('翻譯中…') : 'EN'}
                      </button>
                    ))}
                  </div>
                </div>

                <div id="sec-charts">
                {CHART_DEFS.map((c) => {
                  const open = openCharts.includes(c.key)
                  return (
                  <div key={c.key} className="mb-4">
                    <div className="cv-slbl">
                      <span
                        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}
                        onClick={() => toggleChartOpen(c.key)}
                      >
                        <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
                          ▶
                        </span>
                        {t(c.title)}
                      </span>
                      <label className="cv-inc">
                        <input
                          type="checkbox"
                          checked={!!analysis.client_charts?.[c.key]}
                          onChange={(e) => toggleChart(c.key, e.target.checked)}
                        />
                        {t('納入客戶版')}
                      </label>
                    </div>
                    {open && (
                      <ReportChart chartKey={c.key} sessions={analysis.sessions} baseline={baseline} />
                    )}
                  </div>
                  )
                })}
                {/* 每次 valence 與評分理由：併入圖表清單，整塊當成清單裡的一項，預設收起 */}
                <div className="mb-4">
                  <div className="cv-slbl">
                    <span
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}
                      onClick={() => toggleChartOpen('sessions')}
                    >
                      <span
                        className="cv-caret"
                        style={{ transform: openCharts.includes('sessions') ? 'rotate(90deg)' : 'none' }}
                      >
                        ▶
                      </span>
                      {t('每次 valence 與評分理由')}
                    </span>
                  </div>
                  {openCharts.includes('sessions') &&
                    analysis.sessions.map((s, i) => {
                      const vs = viewSessions[i] ?? s // 數字用 canonical，文字用顯示語言版
                      const rowOpen = openRows.includes(i)
                      return (
                      <div key={i} className={`cv-vrow ${rowOpen ? 'open' : ''}`}>
                        <div
                          className="cv-vrow-hd"
                          onClick={() =>
                            setOpenRows((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))
                          }
                        >
                          <span className="cv-caret">▶</span>
                          <span className="cv-vrow-n">
                            {t('第')} {i + 1} {t('次')}
                          </span>
                          <span className="cv-vrow-date">{posts[i]?.week_start ?? ''}</span>
                          <span
                            className="cv-vbadge"
                            style={{ background: vColor(s.overall) + '20', color: vColor(s.overall) }}
                          >
                            {t('整體')} {s.overall > 0 ? '+' : ''}
                            {s.overall} · {vLabel(s.overall)}
                          </span>
                        </div>
                        {rowOpen && (
                          <div className="cv-vrow-body">
                            <div className="cv-vreason">
                              <strong>{t('整體評分理由。')}</strong>
                              {vs.overallReason}
                            </div>
                            {KEYS.map((k) => {
                              const dv = s.dims[k] || { v: 0, reason: '' }
                              const reason = vs.dims[k]?.reason ?? dv.reason
                              return (
                                <div key={k} className="cv-vdim">
                                  <span className="cv-vdim-key" style={{ background: DIMCOLOR[k] }}>
                                    {k}
                                  </span>
                                  <span className="cv-vdim-name">{DIM[k]}</span>
                                  <span className="cv-vdim-v" style={{ color: vColor(dv.v || 0) }}>
                                    {(dv.v || 0) > 0 ? '+' : ''}
                                    {dv.v || 0}
                                  </span>
                                  <span className="cv-vdim-reason">{reason || '—'}</span>
                                </div>
                              )
                            })}
                            <div className="cv-emos">
                              {(vs.emotions || []).map((e, j) => (
                                <span key={j} className={`cv-emo ${e.valence}`}>
                                  {e.word}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      )
                    })}
                </div>
                </div>

                {/* 情報簡報區塊 */}
                <div className="cv-slbl" style={{ marginTop: 22 }} id="sec-blocks">
                  <span>{t('教練情報簡報')}</span>
                </div>
                {visibleBlocks.map(({ block: b, index: i }) => {
                  const open = openBlocks.includes(i) || editBlock === i
                  const view = viewBlocks[i] ?? b // 顯示語言版（標題/內文）；納入狀態仍用 canonical
                  return (
                  <div key={i} className="cv-block">
                    <div
                      className="cv-block-hd"
                      style={{ cursor: 'pointer' }}
                      onClick={() => editBlock === null && toggleBlockOpen(i)}
                    >
                      <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
                        ▶
                      </span>
                      <span className="cv-block-title">{t(view.title)}</span>
                      {b.custom && <span className="cv-block-tag ai">{t('AI 框架')}</span>}
                      {(b.include || isLinguisticFingerprint(b)) && (
                        <span className="cv-block-tag inc">{t('納入客戶版')}</span>
                      )}
                    </div>
                    {open && (
                    <div className="cv-block-body">
                      {editBlock === i ? (
                        <>
                          <textarea
                            className="cv-textarea"
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={saveEdit}
                              className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
                            >
                              {t('儲存')}
                            </button>
                            <button
                              onClick={() => setEditBlock(null)}
                              className="rounded-md border border-border px-3 py-1 text-xs text-foreground-soft"
                            >
                              {t('取消')}
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="cv-md" dangerouslySetInnerHTML={{ __html: mdToHtml(view.body) }} />
                          <div className="cv-block-actions">
                            <label className="cv-inc">
                              <input
                                type="checkbox"
                                checked={b.include || isLinguisticFingerprint(b)}
                                onChange={(e) => toggleBlock(i, e.target.checked)}
                                disabled={isLinguisticFingerprint(b)}
                              />
                              {t('納入客戶交付版')}
                            </label>
                            <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                              {b.custom && (
                                <span className="cv-block-del" onClick={() => deleteBlock(i)}>
                                  {t('刪除')}
                                </span>
                              )}
                              {briefLang === 'zh-TW' ? (
                                <span className="cv-block-edit" onClick={() => startEdit(i)}>
                                  {t('編輯')}
                                </span>
                              ) : (
                                <span className="cv-block-edit" style={{ opacity: 0.5 }} title={t('請切回中文編輯原文')}>
                                  {t('編輯')}
                                </span>
                              )}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                    )}
                  </div>
                  )
                })}
                {import.meta.env.DEV && !hasFutureActionsBlock && (
                  <div className="cv-block cv-action-preview">
                    <div
                      className="cv-block-hd"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setOpenActionPreview((open) => !open)}
                    >
                      <span
                        className="cv-caret"
                        style={{ transform: openActionPreview ? 'rotate(90deg)' : 'none' }}
                      >
                        ▶
                      </span>
                      <span className="cv-block-title">{t('未來四週行動')}</span>
                      <span className="cv-block-tags">
                        <span className="cv-block-tag preview">{t('本機預覽')}</span>
                        <span className="cv-block-tag inc">{t('納入客戶版')}</span>
                      </span>
                    </div>
                    {openActionPreview && <div className="cv-block-body">
                      <div className="cv-preview-note">
                        {t('以下僅供版面預覽；重新生成分析後會依日記證據產生個人化行動。')}
                      </div>
                      <div className="cv-md">
                        <ul>
                          <li>
                            <strong>{t('每週恢復檢視')}</strong>
                            <ul>
                              <li><strong>{t('為何適合')}</strong> — {t('幫助你辨認哪些情境消耗能量，以及哪些方法確實能讓自己恢復。')}</li>
                              <li><strong>{t('執行頻率')}</strong> — {t('每週安排 20 分鐘。')}</li>
                              <li><strong>{t('成功訊號')}</strong> — {t('四週內至少完成三次，並找出一項可重複使用的恢復方式。')}</li>
                            </ul>
                          </li>
                          <li>
                            <strong>{t('一個價值導向行動')}</strong>
                            <ul>
                              <li><strong>{t('為何適合')}</strong> — {t('將你在意的價值轉成小而具體的行動，降低只停留在思考中的壓力。')}</li>
                              <li><strong>{t('執行頻率')}</strong> — {t('每週完成一項 30 分鐘內可完成的小行動。')}</li>
                              <li><strong>{t('成功訊號')}</strong> — {t('完成後能清楚說出這項行動和哪個重要價值相連。')}</li>
                            </ul>
                          </li>
                          <li>
                            <strong>{t('一次支持性連結')}</strong>
                            <ul>
                              <li><strong>{t('為何適合')}</strong> — {t('把支持性關係當作可主動運用的資源，而不是等到壓力累積後才求助。')}</li>
                              <li><strong>{t('執行頻率')}</strong> — {t('每週主動與一位可信任的人對話一次。')}</li>
                              <li><strong>{t('成功訊號')}</strong> — {t('對話後能更清楚說出自己的需要或下一步。')}</li>
                            </ul>
                          </li>
                        </ul>
                      </div>
                    </div>}
                  </div>
                )}

                {/* ── 自訂分析框架：教練描述 → AI 依文獻生成框架 → 產生新的簡報區塊 ── */}
                <div className="cv-slbl" style={{ marginTop: 26 }} id="sec-framework">
                  <span>{t('自訂分析框架')}</span>
                </div>
                <div className="cv-fw-intro">
                  <p className="mb-3 text-xs text-muted-foreground">
                    {t('用自己的話描述你想分析什麼，AI 會依心理學文獻生成一個有理論依據的框架；你可以編輯後用它產生一個新的情報簡報區塊。')}
                  </p>
                  <textarea
                    className="cv-textarea"
                    style={{ minHeight: 64 }}
                    placeholder={t('例如：看這位成員面對轉變時的能動性 / 情緒調節的方式 / 自我批評 vs 自我疼惜')}
                    value={fwDesc}
                    onChange={(e) => setFwDesc(e.target.value)}
                  />
                  <div className="mt-2 flex flex-wrap gap-3">
                    <button
                      onClick={genFramework}
                      disabled={busy !== null || fwDesc.trim().length < 4}
                      className="rounded-lg border border-primary px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50"
                    >
                      {busy === 'framework' && !fwDraft ? t('生成中…') : t('AI 生成分析框架')}
                    </button>
                  </div>
                </div>

                {fwDraft && (
                  <div className="cv-fw">
                    <div className="cv-fw-hd">{t('生成的分析框架（可編輯）')}</div>
                    <label className="cv-fw-lab">{t('框架名稱')}</label>
                    <input
                      className="cv-fw-in"
                      value={fwDraft.name}
                      onChange={(e) => setFwDraft({ ...fwDraft, name: e.target.value })}
                    />
                    <label className="cv-fw-lab">{t('理論依據 / 出處')}</label>
                    <input
                      className="cv-fw-in"
                      value={fwDraft.basis}
                      onChange={(e) => setFwDraft({ ...fwDraft, basis: e.target.value })}
                    />
                    <label className="cv-fw-lab">{t('分析視角')}</label>
                    <input
                      className="cv-fw-in"
                      value={fwDraft.lens}
                      onChange={(e) => setFwDraft({ ...fwDraft, lens: e.target.value })}
                    />
                    <label className="cv-fw-lab">{t('分析維度')}</label>
                    {fwDraft.dimensions.map((d, i) => (
                      <div key={i} className="cv-fw-dim">
                        <input
                          className="cv-fw-in"
                          placeholder={t('維度名')}
                          value={d.name}
                          onChange={(e) => updateFwDim(i, 'name', e.target.value)}
                        />
                        <input
                          className="cv-fw-in"
                          placeholder={t('要留意的語言／行為線索')}
                          value={d.look_for}
                          onChange={(e) => updateFwDim(i, 'look_for', e.target.value)}
                        />
                        <input
                          className="cv-fw-in"
                          placeholder={t('證據規則（引用原話）')}
                          value={d.evidence_rule}
                          onChange={(e) => updateFwDim(i, 'evidence_rule', e.target.value)}
                        />
                        <button className="cv-fw-del" onClick={() => removeFwDim(i)} title={t('移除維度')}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button className="cv-fw-add" onClick={addFwDim}>
                      ＋ {t('新增維度')}
                    </button>
                    {fwDraft.references.length > 0 && (
                      <div className="cv-fw-refs">
                        <div className="cv-fw-lab" style={{ margin: '0 0 2px' }}>
                          {t('參考文獻')}
                        </div>
                        <ul>
                          {fwDraft.references.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {fwDraft.note && <div className="cv-fw-note">{fwDraft.note}</div>}
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={runFrameworkAnalysis}
                        disabled={busy !== null}
                        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                      >
                        {busy === 'framework' ? t('分析中…') : t('用這個框架分析')}
                      </button>
                      <button
                        onClick={() => setFwDraft(null)}
                        className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-soft"
                      >
                        {t('取消')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            </>
            )}
          </section>

          {/* ── 學員版報告：第 4、8 週的草稿要教練確認後才發布 ── */}
          {memberReports.length > 0 && (
            <section className="mb-8" id="sec-member-reports">
              <h2 className="mb-2 text-sm font-semibold text-foreground-soft">
                {t('學員版報告')}
                {pendingReports.length > 0 && (
                  <span className="ml-2 rounded-full bg-rust/15 px-2 py-0.5 text-[11px] font-semibold text-rust">
                    {t('{n} 份待確認', { n: pendingReports.length })}
                  </span>
                )}
              </h2>
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                {t('第 4、8 週的報告不會自動給學員，請你確認內容後再發布；其他週次會自動發布。')}
              </p>
              <div className="flex flex-col gap-3">
                {memberReports.map((r) => {
                  const pending = r.status === 'pending_coach'
                  const editing = editReportId === r.id
                  return (
                    <div
                      key={r.id}
                      className={`rounded-xl border p-4 ${
                        pending ? 'border-rust/40 bg-rust/5' : 'border-border bg-card'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {t('第 {n} 週', { n: r.week_number })}　·　{r.week_start}
                        </span>
                        <span className={`text-xs font-semibold ${pending ? 'text-rust' : 'text-muted-foreground'}`}>
                          {pending ? t('待你確認，學員看不到') : t('已發布給學員')}
                        </span>
                      </div>

                      {editing ? (
                        <div className="mt-3">
                          <textarea
                            className="cv-textarea"
                            style={{ minHeight: 280 }}
                            value={reportEditText}
                            onChange={(e) => setReportEditText(e.target.value)}
                          />
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={() => void saveReportEdit(r.id)}
                              className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
                            >
                              {t('儲存')}
                            </button>
                            <button
                              onClick={() => setEditReportId(null)}
                              className="rounded-md border border-border px-3 py-1 text-xs text-foreground-soft"
                            >
                              {t('取消')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            onClick={() => {
                              setEditReportId(r.id)
                              setReportEditText(r.body_md)
                            }}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-soft"
                          >
                            {t('編輯內容')}
                          </button>
                          {pending && (
                            <button
                              onClick={() => void publishReport(r.id)}
                              disabled={publishingReport === r.id}
                              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                            >
                              {publishingReport === r.id ? t('發布中…') : t('發布給學員')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* ── 每月（里程碑）PERMA 報告：第 4／8 週跨週回顧，僅教練閱讀，不寄信 ── */}
          {posts.length > 0 && (
            <section className="mb-8" id="sec-monthly-reports">
              <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('每月 PERMA 報告')}</h2>
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                {t('第 4 週回顧第 1–4 週、第 8 週回顧第 1–8 週，並與 T0 基準比較；僅教練可見。')}
              </p>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void generateMonthlyReports()}
                  disabled={monthlyBusy || !baseline}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {monthlyBusy
                    ? t('生成中…')
                    : monthlyReports.length > 0
                      ? t('重新生成月報告')
                      : t('生成月報告')}
                </button>
                {!baseline && <span className="text-xs text-muted-foreground">{t('需先設定並儲存 T0 基準點')}</span>}
              </div>
              {monthlyReports.length === 0 && (
                <p className="mb-3 text-sm text-muted-foreground">{t('目前還沒有月報告。完成 4 週或 8 週後，按上方按鈕即可生成。')}</p>
              )}
              <div className="flex flex-col gap-3">
                {monthlyReports.map((report) => {
                  const m = report.milestone_week
                  const open = openMonthly.includes(m)
                  const sessions = report.content?.sessions ?? []
                  const rBaseline = report.content?.baseline ?? null
                  const blocks = report.content?.blocks ?? []
                  const draft = monthlyFwDraft[m] ?? null
                  return (
                    <article key={m} className="cv-block">
                      <button
                        type="button"
                        className="cv-block-hd w-full text-left"
                        onClick={() => setOpenMonthly((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]))}
                      >
                        <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
                        <span className="cv-block-title">
                          {t('第 {n} 週', { n: m })}
                          {report.week_start_from ? ` · ${report.week_start_from} → ${report.week_start_to}` : ''}
                        </span>
                        <span className="cv-block-tag">{t('第 1–{n} 週', { n: m })}</span>
                      </button>
                      {open && (
                        <div className="cv-block-body">
                          {sessions.length > 0 && (
                            <>
                              {CHART_DEFS.filter((c) => ['dims', 'topics', 'radar', 'cloud'].includes(c.key)).map((c) => (
                                <div key={c.key} className="mb-4">
                                  <div className="cv-slbl"><span>{t(c.title)}</span></div>
                                  <ReportChart chartKey={c.key} sessions={sessions} baseline={rBaseline} compareWith="previous" />
                                </div>
                              ))}
                            </>
                          )}
                          {blocks.map((b, i) => (
                            <div key={i} className="cv-block" style={{ marginTop: 12 }}>
                              <div className="cv-block-hd">
                                <span className="cv-block-title">{t(b.title)}</span>
                                {b.custom && <span className="cv-block-tag ai">{t('AI 框架')}</span>}
                              </div>
                              <div className="cv-block-body">
                                <div className="cv-md" dangerouslySetInnerHTML={{ __html: mdToHtml(b.body) }} />
                              </div>
                            </div>
                          ))}

                          {/* ── 這份月報告專用的自訂分析框架：只分析這個里程碑涵蓋的週次 ── */}
                          <div className="cv-fw-intro" style={{ marginTop: 16 }}>
                            <p className="mb-3 text-xs text-muted-foreground">
                              {t('用自己的話描述你想分析什麼，AI 會依心理學文獻生成一個有理論依據的框架；你可以編輯後用它產生一個新的情報簡報區塊。')}
                            </p>
                            <textarea
                              className="cv-textarea"
                              style={{ minHeight: 64 }}
                              placeholder={t('例如：看這位成員面對轉變時的能動性 / 情緒調節的方式 / 自我批評 vs 自我疼惜')}
                              value={monthlyFwDesc[m] ?? ''}
                              onChange={(e) => setMonthlyFwDesc((prev) => ({ ...prev, [m]: e.target.value }))}
                            />
                            <div className="mt-2 flex flex-wrap gap-3">
                              <button
                                onClick={() => void genMonthlyFramework(m)}
                                disabled={monthlyFwBusy !== null || (monthlyFwDesc[m] ?? '').trim().length < 4}
                                className="rounded-lg border border-primary px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50"
                              >
                                {monthlyFwBusy === `gen-${m}` ? t('生成中…') : t('AI 生成分析框架')}
                              </button>
                            </div>
                          </div>

                          {draft && (
                            <div className="cv-fw">
                              <div className="cv-fw-hd">{t('生成的分析框架（可編輯）')}</div>
                              <label className="cv-fw-lab">{t('框架名稱')}</label>
                              <input
                                className="cv-fw-in"
                                value={draft.name}
                                onChange={(e) => setMonthlyFwDraft((prev) => ({ ...prev, [m]: { ...draft, name: e.target.value } }))}
                              />
                              <label className="cv-fw-lab">{t('理論依據 / 出處')}</label>
                              <input
                                className="cv-fw-in"
                                value={draft.basis}
                                onChange={(e) => setMonthlyFwDraft((prev) => ({ ...prev, [m]: { ...draft, basis: e.target.value } }))}
                              />
                              <label className="cv-fw-lab">{t('分析視角')}</label>
                              <input
                                className="cv-fw-in"
                                value={draft.lens}
                                onChange={(e) => setMonthlyFwDraft((prev) => ({ ...prev, [m]: { ...draft, lens: e.target.value } }))}
                              />
                              <label className="cv-fw-lab">{t('分析維度')}</label>
                              {draft.dimensions.map((d, i) => (
                                <div key={i} className="cv-fw-dim">
                                  <input
                                    className="cv-fw-in"
                                    placeholder={t('維度名')}
                                    value={d.name}
                                    onChange={(e) => updateMonthlyFwDim(m, i, 'name', e.target.value)}
                                  />
                                  <input
                                    className="cv-fw-in"
                                    placeholder={t('要留意的語言／行為線索')}
                                    value={d.look_for}
                                    onChange={(e) => updateMonthlyFwDim(m, i, 'look_for', e.target.value)}
                                  />
                                  <input
                                    className="cv-fw-in"
                                    placeholder={t('證據規則（引用原話）')}
                                    value={d.evidence_rule}
                                    onChange={(e) => updateMonthlyFwDim(m, i, 'evidence_rule', e.target.value)}
                                  />
                                  <button className="cv-fw-del" onClick={() => removeMonthlyFwDim(m, i)} title={t('移除維度')}>×</button>
                                </div>
                              ))}
                              <button className="cv-fw-add" onClick={() => addMonthlyFwDim(m)}>＋ {t('新增維度')}</button>
                              {draft.references.length > 0 && (
                                <div className="cv-fw-refs">
                                  <div className="cv-fw-lab" style={{ margin: '0 0 2px' }}>{t('參考文獻')}</div>
                                  <ul>{draft.references.map((r, i) => <li key={i}>{r}</li>)}</ul>
                                </div>
                              )}
                              {draft.note && <div className="cv-fw-note">{draft.note}</div>}
                              <div className="mt-3 flex gap-2">
                                <button
                                  onClick={() => void runMonthlyFrameworkAnalysis(m)}
                                  disabled={monthlyFwBusy !== null}
                                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                                >
                                  {monthlyFwBusy === `run-${m}` ? t('分析中…') : t('用這個框架分析')}
                                </button>
                                <button
                                  onClick={() => setMonthlyFwDraft((prev) => ({ ...prev, [m]: null }))}
                                  className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-soft"
                                >
                                  {t('取消')}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          )}

          {/* ── 客戶交付版 ── */}
          {analysis && analysis.sessions.length > 0 && (
            <section className="mb-8" id="sec-client">
              <SectionHeading
                open={openSections.client}
                onToggle={() => setOpenSections((p) => ({ ...p, client: !p.client }))}
              >
                {t('客戶交付版')}
              </SectionHeading>
              {openSections.client && (
              <>
              <p className="mb-3 text-xs text-muted-foreground">
                {t('依勾選納入的區塊，生成給客戶本人的正式回顧文件。')}
              </p>
              <div className="cv-note" style={{ marginBottom: 12 }}>
                {t('目前納入客戶版的區塊：')}
                <strong>
                  {' '}
                  {includedBlocks.length}
                </strong>{' '}
                / {visibleBlocks.length}
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={runClientReport}
                  disabled={busy !== null || includedBlocks.length === 0}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {busy === 'client'
                    ? t('生成中…')
                    : analysis.client_text
                      ? t('重新生成客戶版')
                      : t('生成客戶交付版')}
                </button>
                {analysis.client_text && !editClient && (
                  <>
                    <button
                      onClick={startClientEdit}
                      className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-soft"
                    >
                      {t('編輯')}
                    </button>
                    <button
                      onClick={downloadClientPdf}
                      className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-soft"
                    >
                      {t('下載 PDF')}
                    </button>
                    <button
                      onClick={downloadClientWord}
                      className="rounded-lg border border-border px-4 py-2 text-sm text-foreground-soft"
                    >
                      {t('下載 Word')}
                    </button>
                  </>
                )}
              </div>
              {analysis.client_text && editClient && (
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t('直接編輯客戶版文字（Markdown：## 標題、** 粗體、- 條列），儲存後即更新交付文件。')}
                  </p>
                  <textarea
                    className="cv-textarea"
                    style={{ minHeight: 320 }}
                    value={clientEditText}
                    onChange={(e) => setClientEditText(e.target.value)}
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={saveClientEdit}
                      className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
                    >
                      {t('儲存')}
                    </button>
                    <button
                      onClick={() => setEditClient(false)}
                      className="rounded-md border border-border px-3 py-1 text-xs text-foreground-soft"
                    >
                      {t('取消')}
                    </button>
                  </div>
                </div>
              )}
              {analysis.client_text && !editClient && (
                <div className="cv-doc" id="cv-print-area">
                  <div className="cv-doc-head">
                    <div className="cv-doc-title">{t('個人福祉回顧')}</div>
                    <div className="cv-doc-meta">
                      {name}　·　{analysis.client_date}
                    </div>
                  </div>
                  <div dangerouslySetInnerHTML={{ __html: mdToHtml(analysis.client_text) }} />
                  {CHART_DEFS.some((c) => analysis.client_charts?.[c.key]) && (
                    <div className="cv-doc-charts">
                      {CHART_DEFS.filter((c) => analysis.client_charts?.[c.key]).map((c, idx) => (
                        <div key={c.key} className="cv-doc-chart">
                          {idx === 0 && <h2 className="cv-doc-chart-h">{t('情緒歷程一覽')}</h2>}
                          <div className="cv-slbl">
                            <span>{t(c.title)}</span>
                          </div>
                          <ReportChart chartKey={c.key} sessions={analysis.sessions} baseline={baseline} />

                        </div>
                      ))}
                    </div>
                  )}
                  <div className="cv-doc-sign">{t('教練　Yee Ming Tan')}</div>
                </div>
              )}
              </>
              )}
            </section>
          )}

          {/* ── 書寫時間軸（原有）── */}
          <section id="sec-timeline">
            <SectionHeading
              open={openSections.timeline}
              onToggle={() => setOpenSections((p) => ({ ...p, timeline: !p.timeline }))}
            >
              {t('書寫時間軸')}
            </SectionHeading>
            {openSections.timeline && (entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('目前還沒有人發布書寫')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {entries.map((e) => {
                  const dim = DIMENSION_CONFIGS[e.dimension]
                  return (
                    <article key={e.id} className="rounded-xl border border-border bg-card p-4 shadow-soft">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${dim.textColor} ${dim.bgLight}`}
                          >
                            {language === 'en' ? dim.sublabel : dim.label}
                          </span>
                          {!e.is_public && (
                            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                              {t('私人')}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(e.created_at).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-TW')}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{e.content}</p>
                    </article>
                  )
                })}
              </div>
            ))}
          </section>
          </div>
        </div>
      )}
    </div>
  )
}
