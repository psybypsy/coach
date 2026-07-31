# 報告產生流程（學員週報告 × 教練深度分析）

這份文件說明一份報告從「學員寫完週記」到「教練在後台看到」中間發生的每一件事，
以及第 4、8 週為什麼要教練審核。最後有本機試用步驟。

相關程式：[`backend/app.py`](../backend/app.py)、
[`src/routes/app.journal.tsx`](../src/routes/app.journal.tsx)、
[`src/routes/app.report.tsx`](../src/routes/app.report.tsx)、
[`src/routes/app.coach.member.$id.tsx`](../src/routes/app.coach.member.$id.tsx)

---

## 一、資料表分工

| 表 | 誰看得到 | 存什麼 | 由誰寫入 |
|---|---|---|---|
| `journal_posts` | 學員本人、教練 | 每週五題原文（P/E/R/M/A） | 學員在 `/app/journal` 發布 |
| `member_reports` | **學員與教練看同一列** | 單週報告全文、`status`、`sessions`、`baseline` | `_ensure_member_report()` |
| `coach_analyses` | 只有教練 | 縱向深度分析、情報簡報區塊、客戶交付版、T0 基準點 | `_analyze_member()` |
| `perma_monthly_reports` | 只有教練 | 第 4／8 週里程碑跨週回顧、AI 框架區塊 | `/api/coach/monthly-reports/generate` |

重點：**學員報告沒有第二份**。教練頁讀的就是 `member_reports` 同一列，
所以教練看到的內容與學員收到的完全一致，不會有兩套版本對不上的問題。

---

## 二、週 1／2／3／5／6／7：全自動，教練不用動手

### 流程

```
學員在 /app/journal 填完 P／E／R／M／A 並發布
        │
        ├─ 寫入 journal_posts（一週一列）
        └─ 寫入 perma_entries（五列，社群動態與個人回顧沿用）
                │
    ┌───────────┴────────────────────────────────────────┐
    │                                                    │
路徑 A（前端主動）                                 路徑 B（伺服器端）
POST /api/member/report                    Supabase Database Webhook
                                           → POST /api/coach/report-completed-webhook
    │                                                    │
    └───────────┬────────────────────────────────────────┘
                │  兩條路都走同一支，且冪等
                ▼
      _ensure_member_report(user_id, week_start, actor_id)
                │
                ├─ 已有這週報告 → 直接回傳，不重複花 AI 費用
                │                （順手補寄上次失敗的信、順手檢查教練分析是否落後）
                │
                ├─ 這週五題沒寫滿 → 409「還沒全部完成」（正常狀態，不是錯誤）
                │
                └─ 沒有報告且五題齊全
                        │
                        ▼
              _analyze_week_for_client(post)
              只分析這一週、直接用第二人稱寫給學員本人
              （含優勢與內在資源、金句 → 一週只花一次 AI 呼叫）
                        │
                        ▼
              寫入 member_reports，status = 'published'
                        │
          ┌─────────────┴──────────────┐
          ▼                            ▼
  _email_report()              _auto_refresh_coach_analysis()  ← 教練開頁時也會觸發一次
  背景寄信（Brevo HTTP API）      背景重跑教練端縱向深度分析
  附 reportlab 產生的 PDF        （落後才跑，見第四節）
  （雷達圖／主題圓餅／情緒詞雲）           │
                                       ▼
                              更新 coach_analyses
                              （縱向分析、情報簡報區塊）
```

### 為什麼要兩條觸發路徑

- **路徑 A** 是前端「射後不理」：學員一關分頁請求就斷了。
- **路徑 B** 在伺服器端跑，不受瀏覽器影響，是可靠性的保險。
- 兩條都走 `_ensure_member_report`，該函式冪等 —— 重複觸發不會產生兩份報告、
  也不會重複花 AI 費用。

### 寄信與失敗補救

寄信用 `_spawn_background` 在背景執行、不 `await`。原因：Render 對外的連線有時會慢或
整個逾時，同步等待會拖慢回應，甚至讓 Supabase webhook 判定逾時。報告本身已經存進
`member_reports`，寄信結果與回傳無關，成功寫 `emailed_at`、失敗寫 `email_error`。

下次任何路徑再觸發同一週時，若發現 `email_error` 有值而 `emailed_at` 還是空，
會自動補寄一次。

### 學員端看到什麼

`/app/report` 發現缺報告時會**自動輪詢最多 90 秒**（報告通常正在背景產生），
出現就直接顯示，不需要使用者自己按或重新整理。只有輪詢逾時才顯示手動補救按鈕。

---

