import type { Translation } from '../dictionary'

export const report: Record<string, Translation> = {
  // ── 學員版 PERMA 報告（見遷移 008）──
  '我的報告': { en: 'My Report' },
  '每次完成記錄後，這裡會多一份屬於你的回顧。': {
    en: 'Every time you complete an entry, a new review appears here.',
  },
  '完成本週的 PERMA 記錄後，這裡就會出現你的個人報告。': {
    en: 'Finish this week’s PERMA entry and your personal report will appear here.',
  },
  '你第 {n} 週的記錄還沒產生報告。': { en: 'Your week {n} entry does not have a report yet.' },
  '第 {n} 週的報告正在自動產生中，通常一分鐘內完成。': {
    en: 'Your week {n} report is being generated automatically — usually done within a minute.',
  },
  '產生我的報告': { en: 'Generate my report' },
  '產生中，大約需要一分鐘…': { en: 'Generating — this takes about a minute…' },
  '請先不要關閉這個頁面。': { en: 'Please keep this page open.' },
  '產生報告時發生問題，請稍後再試一次。': {
    en: 'Something went wrong generating the report. Please try again in a moment.',
  },

  '本週個人幸福報告': { en: "This Week's Well-being Report" },
  '這週還沒有足夠的書寫': { en: "Not enough entries yet this week" },
  '至少寫滿 2 篇，本週日就能看到分析': { en: 'Write at least 2 entries — your report unlocks this Sunday.' },
  '分析將於本週日產生': { en: 'Your analysis will be generated this Sunday' },
  '已經有 {n} 篇書寫，繼續保持': { en: "You've written {n} entries — keep it up" },
  'PERMA 五維度分布': { en: 'PERMA Dimension Balance' },
  '情緒詞彙': { en: 'Emotion Words' },
  '關鍵詞文字雲': { en: 'Keyword Cloud' },
  '本週回饋': { en: "This Week's Reflection" },
  '準確觀察': { en: 'Accurate Observation' },
  '意外發現': { en: 'Unexpected Patterns' },
  '自我覺察': { en: 'Self-awareness' },
  '洞察與行動': { en: 'Insight & Action' },
  '產生報告': { en: 'Generate report' },
  '產生中…': { en: 'Generating…' },
  '本篇書寫': { en: 'entries this week' },
  '這是別人的報告，僅教練可見': { en: "This is someone else's report — coach view only" },
}
