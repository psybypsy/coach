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

// ── 課程週次（week 1 = 2026/07/27 那一週）──
// 這個起點同時寫在後端 backend/app.py 的 PROGRAM_WEEK_1_START，兩邊要一起改。
export const PROGRAM_WEEK_1_START = '2026-07-27'

// 課程總長度；第 4、8 週的報告要教練確認後才發布給學員。
export const PROGRAM_TOTAL_WEEKS = 8
export const COACH_REVIEW_WEEKS = [4, 8]

// 由該週的週一日期換算成課程第幾週。起點之前的週次會是 0 或負數。
export function programWeekNumber(weekStart: string): number {
  const start = new Date(PROGRAM_WEEK_1_START + 'T00:00:00').getTime()
  const target = new Date(weekStart + 'T00:00:00').getTime()
  return Math.floor((target - start) / (7 * 24 * 60 * 60 * 1000)) + 1
}

// 第 4、8 週的報告由教練親自確認後才發布。
export function needsCoachReview(weekNumber: number): boolean {
  return COACH_REVIEW_WEEKS.includes(weekNumber)
}
