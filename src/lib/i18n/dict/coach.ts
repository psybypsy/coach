import type { Translation } from '../dictionary'

export const coach: Record<string, Translation> = {
  // ── 學員版報告的審核與發布（見遷移 008）──
  '學員版報告': { en: 'Member reports' },
  '{n} 份待確認': { en: '{n} awaiting review' },
  '第 4、8 週的報告不會自動給學員，請你確認內容後再發布；其他週次會自動發布。': {
    en: 'Week 4 and 8 reports are not sent automatically — review them, then publish. All other weeks publish on their own.',
  },
  '待你確認，學員看不到': { en: 'Awaiting your review — not visible to the member' },
  '已發布給學員': { en: 'Published to member' },
  '已發布給學員，並寄出報告 email': { en: 'Published to member and report email sent' },
  '編輯內容': { en: 'Edit content' },
  '發布給學員': { en: 'Publish to member' },
  '已儲存報告內容': { en: 'Report content saved' },
  '儲存失敗，請確認已在 Supabase 執行遷移 008': {
    en: 'Save failed — check that migration 008 has been run in Supabase',
  },

  '教練儀表板': { en: 'Coach Dashboard' },
  '教練後台': { en: 'Coach Dashboard' },
  '本週全群書寫': { en: 'Entries this week' },
  '五維度分布': { en: 'Dimension balance' },
  '成員': { en: 'Member' },
  '本週篇數': { en: 'This week' },
  '最近書寫': { en: 'Last entry' },
  '私人': { en: 'Private' },
  '書寫時間軸': { en: 'Entry timeline' },
  '目前還沒有人發布書寫': { en: 'No entries published yet' },
  '載入中…': { en: 'Loading…' },

  // 教練深度分析
  '教練深度分析': { en: 'Coach Deep Analysis' },
  '對每週回饋做情緒 valence 分析與情報簡報。': {
    en: 'Emotional valence analysis and an intelligence brief per weekly entry.',
  },
  '生成情緒分析與情報簡報': { en: 'Generate valence analysis & brief' },
  '重新生成分析': { en: 'Regenerate analysis' },
  '分析中…': { en: 'Analyzing…' },
  '基於': { en: 'Based on' },
  '週': { en: 'weeks' },
  '至少需要 1 次書寫': { en: 'Needs at least 1 entry' },
  '偵測到新的一週，正在自動更新分析…（約半分鐘，完成後會自動顯示）': {
    en: 'New week detected — updating the analysis automatically (about 30s; it will appear here).',
  },
  '學員完成一週書寫後會自動生成，也可以按上方按鈕立即重跑。': {
    en: 'Generated automatically once the member completes a week; you can also rerun it now with the button above.',
  },
  '納入客戶版': { en: 'Include in client version' },
  '每次 valence 與評分理由': { en: 'Per-week valence & rationale' },
  // 章節導覽側欄的精簡標籤（跟上面的完整標題分開，寬度較窄）
  '圖表': { en: 'Charts' },
  '每次 valence': { en: 'Sessions' },
  '第': { en: 'Week' },
  '次': { en: '' },
  '整體': { en: 'Overall' },
  '整體評分理由。': { en: 'Overall rationale. ' },
  '教練情報簡報': { en: 'Coach intelligence brief' },
  '確定要刪除這個區塊嗎？此動作無法復原。': { en: 'Delete this block? This cannot be undone.' },
  '納入客戶交付版': { en: 'Include in client deliverable' },
  '編輯': { en: 'Edit' },
  '儲存': { en: 'Save' },
  '取消': { en: 'Cancel' },
  '平均整體 valence': { en: 'Mean overall valence' },
  '變化（末−首）': { en: 'Change (last − first)' },
  '最高 / 最低': { en: 'High / Low' },
  '最強面向': { en: 'Strongest dimension' },
  '第一次（虛線）': { en: 'First (dashed)' },
  '最新一次': { en: 'Latest' },
  '內圈為 −100、中圈為 0（中性）、外圈為 +100。': {
    en: 'Inner ring −100, middle 0 (neutral), outer +100.',
  },
  '正向（往上）': { en: 'Positive (up)' },
  '負向（往下）': { en: 'Negative (down)' },
  '每週 PERMA 報告': { en: 'Weekly PERMA Reports' },
  '每份報告只根據該週的 P／E／R／M／A 內容分析，並與 T0 基準比較。': {
    en: 'Each report analyzes only that week’s P/E/R/M/A content and compares it with the T0 baseline.',
  },
  '已寄送': { en: 'Emailed' },
  '等待寄送': { en: 'Awaiting email' },
  // 客戶視角預覽（每週報告）
  '預覽客戶收到的信與 PDF': { en: 'Preview what the client receives' },
  '上方圖表僅教練可見，客戶收到的是下列信件與 PDF。': {
    en: 'The charts above are coach-only; the client receives the email and PDF below.',
  },
  '客戶收到的內容': { en: 'What the client receives' },
  '收件者': { en: 'To' },
  '主旨': { en: 'Subject' },
  '附件': { en: 'Attachment' },
  '這一週尚未實際寄出，以下為將寄出的內容。': {
    en: 'This week has not been emailed yet — this is what will be sent.',
  },
  'PDF 附件': { en: 'PDF attachment' },
  '預覽失敗，請再試一次。': { en: 'Preview failed. Please try again.' },
  '面向': { en: 'Dimension' },
  'T0 基準': { en: 'T0 baseline' },
  '本週': { en: 'This week' },
  '變化': { en: 'Change' },

  // 客戶交付版
  '客戶交付版': { en: 'Client Deliverable' },
  '依勾選納入的區塊，生成給客戶本人的正式回顧文件。': {
    en: 'Generate a formal review document for the client from the blocks you included.',
  },
  '目前納入客戶版的區塊：': { en: 'Blocks included in client version: ' },
  '生成客戶交付版': { en: 'Generate client deliverable' },
  '重新生成客戶版': { en: 'Regenerate client version' },
  '客戶版已生成，PDF 已寄送給成員。': { en: 'Client version generated and PDF emailed to the member.' },
  '客戶版已生成，但 PDF 尚未寄出：': { en: 'Client version generated, but the PDF was not emailed: ' },
  '生成中…': { en: 'Generating…' },
  '列印 / 匯出 PDF': { en: 'Print / Export PDF' },
  '個人福祉回顧': { en: 'Personal Well-being Review' },
  '情緒歷程一覽': { en: 'Emotional journey at a glance' },
  '教練　Yee Ming Tan': { en: 'Coach · Tan Yee Ming' },

  // 內文語言切換
  '內文語言': { en: 'Text language' },
  '翻譯中…': { en: 'Translating…' },
  '請切回中文編輯原文': { en: 'Switch to 中文 to edit the source text' },

  // 情報簡報區塊 canonical 標題（依固定順序，預設英文）
  '整體情緒與福祉軌跡': { en: 'Overall Emotional & Well-being Trajectory' },
  'PERMA 五面向剖析': { en: 'PERMA Five-Dimension Profile' },
  '優勢與內在資源': { en: 'Strengths & Inner Resources' },
  '自我決定論動機': { en: 'Self-Determination Motivation' },
  '語言指紋': { en: 'Linguistic Fingerprint' },
  '未來四週行動': { en: 'Actions for the Next Four Weeks' },

  // 圖表標題（deep analysis / 客戶版共用）
  '情緒 valence 摘要': { en: 'Valence summary' },
  '整體情緒 valence 趨勢': { en: 'Overall valence trend' },
  '五面向 valence 趨勢': { en: 'Five-dimension valence trends' },
  '每週主題占比': { en: 'Weekly topic share' },
  '五面向 valence 剖面': { en: 'Five-dimension valence profile' },
  '正負情緒平衡': { en: 'Positive–negative affect balance' },
  '情緒詞雲': { en: 'Emotion word cloud' },
  '工作／學業': { en: 'Work / study' },
  '關係': { en: 'Relationships' },
  '健康': { en: 'Health' },
  '休息與恢復': { en: 'Rest & recovery' },
  '自我成長': { en: 'Personal growth' },
  '其他': { en: 'Other' },
  '重新生成分析後，即可查看每週主題占比。': {
    en: 'Regenerate the analysis to view weekly topic shares.',
  },
  '每週合計為 100%，呈現日記內容的關注占比，不代表實際投入時間。': {
    en: 'Each week totals 100%. This reflects attention in the journal, not actual time spent.',
  },
  '本機版面預覽資料；重新生成分析後會換成日記分析結果。': {
    en: 'Local layout preview data; regenerating the analysis will replace it with journal-based results.',
  },
  '本機預覽': { en: 'Local preview' },
  '以下僅供版面預覽；重新生成分析後會依日記證據產生個人化行動。': {
    en: 'Layout preview only. Regenerating the analysis will create personalised actions grounded in journal evidence.',
  },
  '每週恢復檢視': { en: 'Weekly recovery check-in' },
  '每週安排 20 分鐘，記下最消耗與最能恢復能量的事件；四週完成至少三次。': {
    en: 'Set aside 20 minutes each week to note what depleted and restored your energy; complete at least three of four weeks.',
  },
  '一個價值導向行動': { en: 'One values-led action' },
  '每週選一項真正重要、能在 30 分鐘內完成的小行動，並記錄完成後的感受。': {
    en: 'Choose one meaningful action each week that can be completed in 30 minutes, then note how it felt.',
  },
  '一次支持性連結': { en: 'One supportive connection' },
  '每週主動與一位可信任的人對話；成功訊號是能更清楚說出自己的需要。': {
    en: 'Initiate one conversation each week with someone you trust; success means expressing your needs more clearly.',
  },
  '為何適合': { en: 'Why this fits' },
  '執行頻率': { en: 'Cadence' },
  '成功訊號': { en: 'Success signal' },
  '幫助你辨認哪些情境消耗能量，以及哪些方法確實能讓自己恢復。': {
    en: 'It helps you identify which situations deplete your energy and which responses genuinely restore it.',
  },
  '每週安排 20 分鐘。': { en: 'Set aside 20 minutes each week.' },
  '四週內至少完成三次，並找出一項可重複使用的恢復方式。': {
    en: 'Complete it at least three times in four weeks and identify one recovery practice you can reuse.',
  },
  '將你在意的價值轉成小而具體的行動，降低只停留在思考中的壓力。': {
    en: 'It turns what matters to you into a small, concrete step instead of leaving it only as a thought.',
  },
  '每週完成一項 30 分鐘內可完成的小行動。': {
    en: 'Complete one small action each week that takes no more than 30 minutes.',
  },
  '完成後能清楚說出這項行動和哪個重要價值相連。': {
    en: 'Afterward, you can clearly name the important value the action supported.',
  },
  '把支持性關係當作可主動運用的資源，而不是等到壓力累積後才求助。': {
    en: 'It makes supportive relationships a resource you can use proactively, before pressure accumulates.',
  },
  '每週主動與一位可信任的人對話一次。': {
    en: 'Initiate one conversation each week with someone you trust.',
  },
  '對話後能更清楚說出自己的需要或下一步。': {
    en: 'After the conversation, you can express your needs or next step more clearly.',
  },
  '下載 PDF': { en: 'Download PDF' },
  '下載 Word': { en: 'Download Word' },

  // T0 基準點
  'T0 基準點': { en: 'T0 baseline' },
  'T0 基準點（起始幸福感）': { en: 'T0 baseline (starting wellbeing)' },
  '填入成員一開始（T0）的五面向幸福感分數（0–10）。填好後，下面的 valence 圖表都會以 T0 為起點；整體分數由五項自動平均。': {
    en: 'Enter the member’s starting (T0) wellbeing across the five dimensions (0–10). Once filled, the valence charts below start from T0; the overall score is the average of the five.',
  },
  '儲存 T0 基準點': { en: 'Save T0 baseline' },
  '儲存中…': { en: 'Saving…' },
  '請把 T0 的五個面向都填 0–10 的分數': { en: 'Fill all five T0 dimensions with a score of 0–10' },
  '儲存失敗，請確認已在 Supabase 執行遷移 005（新增 baseline 欄）': {
    en: 'Save failed. Make sure migration 005 (add baseline column) has been run in Supabase.',
  },
  '已儲存 T0 基準點': { en: 'T0 baseline saved' },
  '整體（自動平均）：': { en: 'Overall (auto average): ' },
  '五個面向都填 0–10 才會套用到圖表。': { en: 'Fill all five dimensions (0–10) to apply to the charts.' },
  'T0 基準（虛線）': { en: 'T0 baseline (dashed)' },

  // 每週報告：教練手動生成
  '生成每週報告': { en: 'Generate weekly reports' },
  '重新生成每週報告': { en: 'Regenerate weekly reports' },
  '需先設定並儲存 T0 基準點': { en: 'Set and save the T0 baseline first' },
  '請先在最上方填寫並儲存 T0 基準點': { en: 'Fill in and save the T0 baseline at the top first' },
  '目前還沒有每週報告。按上方按鈕，即可為每個「五面向都填寫」的完整週各生成一份。': {
    en: 'No weekly reports yet. Use the button above to generate one for each fully completed week (all five dimensions filled).',
  },
  '已生成每週報告': { en: 'Weekly reports generated:' },
  '生成失敗，請再試一次。': { en: 'Generation failed, please try again.' },
  '本週主題占比': { en: 'This week’s topic share' },
  '本週情緒詞雲': { en: 'This week’s emotion word cloud' },
  '這週沒有可用的主題資料。': { en: 'No topic data available for this week.' },
  '與 T0 的逐面向變化': { en: 'Change from T0 by dimension' },

  // 每月（里程碑）報告
  '每月 PERMA 報告': { en: 'Monthly PERMA Reports' },
  '第 4 週回顧第 1–4 週、第 8 週回顧第 1–8 週，並與 T0 基準比較；僅教練可見。': {
    en: 'The week-4 report reviews weeks 1–4 and the week-8 report reviews weeks 1–8, both compared with the T0 baseline. Coach-only.',
  },
  '生成月報告': { en: 'Generate monthly reports' },
  '重新生成月報告': { en: 'Regenerate monthly reports' },
  '目前還沒有月報告。完成 4 週或 8 週後，按上方按鈕即可生成。': {
    en: 'No monthly reports yet. Once 4 or 8 weeks are complete, use the button above to generate them.',
  },
  '已生成月報告': { en: 'Monthly reports generated:' },
  '第 1–{n} 週': { en: 'Weeks 1–{n}' },
  '用 AI 框架增加新的分析內容': { en: 'Add new analysis with an AI framework' },
  '用自己的話描述想分析什麼，AI 會依心理學文獻生成有理論依據的框架；你可以編輯後套用到這段期間。': {
    en: 'Describe in your own words what you want to analyze. AI generates a theory-grounded framework from the psychology literature; edit it, then apply it to this period.',
  },
  '例如：面對轉變時的能動性／情緒調節方式／自我批評 vs 自我疼惜': {
    en: 'e.g. agency through change / how they regulate emotion / self-criticism vs self-compassion',
  },
  '已加入新的分析內容': { en: 'New analysis added' },
  '直接編輯客戶版文字（Markdown：## 標題、** 粗體、- 條列），儲存後即更新交付文件。': {
    en: 'Edit the client version text directly (Markdown: ## headings, ** bold **, - bullets). Saving updates the deliverable.',
  },

  // 自訂分析框架
  '自訂分析框架': { en: 'Custom analysis framework' },
  '用自己的話描述你想分析什麼，AI 會依心理學文獻生成一個有理論依據的框架；你可以編輯後用它產生一個新的情報簡報區塊。': {
    en: 'Describe in your own words what you want to analyze. AI will generate a theory-grounded framework from the psychology literature; you can edit it, then use it to produce a new brief block.',
  },
  '例如：看這位成員面對轉變時的能動性 / 情緒調節的方式 / 自我批評 vs 自我疼惜': {
    en: 'e.g. this member’s agency through change / how they regulate emotion / self-criticism vs self-compassion',
  },
  'AI 生成分析框架': { en: 'Generate framework with AI' },
  '生成的分析框架（可編輯）': { en: 'Generated framework (editable)' },
  '框架名稱': { en: 'Framework name' },
  '理論依據 / 出處': { en: 'Theory basis / source' },
  '分析視角': { en: 'Analytical lens' },
  '分析維度': { en: 'Dimensions' },
  '維度名': { en: 'Dimension' },
  '要留意的語言／行為線索': { en: 'Language / behavioral cues to watch for' },
  '證據規則（引用原話）': { en: 'Evidence rule (quote their words)' },
  '移除維度': { en: 'Remove dimension' },
  '新增維度': { en: 'Add dimension' },
  '參考文獻': { en: 'References' },
  '用這個框架分析': { en: 'Analyze with this framework' },
  'AI 框架': { en: 'AI framework' },
  '刪除': { en: 'Delete' },
  '請先描述你想分析什麼': { en: 'Describe what you want to analyze first' },
  '請至少保留一個維度': { en: 'Keep at least one dimension' },
}
