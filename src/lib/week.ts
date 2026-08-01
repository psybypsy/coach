// 把 Date 轉成本機時區的 YYYY-MM-DD。刻意不用 toISOString()——那一律輸出 UTC，
// 對 UTC+8（台灣）使用者來說，本機時間週一 00:00–07:59 換算成 UTC 還是週日，
// 日期字串會整整早一天，進而讓 programWeekNumber() 算出錯誤的週次。
function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 回傳本週一的日期字串（YYYY-MM-DD），週次以週一為起點。
export function currentWeekStart(): string {
  const now = new Date()
  const day = now.getDay() // 0=Sun ... 6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diffToMonday)
  monday.setHours(0, 0, 0, 0)
  return formatLocalDate(monday)
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return formatLocalDate(d)
}

// ── 課程週次（week 1 涵蓋 2026/07/27 那一週起到 8/9，之後每週一正常起算）──
// 這組設定同時寫在後端 backend/app.py 的 PROGRAM_WEEK_1_START / PROGRAM_WEEK_2_START，兩邊要一起改。
// Ipsen 這梯次 2026-08-01 才開始加入白名單，第 1 週刻意拉長到 8/9（含起跑緩衝期），
// 讓當週或次週開始寫都算第 1 週；第 2 週起恢復成每週一到週日的正常週期（8/10 開始）。
export const PROGRAM_WEEK_1_START = '2026-07-27'
export const PROGRAM_WEEK_2_START = '2026-08-10'

// 課程總長度；第 4、8 週的報告要教練確認後才發布給學員。
export const PROGRAM_TOTAL_WEEKS = 8
export const COACH_REVIEW_WEEKS = [4, 8]

// 由該週的週一日期換算成課程第幾週。起點之前的週次會是 0 或負數。
export function programWeekNumber(weekStart: string): number {
  const DAY = 24 * 60 * 60 * 1000
  const start = new Date(PROGRAM_WEEK_1_START + 'T00:00:00').getTime()
  const week2Start = new Date(PROGRAM_WEEK_2_START + 'T00:00:00').getTime()
  const target = new Date(weekStart + 'T00:00:00').getTime()
  if (target < start) return Math.floor((target - start) / (7 * DAY)) + 1
  if (target < week2Start) return 1
  return Math.floor((target - week2Start) / (7 * DAY)) + 2
}

// 第 4、8 週的報告由教練親自確認後才發布。
export function needsCoachReview(weekNumber: number): boolean {
  return COACH_REVIEW_WEEKS.includes(weekNumber)
}
