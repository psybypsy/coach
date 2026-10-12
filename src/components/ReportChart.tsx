// ── 報告圖表（教練後台的客戶交付版 ↔ 學員版報告共用）──
// 從 app.coach.member.$id.tsx 抽出來，讓兩邊的圖表由同一份程式碼產生，
// 不會出現「教練看到的」跟「學員收到的」長得不一樣。
import { useLanguage } from '../lib/i18n/context'
import {
  KEYS,
  DIM,
  DIMCOLOR,
  vColor,
  valLine,
  valRadar,
  radarDelta,
  affectBalance,
  topicShareStacked,
  emotionWordCloud,
  type SessionScore,
  type DimKey,
  type TopicKey,
  type ChartTone,
} from '../lib/coachViz'

// T0 基準點：五面向幸福感分數（0–10），作為所有圖表的起點（見遷移 005 / 007）
export type BaselineScores = Record<DimKey, number>

export const CHART_DEFS: { key: string; title: string }[] = [
  { key: 'summary', title: '情緒 valence 摘要' },
  { key: 'trend', title: '整體情緒 valence 趨勢' },
  { key: 'dims', title: '五面向 valence 趨勢' },
  { key: 'topics', title: '每週主題占比' },
  { key: 'radar', title: '五面向 valence 剖面' },
  { key: 'affect', title: '正負情緒平衡' },
  { key: 'cloud', title: '情緒詞雲' },
]

// 每個圖表開頭的一句話說明：先講這張圖在看什麼，再呈現數據。
// 學員報告頁與教練頁共用同一份，兩邊的解讀方式才會一致。
export const CHART_INTROS: Record<string, string> = {
  summary: '這裡把整段期間的情緒起伏濃縮成四個數字，讓你先抓到整體輪廓。',
  trend: '這條線是每一次書寫的整體情緒基調，看得出高低起伏落在哪幾週。',
  dims: '把五個面向拆開來看各自的走勢，就能分辨是全面起伏，還是某一兩個面向在帶動。',
  topics: '這張圖看的是每一週的內容分別落在哪些主題、各占多少；它反映注意力放在哪裡，不代表實際花費的時間。',
  radar:
    '虛線是比較基準、實線是最新一次。點離中心越遠代表越正向，顏色較深的那一圈是 0（不好不壞）；'
    + '形狀越往外撐開，代表整體越飽滿。字母旁的百分比是移動了幾個百分點。',
  affect: '把每一次出現的正向與負向情緒詞數量上下對照，看正負情緒的消長。',
  cloud: '把文字裡出現的情緒詞挑出來，字越大代表出現得越頻繁；綠色偏正向、橘色偏負向。',
}

// T0 分數尺度：0–10 → valence −100~+100（5=0 中性、10=+100、0=−100）
export function baselineToValence(score: number): number {
  const s = Math.max(0, Math.min(10, score))
  return Math.round((s - 5) * 20)
}

// 由五面向 0–10 分數組出一個「第 0 次」的 SessionScore（overall 取五項平均）
export function makeBaselineSession(b: BaselineScores | null | undefined): SessionScore | null {
  if (!b || !KEYS.every((k) => typeof b[k] === 'number' && !Number.isNaN(b[k]))) return null
  const dims = {} as SessionScore['dims']
  KEYS.forEach((k) => {
    dims[k] = { v: baselineToValence(b[k]), reason: '' }
  })
  const overall = Math.round(KEYS.reduce((sum, k) => sum + dims[k].v, 0) / KEYS.length)
  return { overall, overallReason: '', dims, emotions: [] }
}

