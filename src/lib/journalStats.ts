// 書寫統計：第幾週、連續幾週、下次提醒時間等共用計算。
import { addDays } from './week'

// 兩個週一日期（YYYY-MM-DD）之間相隔幾週。
export function weeksBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime()
  const db = new Date(`${b}T00:00:00`).getTime()
  return Math.round((db - da) / (7 * 86400000))
}

// 以作者最早的週為第 1 週，用日曆週推算某週是第幾週（跳週照算）。
export function programWeek(weekStarts: string[], thisWeek: string): number {
  if (weekStarts.length === 0) return 1
  const min = weekStarts.reduce((a, b) => (a < b ? a : b), thisWeek)
  return weeksBetween(min, thisWeek) + 1
}

// 連續幾週（往回數，每一步 -7 天都要有紀錄才續算）。
export function weekStreak(weekStarts: string[], thisWeek: string): number {
  const set = new Set(weekStarts)
  let streak = 1
  while (set.has(addDays(thisWeek, -7 * streak))) streak += 1
  return streak
}

// 依「上次書寫的時間」算下次提醒：同一星期幾、固定 21:00、隔一週。
// 例：上週五 20:00 書寫 → 下週五 21:00 提醒。
export function nextReminderAt(lastEntryIso: string): Date {
  const last = new Date(lastEntryIso)
  const next = new Date(last)
  next.setDate(last.getDate() + 7)
  next.setHours(21, 0, 0, 0)
  return next
}
