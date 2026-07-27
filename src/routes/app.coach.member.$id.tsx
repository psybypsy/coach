import { useEffect, useMemo, useState, type ReactNode } from 'react'
import html2pdf from 'html2pdf.js'
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { useLanguage } from '../lib/i18n/context'
import { DIMENSION_CONFIGS, type DimensionKey } from '../lib/perma'
import {
  KEYS,
  DIM,
  DIMCOLOR,
  vColor,
  valLine,
  valRadar,
  radarDelta,
  topicShareStacked,
  topicSharePie,
  emotionWordCloud,
  type SessionScore,
  type DimKey,
  type TopicKey,
} from '../lib/coachViz'

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
  week_start: string
}

interface BriefBlock {
  title: string
  body: string
  include: boolean
  custom?: boolean // 由教練自訂 AI 框架生成的區塊
}

// T0 基準點：教練手填的五面向幸福感分數（0–10），作為所有圖表的起點（見遷移 005）
type BaselineScores = Record<DimKey, number>

interface CoachAnalysis {
  member_id: string
  based_on: number
  sessions: SessionScore[]
  blocks: BriefBlock[]
  client_charts: Record<string, boolean>
  client_text: string | null
  client_date: string | null
  // 繁中為原生分析；教練選擇英文時才即時翻譯並快取。
  translations?: Record<string, { blocks: BriefBlock[]; sessions: SessionScore[] }>
  baseline?: BaselineScores | null
  report_emailed_at?: string | null
  report_email_recipient?: string | null
  report_email_error?: string | null
  updated_at: string
}

interface WeeklyPermaReport {
  member_id: string
  week_start: string
  week_number: number
  content: {
    baseline: BaselineScores
    session: SessionScore
    block: BriefBlock
    scope: 'single_week_only'
  }
  report_emailed_at?: string | null
  report_email_recipient?: string | null
}

