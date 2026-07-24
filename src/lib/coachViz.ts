// ── 教練分析圖表（純函式，回傳 SVG / HTML 字串）──
// 移植自 Ming Websit/ipsen-perma.html 的 valence 視覺化。CSS 變數改為明確 hex，
// P/E/R/M/A 對應 DIMENSION_CONFIGS 的色系。無 DOM 依賴，方便測試與 SSR。

export type DimKey = 'P' | 'E' | 'R' | 'M' | 'A'

export interface SessionScore {
  overall: number
  overallReason: string
  dims: Record<DimKey, { v: number; reason: string }>
  emotions: { word: string; valence: string; intensity: number }[]
}

export const KEYS: DimKey[] = ['P', 'E', 'R', 'M', 'A']
export const DIM: Record<DimKey, string> = {
  P: 'Positive Emotions',
  E: 'Engagement',
  R: 'Relationships',
  M: 'Meaning',
  A: 'Accomplishment',
}

// 對應 DIMENSION_CONFIGS：amber / teal / rose / indigo / emerald
const HEX = {
  P: '#B5843A',
  E: '#487A64',
  R: '#95586A',
  M: '#3D6390',
  A: '#6F5E97',
  primary: '#1F3A5C',
  pos: '#2E7057',
  neg: '#B0542C',
  neu: '#8A94A2',
  ink: '#1C2530',
  text2: '#54606E',
  text3: '#8993A1',
  border: '#E2E5EA',
  border2: '#CBD1DA',
  surface: '#FFFFFF',
  surface2: '#EEF0F3',
  posSoft: '#D9E7E0',
  negSoft: '#F0E0D6',
  neuSoft: '#EAECF0',
} as const

export const DIMCOLOR: Record<DimKey, string> = {
  P: HEX.P,
  E: HEX.E,
  R: HEX.R,
  M: HEX.M,
  A: HEX.A,
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function vColor(v: number): string {
  return v > 15 ? HEX.pos : v < -15 ? HEX.neg : HEX.neu
}
export function vLabel(v: number): string {
  return v >= 60 ? '高度正向' : v >= 20 ? '正向' : v > -20 ? '中性起伏' : v > -60 ? '偏負' : '高度負向'
}

interface LineSeries {
  values: number[]
  color: string
  width?: number
  dash?: boolean
  label?: boolean
}

// 雙極折線圖（−100 ~ +100）
export function valLine(series: LineSeries[], count: number): string {
  const n = Math.max(count, 1)
  const W = Math.max(340, 44 + (Math.max(count, 2) - 1) * Math.max(50, Math.min(92, 560 / Math.max(count - 1, 1))))
  const H = 196
  const padL = 40
  const padR = 14
  const padT = 14
  const padB = 24
  const iW = W - padL - padR
  const iH = H - padT - padB
  const x = (i: number) => (n === 1 ? padL + iW / 2 : padL + (i / (n - 1)) * iW)
  const y = (v: number) => padT + (1 - (v + 100) / 200) * iH
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:none">`
  ;[100, 50, 0, -50, -100].forEach((g) => {
    const yy = y(g)
    const mid = g === 0
    svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${mid ? HEX.border2 : HEX.border}" stroke-width="${mid ? 1.5 : 1}"/><text x="${padL - 7}" y="${yy + 3}" text-anchor="end" font-size="9" fill="${HEX.text3}">${g > 0 ? '+' : ''}${g}</text>`
  })
  for (let i = 0; i < n; i++)
    svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="${HEX.text3}">${i + 1}</text>`
  series.forEach((s) => {
    const vals = s.values
    if (!vals.length) return
    let d = ''
    vals.forEach((v, i) => {
      d += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '
    })
    if (vals.length > 1)
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`
    vals.forEach((v, i) => {
      svg += `<circle cx="${x(i)}" cy="${y(v)}" r="${(s.width || 2) >= 3 ? 4 : 3}" fill="${s.color}"/>`
      if (s.label)
        svg += `<text x="${x(i)}" y="${y(v) - 8}" text-anchor="middle" font-size="9" font-weight="700" fill="${s.color}">${v > 0 ? '+' : ''}${v}</text>`
    })
  })
  return svg + '</svg>'
}

