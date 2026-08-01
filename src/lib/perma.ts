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
    sublabel: 'Positive Emotions',
    question: '這週有什麼讓你充滿能量的事？',
    textColor: 'text-amber-800',
    bgLight: 'bg-amber-50',
    bgMed: 'bg-amber-100',
    borderLight: 'border-amber-200',
    borderSolid: 'border-amber-700',
    gradientBar: 'from-amber-700 to-amber-500',
    ring: 'ring-amber-700/40',
  },
  E: {
    key: 'E',
    label: '投入力',
    sublabel: 'Engagement',
    question: '你這週最投入、最有狀態的時刻是什麼時候？',
    textColor: 'text-teal-800',
    bgLight: 'bg-teal-50',
    bgMed: 'bg-teal-100',
    borderLight: 'border-teal-200',
    borderSolid: 'border-teal-700',
    gradientBar: 'from-teal-700 to-teal-500',
    ring: 'ring-teal-700/40',
  },
  R: {
    key: 'R',
    label: '連結力',
    sublabel: 'Relationships',
    question: '這週誰幫助了你？或者你幫助了誰？',
    textColor: 'text-rose-900',
    bgLight: 'bg-rose-50',
    bgMed: 'bg-rose-100',
    borderLight: 'border-rose-200',
    borderSolid: 'border-rose-800',
    gradientBar: 'from-rose-800 to-rose-600',
    ring: 'ring-rose-800/40',
  },
  M: {
    key: 'M',
    label: '意義力',
    sublabel: 'Meaning',
    question: '這週的工作，為什麼對你來說是重要的？',
    textColor: 'text-indigo-900',
    bgLight: 'bg-indigo-50',
    bgMed: 'bg-indigo-100',
    borderLight: 'border-indigo-200',
    borderSolid: 'border-indigo-800',
    gradientBar: 'from-indigo-800 to-indigo-600',
    ring: 'ring-indigo-800/40',
  },
  A: {
    key: 'A',
    label: '成就力',
    sublabel: 'Accomplishment',
    question: '這週的工作有什麼進展讓你感到驕傲？',
    textColor: 'text-emerald-900',
    bgLight: 'bg-emerald-50',
    bgMed: 'bg-emerald-100',
    borderLight: 'border-emerald-200',
    borderSolid: 'border-emerald-800',
    gradientBar: 'from-emerald-800 to-emerald-600',
    ring: 'ring-emerald-800/40',
  },
}