## 三、週 4 與週 8：先給教練審核

判定規則寫在 [`COACH_REVIEW_WEEKS = {4, 8}`](../backend/app.py)。

### 流程

```
與第二節完全相同，直到寫入 member_reports
        │
        ▼
  status = 'pending_coach'（不是 published）
        │
        ├─ 學員在 /app/report 看不到這一週
        └─ 不寄信
        │
        ▼
Ming 進 /app/coach/member/:id
        │
        ├─ 該週卡片標示「待你確認，學員看不到」
        └─ 可直接編輯內容
        │
        ▼
  按「發布給學員」→ POST /api/coach/publish-report
        │
        ▼
  status = 'published'、寫入 published_at
        └─→ 寄出 email（附 PDF）
```

### 設計理由

第 4、8 週是課程的里程碑報告，份量與影響都比單週大，
所以先產生草稿讓教練確認、必要時修改，再由教練決定何時發布給學員。

---

## 四、教練深度分析何時更新

`coach_analyses` 與 `member_reports` 是**兩套不同的分析**：

| | 分析範圍 | 語氣 | 產生時機 |
|---|---|---|---|
| 學員週報告 | 只有那一週 | 第二人稱，寫給學員 | 學員寫完該週 |
| 教練深度分析 | **全部週次的縱向軌跡** | 教練視角，可含坦率假設 | 見下方 |

### 自動更新的三個觸發點

| 觸發點 | 什麼時候發生 | 帶 `coach_id` |
|---|---|---|
| `_ensure_member_report` 的**每一條路徑**（含「報告已存在」那條） | 學員寫完一週、webhook 觸發、學員按補產生 | ✗（會蓋成學員 id） |
| `POST /api/coach/ensure-analysis` | **教練一開成員頁就自動呼叫**，前端不需要按鈕 | ✓ |
| `POST /api/coach/analyze` | 教練手動按「重新生成分析」（強制重跑，不看落後與否） | ✓ |

前兩個都**只有落後時才真的跑 AI**：

```
_coach_analysis_state(member_id) → {weeks, based_on, stale}
   ├─ 沒有 coach_analyses 那一列          → 落後（從沒分析過）
   ├─ 有那列但 sessions 是空的            → 落後（只存過 T0 基準點）
   ├─ based_on < journal_posts 週數       → 落後（有新的一週還沒進去）
   └─ 其他                                → 已是最新，直接返回，不花錢
```

第二個觸發點是**最後一道保險**：學員端那兩條路徑有可能一次都沒跑到
（Supabase webhook 沒設、學員寫完就關分頁、後端當時正在重啟），
少了它，`coach_analyses` 會一直停在舊週數，只能靠教練自己記得按按鈕。

教練頁的做法：一進頁就打 `ensure-analysis`（回應是即時的，不等分析），
若回傳 `refreshing: true` 就顯示「正在自動更新分析…」、每 10 秒回讀一次
`coach_analyses`，跑完自動換上新結果；輪詢期間手動按鈕停用，避免同一份分析付兩次錢。

`_analyzing_members` 這個集合擋掉同一位成員的並行重複觸發。
分析失敗只記 log，不影響學員拿到自己的報告；教練仍可隨時手動按「重新生成分析」補跑。

### 教練的策展成果不會被蓋掉

自動重跑會在無預警下進行，所以 `_analyze_member` 會把不屬於這次 AI 產出的東西接回去：

- 「納入客戶版」勾選 —— **依標題對齊**帶回（不是依索引，因為自訂區塊會 append 在後面）
- 教練自訂的 AI 框架區塊 —— 接回
- 圖表勾選（`client_charts`）—— 沿用
- `coach_id` —— 學員觸發時不帶入，避免被蓋成學員自己的 id

---

## 五、Ming 的操作清單

| 時機 | 要做什麼 |
|---|---|
| 課程開始前 | 在成員頁最上方填 **T0 基準點**（五面向 0–10）。沒填就不能生成月報告 |
| 週 1／2／3／5／6／7 | **什麼都不用做** —— 報告自動產生、自動寄信、深度分析自動更新 |
| 週 4／週 8 | 進成員頁審核草稿 → 按「**發布給學員**」 |
| 週 4／週 8 | 按「**生成月報告**」；需要別的分析角度時再用 AI 框架追加 |
| 隨時 | 客戶交付版：勾選要納入的區塊 → 生成 → 下載 PDF |

---

## 六、本機試用步驟

### 1. 後端設定

在 `backend/.env` 填入（範本見 `backend/.env.example`）：

