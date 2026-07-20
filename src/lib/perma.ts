// ── PERMA 五個維度：題目與配色 ──
// 團隊會議可用的簡化版（每個維度一題，不需要額外提示）。

export type DimensionKey = 'P' | 'E' | 'R' | 'M' | 'A'

export const DIMENSION_ORDER: DimensionKey[] = ['P', 'E', 'R', 'M', 'A']

export interface DimensionConfig {
  key: DimensionKey
  label: string
  sublabel: string
  question: string
  textColor: string
  bgLight: string
  bgMed: string
  borderLight: string
  borderSolid: string
  gradientBar: string
  ring: string
}

export const DIMENSION_CONFIGS: Record<DimensionKey, DimensionConfig> = {
  P: {
    key: 'P',
    label: '情緒力',
    sublabel: 'Positive Emotion',
    question: '這週有什麼讓你充滿能量的事？',
    textColor: 'text-amber-600',
    bgLight: 'bg-amber-500/10',
    bgMed: 'bg-amber-500/20',
    borderLight: 'border-amber-500/30',
    borderSolid: 'border-amber-500',
    gradientBar: 'from-amber-500 to-amber-300',
    ring: 'ring-amber-500/50',
  },
  E: {
    key: 'E',
    label: '投入力',
    sublabel: 'Engagement',
    question: '你這週最投入、最有狀態的時刻是什麼時候？',
    textColor: 'text-cyan-600',
    bgLight: 'bg-cyan-500/10',
    bgMed: 'bg-cyan-500/20',
    borderLight: 'border-cyan-500/30',
    borderSolid: 'border-cyan-500',
    gradientBar: 'from-cyan-500 to-cyan-300',
    ring: 'ring-cyan-500/50',
  },
  R: {
    key: 'R',
    label: '連結力',
    sublabel: 'Relationships',
    question: '這週誰幫助了你？或者你幫助了誰？',
    textColor: 'text-rose-600',
    bgLight: 'bg-rose-500/10',
    bgMed: 'bg-rose-500/20',
    borderLight: 'border-rose-500/30',
    borderSolid: 'border-rose-500',
    gradientBar: 'from-rose-500 to-rose-300',
    ring: 'ring-rose-500/50',
  },
  M: {
    key: 'M',
    label: '意義力',
    sublabel: 'Meaning',
    question: '這週的工作，為什麼對你來說是重要的？',
    textColor: 'text-violet-600',
    bgLight: 'bg-violet-500/10',
    bgMed: 'bg-violet-500/20',
    borderLight: 'border-violet-500/30',
    borderSolid: 'border-violet-500',
    gradientBar: 'from-violet-500 to-violet-300',
    ring: 'ring-violet-500/50',
  },
  A: {
    key: 'A',
    label: '成就力',
    sublabel: 'Accomplishment',
    question: '有什麼進展讓你感到驕傲？',
    textColor: 'text-emerald-600',
    bgLight: 'bg-emerald-500/10',
    bgMed: 'bg-emerald-500/20',
    borderLight: 'border-emerald-500/30',
    borderSolid: 'border-emerald-500',
    gradientBar: 'from-emerald-500 to-emerald-300',
    ring: 'ring-emerald-500/50',
  },
}