// 雷達圖：a=第一次（淺虛線）、b=最新一次（深）疊圖
export function valRadar(a: Record<DimKey, number> | null, b: Record<DimKey, number> | null): string {
  const size = 280
  const cx = size / 2
  const cy = size / 2 + 4
  const R = 94
  const ang = (i: number) => ((-90 + i * 72) * Math.PI) / 180
  const rad = (v: number) => (v + 100) / 200
  const pt = (i: number, f: number): [number, number] => [cx + Math.cos(ang(i)) * R * f, cy + Math.sin(ang(i)) * R * f]
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size + 14}" width="${size}" height="${size + 14}">`
  ;[0, 0.25, 0.5, 0.75, 1].forEach((f) => {
    let d = ''
    for (let i = 0; i < 5; i++) {
      const [x, y] = pt(i, f)
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '
    }
    svg += `<path d="${d}Z" fill="none" stroke="${f === 0.5 ? HEX.border2 : HEX.border}" stroke-width="${f === 0.5 ? 1.5 : 1}"/>`
  })
  for (let i = 0; i < 5; i++) {
    const [x, y] = pt(i, 1)
    svg += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${HEX.border}" stroke-width="1"/>`
    const [lx, ly] = pt(i, 1.16)
    svg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${DIMCOLOR[KEYS[i]]}">${KEYS[i]}</text>`
  }
  const poly = (map: Record<DimKey, number>, stroke: string, fill: string, w: number, dash: boolean) => {
    let d = ''
    KEYS.forEach((k, i) => {
      const [x, y] = pt(i, rad(map[k]))
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '
    })
    return `<path d="${d}Z" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"${dash ? ' stroke-dasharray="5 4"' : ''}/>`
  }
  if (a) svg += poly(a, HEX.text3, 'rgba(137,147,162,.12)', 1.5, true)
  if (b) {
    svg += poly(b, HEX.primary, 'rgba(31,58,92,.14)', 2, false)
    KEYS.forEach((k, i) => {
      const [x, y] = pt(i, rad(b[k]))
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${HEX.primary}"/>`
    })
  }
  return svg + '</svg>'
}

// 第一次 → 最新一次的逐面向進步／退步
export function radarDelta(a: Record<DimKey, number>, b: Record<DimKey, number>): string {
  const rows = KEYS.map((k) => ({ k, a: a[k], b: b[k], d: b[k] - a[k] })).sort((x, y) => y.d - x.d)
  const fmt = (v: number) => (v > 0 ? '+' : '') + v
  return `<div class="cv-rdelta">${rows
    .map((r) => {
      const col = r.d > 0 ? HEX.pos : r.d < 0 ? HEX.neg : HEX.text3
      const bg = r.d > 0 ? HEX.posSoft : r.d < 0 ? HEX.negSoft : HEX.neuSoft
      const word = r.d > 0 ? '進步' : r.d < 0 ? '退步' : '持平'
      return `<div class="cv-rdelta-row">
        <span class="cv-rdelta-key" style="background:${DIMCOLOR[r.k]}">${r.k}</span>
        <span class="cv-rdelta-name">${DIM[r.k]}</span>
        <span class="cv-rdelta-val">${fmt(r.a)} → ${fmt(r.b)}</span>
        <span class="cv-rdelta-tag" style="background:${bg};color:${col}">${fmt(r.d)}　${word}</span>
      </div>`
    })
    .join('')}</div>`
}