// 月報告（里程碑）：第 4 週看 1–4 週、第 8 週看 1–8 週；僅教練端閱讀
interface MonthlyPermaReport {
  member_id: string
  milestone_week: number
  weeks_covered: number
  week_start_from: string | null
  week_start_to: string | null
  content: {
    baseline: BaselineScores
    sessions: SessionScore[]
    blocks: BriefBlock[]
    scope: string
  }
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

// 客戶端預覽：後端回傳「實際會寄出」的信件內文與 PDF（與寄送共用同一組產生函式）
interface WeeklyReportPreview {
  week_number: number
  week_start: string
  recipient_name: string
  recipient_email: string
  subject: string
  email_html: string
  pdf_filename: string
  pdf_base64: string
  emailed_at?: string | null
}

// T0 分數尺度：0–10 → valence −100~+100（5=0 中性、10=+100、0=−100）
function baselineToValence(score: number): number {
  const s = Math.max(0, Math.min(10, score))
  return Math.round((s - 5) * 20)
}
// 由五面向 0–10 分數組出一個「第 0 次」的 SessionScore（overall 取五項平均）
function makeBaselineSession(b: BaselineScores | null | undefined): SessionScore | null {
  if (!b || !KEYS.every((k) => typeof b[k] === 'number' && !Number.isNaN(b[k]))) return null
  const dims = {} as SessionScore['dims']
  KEYS.forEach((k) => {
    dims[k] = { v: baselineToValence(b[k]), reason: '' }
  })
  const overall = Math.round(KEYS.reduce((sum, k) => sum + dims[k].v, 0) / KEYS.length)
  return { overall, overallReason: '', dims, emotions: [] }
}

const ALLOWED_BLOCK_TITLES = new Set([
  'perma five-dimension profile',
  'perma 五面向剖析',
  'strengths & inner resources',
  '優勢與內在資源',
])

function isAllowedBlock(block: BriefBlock): boolean {
  // custom=true 是教練用自訂框架生成的區塊，標題不固定，不受白名單限制
  if (block.custom) return true
  return ALLOWED_BLOCK_TITLES.has(String(block.title || '').trim().toLowerCase())
}

function isLegacyClientText(text: string | null | undefined): boolean {
  return /(linguistic fingerprint|actions for the next four weeks|self-determination motivation|語言指紋|未來四週行動|自我決定論動機)/i.test(
    String(text || ''),
  )
}

// 兩個標準區塊依介面語言顯示 canonical 標題；自訂框架區塊沿用 AI 生成的原標題
const CANONICAL_BLOCK_TITLES: Record<string, { 'zh-TW': string; en: string }> = {
  'perma five-dimension profile': { 'zh-TW': 'PERMA 五面向剖析', en: 'PERMA Five-Dimension Profile' },
  'perma 五面向剖析': { 'zh-TW': 'PERMA 五面向剖析', en: 'PERMA Five-Dimension Profile' },
  'strengths & inner resources': { 'zh-TW': '優勢與內在資源', en: 'Strengths & Inner Resources' },
  '優勢與內在資源': { 'zh-TW': '優勢與內在資源', en: 'Strengths & Inner Resources' },
}

function blockTitleForLanguage(block: BriefBlock, language: 'en' | 'zh-TW'): string {
  const raw = String(block.title || '').trim()
  return CANONICAL_BLOCK_TITLES[raw.toLowerCase()]?.[language] ?? raw
}

const CHART_DEFS: { key: string; title: string }[] = [
  { key: 'dims', title: '五面向 valence 趨勢' },
  { key: 'topics', title: '每週主題占比' },
  { key: 'radar', title: '五面向 valence 剖面' },
  { key: 'cloud', title: '情緒詞雲' },
]

// ── 極簡 Markdown → HTML（** 粗體、* 斜體、## 標題、- / • 條列、1. 數字條列、縮排巢狀條列）──
function mdToHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '<em>$1</em>')
  const rawLines = String(md || '').split('\n')
  let h = ''
  // 依縮排深度堆疊巢狀 <ul>/<ol>：同層同類型接續為 <li> 手足，縮排加深則在目前 <li> 內開新子清單
  const stack: { type: 'ul' | 'ol'; indent: number }[] = []
  const closeAllLists = () => {
    while (stack.length) {
      h += '</li>'
      const f = stack.pop()!
      h += f.type === 'ul' ? '</ul>' : '</ol>'
    }
  }
  for (const raw of rawLines) {
    const l = raw.trim()
    const indent = (/^\s*/.exec(raw)?.[0] ?? '').replace(/\t/g, '  ').length
    const bullet = /^[-*•‣]\s+(.*)$/.exec(l)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(l)
    if (bullet || numbered) {
      const type: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      const content = inline((bullet ?? numbered)![1])
      while (
        stack.length &&
        (stack[stack.length - 1].indent > indent ||
          (stack[stack.length - 1].indent === indent && stack[stack.length - 1].type !== type))
      ) {
        h += '</li>'
        const f = stack.pop()!
        h += f.type === 'ul' ? '</ul>' : '</ol>'
      }
      if (stack.length && stack[stack.length - 1].indent === indent) {
        h += '</li><li>' + content
      } else {
        h += type === 'ul' ? '<ul>' : '<ol>'
        stack.push({ type, indent })
        h += '<li>' + content
      }
      continue
    }
    closeAllLists()
    const hm = l.match(/^#{1,3} /)
    if (hm) {
      const lvl = hm[0].trim().length
      h += `<h${lvl}>` + inline(l.replace(/^#+ /, '')) + `</h${lvl}>`
    } else if (l) {
      h += '<p>' + inline(l) + '</p>'
    }
  }
  closeAllLists()
  return h
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

// AI 自訂分析框架面板：教練描述想分析什麼 → AI 依文獻生成可編輯框架 → 追加成新的分析區塊。
// 教練情報簡報與各里程碑月報告共用同一個元件，避免兩處實作走鐘。
function FrameworkPanel({
  fwKey,
  desc,
  draft,
  busy,
  intro,
  onDescChange,
  onGenerate,
  onPatch,
  onRun,
  onCancel,
  t,
}: {
  fwKey: string
  desc: string
  draft: Framework | null
  busy: string | null
  intro: string
  onDescChange: (value: string) => void
  onGenerate: () => void
  onPatch: (patch: Partial<Framework>) => void
  onRun: () => void
  onCancel: () => void
  t: (key: string) => string
}) {
  return (
    <>
      <div className="cv-fw-intro">
        <div className="cv-fw-hd">{t('用 AI 框架增加新的分析內容')}</div>
        <p className="mb-2 text-xs text-muted-foreground">{intro}</p>
        <textarea
          className="cv-fw-in"
          rows={2}
          value={desc}
          onChange={(e) => onDescChange(e.target.value)}
          placeholder={t('例如：面對轉變時的能動性／情緒調節方式／自我批評 vs 自我疼惜')}
        />
        <button
          onClick={onGenerate}
          disabled={busy !== null}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground-soft disabled:opacity-50"
        >
          {busy === `gen-${fwKey}` ? t('生成中…') : t('AI 生成分析框架')}
        </button>
      </div>

      {draft && (
        <div className="cv-fw">
          <div className="cv-fw-hd">{t('生成的分析框架（可編輯）')}</div>
          <label className="cv-fw-lab">{t('框架名稱')}</label>
          <input className="cv-fw-in" value={draft.name} onChange={(e) => onPatch({ name: e.target.value })} />
          <label className="cv-fw-lab">{t('理論依據 / 出處')}</label>
          <input className="cv-fw-in" value={draft.basis} onChange={(e) => onPatch({ basis: e.target.value })} />
          <label className="cv-fw-lab">{t('分析視角')}</label>
          <input className="cv-fw-in" value={draft.lens} onChange={(e) => onPatch({ lens: e.target.value })} />
          <label className="cv-fw-lab">{t('分析維度')}</label>
          {draft.dimensions.map((d, di) => (
            <div key={di} className="cv-fw-dim">
              <button
                className="cv-fw-del"
                title={t('移除維度')}
                onClick={() => onPatch({ dimensions: draft.dimensions.filter((_, x) => x !== di) })}
              >
                ×
              </button>
              {(['name', 'look_for', 'evidence_rule'] as const).map((field) => (
                <input
                  key={field}
                  className="cv-fw-in"
                  value={d[field]}
                  placeholder={t(
                    field === 'name'
                      ? '維度名'
                      : field === 'look_for'
                        ? '要留意的語言／行為線索'
                        : '證據規則（引用原話）',
                  )}
                  onChange={(e) =>
                    onPatch({
                      dimensions: draft.dimensions.map((x, xi) =>
                        xi === di ? { ...x, [field]: e.target.value } : x,
                      ),
                    })
                  }
                />
              ))}
            </div>
          ))}
          <button
            className="cv-fw-add"
            onClick={() =>
              onPatch({ dimensions: [...draft.dimensions, { name: '', look_for: '', evidence_rule: '' }] })
            }
          >
            ＋ {t('新增維度')}
          </button>
          {draft.references?.length > 0 && (
            <div className="cv-fw-refs">
              {t('參考文獻')}
              <ul>
                {draft.references.map((r, ri) => (
                  <li key={ri}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {draft.note && <div className="cv-fw-note">{draft.note}</div>}
          <div className="mt-3 flex gap-2">
            <button
              onClick={onRun}
              disabled={busy !== null}
              className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy === `run-${fwKey}` ? t('分析中…') : t('用這個框架分析')}
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg border border-border px-4 py-2 text-xs text-foreground-soft"
            >
              {t('取消')}
            </button>
          </div>
        </div>
      )}
    </>
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

function chartData(sessions: SessionScore[]) {
  const ov = sessions.map((s) => s.overall)
  const avg = Math.round(ov.reduce((x, v) => x + v, 0) / ov.length)
  const hi = Math.max(...ov)
  const lo = Math.min(...ov)
  const delta = ov[ov.length - 1] - ov[0]
  const avgDim = {} as Record<DimKey, number>
  KEYS.forEach((k) => {
    avgDim[k] = Math.round(sessions.reduce((x, s) => x + (s.dims[k]?.v || 0), 0) / sessions.length)
  })
  const strong = KEYS.slice().sort((x, y) => avgDim[y] - avgDim[x])[0]
  const firstDim = {} as Record<DimKey, number>
  const lastDim = {} as Record<DimKey, number>
  KEYS.forEach((k) => {
    firstDim[k] = sessions[0].dims[k]?.v || 0
    lastDim[k] = sessions[sessions.length - 1].dims[k]?.v || 0
  })
  return { ov, avg, hi, lo, delta, strong, firstDim, lastDim }
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
  const [weeklyReports, setWeeklyReports] = useState<WeeklyPermaReport[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'analyze' | 'client' | 'translate' | null>(null)
  const [briefLang, setBriefLang] = useState<'en' | 'zh-TW'>('zh-TW')
  const [autoTranslationAttempted, setAutoTranslationAttempted] = useState(false)
  const [openBlocks, setOpenBlocks] = useState<number[]>([])
  const [openWeeklyReports, setOpenWeeklyReports] = useState<number[]>([])
  const [weeklyBusy, setWeeklyBusy] = useState(false)
  // 月報告（第 4／第 8 週）與其 AI 自訂框架
  const [monthlyReports, setMonthlyReports] = useState<MonthlyPermaReport[]>([])
  const [monthlyBusy, setMonthlyBusy] = useState(false)
  const [openMonthly, setOpenMonthly] = useState<number[]>([])
  // key 用字串：'brief' 為教練情報簡報（隨時可用），數字字串為各里程碑月報告
  const [fwDesc, setFwDesc] = useState<Record<string, string>>({})
  const [fwDraft, setFwDraft] = useState<Record<string, Framework | null>>({})
  const [fwBusy, setFwBusy] = useState<string | null>(null)
  // 客戶視角預覽：客戶實際收到的信件內文＋PDF 附件（由後端用寄送同一套函式重建）
  const [preview, setPreview] = useState<WeeklyReportPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState<string | null>(null)
  // PDF 以 blob URL 內嵌在對話框裡顯示（window.open(blob:) 常被瀏覽器攔截，不可靠）
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null)
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
  // T0 基準點：五面向 0–10 輸入（字串以容許暫時空白），存進 coach_analyses.baseline
  const emptyBaselineDraft: Record<DimKey, string> = { P: '', E: '', R: '', M: '', A: '' }
  const [baselineDraft, setBaselineDraft] = useState<Record<DimKey, string>>(emptyBaselineDraft)
  const [savingBaseline, setSavingBaseline] = useState(false)
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
    setAutoTranslationAttempted(false)
    void guardAndLoad()
  }, [id])

  // 預覽的 PDF：base64 → blob URL，供對話框內嵌顯示與下載；關閉時釋放
  useEffect(() => {
    if (!preview) {
      setPreviewPdfUrl(null)
      return
    }
    const bytes = Uint8Array.from(atob(preview.pdf_base64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    setPreviewPdfUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [preview])

  useEffect(() => {
    if (!analysis || briefLang !== 'zh-TW' || autoTranslationAttempted) return
    const canonicalIsChinese = analysis.blocks.some((block) =>
      String(block.title || '').trim().toLowerCase() === 'perma 五面向剖析',
    )
    if (!canonicalIsChinese && !analysis.translations?.['zh-TW']) {
      setAutoTranslationAttempted(true)
      void switchBriefLang('zh-TW')
    }
  }, [analysis, briefLang, autoTranslationAttempted])

  const hasDeepAnalysis = !!analysis && analysis.sessions.length > 0
  const navItems = useMemo(() => {
    const items: NavItem[] = [
      { id: 'sec-baseline', label: t('T0 基準點') },
      { id: 'sec-deep', label: t('教練深度分析') },
    ]
    // 順序必須與頁面上區塊實際出現的先後一致，否則 scrollspy 高亮會跳來跳去
    if (hasDeepAnalysis) {
      items.push({ id: 'sec-charts', label: t('圖表'), indent: true })
      items.push({ id: 'sec-blocks', label: t('教練情報簡報'), indent: true })
    }
    if (posts.length > 0) {
      items.push({ id: 'sec-weekly-reports', label: t('每週 PERMA 報告') })
      items.push({ id: 'sec-monthly-reports', label: t('每月 PERMA 報告') })
    }
    if (hasDeepAnalysis) {
      items.push({ id: 'sec-client', label: t('客戶交付版') })
    }
    items.push({ id: 'sec-timeline', label: t('書寫時間軸') })
    return items
  }, [hasDeepAnalysis, posts.length, t])

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
  }

  async function load() {
    setLoading(true)
    const [
      { data: profile },
      { data: entryRows },
      { data: postRows },
      { data: analysisRow },
      { data: weeklyReportRows },
      { data: monthlyReportRows },
    ] =
      await Promise.all([
        supabase.from('profiles').select('display_name').eq('id', id).single(),
        supabase
          .from('perma_entries')
          .select('id,dimension,content,is_public,created_at')
          .eq('user_id', id)
          .order('created_at', { ascending: false }),
        supabase
          .from('journal_posts')
          .select('week_start')
          .eq('user_id', id)
          .order('week_start', { ascending: true }),
        supabase.from('coach_analyses').select('*').eq('member_id', id).maybeSingle(),
        supabase
          .from('perma_weekly_reports')
          .select('*')
          .eq('member_id', id)
          .order('week_number', { ascending: true }),
        supabase
          .from('perma_monthly_reports')
          .select('*')
          .eq('member_id', id)
          .order('milestone_week', { ascending: true }),
      ])
    setName(profile?.display_name ?? '')
    setEntries((entryRows as unknown as EntryRow[]) ?? [])
    setPosts((postRows as unknown as JournalPost[]) ?? [])
    const row = (analysisRow as unknown as CoachAnalysis) ?? null
    setAnalysis(row)
    setWeeklyReports((weeklyReportRows as unknown as WeeklyPermaReport[]) ?? [])
    setMonthlyReports((monthlyReportRows as unknown as MonthlyPermaReport[]) ?? [])
    const b = row?.baseline
    setBaselineDraft(
      b ? (Object.fromEntries(KEYS.map((k) => [k, String(b[k] ?? '')])) as Record<DimKey, string>) : emptyBaselineDraft,
    )
    setLoading(false)
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

  async function reloadWeeklyReports() {
    const { data } = await supabase
      .from('perma_weekly_reports')
      .select('*')
      .eq('member_id', id)
      .order('week_number', { ascending: true })
    setWeeklyReports((data as unknown as WeeklyPermaReport[]) ?? [])
  }

  // 教練手動生成每週報告：只依該週內容分析、與 T0 比較，存進 perma_weekly_reports（並依設定寄給成員）
  async function generateWeeklyReports() {
    if (!baseline) {
      setMessage(t('請先在最上方填寫並儲存 T0 基準點'))
      return
    }
    setWeeklyBusy(true)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/weekly-reports/generate', { member_id: id })
      if (resp.ok) {
        const data = (await resp.json()) as { generated?: number; reports?: { status?: string }[] }
        const sent = (data.reports ?? []).filter((r) => r.status === 'sent').length
        await reloadWeeklyReports()
        setMessage(
          `${t('已生成每週報告')} ${data.generated ?? 0}${sent ? `，${t('已寄送')} ${sent}` : ''}`,
        )
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('生成失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('生成失敗，請再試一次。'))
    } finally {
      setWeeklyBusy(false)
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

  // 生成第 4 週（1–4 週）與第 8 週（1–8 週）的跨週回顧，僅教練端閱讀
  async function generateMonthlyReports() {
    if (!baseline) {
      setMessage(t('請先在最上方填寫並儲存 T0 基準點'))
      return
    }
    setMonthlyBusy(true)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/monthly-reports/generate', { member_id: id })
      if (resp.ok) {
        const data = (await resp.json()) as { reports?: { status?: string; detail?: string }[] }
        await reloadMonthlyReports()
        const ok = (data.reports ?? []).filter((r) => r.status === 'ok').length
        const skipped = (data.reports ?? []).find((r) => r.status === 'not_enough_weeks')
        setMessage(`${t('已生成月報告')} ${ok}${skipped ? `　（${skipped.detail}）` : ''}`)
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('生成失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('生成失敗，請再試一次。'))
    } finally {
      setMonthlyBusy(false)
    }
  }

  // 教練用自然語言描述 → AI 上網找對應實證理論 → 回傳可編輯的結構化框架
  async function generateFramework(key: string) {
    const desc = (fwDesc[key] || '').trim()
    if (desc.length < 4) {
      setMessage(t('請先描述你想分析什麼'))
      return
    }
    setFwBusy(`gen-${key}`)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/framework/generate', { description: desc, language: 'zh-TW' })
      if (resp.ok) {
        const fw = (await resp.json()) as Framework
        setFwDraft((p) => ({ ...p, [key]: fw }))
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('生成失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('生成失敗，請再試一次。'))
    } finally {
      setFwBusy(null)
    }
  }

  // 用（教練確認過的）框架分析全部週記，把新區塊追加進教練情報簡報——不必等到里程碑，隨時可用
  async function runBriefFramework() {
    const fw = fwDraft.brief
    if (!fw || !fw.dimensions?.length) {
      setMessage(t('框架不完整，請至少保留一個維度'))
      return
    }
    setFwBusy('run-brief')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/analyze-framework', {
        member_id: id,
        framework: fw,
        language: 'zh-TW',
      })
      if (resp.ok) {
        setAnalysis((await resp.json()) as CoachAnalysis)
        setFwDraft((p) => ({ ...p, brief: null }))
        setFwDesc((p) => ({ ...p, brief: '' }))
        setMessage(t('已加入新的分析內容'))
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('生成失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('生成失敗，請再試一次。'))
    } finally {
      setFwBusy(null)
    }
  }

  // 用（教練確認過的）框架分析該里程碑涵蓋的週次，並把新區塊追加進月報告
  async function runMonthlyFramework(milestone: number) {
    const fw = fwDraft[String(milestone)]
    if (!fw || !fw.dimensions?.length) {
      setMessage(t('框架不完整，請至少保留一個維度'))
      return
    }
    setFwBusy(`run-${milestone}`)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/monthly-reports/analyze-framework', {
        member_id: id,
        milestone_week: milestone,
        framework: fw,
        language: 'zh-TW',
      })
      if (resp.ok) {
        await reloadMonthlyReports()
        setFwDraft((p) => ({ ...p, [String(milestone)]: null }))
        setFwDesc((p) => ({ ...p, [String(milestone)]: '' }))
        setOpenMonthly((p) => (p.includes(milestone) ? p : [...p, milestone]))
        setMessage(t('已加入新的分析內容'))
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('生成失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('生成失敗，請再試一次。'))
    } finally {
      setFwBusy(null)
    }
  }

  function patchFw(key: string, patch: Partial<Framework>) {
    setFwDraft((p) => {
      const cur = p[key]
      return cur ? { ...p, [key]: { ...cur, ...patch } } : p
    })
  }

  // 預覽某一週「客戶實際收到」的信件與 PDF：後端讀已存的分析重建，不重跑 AI、不寄信
  async function openWeeklyPreview(weekStart: string) {
    setPreviewBusy(weekStart)
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/weekly-reports/preview', {
        member_id: id,
        week_start: weekStart,
      })
      if (resp.ok) {
        setPreview((await resp.json()) as WeeklyReportPreview)
      } else {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string }
        setMessage(body.detail || t('預覽失敗，請再試一次。'))
      }
    } catch {
      setMessage(t('預覽失敗，請再試一次。'))
    } finally {
      setPreviewBusy(null)
    }
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
        setBriefLang('zh-TW')
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

  // 繁中為原文；英文只在教練選擇後翻譯一次並快取。
  async function switchBriefLang(target: 'en' | 'zh-TW') {
    const canonicalIsChinese = analysis?.blocks.some((block) =>
      String(block.title || '').trim().toLowerCase() === 'perma 五面向剖析',
    )
    if ((target === 'zh-TW' && canonicalIsChinese) || (target === 'en' && !canonicalIsChinese)) {
      setBriefLang(target)
      return
    }
    if (analysis?.translations?.[target]) {
      setBriefLang(target)
      return
    }
    setBusy('translate')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/translate', { member_id: id, target })
      if (resp.ok) {
        setAnalysis((await resp.json()) as CoachAnalysis)
        setBriefLang(target)
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
        const next = (await resp.json()) as CoachAnalysis
        setAnalysis(next)
        if (next.report_emailed_at) {
          setMessage(t('客戶版已生成，PDF 已寄送給成員。'))
        } else if (next.report_email_error) {
          setMessage(`${t('客戶版已生成，但 PDF 尚未寄出：')}${next.report_email_error}`)
        }
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
  async function rasterizeExportSvgs(root: HTMLElement) {
    const svgs = [...root.querySelectorAll('svg')] as SVGSVGElement[]
    await Promise.all(
      svgs.map(
        (svg) =>
          new Promise<void>((resolve) => {
            const rect = svg.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) {
              resolve()
              return
            }
            const source = new XMLSerializer().serializeToString(svg)
            const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }))
            const image = new Image()
            image.onload = () => {
              const scale = 2
              const canvas = document.createElement('canvas')
              canvas.width = Math.ceil(rect.width * scale)
              canvas.height = Math.ceil(rect.height * scale)
              const ctx = canvas.getContext('2d')
              if (ctx) {
                ctx.scale(scale, scale)
                ctx.drawImage(image, 0, 0, rect.width, rect.height)
                const replacement = document.createElement('img')
                replacement.src = canvas.toDataURL('image/png')
                replacement.alt = ''
                replacement.style.display = 'block'
                replacement.style.width = `${rect.width}px`
                replacement.style.height = `${rect.height}px`
                replacement.style.maxWidth = '100%'
                replacement.style.margin = getComputedStyle(svg).margin
                svg.replaceWith(replacement)
              }
              URL.revokeObjectURL(url)
              resolve()
            }
            image.onerror = () => {
              URL.revokeObjectURL(url)
              resolve() // 保留原 SVG，讓 html2canvas 作為後備處理
            }
            image.src = url
          }),
      ),
    )
  }

  // #3 下載 PDF：用固定桌面版寬度的離屏副本輸出，不改動使用者正在看的報告。
  async function downloadClientPdf() {
    const source = document.getElementById('cv-print-area')
    if (!source) return

    const exportRoot = source.cloneNode(true) as HTMLElement
    exportRoot.removeAttribute('id')
    exportRoot.classList.add('cv-pdf-export')
    // 定位放在外層 host，而不是 exportRoot 本身；html2pdf 再複製 exportRoot 時才不會
    // 把 left:-100000px 一起複製進 PDF 畫布。
    const exportHost = document.createElement('div')
    exportHost.style.cssText = 'position:fixed;left:-100000px;top:0;width:720px;z-index:-1'
    exportHost.appendChild(exportRoot)
    document.body.appendChild(exportHost)

    try {
      // 等字型完成後再量尺寸，避免中文字型替換造成換行點在匯出途中改變。
      await document.fonts?.ready
      await rasterizeExportSvgs(exportRoot)

      await html2pdf()
        .set({
          margin: [12, 12, 14, 12],
          filename: 'Personal-Well-being-Review.pdf', // 純 ASCII，避免檔名特殊字元讓下載失效
          image: { type: 'png', quality: 1 },
          // width/windowWidth 同時固定 html2pdf 容器與 media query 的計算，手機與桌面輸出一致。
          width: 720,
          windowWidth: 720,
          html2canvas: {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            foreignObjectRendering: false,
            windowWidth: 720,
          },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
          pagebreak: {
            mode: ['css', 'legacy'],
            avoid: [
              '.cv-doc-head',
              '.cv-doc h2',
              '.cv-doc h3',
              '.cv-doc p',
              '.cv-doc li',
              '.cv-doc-sign',
              '.cv-doc-chart',
              '.cv-rdelta',
              '.cv-stats',
              '.cv-wcloud',
            ],
          },
        })
        .from(exportRoot)
        .save()
    } finally {
      exportHost.remove()
    }
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

  function renderChart(key: string) {
    if (!analysis) return null
    // T0 基準點：若五面向都填了，就把它當「第 0 次」接在最前面，讓趨勢／五面向／雷達／摘要都以 T0 為起點。
    // 情緒相關圖（正負平衡、詞雲）與逐次列表不含 T0（T0 沒有情緒詞與理由）。
    const base = makeBaselineSession(baseline)
    const cs = base ? [base, ...analysis.sessions] : analysis.sessions
    const s = cs
    const cd = chartData(cs)
    const xLabels = base ? ['T0', ...analysis.sessions.map((_, i) => String(i + 1))] : undefined
    const legendItem = (color: string, label: string, key?: string) => {
      // 色塊與文字必須在同一張 SVG 內；若拆成兩個 flex item，html2canvas 仍會用錯誤的
      // 文字基線把兩者上下拉開。寬度依 ASCII／CJK 字元估算，保留足夠但不浪費的空間。
      const textWidth = [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 12 : ch === ' ' ? 4 : 7), 0)
      const width = Math.ceil(20 + textWidth)
      return (
        <svg
          key={key}
          className="cv-legend-item-svg"
          viewBox={`0 0 ${width} 18`}
          width={width}
          height="18"
          role="img"
          aria-label={label}
        >
          <rect x="0" y="3" width="12" height="12" rx="2" fill={color} />
          <text
            x="19"
            y="14"
            fontFamily="Arial, 'PingFang TC', 'Noto Sans TC', sans-serif"
            fontSize="11.5"
            fontWeight="700"
            fill="#54606E"
          >
            {label}
          </text>
        </svg>
      )
    }
    switch (key) {
      case 'summary':
        return (
          <div className="cv-stats">
            <div className="cv-stat">
              <div className="cv-stat-n" style={{ color: vColor(cd.avg) }}>
                {cd.avg > 0 ? '+' : ''}
                {cd.avg}
              </div>
              <div className="cv-stat-l">{t('平均整體 valence')}</div>
            </div>
            <div className="cv-stat">
              <div className="cv-stat-n">
                {cd.delta > 0 ? '+' : ''}
                {cd.delta}
              </div>
              <div className="cv-stat-l">{t('變化（末−首）')}</div>
            </div>
            <div className="cv-stat">
              <div className="cv-stat-n">
                {cd.hi > 0 ? '+' : ''}
                {cd.hi}
                <small>
                  {' / '}
                  {cd.lo > 0 ? '+' : ''}
                  {cd.lo}
                </small>
              </div>
              <div className="cv-stat-l">{t('最高 / 最低')}</div>
            </div>
            <div className="cv-stat">
              <div className="cv-stat-n" style={{ fontSize: 15 }}>
                {DIM[cd.strong]}
              </div>
              <div className="cv-stat-l">{t('最強面向')}</div>
            </div>
          </div>
        )
      case 'trend':
        return (
          <div
            className="cv-chart-wrap"
            dangerouslySetInnerHTML={{
              __html: valLine([{ values: cd.ov, color: DIMCOLOR.M, width: 3, label: true }], s.length, xLabels),
            }}
          />
        )
      case 'dims':
        return (
          <>
            <div className="cv-legend">
              {KEYS.map((k) => legendItem(DIMCOLOR[k], `${k} · ${DIM[k]}`, k))}
            </div>
            <div
              className="cv-chart-wrap"
              dangerouslySetInnerHTML={{
                __html: valLine(
                  KEYS.map((k) => ({ values: s.map((x) => x.dims[k]?.v || 0), color: DIMCOLOR[k], width: 2 })),
                  s.length,
                  xLabels,
                ),
              }}
            />
          </>
        )
      case 'topics': {
        const topicLabels: Record<TopicKey, string> = {
          work: t('工作／學業'),
          relationships: t('關係'),
          health: t('健康'),
          rest: t('休息與恢復'),
          growth: t('自我成長'),
          other: t('其他'),
        }
        const hasTopicData = analysis.sessions.some((session) =>
          Object.values(session.topics ?? {}).some((value) => Number(value) > 0),
        )
        // 舊分析沒有 topics；本機開發模式提供清楚標示的版面預覽，方便在分析 API
        // 暫時不可用時仍能驗收圖表。正式 build 不會顯示或匯出這些模擬數值。
        const topicSessions =
          !hasTopicData && import.meta.env.DEV
            ? analysis.sessions.map((session, index, all) => {
                const progress = all.length <= 1 ? 0 : index / (all.length - 1)
                const work = Math.round(38 - progress * 18)
                const relationships = Math.round(18 + progress * 10)
                const health = 14
                const rest = Math.round(12 + progress * 8)
                const growth = Math.round(12 + progress * 2)
                return {
                  ...session,
                  topics: {
                    work,
                    relationships,
                    health,
                    rest,
                    growth,
                    other: 100 - work - relationships - health - rest - growth,
                  },
                }
              })
            : analysis.sessions
        return (
          <>
            <div
              className="cv-chart-wrap cv-topic-wrap"
              dangerouslySetInnerHTML={{
                __html: topicShareStacked(
                  topicSessions,
                  topicLabels,
                  (index) => (language === 'en' ? `W${index + 1}` : `第 ${index + 1} 週`),
                  t('重新生成分析後，即可查看每週主題占比。'),
                ),
              }}
            />
            {!hasTopicData && import.meta.env.DEV && (
              <div className="cv-preview-note">{t('本機版面預覽資料；重新生成分析後會換成日記分析結果。')}</div>
            )}
            <div className="cv-note">
              {t('每週合計為 100%，呈現日記內容的關注占比，不代表實際投入時間。')}
            </div>
          </>
        )
      }
      case 'radar':
        return (
          <>
            <div
              className="cv-chart-wrap cv-radar-wrap"
              dangerouslySetInnerHTML={{ __html: valRadar(cd.firstDim, cd.lastDim) }}
            />
            <div className="cv-legend" style={{ justifyContent: 'center' }}>
              {legendItem('#8993A1', base ? t('T0 基準（虛線）') : t('第一次（虛線）'))}
              {legendItem('#1F3A5C', t('最新一次'))}
            </div>
            <div className="cv-note">{t('內圈為 −100、中圈為 0（中性）、外圈為 +100。')}</div>
            <div dangerouslySetInnerHTML={{ __html: radarDelta(cd.firstDim, cd.lastDim) }} />
          </>
        )
      case 'cloud':
        return <div dangerouslySetInnerHTML={{ __html: emotionWordCloud(analysis.sessions) }} />
    }
    return null
  }

  if (checking) return null

  const visibleBlocks =
    analysis?.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => isAllowedBlock(block)) ?? []
  const includedBlocks = visibleBlocks.filter(({ block }) => block.include).map(({ block }) => block)
  const canonicalIsChinese =
    analysis?.blocks.some((block) =>
      String(block.title || '').trim().toLowerCase() === 'perma 五面向剖析',
    ) ?? false
  // 新資料繁中是 canonical；舊資料仍可使用既有 zh-TW 翻譯快取。
  const briefTr =
    briefLang === 'en' && canonicalIsChinese
      ? analysis?.translations?.en
      : briefLang === 'zh-TW' && !canonicalIsChinese
        ? analysis?.translations?.['zh-TW']
        : undefined
  const viewBlocks = briefTr?.blocks ?? analysis?.blocks ?? []
  const hasCurrentClientText = !!analysis?.client_text && !isLegacyClientText(analysis.client_text)
  // 「優勢與內在資源」區塊（跨全部週的綜合分析），顯示語言版供每週報告頂部概覽引用。
  const strengthsIndex = (analysis?.blocks ?? []).findIndex((b) =>
    ['優勢與內在資源', 'Strengths & Inner Resources'].includes(String(b.title || '').trim()),
  )
  const strengthsView = strengthsIndex >= 0 ? viewBlocks[strengthsIndex] ?? analysis?.blocks[strengthsIndex] : null

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
                disabled={busy !== null || posts.length < 1}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {busy === 'analyze' ? t('分析中…') : analysis ? t('重新生成分析') : t('生成情緒分析與情報簡報')}
              </button>
              {analysis && (
                <span className="text-xs text-muted-foreground">
                  {t('基於')} {analysis.based_on} {t('週')}
                </span>
              )}
              {posts.length < 1 && (
                <span className="text-xs text-muted-foreground">{t('至少需要 1 次書寫')}</span>
              )}
            </div>

            {analysis && analysis.sessions.length > 0 && (
              <>
                {/* 內文預設繁中；只有選取英文時才翻譯並快取。 */}
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
                    {open && renderChart(c.key)}
                  </div>
                  )
                })}
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
                      <span className="cv-block-title">{blockTitleForLanguage(b, briefLang)}</span>
                      {b.include && <span className="cv-block-tag inc">{t('納入客戶版')}</span>}
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
                                checked={b.include}
                                onChange={(e) => toggleBlock(i, e.target.checked)}
                              />
                              {t('納入客戶交付版')}
                            </label>
                            <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
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

                {/* AI 自訂框架：隨時可用，不必等到里程碑；生成的區塊會追加進上面的情報簡報 */}
                <FrameworkPanel
                  fwKey="brief"
                  desc={fwDesc.brief ?? ''}
                  draft={fwDraft.brief ?? null}
                  busy={fwBusy}
                  intro={t('用自己的話描述想分析什麼，AI 會依心理學文獻生成有理論依據的框架；你可以編輯後套用到這位成員的全部週記。')}
                  onDescChange={(v) => setFwDesc((p) => ({ ...p, brief: v }))}
                  onGenerate={() => generateFramework('brief')}
                  onPatch={(patch) => patchFw('brief', patch)}
                  onRun={runBriefFramework}
                  onCancel={() => setFwDraft((p) => ({ ...p, brief: null }))}
                  t={t}
                />
              </>
            )}
            </>
            )}
          </section>

          {/* ── 每週 PERMA 報告：每一份只使用該週內容，並與 T0 比較 ── */}
          {posts.length > 0 && (
            <section className="mb-8" id="sec-weekly-reports">
              <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('每週 PERMA 報告')}</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                {t('每份報告只根據該週的 P／E／R／M／A 內容分析，並與 T0 基準比較。')}
              </p>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={generateWeeklyReports}
                  disabled={weeklyBusy || !baseline}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {weeklyBusy
                    ? t('生成中…')
                    : weeklyReports.length > 0
                      ? t('重新生成每週報告')
                      : t('生成每週報告')}
                </button>
                {!baseline && <span className="text-xs text-muted-foreground">{t('需先設定並儲存 T0 基準點')}</span>}
              </div>
              {weeklyReports.length === 0 && (
                <p className="mb-3 text-sm text-muted-foreground">
                  {t('目前還沒有每週報告。按上方按鈕，即可為每個「五面向都填寫」的完整週各生成一份。')}
                </p>
              )}
              <div className="flex flex-col gap-3">
                {weeklyReports.map((report) => {
                  const open = openWeeklyReports.includes(report.week_number)
                  const session = report.content?.session
                  const reportBaseline = report.content?.baseline
                  const block = report.content?.block
                  return (
                    <article key={`${report.week_start}-${report.week_number}`} className="cv-block">
                      <button
                        type="button"
                        className="cv-block-hd w-full text-left"
                        onClick={() =>
                          setOpenWeeklyReports((current) =>
                            current.includes(report.week_number)
                              ? current.filter((week) => week !== report.week_number)
                              : [...current, report.week_number],
                          )
                        }
                      >
                        <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
                          ▶
                        </span>
                        <span className="cv-block-title">
                          {language === 'zh-TW' ? `第 ${report.week_number} 週` : `Week ${report.week_number}`} ·{' '}
                          {report.week_start}
                        </span>
                        <span className={`cv-block-tag ${report.report_emailed_at ? 'inc' : ''}`}>
                          {report.report_emailed_at ? t('已寄送') : t('等待寄送')}
                        </span>
                      </button>
                      {open && session && reportBaseline && block && (
                        <div className="cv-block-body">
                          {(() => {
                            // 單週圖表：雷達（T0 vs 本週）、本週主題占比、本週情緒詞雲。
                            // 「五面向趨勢」需跨多週，單週由雷達涵蓋五面向對比，故不重複。
                            const t0Dims = Object.fromEntries(
                              KEYS.map((key) => [key, baselineToValence(reportBaseline[key])]),
                            ) as Record<DimKey, number>
                            const weekDims = Object.fromEntries(
                              KEYS.map((key) => [key, session.dims?.[key]?.v ?? 0]),
                            ) as Record<DimKey, number>
                            const topicLabels: Record<TopicKey, string> = {
                              work: t('工作／學業'),
                              relationships: t('關係'),
                              health: t('健康'),
                              rest: t('休息與恢復'),
                              growth: t('自我成長'),
                              other: t('其他'),
                            }
                            const hasTopics = Object.values(session.topics ?? {}).some((v) => Number(v) > 0)
                            const hasEmotions = (session.emotions ?? []).length > 0
                            return (
                              <>
                                <div className="cv-slbl">
                                  <span>{t('五面向 valence 剖面')}</span>
                                </div>
                                <div
                                  className="cv-chart-wrap"
                                  style={{ display: 'flex', justifyContent: 'center' }}
                                  dangerouslySetInnerHTML={{ __html: valRadar(t0Dims, weekDims) }}
                                />
                                <div className="cv-legend mb-3" style={{ justifyContent: 'center' }}>
                                  <span>
                                    <i style={{ background: '#8993A1' }} />
                                    {t('T0 基準（虛線）')}
                                  </span>
                                  <span>
                                    <i style={{ background: '#1F3A5C' }} />
                                    {t('本週')}
                                  </span>
                                </div>
                                {hasTopics && (
                                  <>
                                    <div className="cv-slbl">
                                      <span>{t('本週主題占比')}</span>
                                    </div>
                                    <div
                                      className="cv-chart-wrap mb-3"
                                      style={{ display: 'flex', justifyContent: 'center' }}
                                      dangerouslySetInnerHTML={{
                                        __html: topicSharePie(
                                          session.topics,
                                          topicLabels,
                                          t('這週沒有可用的主題資料。'),
                                        ),
                                      }}
                                    />
                                  </>
                                )}
                                {hasEmotions && (
                                  <>
                                    <div className="cv-slbl">
                                      <span>{t('本週情緒詞雲')}</span>
                                    </div>
                                    <div
                                      className="mb-3"
                                      dangerouslySetInnerHTML={{ __html: emotionWordCloud([session]) }}
                                    />
                                  </>
                                )}
                              </>
                            )
                          })()}
                          <div className="cv-md" dangerouslySetInnerHTML={{ __html: mdToHtml(block.body) }} />
                          {/* 優勢與內在資源（跨全部週的綜合分析）：每份週報告都附上，作為教練會談的優勢視角 */}
                          {strengthsView && (
                            <>
                              <div className="cv-slbl" style={{ marginTop: 16 }}>
                                <span>{t('優勢與內在資源')}</span>
                              </div>
                              <div className="cv-md" dangerouslySetInnerHTML={{ __html: mdToHtml(strengthsView.body) }} />
                            </>
                          )}
                          {/* 上面的圖表是教練專用視角；客戶收到的信只有文字＋PDF 附件，用這顆按鈕看實際內容 */}
                          <div className="cv-block-actions">
                            <span className="text-[11px] text-muted-foreground">
                              {t('上方圖表僅教練可見，客戶收到的是下列信件與 PDF。')}
                            </span>
                            <button
                              type="button"
                              onClick={() => openWeeklyPreview(report.week_start)}
                              disabled={previewBusy !== null}
                              className="rounded-md border border-border px-3 py-1 text-xs font-semibold text-foreground-soft disabled:opacity-50"
                            >
                              {previewBusy === report.week_start
                                ? t('載入中…')
                                : t('預覽客戶收到的信與 PDF')}
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          )}

          {/* ── 月報告（第 4／第 8 週）：跨週回顧＋可用 AI 框架追加內容 ── */}
          {posts.length > 0 && (
            <section className="mb-8" id="sec-monthly-reports">
              <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('每月 PERMA 報告')}</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                {t('第 4 週回顧第 1–4 週、第 8 週回顧第 1–8 週，並與 T0 基準比較；僅教練可見。')}
              </p>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={generateMonthlyReports}
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
                <p className="mb-3 text-sm text-muted-foreground">
                  {t('目前還沒有月報告。完成 4 週或 8 週後，按上方按鈕即可生成。')}
                </p>
              )}
              <div className="flex flex-col gap-3">
                {monthlyReports.map((report) => {
                  const m = report.milestone_week
                  const open = openMonthly.includes(m)
                  const sessions = report.content?.sessions ?? []
                  const blocks = report.content?.blocks ?? []
                  const rb = report.content?.baseline
                  const draft = fwDraft[m] ?? null
                  return (
                    <article key={m} className="cv-block">
                      <button
                        type="button"
                        className="cv-block-hd w-full text-left"
                        onClick={() =>
                          setOpenMonthly((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]))
                        }
                      >
                        <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
                          ▶
                        </span>
                        <span className="cv-block-title">
                          {language === 'zh-TW' ? `第 ${m} 週月報告` : `Month report · week ${m}`}
                          {report.week_start_from ? ` · ${report.week_start_from} → ${report.week_start_to}` : ''}
                        </span>
                        <span className="cv-block-tag">
                          {language === 'zh-TW'
                            ? `第 1–${m} 週`
                            : `weeks 1–${m}`}
                        </span>
                      </button>
                      {open && (
                        <div className="cv-block-body">
                          {sessions.length > 0 && rb && (() => {
                            const t0Dims = Object.fromEntries(
                              KEYS.map((k) => [k, baselineToValence(rb[k])]),
                            ) as Record<DimKey, number>
                            const lastDims = Object.fromEntries(
                              KEYS.map((k) => [k, sessions[sessions.length - 1]?.dims?.[k]?.v ?? 0]),
                            ) as Record<DimKey, number>
                            const xLabels = ['T0', ...sessions.map((_, i) => String(i + 1))]
                            return (
                              <>
                                <div className="cv-slbl">
                                  <span>{t('五面向 valence 趨勢')}</span>
                                </div>
                                <div className="cv-legend">
                                  {KEYS.map((k) => (
                                    <span key={k}>
                                      <i style={{ background: DIMCOLOR[k] }} />
                                      {k} · {DIM[k]}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className="cv-chart-wrap mb-3"
                                  dangerouslySetInnerHTML={{
                                    __html: valLine(
                                      KEYS.map((k) => ({
                                        values: [t0Dims[k], ...sessions.map((s) => s.dims?.[k]?.v ?? 0)],
                                        color: DIMCOLOR[k],
                                        width: 2,
                                      })),
                                      sessions.length + 1,
                                      xLabels,
                                    ),
                                  }}
                                />
                                <div className="cv-slbl">
                                  <span>{t('五面向 valence 剖面')}</span>
                                </div>
                                <div
                                  className="cv-chart-wrap mb-1"
                                  style={{ display: 'flex', justifyContent: 'center' }}
                                  dangerouslySetInnerHTML={{ __html: valRadar(t0Dims, lastDims) }}
                                />
                                <div className="cv-legend mb-3" style={{ justifyContent: 'center' }}>
                                  <span>
                                    <i style={{ background: '#8993A1' }} />
                                    {t('T0 基準（虛線）')}
                                  </span>
                                  <span>
                                    <i style={{ background: '#1F3A5C' }} />
                                    {t('最新一次')}
                                  </span>
                                </div>
                              </>
                            )
                          })()}

                          {blocks.map((b, bi) => (
                            <div key={bi} className="mb-3">
                              <div className="cv-slbl">
                                <span>
                                  {b.title}
                                  {b.custom ? `　（${t('AI 框架')}）` : ''}
                                </span>
                              </div>
                              <div className="cv-md" dangerouslySetInnerHTML={{ __html: mdToHtml(b.body) }} />
                            </div>
                          ))}

                          {/* AI 框架：教練描述想分析什麼 → 生成框架 → 追加成新的分析內容 */}
                          <FrameworkPanel
                            fwKey={String(m)}
                            desc={fwDesc[String(m)] ?? ''}
                            draft={draft}
                            busy={fwBusy}
                            intro={t('用自己的話描述想分析什麼，AI 會依心理學文獻生成有理論依據的框架；你可以編輯後套用到這段期間。')}
                            onDescChange={(v) => setFwDesc((p) => ({ ...p, [String(m)]: v }))}
                            onGenerate={() => generateFramework(String(m))}
                            onPatch={(patch) => patchFw(String(m), patch)}
                            onRun={() => runMonthlyFramework(m)}
                            onCancel={() => setFwDraft((p) => ({ ...p, [String(m)]: null }))}
                            t={t}
                          />
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
                    : hasCurrentClientText
                      ? t('重新生成客戶版')
                      : t('生成客戶交付版')}
                </button>
                {hasCurrentClientText && !editClient && (
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
              {hasCurrentClientText && editClient && (
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
              {hasCurrentClientText && !editClient && (
                <div className="cv-doc" id="cv-print-area">
                  <div className="cv-doc-head">
                    <div className="cv-doc-title">{t('個人福祉回顧')}</div>
                    <div className="cv-doc-meta">
                      {name}　·　{analysis.client_date}
                    </div>
                  </div>
                  <div dangerouslySetInnerHTML={{ __html: mdToHtml(analysis.client_text || '') }} />
                  {CHART_DEFS.some((c) => analysis.client_charts?.[c.key]) && (
                    <div className="cv-doc-charts">
                      {CHART_DEFS.filter((c) => analysis.client_charts?.[c.key]).map((c, idx) => (
                        <div key={c.key} className="cv-doc-chart">
                          {idx === 0 && <h2 className="cv-doc-chart-h">{t('情緒歷程一覽')}</h2>}
                          <div className="cv-slbl">
                            <span>{t(c.title)}</span>
                          </div>
                          {renderChart(c.key)}
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

      {/* 客戶視角預覽：信件內文與 PDF 附件都由後端用「寄送時同一組函式」重建，所見即客戶所得 */}
      {preview && (
        <div className="cv-modal" role="dialog" aria-modal="true" onMouseDown={() => setPreview(null)}>
          <div className="cv-modal-box" onMouseDown={(e) => e.stopPropagation()}>
            <div className="cv-modal-hd">
              <strong>{t('客戶收到的內容')}</strong>
              <button type="button" className="cv-modal-x" onClick={() => setPreview(null)}>
                ×
              </button>
            </div>
            <div className="cv-modal-body">
              <div className="cv-mailmeta">
                <div>
                  <span>{t('收件者')}</span>
                  {preview.recipient_name}
                  {preview.recipient_email ? `　<${preview.recipient_email}>` : ''}
                </div>
                <div>
                  <span>{t('主旨')}</span>
                  {preview.subject}
                </div>
                <div>
                  <span>{t('附件')}</span>
                  {preview.pdf_filename}
                </div>
                {!preview.emailed_at && (
                  <div className="cv-mailnote">{t('這一週尚未實際寄出，以下為將寄出的內容。')}</div>
                )}
              </div>
              <div className="cv-mailbody" dangerouslySetInnerHTML={{ __html: preview.email_html }} />
              {/* PDF 直接內嵌顯示；另附下載連結，避免瀏覽器內建檢視器不可用時看不到內容 */}
              <div className="cv-slbl" style={{ marginTop: 16 }}>
                <span>{t('PDF 附件')}</span>
                {previewPdfUrl && (
                  <a
                    href={previewPdfUrl}
                    download={preview.pdf_filename}
                    className="cv-block-edit"
                    style={{ textTransform: 'none', letterSpacing: 'normal' }}
                  >
                    {t('下載 PDF')}
                  </a>
                )}
              </div>
              {previewPdfUrl && <iframe src={previewPdfUrl} className="cv-pdfframe" title={preview.pdf_filename} />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// coachViz 產出的 HTML 片段用的樣式（cv-* 命名空間，避免與 Tailwind 衝突）
const COACH_VIZ_CSS = `
.cv-slbl{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:11px;font-weight:800;color:#8993A1;letter-spacing:.09em;text-transform:uppercase;margin:22px 0 9px;padding-bottom:6px;border-bottom:1.5px solid #E2E5EA}
.cv-slbl>span{flex:1}
.cv-inc{font-size:11px;font-weight:700;color:#54606E;text-transform:none;letter-spacing:0;display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;white-space:nowrap}
.cv-inc input{width:14px;height:14px;accent-color:#1F3A5C;cursor:pointer;margin:0}
.cv-chart-wrap{overflow-x:auto;padding:4px 0}
.cv-chart-wrap svg{max-width:none;height:auto}
/* 客戶視角預覽對話框 */
.cv-modal{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(28,37,48,.42)}
.cv-modal-box{width:100%;max-width:640px;max-height:86vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 18px 48px rgba(28,37,48,.24);overflow:hidden}
.cv-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:#EEF0F3;border-bottom:1.5px solid #E2E5EA;font-size:13.5px;color:#1C2530}
.cv-modal-x{border:none;background:none;font-size:20px;line-height:1;color:#8993A1;cursor:pointer;padding:0 4px}
.cv-modal-x:hover{color:#1C2530}
.cv-modal-body{padding:16px;overflow-y:auto}
.cv-mailmeta{font-size:12px;color:#54606E;line-height:1.9;padding:11px 13px;background:#EEF0F3;border-radius:8px;margin-bottom:12px}
.cv-mailmeta span{display:inline-block;min-width:58px;font-weight:700;color:#8993A1}
.cv-mailnote{margin-top:5px;color:#8A6A26;font-weight:700}
.cv-mailbody{font-size:13.5px;line-height:1.85;color:#2B3440;border:1.5px solid #E2E5EA;border-radius:8px;padding:14px 16px}
.cv-mailbody p{margin:0 0 10px}
.cv-mailbody ul{margin:6px 0 12px 20px;list-style:disc}
.cv-mailbody li{margin-bottom:4px}
.cv-pdfframe{width:100%;height:520px;border:1.5px solid #E2E5EA;border-radius:8px;background:#EEF0F3}
.cv-topic-wrap svg{display:block;max-width:100%;height:auto}
/* 雷達圖置中：Tailwind preflight 把所有 svg 設成 display:block（非預設的 inline），
   所以父層的 text-align:center 完全沒有作用——這才是一直沒置中的真正原因。
   block 元素本來就該用 margin:auto 置中，不需要 flex 或其他花招。 */
.cv-radar-wrap svg{margin:0 auto}
.cv-legend{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 2px;font-size:11.5px;font-weight:700;line-height:1.35}
.cv-legend-item-svg{display:block;flex:none;height:18px;overflow:visible}
.cv-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:6px 0}
@media(max-width:620px){.cv-stats{grid-template-columns:repeat(2,1fr)}}
.cv-stat{background:#fff;border:1.5px solid #E2E5EA;border-radius:9px;padding:14px 12px}
.cv-stat-n{font-size:21px;font-weight:800;color:#1C2530;font-variant-numeric:tabular-nums;line-height:1.1}
.cv-stat-n small{font-size:11px;color:#8993A1;font-weight:700}
.cv-stat-l{font-size:10.5px;color:#8993A1;margin-top:5px}
.cv-rdelta{border:1.5px solid #E2E5EA;border-radius:10px;margin-top:8px;overflow:hidden}
.cv-rdelta-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #E2E5EA;font-size:12.5px}
.cv-rdelta-row:last-child{border-bottom:none}
.cv-rdelta-key{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;line-height:1;text-align:center;flex-shrink:0;font-family:Arial,-apple-system,'PingFang TC','Noto Sans TC',sans-serif}
.cv-rdelta-name{font-weight:700;flex:1}
.cv-rdelta-val{font-variant-numeric:tabular-nums;color:#54606E;font-weight:600;white-space:nowrap}
.cv-rdelta-tag-svg{width:82px;height:26px;display:block;flex:0 0 82px;overflow:visible}
.cv-wcloud{display:flex;flex-wrap:wrap;justify-content:center;align-items:baseline;gap:5px 18px;padding:28px 22px;line-height:1.35;background:#EEF0F3;border:1.5px solid #E2E5EA;border-radius:12px}
.cv-wcloud span{white-space:nowrap}
.cv-note{font-size:11.5px;color:#54606E;line-height:1.7;padding:12px 15px;background:#EEF0F3;border-radius:8px;margin-top:10px}
.cv-vrow{border:1.5px solid #E2E5EA;border-radius:9px;margin-bottom:9px;overflow:hidden}
.cv-vrow-hd{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#EEF0F3;cursor:pointer}
.cv-vrow-n{font-size:12px;font-weight:800;color:#1C2530}
.cv-vrow-date{font-size:11px;color:#8993A1}
.cv-vbadge{font-size:11.5px;font-weight:800;padding:3px 11px;border-radius:20px;margin-left:auto;font-variant-numeric:tabular-nums}
.cv-vrow-body{padding:14px;border-top:1.5px solid #E2E5EA}
.cv-caret{font-size:11px;color:#8993A1;transition:transform .2s}
.cv-vrow.open .cv-caret{transform:rotate(90deg)}
.cv-vreason{font-size:12.5px;line-height:1.75;color:#2B3440;margin-bottom:12px;padding:10px 13px;background:#EEF0F3;border-radius:7px;border-left:3px solid #1F3A5C}
.cv-vdim{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #E2E5EA}
.cv-vdim:last-child{border-bottom:none}
.cv-vdim-key{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;display:inline-block;line-height:20px;text-align:center;flex-shrink:0;font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif}
.cv-vdim-name{font-size:12px;font-weight:700;width:150px;flex-shrink:0}
.cv-vdim-v{font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;width:42px;flex-shrink:0}
.cv-vdim-reason{font-size:11.5px;color:#54606E;line-height:1.5;flex:1}
.cv-emos{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.cv-emo{font-size:12px;font-weight:700;padding:5px 12px;border-radius:6px;border:1.5px solid}
.cv-emo.positive{background:#D9E7E0;border-color:#BCD3C8;color:#2E7057}
.cv-emo.negative{background:#F0E0D6;border-color:#E1C3B1;color:#B0542C}
.cv-emo.neutral{background:#EAECF0;border-color:#CBD1DA;color:#54606E}
.cv-block{border:1.5px solid #E2E5EA;border-radius:10px;margin-bottom:12px;overflow:hidden;background:#fff}
.cv-block-hd{display:flex;align-items:center;gap:10px;padding:12px 15px;background:#EEF0F3;border-bottom:1.5px solid #E2E5EA}
.cv-block-title{font-size:13.5px;font-weight:800;color:#1C2530;flex:1}
.cv-block-tag{font-size:10px;font-weight:800;letter-spacing:.04em;padding:3px 9px;border-radius:5px;text-transform:uppercase}
.cv-block-tag.inc{background:#D9E7E0;color:#2E7057;border:1.5px solid #BCD3C8}
.cv-block-tag.preview{background:#E7ECF5;color:#1F3A5C;border:1.5px solid #B9C6DE}
.cv-block-tags{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.cv-block-body{padding:14px 16px}
.cv-preview-note{font-size:11.5px;color:#54606E;line-height:1.6;padding:9px 12px;background:#EEF0F3;border-left:3px solid #8993A1;margin:8px 0 10px}
.cv-md{font-size:13px;line-height:1.8;color:#2B3440}
.cv-md p{margin:0 0 9px}
.cv-md h2,.cv-md h3{font-size:14px;font-weight:800;margin:13px 0 6px;color:#1C2530}
.cv-md strong{font-weight:800;color:#8A6A26}
.cv-md em{color:#54606E}
.cv-block-actions{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid #E2E5EA;justify-content:space-between}
.cv-block-edit{font-size:11.5px;font-weight:700;color:#1F3A5C;cursor:pointer}
.cv-block-edit:hover{text-decoration:underline}
.cv-textarea{width:100%;min-height:140px;border:1.5px solid #CBD1DA;border-radius:7px;padding:11px 13px;font-size:13px;font-family:inherit;line-height:1.7;color:#2B3440;resize:vertical}
.cv-doc{background:#fff;border:1.5px solid #E2E5EA;border-radius:10px;padding:34px 38px;line-height:1.95;color:#1C2530;font-family:'Songti TC','Noto Serif TC',Georgia,serif}
@media(max-width:560px){.cv-doc{padding:24px 22px}}
/* PDF 一律用同一個可量測的桌面版面；不可用 visibility:hidden/display:none，否則 SVG 尺寸會變成 0。 */
.cv-pdf-export{position:relative!important;width:720px!important;box-sizing:border-box!important;margin:0!important;border:0!important;border-radius:0!important;padding:34px 38px!important;background:#fff!important}
.cv-pdf-export .cv-stats{grid-template-columns:repeat(4,1fr)!important}
.cv-doc-head{text-align:center;padding-bottom:20px;margin-bottom:22px;border-bottom:2px solid #1C2530}
.cv-doc-title{font-size:22px;font-weight:800;margin:0 0 4px;letter-spacing:.02em}
.cv-doc-meta{font-size:12px;color:#54606E}
.cv-doc h2,.cv-doc h3{color:#1C2530}
.cv-doc h2{font-size:16px;font-weight:800;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid #E2E5EA}
.cv-doc h3{font-size:14px;font-weight:800;margin:16px 0 6px}
.cv-doc p{margin:0 0 12px;font-size:14px}
.cv-doc strong{font-weight:800;color:#8A6A26}
.cv-doc-sign{margin-top:26px;padding-top:16px;border-top:1px solid #E2E5EA;font-size:13px;color:#54606E}
.cv-doc-charts{margin-top:8px;font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif}
/* 客戶文件內的圖表要縮進頁寬，避免 PDF／Word 右側被裁切、比例跑掉。
   SVG 有 viewBox，設 max-width:100%+height:auto 即等比縮放至容器寬；窄圖（雷達）維持原寸。 */
.cv-doc-charts .cv-chart-wrap{overflow:visible;text-align:center}
.cv-doc-charts .cv-chart-wrap svg{max-width:100% !important;height:auto !important}
/* 雷達圖固定尺寸，PDF/Word 匯出時不要被上面那條縮放規則影響——懷疑 html2canvas 對
   「縮到 100% 寬度」這個縮放算不準，導致內容被裁切而非等比縮小，先讓它維持原寸排除這個變因。 */
.cv-doc-charts .cv-radar-wrap svg{max-width:none !important;width:280px !important;height:294px !important}
/* 圖表接續正文流動排版；單一圖表本身不可從中間被切
   （避免雷達與 A/P/M/R/E 清單分到不同頁），也避免正文很短時留下大面積空白頁。 */
.cv-doc-chart{break-inside:avoid;page-break-inside:avoid;margin-bottom:30px}
.cv-doc-chart-h{margin-top:0 !important}
.cv-rdelta,.cv-stats,.cv-wcloud,.cv-rdelta-row{break-inside:avoid;page-break-inside:avoid}
.cv-pdf-export h2,.cv-pdf-export h3{break-after:avoid;page-break-after:avoid}
.cv-pdf-export p,.cv-pdf-export li,.cv-pdf-export .cv-doc-head,.cv-pdf-export .cv-doc-sign{break-inside:avoid;page-break-inside:avoid}
/* PDF 中的雷達明細採緊湊行高；避免 PDF viewer 放大後每列看起來像獨佔一個大區塊。 */
.cv-pdf-export .cv-rdelta-row{padding:7px 12px;font-size:11.5px;gap:8px}
.cv-pdf-export .cv-rdelta-key{width:18px;height:18px;box-sizing:border-box}
.cv-pdf-export .cv-rdelta-tag-svg{width:82px;height:26px;flex-basis:82px}
.cv-word-export{position:relative!important;width:644px!important;box-sizing:border-box!important;margin:0!important;padding:0 2px 10px!important;background:#fff!important}
.cv-word-export .cv-chart-wrap{overflow:visible!important}
.cv-word-export .cv-chart-wrap svg{max-width:100%!important;height:auto!important}
.cv-md{font-size:13.5px;line-height:1.85}
.cv-md h2,.cv-md h3{margin:16px 0 7px}
/* 真正的列點：實心圓點／數字，而非單純換行 —— cv-md（教練簡報）與 cv-doc（客戶文件）共用 */
.cv-md ul,.cv-doc ul{list-style:none;margin:8px 0 14px;padding:0}
.cv-md ul li,.cv-doc ul li{position:relative;padding-left:20px;margin-bottom:7px;line-height:1.7}
.cv-md ul li::before,.cv-doc ul li::before{content:'';position:absolute;left:3px;top:.68em;width:5px;height:5px;border-radius:50%;background:#8993A1}
.cv-md ol,.cv-doc ol{list-style:none;counter-reset:cvol;margin:8px 0 14px;padding:0}
.cv-md ol li,.cv-doc ol li{position:relative;counter-increment:cvol;padding-left:24px;margin-bottom:7px;line-height:1.7}
.cv-md ol li::before,.cv-doc ol li::before{content:counter(cvol) '.';position:absolute;left:0;top:0;font-weight:800;color:#1F3A5C;font-variant-numeric:tabular-nums}
/* 巢狀子條列：縮排一層、標記縮小變淺，清楚區分「維度標籤」與其下的證據 */
.cv-md li>ul,.cv-doc li>ul,.cv-md li>ol,.cv-doc li>ol{margin:6px 0 2px}
.cv-md li>ul>li,.cv-doc li>ul>li{padding-left:17px}
.cv-md li>ul>li::before,.cv-doc li>ul>li::before{width:4px;height:4px;background:#B9C0CB}
.cv-md li>ol>li,.cv-doc li>ol>li{padding-left:20px;font-size:.96em}
/* 章節導覽側欄（sticky，隨捲動高亮目前章節） */
[id^="sec-"]{scroll-margin-top:20px}
.cv-toc{position:sticky;top:24px;display:flex;flex-direction:column;gap:2px;width:172px;flex-shrink:0;max-height:calc(100vh - 48px);overflow-y:auto}
.cv-toc-link{font-size:12.5px;font-weight:700;color:#8993A1;padding:7px 10px;border-radius:7px;text-decoration:none;border-left:2px solid transparent;transition:color .15s,background-color .15s}
.cv-toc-link:hover{color:#1C2530;background:#EEF0F3}
.cv-toc-link.active{color:#1F3A5C;font-weight:800;background:#EEF0F3;border-left-color:#1F3A5C}
.cv-toc-sub{padding-left:20px;font-size:11.5px;font-weight:600}
@media(max-width:1024px){.cv-toc{display:none}}
/* 自訂分析框架編輯器 */
.cv-block-tag.ai{background:#E7ECF5;color:#1F3A5C;border:1.5px solid #B9C6DE}
.cv-block-del{font-size:11.5px;font-weight:700;color:#B0542C;cursor:pointer}
.cv-block-del:hover{text-decoration:underline}
.cv-fw-intro{border:1.5px solid #E2E5EA;background:#FAFAF8;border-radius:10px;padding:15px 16px;margin-bottom:14px}
.cv-fw{border:1.5px solid #B5843A;background:#FBF7EE;border-radius:10px;padding:15px 16px;margin-bottom:14px}
.cv-fw-hd{font-size:12.5px;font-weight:800;color:#1C2530;margin-bottom:11px}
.cv-fw-lab{display:block;font-size:11.5px;font-weight:700;color:#54606E;margin:8px 0 4px}
.cv-fw-in{width:100%;border:1.5px solid #CBD1DA;border-radius:7px;padding:8px 11px;font-size:12.5px;font-family:inherit;line-height:1.5;color:#2B3440;background:#fff;margin-bottom:6px}
.cv-fw-in:focus{outline:none;border-color:#B5843A}
.cv-fw-dim{position:relative;border:1px dashed #CBD1DA;border-radius:8px;padding:10px 34px 4px 11px;margin-bottom:8px;background:#fff}
.cv-fw-del{position:absolute;top:8px;right:9px;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:#8993A1;cursor:pointer;font-size:16px;line-height:1}
.cv-fw-del:hover{background:#F0E0D6;color:#B0542C}
.cv-fw-add{font-size:12px;font-weight:700;color:#1F3A5C;cursor:pointer;background:none;border:none;padding:2px 0}
.cv-fw-add:hover{text-decoration:underline}
.cv-fw-refs{margin-top:10px;font-size:11.5px;color:#54606E}
.cv-fw-refs ul{margin:4px 0 0 18px}
.cv-fw-refs li{margin-bottom:3px;line-height:1.5}
.cv-fw-note{margin-top:10px;font-size:11.5px;color:#8A6A26;background:#F6EEDC;border-radius:6px;padding:8px 11px}
/* #3 列印：只輸出客戶報告（Personal Well-being Review），不印整頁 */
@media print{
  body *{visibility:hidden !important}
  #cv-print-area,#cv-print-area *{visibility:visible !important}
  #cv-print-area{position:absolute;left:0;top:0;width:100%;margin:0;border:none;box-shadow:none;padding:0 8mm}
}
`
