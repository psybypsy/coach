import { supabase } from './supabase'

const API_BASE = import.meta.env.VITE_API_BASE as string

// 請後端產生（或取回）某篇週記的學員版報告。去重單位是 postId：同一篇重複
// 觸發只會拿到同一份報告，但同一週不同篇週記會各自產生一份。
// 分析要跑約半分鐘，呼叫端不必等——失敗就安靜略過，
// 使用者下次開「我的報告」時 ensureWeeklyReport 會再試一次。
export async function requestWeeklyReport(weekStart: string, postId: string): Promise<boolean> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return false

  try {
    const resp = await fetch(`${API_BASE}/api/member/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ week_start: weekStart, post_id: postId }),
    })
    if (!resp.ok) {
      console.warn('member report generation failed:', resp.status, await resp.text())
      return false
    }
    return true
  } catch (err) {
    console.warn('member report request error:', err)
    return false
  }
}