| 變數 | 必要性 | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | **必填** | 不填無法產生任何分析 |
| `SUPABASE_URL` | **必填** | 公開值 |
| `SUPABASE_SERVICE_ROLE_KEY` | **必填** | Supabase → Settings → API → `service_role` |
| `ALLOWED_ORIGINS` | **必填** | 要包含前端的埠，例如 `http://localhost:5173` |
| `BREVO_API_KEY`／`REPORT_FROM_EMAIL` | 選填 | 不填就不寄信，報告照樣產生（狀態記在 `email_error`） |
| `REPORT_WEBHOOK_SECRET` | 選填 | 只有要測路徑 B（webhook）才需要；留空等於停用 webhook |
| `MEMBER_REPORT_RATE_LIMIT` | 選填 | 預設 `6/hour`。**反覆測試很容易撞到**，本機可先設 `100/hour` |
| `OPENAI_API_KEY` | 選填 | 只有語音轉錄要用；不填啟動時會有一行警告，可忽略 |

寄信管道的優先序是 **Brevo → Gmail API → Gmail SMTP**，全都沒設就完全不寄信、
其餘功能照常運作。本機開發建議直接留空（見第七節）。

### 2. 啟動

```bash
cd backend && .venv/bin/python -m uvicorn app:app --port 8000 --reload
```

```bash
npm run dev
```

確認後端活著：

```bash
curl -s http://localhost:8000/healthz
```

### 3. 走一遍學員流程

1. 用**學員帳號**登入 → `/app/journal`
2. 五題（P／E／R／M／A）全部填完並發布
3. 前端會自動呼叫 `POST /api/member/report`，然後跳去社群（分析要跑約半分鐘）
4. 進 `/app/report` —— 會自動輪詢，報告出現就顯示
5. 用**教練帳號**進 `/app/coach/member/<學員id>` —— 同一份報告會出現在「學員版報告」區，
   圖表與情報簡報也會跟著更新

### 4. 只測後端（不開前端）

拿到學員的 access token 後直接打：

```bash
curl -X POST http://localhost:8000/api/member/report -H "Authorization: Bearer <學員 token>" -H "Content-Type: application/json" -d '{"week_start":"2026-07-27"}'
```

要測路徑 B（webhook）：

```bash
curl -X POST http://localhost:8000/api/coach/report-completed-webhook -H "X-Report-Webhook-Secret: <REPORT_WEBHOOK_SECRET>" -H "Content-Type: application/json" -d '{"record":{"user_id":"<學員id>","week_start":"2026-07-27"}}'
```

---

## 七、常見卡點

### ⚠️ 週次是用固定的課程起始日換算的

```python
PROGRAM_WEEK_1_START = "2026-07-27"   # backend/app.py，寫死在程式裡
```

`week_number = (該週週一 − 課程起始日).days // 7 + 1`

| `week_start` | 第幾週 | 結果 |
|---|---|---|
| `2026-07-20` | 第 0 週 | ❌ 400「這一週在課程開始之前」 |
| `2026-07-27` | 第 1 週 | ✅ 自動發布 |
| `2026-08-17` | 第 4 週 | ⏸ `pending_coach`，等教練審核 |
| `2026-09-14` | 第 8 週 | ⏸ `pending_coach`，等教練審核 |

**測試資料一定要用課程起始日之後的週一**，否則報告永遠產生不出來。
（實例：測試帳號「林思妤」有 8 週 `journal_posts`，日期是 6/01–7/20，全在課程開始前，
所以一份 `member_reports` 都沒有 —— 不是壞掉，是被日期規則擋住。）

### 其他

| 現象 | 原因 |
|---|---|
| 報告一直不出現 | 該週五題沒寫滿（後端回 409）；或 `ANTHROPIC_API_KEY` 沒填 |
| 回 429「請求過於頻繁」 | 撞到 `MEMBER_REPORT_RATE_LIMIT`（預設 6/hour）。本機調寬即可 |
| 教練頁顯示「基於 0 週」 | 只存過 T0 基準點、還沒跑過分析；寫完一週後會自動補上 |
| 前端呼叫後端被 CORS 擋 | `ALLOWED_ORIGINS` 沒包含前端實際的埠（`npm run dev` 埠被占用時會換號） |
| 沒收到 email | 本機通常沒設 `BREVO_API_KEY`；報告仍會產生，失敗原因寫在 `member_reports.email_error` |
| 教練分析沒更新 | 只有「落後」才會重跑；`based_on` 已等於週記數就是最新 |
| PDF 出現空白方框 ▯ | `NotoSansTC` 是純繁中字型，簡體專用字（如 `鹏`、`陈`）不在字符集裡（已知未解） |
