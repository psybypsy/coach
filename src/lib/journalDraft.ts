// 每週書寫的草稿：存在 localStorage（依「使用者 + 當週」為 key），
// 讓使用者中途離開後回來能接續填寫，正式發布後才清除。
import type { DimensionKey } from './perma'

export type JournalAnswers = Record<DimensionKey, string>

export function emptyAnswers(): JournalAnswers {
  return { P: '', E: '', R: '', M: '', A: '' }
}

function draftKey(userId: string, weekStart: string): string {
  return `journal_draft_${userId}_${weekStart}`
}

export function loadDraft(userId: string, weekStart: string): JournalAnswers {
  try {
    const raw = localStorage.getItem(draftKey(userId, weekStart))
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<JournalAnswers>
      return { ...emptyAnswers(), ...parsed }
    }
  } catch {
    // localStorage 不可用時退回空白
  }
  return emptyAnswers()
}

export function saveDraft(userId: string, weekStart: string, answers: JournalAnswers): void {
  try {
    localStorage.setItem(draftKey(userId, weekStart), JSON.stringify(answers))
  } catch {
    // 忽略寫入失敗（隱私模式等）
  }
}

export function clearDraft(userId: string, weekStart: string): void {
  try {
    localStorage.removeItem(draftKey(userId, weekStart))
  } catch {
    // 忽略
  }
}
