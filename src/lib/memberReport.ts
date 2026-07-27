import { supabase } from './supabase'

const API_BASE = import.meta.env.VITE_API_BASE as string

// 請後端產生（或取回）該週的學員版報告。
// 分析要跑約半分鐘，呼叫端不必等——失敗就安靜略過，
// 使用者下次開「我的報告」時 ensureWeeklyReport 會再試一次。
export async function requestWeeklyReport(weekStart: string): Promise<boolean> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return false

  try {
    const resp = await fetch(`${API_BASE}/api/member/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ week_start: weekStart }),
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
