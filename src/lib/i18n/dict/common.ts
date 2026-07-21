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