// 正負情緒平衡：正向往上（綠）、負向往下（赭），中線為零
export function affectBalance(sessions: SessionScore[]): string {
  const data = sessions.map((s) => {
    const e = s.emotions || []
    return {
      pos: e.filter((x) => x.valence === 'positive').length,
      neg: e.filter((x) => x.valence === 'negative').length,
    }
  })
  const maxV = Math.max(1, ...data.map((d) => Math.max(d.pos, d.neg)))
  const n = sessions.length
  const W = Math.max(320, 44 + n * Math.min(74, 540 / n))
  const H = 196
  const padL = 20
  const padR = 12
  const padT = 16
  const padB = 26
  const iW = W - padL - padR
  const iH = H - padT - padB
  const cy = padT + iH / 2
  const bw = Math.min(30, (iW / n) * 0.5)
  const cx = (i: number) => padL + (i + 0.5) * (iW / n)
  const sc = (iH / 2 - 6) / maxV
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:none">`
  svg += `<text x="${padL}" y="${padT - 4}" font-size="9" fill="${HEX.pos}">正向</text><text x="${padL}" y="${H - 14}" font-size="9" fill="${HEX.neg}">負向</text>`
  svg += `<line x1="${padL}" y1="${cy}" x2="${W - padR}" y2="${cy}" stroke="${HEX.border2}" stroke-width="1.5"/>`
  data.forEach((d, i) => {
    if (d.pos) {
      const hh = d.pos * sc
      svg += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${(cy - hh).toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${HEX.pos}" rx="2"/>`
    }
    if (d.neg) {
      const hh = d.neg * sc
      svg += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${cy.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${HEX.neg}" rx="2"/>`
    }
    svg += `<text x="${cx(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="${HEX.text3}">${i + 1}</text>`
  })
  return svg + '</svg>'
}

// 情緒詞雲：字級／字重／不透明度隨頻率，依效價上色，大字置中
export function emotionWordCloud(sessions: SessionScore[]): string {
  const map: Record<string, { word: string; valence: string; n: number }> = {}
  sessions.forEach((s) =>
    (s.emotions || []).forEach((e) => {
      const k = (e.word || '').trim()
      if (!k) return
      if (!map[k]) map[k] = { word: e.word, valence: e.valence, n: 0 }
      map[k].n++
    }),
  )
  const arr = Object.values(map)
  if (!arr.length) return `<div class="cv-note">尚無情緒詞彙。</div>`
  const tp = arr.filter((e) => e.valence === 'positive').reduce((s, e) => s + e.n, 0)
  const tn = arr.filter((e) => e.valence === 'negative').reduce((s, e) => s + e.n, 0)
  const tu = arr.filter((e) => e.valence === 'neutral').reduce((s, e) => s + e.n, 0)
  const ratio = tp + tn ? Math.round((tp / (tp + tn)) * 100) : 50
  const maxN = Math.max(...arr.map((e) => e.n))
  const col: Record<string, string> = { positive: HEX.pos, negative: HEX.neg, neutral: HEX.text3 }
  const jitter = (w: string) => {
    let h = 7
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 101
    return h / 101
  }
  const sorted = arr.slice().sort((a, b) => b.n - a.n)
  const ordered: typeof arr = []
  sorted.forEach((w, i) => (i % 2 ? ordered.push(w) : ordered.unshift(w)))
  const spans = ordered
    .map((e) => {
      const t = (e.n - 1) / Math.max(1, maxN - 1)
      const jt = jitter(e.word)
      const size = (15 + t * 21 + jt * 7).toFixed(0)
      const weight = t > 0.55 || jt > 0.7 ? 800 : t > 0.25 || jt > 0.4 ? 700 : 600
      const op = (0.68 + t * 0.24 + jt * 0.08).toFixed(2)
      return `<span style="font-size:${size}px;font-weight:${weight};color:${col[e.valence] || HEX.text3};opacity:${op}">${esc(e.word)}</span>`
    })
    .join('')
  return `<div class="cv-wcloud">${spans}</div>
    <div class="cv-note" style="display:flex;gap:18px;justify-content:center;flex-wrap:wrap">
      <span>正向情緒詞佔比 <strong>${ratio}%</strong></span>
      <span style="color:${HEX.pos}">正向 ${tp}</span><span style="color:${HEX.neg}">負向 ${tn}</span><span style="color:${HEX.text3}">中性 ${tu}</span></div>`
}
