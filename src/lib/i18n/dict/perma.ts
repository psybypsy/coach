import type { Translation } from '../dictionary'

// PERMA 五題（團隊會議可用的簡化版）。
export const perma: Record<string, Translation> = {
  '這週有什麼讓你充滿能量的事？': { en: 'What gave you energy this week?' },
  '你這週最投入、最有狀態的時刻是什麼時候？': { en: 'When were you at your best?' },
  '這週誰幫助了你？或者你幫助了誰？': { en: 'Who helped you, or whom did you help?' },
  '這週的工作，為什麼對你來說是重要的？': { en: 'Why did your work matter this week?' },
  '有什麼進展讓你感到驕傲？': { en: 'What progress are you proud of?' },

  '今天想寫哪個維度？': { en: 'Which dimension do you want to write about today?' },
  '書寫': { en: 'Write' },
  '社群': { en: 'Community' },
  '個人幸福報告': { en: 'Well-being Report' },
  '寫下你的想法': { en: 'Write your thoughts' },
  '發布到社群': { en: 'Share to community' },
  '只留給自己': { en: 'Keep private' },
  '你的教練可以看到所有書寫內容': { en: 'Your coach can see everything you write' },
  '發布': { en: 'Post' },
  '發布中…': { en: 'Posting…' },
  '發布失敗，請再試一次。': { en: 'Something went wrong. Please try again.' },

  // ── 每週書寫入口（home）與 5 題精靈（journal）──
  '日記': { en: 'Journal' },
  '開始記錄': { en: 'Start journaling' },
  '第 {n} 週': { en: 'Week {n}' },
  '共 {n} 週旅程': { en: '{n}-week journey' },
  '本週 PERMA 書寫': { en: 'This week’s PERMA journal' },
  '本週 PERMA Self-Reflection': { en: 'This week’s PERMA Self-Reflection' },
  '開始本週書寫': { en: 'Start this week’s journal' },
  '本週書寫已完成': { en: 'This week’s journal is complete' },
  '本週回顧已完成': { en: 'This week’s reflection is complete' },
  '你已經完成這週的 PERMA Self-Reflection。下週同一時間，我們會再邀請你回來記錄一次。': {
    en: "You've completed this week's PERMA Self-Reflection. We'll invite you back at the same time next week for your next one.",
  },
  '你已經完成這週的 PERMA Self-Reflection。想再寫一篇隨時都可以，我們也會在每週你固定的時間邀請你回來。': {
    en: "You've completed a PERMA Self-Reflection this week. You can add another anytime, and we'll invite you back at your usual time each week.",
  },
  '看看社群': { en: 'View community' },
  '書寫是培養覺察、支持建立新習慣的有效方法。我鼓勵你透過回答這 5 個問題來練習。請每週進行一次，最好固定在每週同一天、同一時段（例如每週五下午或週一早上）。系統會協助你記錄，並在接下來的 8 週為你呈現 PERMA 進展報告。':
    {
      en: 'Journaling is an effective way to develop awareness and supporting the building of new habits. I encourage you to do this by answering these 5 questions. Do this weekly, ideally the same day and time of the week (for example every Friday afternoon or Monday morning). The system can help you record your activities and provide a report of your PERMA progress during the next 8 weeks.',
    },
  '第 {n} 題，共 5 題': { en: 'Question {n} of 5' },
  '上一題': { en: 'Back' },
  '下一題': { en: 'Next' },
  '系統會自動保存草稿': { en: 'Your draft is saved automatically' },
  '請先完成全部 5 題再發布。': { en: 'Please answer all 5 questions before posting.' },

  // ── 歡迎設定名字（welcome）與個人設定（settings）──
  '歡迎！先設定你的名字': { en: 'Welcome! First, set your name' },
  '這個名字會顯示在社群的貼文上。之後也可以在「設定」頁隨時修改。': {
    en: 'This name will appear on your community posts. You can change it anytime in Settings.',
  },
  '這個名字會顯示在社群的貼文上。': { en: 'This name will appear on your community posts.' },
  '例如：怡明': { en: 'e.g. Yee Ming' },
  '開始使用': { en: 'Get started' },
}
