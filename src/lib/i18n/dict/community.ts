import type { Translation } from '../dictionary'

export const community: Record<string, Translation> = {
  '社群動態': { en: 'Community feed' },
  '目前還沒有人發布書寫': { en: 'No one has posted yet' },
  '載入中…': { en: 'Loading…' },
  '讚': { en: 'Like' },
  '留言': { en: 'Comment' },
  '寫下留言…': { en: 'Write a comment…' },
  '送出': { en: 'Send' },
  '教練': { en: 'Coach' },
  '排序': { en: 'Sort' },
  '最新': { en: 'Newest' },
  '最早': { en: 'Oldest' },
  '第 {n} 週之 {m}': { en: 'Week {n} · #{m}' },
  '連續 {n} 週': { en: '{n}-week streak' },
  '社群貼文': { en: 'Community posts' },
  '我的貼文': { en: 'My posts' },
  '你還沒有發布任何書寫': { en: "You haven't posted anything yet" },
  '更多': { en: 'More' },
  '編輯': { en: 'Edit' },
  '刪除': { en: 'Delete' },
  '確定要刪除這則貼文嗎？此動作無法復原。': { en: 'Delete this post? This cannot be undone.' },
  '僅自己與教練可見': { en: 'Visible to you and your coach' },
  '不會出現在社群動態，只有你和教練看得到': {
    en: "Won't appear in the community feed — only you and your coach can see it",
  },
  '匿名': { en: 'Anonymous' },
  '匿名（僅教練可見真實身分）': { en: 'Anonymous (real name visible to coach only)' },
  '神秘旅人': { en: 'Mystery traveler' },
  '隱私設定': { en: 'Privacy' },
  '以能量代號匿名出現在社群動態，教練仍看得到你的名字': {
    en: 'Shown under an energy alias in the feed; your coach still sees your name',
  },

  // ── 教練視角（coach 帳號在社群頁看得到全部學員的書寫並直接回覆）──
  '教練視角': { en: 'Coach view' },
  '你看得到所有學員的書寫（含匿名與「僅自己與教練可見」），並可以直接在下方留言回覆。': {
    en: 'You can see every member\'s reflections (including anonymous and coach-only posts) and reply right here.',
  },
  '以教練身分回覆…': { en: 'Reply as coach…' },
  '刪除貼文': { en: 'Delete post' },
}
