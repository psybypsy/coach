import { useEffect, useState } from 'react'
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
  vLabel,
  valLine,
  valRadar,
  radarDelta,
  affectBalance,
  emotionWordCloud,
  type SessionScore,
  type DimKey,
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
  updated_at: string
}

const CHART_DEFS: { key: string; title: string }[] = [
  { key: 'summary', title: '情緒 valence 摘要' },
  { key: 'trend', title: '整體情緒 valence 趨勢' },
  { key: 'dims', title: '五面向 valence 趨勢' },
  { key: 'radar', title: '五面向 valence 剖面' },
  { key: 'affect', title: '正負情緒平衡' },
  { key: 'cloud', title: '情緒詞雲' },
]

// ── 極簡 Markdown → HTML（** 粗體、* 斜體、## 標題、- 條列）──
function mdToHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '<em>$1</em>')
  const lines = String(md || '').split('\n')
  let h = ''
  let inList = false
  for (const line of lines) {
    const l = line.trim()
    if (/^[-*] /.test(l)) {
      if (!inList) {
        h += '<ul>'
        inList = true
      }
      h += '<li>' + inline(l.slice(2)) + '</li>'
      continue
    }
    if (inList) {
      h += '</ul>'
      inList = false
    }
    const hm = l.match(/^#{1,3} /)
    if (hm) {
      const lvl = hm[0].trim().length
      h += `<h${lvl}>` + inline(l.replace(/^#+ /, '')) + `</h${lvl}>`
    } else if (l) {
      h += '<p>' + inline(l) + '</p>'
    }
  }
  if (inList) h += '</ul>'
  return h
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
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'analyze' | 'client' | 'translate' | 'framework' | null>(null)
  // 自訂分析框架：描述 → AI 生成可編輯的框架草稿 → 用它分析
  const [fwDesc, setFwDesc] = useState('')
  const [fwDraft, setFwDraft] = useState<Framework | null>(null)
  // 教練簡報內文顯示語言：預設英文（原生生成語言）；中文為即時翻譯的快取版
  const [briefLang, setBriefLang] = useState<'en' | 'zh-TW'>('en')
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [openBlocks, setOpenBlocks] = useState<number[]>([])
  // 圖表模塊預設展開；收起的 key 記在這裡（#6：所有模塊都可展開／收合）
  const [collapsedCharts, setCollapsedCharts] = useState<string[]>([])
  const [editBlock, setEditBlock] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  // 客戶交付版可直接行內編輯（存進 coach_analyses.client_text）
  const [editClient, setEditClient] = useState(false)
  const [clientEditText, setClientEditText] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void guardAndLoad()
  }, [id])

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
    const [{ data: profile }, { data: entryRows }, { data: postRows }, { data: analysisRow }] =
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
      ])
    setName(profile?.display_name ?? '')
    setEntries((entryRows as unknown as EntryRow[]) ?? [])
    setPosts((postRows as unknown as JournalPost[]) ?? [])
    setAnalysis((analysisRow as unknown as CoachAnalysis) ?? null)
    setLoading(false)
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
        setBriefLang('en') // 新內容、翻譯已作廢，回到英文
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

  // 切換教練簡報內文語言：英文即時切；中文若無快取則呼叫後端翻譯一次
  async function switchBriefLang(target: 'en' | 'zh-TW') {
    if (target === 'en') {
      setBriefLang('en')
      return
    }
    if (analysis?.translations?.['zh-TW']) {
      setBriefLang('zh-TW')
      return
    }
    setBusy('translate')
    setMessage(null)
    try {
      const resp = await authFetch('/api/coach/translate', { member_id: id, target: 'zh-TW' })
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
        setBriefLang('en') // 新增區塊、翻譯快取已作廢，回到英文
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

  // #3 下載 PDF：直接把「客戶報告」那份文件轉成 PDF 下載（不經列印對話框）。
  // 整份等比縮進 A4 寬度，所以不會有文字被裁切的問題。
  function downloadClientPdf() {
    const el = document.getElementById('cv-print-area')
    if (!el) return
    // 固定 720px 寬輸出：確保每張圖（尤其雷達＋A/P/M/R/E 清單）在任何視窗寬度下都各自容進一頁 A4
    const prevWidth = el.style.width
    el.style.width = '720px'
    const restore = () => {
      el.style.width = prevWidth
    }
    void html2pdf()
      .set({
        margin: [12, 12, 14, 12],
        filename: 'Personal-Well-being-Review.pdf', // 純 ASCII，避免檔名特殊字元讓下載失效
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 1.5, useCORS: true, backgroundColor: '#ffffff', logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        // 圖表區另起一頁；圖表間依序流動排版，只有 avoid 擋住整塊圖（含雷達 A/P/M/R/E 清單）被從中間切開
        pagebreak: {
          mode: ['css', 'legacy'],
          before: ['.cv-doc-charts'],
          avoid: ['.cv-doc-chart', '.cv-rdelta', '.cv-stats', '.cv-wcloud'],
        },
      })
      .from(el)
      .save()
      .then(restore, restore)
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
    // 需 coachViz 的 SVG 帶 xmlns 才能被 html2canvas 光柵化（見 coachViz.ts）。
    const chartParagraphs: InstanceType<typeof Paragraph>[] = []
    const chartEls = [...document.querySelectorAll('#cv-print-area .cv-doc-chart')] as HTMLElement[]
    if (chartEls.length) {
      try {
        const html2canvas = (await import('html2canvas')).default
        const maxW = 600 // A4 內文寬度上限（px）
        const maxH = 780 // A4 內文高度上限（px），確保一張圖不溢出到下一頁
        for (const el of chartEls) {
          const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false })
          const buf = await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer()
          let w = Math.min(maxW, canvas.width / 2)
          let h = (canvas.height / canvas.width) * w
          if (h > maxH) {
            w = (w * maxH) / h
            h = maxH
          }
          chartParagraphs.push(
            new Paragraph({
              pageBreakBefore: true, // 每張圖各自一頁
              children: [new ImageRun({ type: 'png', data: buf, transformation: { width: Math.round(w), height: Math.round(h) } })],
            }),
          )
        }
      } catch {
        // 截圖失敗就略過圖表，仍輸出文字版
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
              children: [new TextRun({ text: t('教練　陳郁敏'), size: 22, color: '54606E' })],
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
    a.click()
    URL.revokeObjectURL(url)
  }

  function toggleBlockOpen(i: number) {
    setOpenBlocks((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))
  }

  function toggleChartOpen(key: string) {
    setCollapsedCharts((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
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
    const s = analysis.sessions
    const cd = chartData(s)
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
              __html: valLine([{ values: cd.ov, color: DIMCOLOR.M, width: 3, label: true }], s.length),
            }}
          />
        )
      case 'dims':
        return (
          <>
            <div className="cv-legend">
              {KEYS.map((k) => (
                <span key={k}>
                  <i style={{ background: DIMCOLOR[k] }} />
                  {k} · {DIM[k]}
                </span>
              ))}
            </div>
            <div
              className="cv-chart-wrap"
              dangerouslySetInnerHTML={{
                __html: valLine(
                  KEYS.map((k) => ({ values: s.map((x) => x.dims[k]?.v || 0), color: DIMCOLOR[k], width: 2 })),
                  s.length,
                ),
              }}
            />
          </>
        )
      case 'radar':
        return (
          <>
            <div
              className="cv-chart-wrap"
              style={{ textAlign: 'center' }}
              dangerouslySetInnerHTML={{ __html: valRadar(cd.firstDim, cd.lastDim) }}
            />
            <div className="cv-legend" style={{ justifyContent: 'center' }}>
              <span>
                <i style={{ background: '#8993A1' }} />
                {t('第一次（虛線）')}
              </span>
              <span>
                <i style={{ background: '#1F3A5C' }} />
                {t('最新一次')}
              </span>
            </div>
            <div className="cv-note">{t('內圈為 −100、中圈為 0（中性）、外圈為 +100。')}</div>
            <div dangerouslySetInnerHTML={{ __html: radarDelta(cd.firstDim, cd.lastDim) }} />
          </>
        )
      case 'affect':
        return (
          <>
            <div className="cv-legend" style={{ justifyContent: 'center' }}>
              <span>
                <i style={{ background: '#2E7057' }} />
                {t('正向（往上）')}
              </span>
              <span>
                <i style={{ background: '#B0542C' }} />
                {t('負向（往下）')}
              </span>
            </div>
            <div className="cv-chart-wrap" dangerouslySetInnerHTML={{ __html: affectBalance(s) }} />
          </>
        )
      case 'cloud':
        return <div dangerouslySetInnerHTML={{ __html: emotionWordCloud(s) }} />
    }
    return null
  }

  if (checking) return null

  const includedBlocks = analysis?.blocks.filter((b) => b.include) ?? []
  // 內文顯示語言：中文且有快取則用翻譯版，否則用原生英文（依 index 對齊 canonical）
  const briefTr = briefLang === 'zh-TW' ? analysis?.translations?.['zh-TW'] : undefined
  const viewBlocks = briefTr?.blocks ?? analysis?.blocks ?? []
  const viewSessions = briefTr?.sessions ?? analysis?.sessions ?? []

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <style>{COACH_VIZ_CSS}</style>
      <Link to="/app/coach" className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground">
        ← {t('教練儀表板')}
      </Link>
      <h1 className="font-heading mb-6 text-xl text-foreground">{name}</h1>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('載入中…')}</p>
      ) : (
        <>
          {message && (
            <p className="mb-4 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground-soft">
              {message}
            </p>
          )}

          {/* ── 教練深度分析 ── */}
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('教練深度分析')}</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              {t('對每週回饋做情緒 valence 分析與情報簡報，僅教練可見。')}
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
                {/* 內文語言切換：預設英文；點「中文」即時翻譯一次並快取，之後切換即時 */}
                <div className="mb-4 flex items-center justify-end gap-2">
                  <span className="text-xs text-muted-foreground">{t('內文語言')}</span>
                  <div className="inline-flex overflow-hidden rounded-md border border-border">
                    {(['en', 'zh-TW'] as const).map((lng) => (
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
                        {lng === 'en' ? 'EN' : busy === 'translate' ? t('翻譯中…') : '中文'}
                      </button>
                    ))}
                  </div>
                </div>

                {CHART_DEFS.map((c) => {
                  const open = !collapsedCharts.includes(c.key)
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

                {/* 每次 valence 與評分理由 */}
                <div className="cv-slbl">
                  <span>{t('每次 valence 與評分理由')}</span>
                </div>
                {analysis.sessions.map((s, i) => {
                  const vs = viewSessions[i] ?? s // 數字用 canonical，文字用顯示語言版
                  return (
                  <div key={i} className={`cv-vrow ${openRow === i ? 'open' : ''}`}>
                    <div className="cv-vrow-hd" onClick={() => setOpenRow(openRow === i ? null : i)}>
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
                    {openRow === i && (
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

                {/* 情報簡報區塊 */}
                <div className="cv-slbl" style={{ marginTop: 22 }}>
                  <span>{t('教練情報簡報')}</span>
                </div>
                {analysis.blocks.map((b, i) => {
                  const open = openBlocks.includes(i) || editBlock === i
                  const view = viewBlocks[i] ?? b // 顯示語言版（標題/內文）；納入狀態仍用 canonical
                  return (
                  <div key={i} className={`cv-block ${b.include ? '' : 'coachonly'}`}>
                    <div
                      className="cv-block-hd"
                      style={{ cursor: 'pointer' }}
                      onClick={() => editBlock === null && toggleBlockOpen(i)}
                    >
                      <span className="cv-caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
                        ▶
                      </span>
                      <span className="cv-block-title">{view.title}</span>
                      {b.custom && <span className="cv-block-tag ai">{t('AI 框架')}</span>}
                      <span className={`cv-block-tag ${b.include ? 'inc' : 'only'}`}>
                        {b.include ? t('納入客戶版') : t('僅教練')}
                      </span>
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
                              {b.custom && (
                                <span className="cv-block-del" onClick={() => deleteBlock(i)}>
                                  {t('刪除')}
                                </span>
                              )}
                              {briefLang === 'en' ? (
                                <span className="cv-block-edit" onClick={() => startEdit(i)}>
                                  {t('編輯')}
                                </span>
                              ) : (
                                <span className="cv-block-edit" style={{ opacity: 0.5 }} title={t('請切回 EN 編輯原文')}>
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

                {/* ── 自訂分析框架：教練描述 → AI 依文獻生成框架 → 產生新的簡報區塊 ── */}
                <div className="cv-slbl" style={{ marginTop: 26 }}>
                  <span>{t('自訂分析框架')}</span>
                </div>
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
                <div className="mb-4 mt-2 flex flex-wrap gap-3">
                  <button
                    onClick={genFramework}
                    disabled={busy !== null || fwDesc.trim().length < 4}
                    className="rounded-lg border border-primary px-4 py-2 text-sm font-semibold text-primary disabled:opacity-50"
                  >
                    {busy === 'framework' && !fwDraft ? t('生成中…') : t('AI 生成分析框架')}
                  </button>
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
          </section>

          {/* ── 客戶交付版 ── */}
          {analysis && analysis.sessions.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('客戶交付版')}</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                {t('依勾選納入的區塊，生成給客戶本人的正式回顧文件。')}
              </p>
              <div className="cv-note" style={{ marginBottom: 12 }}>
                {t('目前納入客戶版的區塊：')}
                <strong>
                  {' '}
                  {includedBlocks.length}
                </strong>{' '}
                / {analysis.blocks.length}
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
                          {renderChart(c.key)}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="cv-doc-sign">{t('教練　陳郁敏')}</div>
                </div>
              )}
            </section>
          )}

          {/* ── 書寫時間軸（原有）── */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground-soft">{t('書寫時間軸')}</h2>
            {entries.length === 0 ? (
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
            )}
          </section>
        </>
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
.cv-legend{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 2px;font-size:11.5px;font-weight:700}
.cv-legend span{display:inline-flex;align-items:center;gap:6px;color:#54606E}
.cv-legend i{width:12px;height:12px;border-radius:2px;display:inline-block}
.cv-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:6px 0}
@media(max-width:620px){.cv-stats{grid-template-columns:repeat(2,1fr)}}
.cv-stat{background:#fff;border:1.5px solid #E2E5EA;border-radius:9px;padding:14px 12px}
.cv-stat-n{font-size:21px;font-weight:800;color:#1C2530;font-variant-numeric:tabular-nums;line-height:1.1}
.cv-stat-n small{font-size:11px;color:#8993A1;font-weight:700}
.cv-stat-l{font-size:10.5px;color:#8993A1;margin-top:5px}
.cv-rdelta{border:1.5px solid #E2E5EA;border-radius:10px;margin-top:8px;overflow:hidden}
.cv-rdelta-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #E2E5EA;font-size:12.5px}
.cv-rdelta-row:last-child{border-bottom:none}
.cv-rdelta-key{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cv-rdelta-name{font-weight:700;flex:1}
.cv-rdelta-val{font-variant-numeric:tabular-nums;color:#54606E;font-weight:600;white-space:nowrap}
.cv-rdelta-tag{font-size:11px;font-weight:800;padding:3px 11px;border-radius:20px;white-space:nowrap;min-width:82px;text-align:center}
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
.cv-vdim-key{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cv-vdim-name{font-size:12px;font-weight:700;width:150px;flex-shrink:0}
.cv-vdim-v{font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;width:42px;flex-shrink:0}
.cv-vdim-reason{font-size:11.5px;color:#54606E;line-height:1.5;flex:1}
.cv-emos{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.cv-emo{font-size:12px;font-weight:700;padding:5px 12px;border-radius:6px;border:1.5px solid}
.cv-emo.positive{background:#D9E7E0;border-color:#BCD3C8;color:#2E7057}
.cv-emo.negative{background:#F0E0D6;border-color:#E1C3B1;color:#B0542C}
.cv-emo.neutral{background:#EAECF0;border-color:#CBD1DA;color:#54606E}
.cv-block{border:1.5px solid #E2E5EA;border-radius:10px;margin-bottom:12px;overflow:hidden;background:#fff}
.cv-block.coachonly{border-color:#E4CF9E}
.cv-block-hd{display:flex;align-items:center;gap:10px;padding:12px 15px;background:#EEF0F3;border-bottom:1.5px solid #E2E5EA}
.cv-block-title{font-size:13.5px;font-weight:800;color:#1C2530;flex:1}
.cv-block-tag{font-size:10px;font-weight:800;letter-spacing:.04em;padding:3px 9px;border-radius:5px;text-transform:uppercase}
.cv-block-tag.inc{background:#D9E7E0;color:#2E7057;border:1.5px solid #BCD3C8}
.cv-block-tag.only{background:#F6EEDC;color:#8A6A26;border:1.5px solid #E4CF9E}
.cv-block-body{padding:14px 16px}
.cv-md{font-size:13px;line-height:1.8;color:#2B3440}
.cv-md p{margin:0 0 9px}
.cv-md h2,.cv-md h3{font-size:14px;font-weight:800;margin:13px 0 6px;color:#1C2530}
.cv-md ul{margin:5px 0 11px 20px}
.cv-md li{margin-bottom:4px}
.cv-md strong{font-weight:800}
.cv-md em{color:#54606E}
.cv-block-actions{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid #E2E5EA;justify-content:space-between}
.cv-block-edit{font-size:11.5px;font-weight:700;color:#1F3A5C;cursor:pointer}
.cv-block-edit:hover{text-decoration:underline}
.cv-textarea{width:100%;min-height:140px;border:1.5px solid #CBD1DA;border-radius:7px;padding:11px 13px;font-size:13px;font-family:inherit;line-height:1.7;color:#2B3440;resize:vertical}
.cv-doc{background:#fff;border:1.5px solid #E2E5EA;border-radius:10px;padding:34px 38px;line-height:1.95;color:#1C2530;font-family:'Songti TC','Noto Serif TC',Georgia,serif}
@media(max-width:560px){.cv-doc{padding:24px 22px}}
.cv-doc-head{text-align:center;padding-bottom:20px;margin-bottom:22px;border-bottom:2px solid #1C2530}
.cv-doc-title{font-size:22px;font-weight:800;margin:0 0 4px;letter-spacing:.02em}
.cv-doc-meta{font-size:12px;color:#54606E}
.cv-doc h2,.cv-doc h3{color:#1C2530}
.cv-doc h2{font-size:16px;font-weight:800;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid #E2E5EA}
.cv-doc h3{font-size:14px;font-weight:800;margin:16px 0 6px}
.cv-doc p{margin:0 0 12px;font-size:14px}
.cv-doc ul{margin:6px 0 14px 22px}
.cv-doc li{margin-bottom:5px;font-size:14px}
.cv-doc strong{font-weight:800}
.cv-doc-sign{margin-top:26px;padding-top:16px;border-top:1px solid #E2E5EA;font-size:13px;color:#54606E}
.cv-doc-charts{margin-top:8px;font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif}
/* 客戶文件內的圖表要縮進頁寬，避免 PDF／Word 右側被裁切、比例跑掉。
   SVG 有 viewBox，設 max-width:100%+height:auto 即等比縮放至容器寬；窄圖（雷達）維持原寸。 */
.cv-doc-charts .cv-chart-wrap{overflow:visible;text-align:center}
.cv-doc-charts .cv-chart-wrap svg{max-width:100% !important;height:auto !important}
/* 圖表區塊整體另起一頁，但各圖依序流動排版（不再每張各佔一整頁）；
   單一圖表本身不可從中間被切（避免雷達的 A/P/M/R/E 清單被切成兩頁）。 */
.cv-doc-charts{page-break-before:always;break-before:page}
.cv-doc-chart{break-inside:avoid;page-break-inside:avoid;margin-bottom:30px}
.cv-doc-chart-h{margin-top:0 !important}
.cv-rdelta,.cv-stats,.cv-wcloud,.cv-rdelta-row{break-inside:avoid;page-break-inside:avoid}
/* #7 可讀性：把每個區塊開頭的「Takeaway / 重點」那一段框起來，讓教練一眼抓到重點 */
.cv-md{font-size:13.5px;line-height:1.85}
.cv-md>p:first-child{background:#F6F1E7;border-left:3px solid #B5843A;padding:9px 13px;border-radius:6px;margin:0 0 12px;color:#1C2530}
.cv-md h2,.cv-md h3{margin:16px 0 7px}
.cv-md ul{margin:6px 0 12px 20px}
.cv-md li{margin-bottom:5px;line-height:1.7}
/* 自訂分析框架編輯器 */
.cv-block-tag.ai{background:#E7ECF5;color:#1F3A5C;border:1.5px solid #B9C6DE}
.cv-block-del{font-size:11.5px;font-weight:700;color:#B0542C;cursor:pointer}
.cv-block-del:hover{text-decoration:underline}
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
