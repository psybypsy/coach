import type { Translation } from '../dictionary'

// 全站共用字串。
export const common: Record<string, Translation> = {
  '讀取中…': { en: 'Loading…' },
  '處理中…': { en: 'Processing…' },
  '登出': { en: 'Log out' },
  '儲存': { en: 'Save' },
  '取消': { en: 'Cancel' },
  '語言': { en: 'Language' },
  '設定': { en: 'Settings' },
  '個人資料': { en: 'Profile' },
  '你的名字': { en: 'Your name' },
  '儲存中…': { en: 'Saving…' },
  '已儲存': { en: 'Saved' },
  '儲存失敗，請再試一次。': { en: 'Could not save. Please try again.' },

  // ── 登入密碼（個人資料頁）──
  '登入密碼': { en: 'Sign-in password' },
  '設定密碼後，登入頁就能用 email + 密碼直接登入，不必等驗證碼信。原本的驗證碼登入仍然可以用。': {
    en: 'Once set, you can sign in with your email and password — no waiting for a code. Code sign-in still works.',
  },
  '新密碼': { en: 'New password' },
  '至少 8 個字元': { en: 'At least 8 characters' },
  '目前': { en: 'now' },
  '再輸入一次': { en: 'Confirm password' },
  '設定密碼': { en: 'Set password' },
  '設定中…': { en: 'Setting…' },
  '密碼已設定，下次可以直接用密碼登入': { en: 'Password set — you can sign in with it next time' },
  '密碼至少要 8 個字元。': { en: 'Password must be at least 8 characters.' },
  '兩次輸入的密碼不一樣。': { en: 'The two passwords do not match.' },
  '設定失敗，請再試一次。密碼太簡單或曾經外洩過都會被拒絕。': {
    en: 'Could not set the password. Passwords that are too weak or known to be breached are rejected.',
  },

  // ── 頂部工具列 / 選單 ──
  '重新整理': { en: 'Refresh' },
  '選單': { en: 'Menu' },
  '關閉': { en: 'Close' },
  '目前登入': { en: 'Signed in' },
  '編輯名字': { en: 'Edit name' },

  // ── 每週提醒（通知）──
  '通知': { en: 'Notifications' },
  '每週回顧提醒': { en: 'Weekly reflection reminder' },
  '每週我們會在你固定的時間寄 Email 提醒你，回來記錄這週的 PERMA Self-Reflection。': {
    en: "Each week we'll email you at your usual time, inviting you back to record this week's PERMA Self-Reflection.",
  },
  '依你上次書寫的星期幾，於晚上 9 點提醒你回顧。': {
    en: "We'll remind you at 9 PM on the same weekday you last journaled.",
  },
  '是時候寫這週的回顧了！': { en: "Time for this week's reflection!" },
  '下次提醒': { en: 'Next reminder' },
  '開啟瀏覽器通知': { en: 'Enable browser notifications' },
  '瀏覽器通知已開啟': { en: 'Browser notifications on' },
  '每週回顧提醒已開啟': { en: 'Weekly reminder enabled' },
}