export function chartData(sessions: SessionScore[]) {
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

// 色塊與文字必須在同一張 SVG 內；若拆成兩個 flex item，html2canvas 仍會用錯誤的
// 文字基線把兩者上下拉開。寬度依 ASCII／CJK 字元估算，保留足夠但不浪費的空間。
function legendItem(color: string, label: string, key?: string) {
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

export function ReportChart({
  chartKey,
  sessions,
  baseline,
  compareWith = 'baseline',
  tone = 'exact',
}: {
  chartKey: string
  sessions: SessionScore[]
  baseline?: BaselineScores | null
  /** 雷達圖的比較基準。
   *  'baseline'：跟 T0 起點比——用在跨期間的縱向分析（教練深度分析、月報告），看的是整段走勢。
   *  'previous'：跟上一次比——用在單週報告，學員關心的是「這週跟上週相比如何」；
   *              只有第 1 週沒有前一次，此時自動退回跟 T0 比。 */
  compareWith?: 'baseline' | 'previous'
  /** 學員本人會看到的圖用 'supportive'（見 coachViz 的 ChartTone）；教練自己看的分析維持 'exact'。 */
  tone?: ChartTone
}) {
  const { t, language } = useLanguage()
  if (!sessions.length) return null

  // T0 基準點：若五面向都填了，就把它當「第 0 次」接在最前面，讓趨勢／五面向／雷達／摘要都以 T0 為起點。
  // 情緒相關圖（正負平衡、詞雲）與逐次列表不含 T0（T0 沒有情緒詞與理由）。
  const base = makeBaselineSession(baseline)
  const s = base ? [base, ...sessions] : sessions
  const cd = chartData(s)
  // 'previous' 模式取倒數第二筆（只有一週時那筆就是 T0，等同跟起點比）
  const cmpIndex = compareWith === 'previous' ? Math.max(0, s.length - 2) : 0
  const cmpDim = {} as Record<DimKey, number>
  KEYS.forEach((k) => {
    cmpDim[k] = s[cmpIndex]?.dims?.[k]?.v ?? 0
  })
  const comparingToBaseline = cmpIndex === 0
  const xLabels = base ? ['T0', ...sessions.map((_, i) => String(i + 1))] : undefined
  const peakIndex = cd.ov.indexOf(cd.hi)
  const peakLabel = xLabels ? xLabels[peakIndex] : String(peakIndex + 1)

  const body = (() => {
  switch (chartKey) {
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
          {tone === 'supportive' && cd.delta < 0 ? (
            // 學員看的版本：末次比首次低時，這一格改報整段期間的最高點，不把一次的回落寫成負的變化
            <div className="cv-stat">
              <div className="cv-stat-n">
                {cd.hi > 0 ? '+' : ''}
                {cd.hi}
              </div>
              <div className="cv-stat-l">
                {peakLabel === 'T0' ? t('最高點（T0）') : t('最高點（第 {n} 次）', { n: peakLabel })}
              </div>
            </div>
          ) : (
            <div className="cv-stat">
              <div className="cv-stat-n">
                {cd.delta > 0 ? '+' : ''}
                {cd.delta}
              </div>
              <div className="cv-stat-l">{t('變化（末−首）')}</div>
            </div>
          )}
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
          <div className="cv-legend">{KEYS.map((k) => legendItem(DIMCOLOR[k], `${k} · ${DIM[k]}`, k))}</div>
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
      const hasTopicData = sessions.some((session) =>
        Object.values(session.topics ?? {}).some((value) => Number(value) > 0),
      )
      // 舊分析沒有 topics；本機開發模式提供清楚標示的版面預覽，方便在分析 API
      // 暫時不可用時仍能驗收圖表。正式 build 不會顯示或匯出這些模擬數值。
      const topicSessions =
        !hasTopicData && import.meta.env.DEV
          ? sessions.map((session, index, all) => {
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
          : sessions
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
        </>
      )
    }
    case 'radar':
      return (
        <>
          <div
            className="cv-chart-wrap cv-radar-wrap"
            dangerouslySetInnerHTML={{ __html: valRadar(cmpDim, cd.lastDim, tone) }}
          />
          <div className="cv-legend" style={{ justifyContent: 'center' }}>
            {legendItem(
              '#8993A1',
              comparingToBaseline
                ? (base ? t('T0 基準（虛線）') : t('第一次（虛線）'))
                : t('上一次（虛線）'),
            )}
            {legendItem('#1F3A5C', t('最新一次'))}
          </div>
          <div dangerouslySetInnerHTML={{ __html: radarDelta(cmpDim, cd.lastDim, tone) }} />
        </>
      )
    case 'affect':
      return (
        <>
          <div className="cv-legend" style={{ justifyContent: 'center' }}>
            {legendItem('#2E7057', t('正向（往上）'))}
            {legendItem('#B0542C', t('負向（往下）'))}
          </div>
          <div className="cv-chart-wrap" dangerouslySetInnerHTML={{ __html: affectBalance(sessions) }} />
        </>
      )
    case 'cloud':
      return <div dangerouslySetInnerHTML={{ __html: emotionWordCloud(sessions) }} />
  }
  return null
  })()

  if (!body) return null
  const intro = CHART_INTROS[chartKey]
  return (
    <>
      {intro && <div className="cv-intro">{t(intro)}</div>}
      {body}
    </>
  )
}
