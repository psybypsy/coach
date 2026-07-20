import type { Translation } from '../dictionary'

export const login: Record<string, Translation> = {
  '職場幸福感書寫': { en: 'Workplace Well-being Journal' },
  '僅開放邀請名單使用': { en: 'Invitation only' },
  '你的 email': { en: 'Your email' },
  '寄送登入連結': { en: 'Send login link' },
  '寄送中…': { en: 'Sending…' },
  '只有邀請名單內的 email 才能登入': { en: 'Only invited emails can sign in' },
  '連結已寄出': { en: 'Link sent' },
  '已寄送登入連結至': { en: 'A login link was sent to' },
  '沒收到嗎？請確認垃圾郵件夾，或稍後再試一次。': {
    en: "Didn't get it? Check your spam folder, or try again in a moment.",
  },
  '重新輸入 email': { en: 'Re-enter email' },
  '此 email 不在允許名單內，請確認是否為陳郁敏老師邀請的信箱，或聯繫老師確認。': {
    en: 'This email is not on the invite list. Please confirm with your coach.',
  },
  '寄送失敗，請確認 email 格式後再試一次。': {
    en: 'Something went wrong. Please check the email format and try again.',
  },
  '登入連結已失效或發生錯誤，請重新輸入 email 再試一次。': {
    en: 'The login link has expired or failed. Please enter your email again.',
  },
}
