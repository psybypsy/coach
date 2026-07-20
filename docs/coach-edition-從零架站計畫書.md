# 教練版網站（陳郁敏老師版）從零架站計畫書

> 目標：獨立架設一個**網頁版**平台，服務一個封閉小社群（企業成員 9 人＋陳郁敏老師 1 人）。
> 核心功能：PERMA 五題書寫（手寫／語音輸入）→ 發布到社群 → AI 每週分析。
> 分成「使用者平台」與「教練平台」兩種角色視角。
> 風格調性沿用現在 MindGym MVP。

---

## 第 0 章：整體架構總覽（先看懂全貌）

沿用你們已經熟悉、且已在 MindGym 驗證過的四層架構：

```
使用者瀏覽器（手機或電腦的網頁）
        │
        ▼
┌─────────────────────────────┐
│ 前端  Vite + React + TS      │  部署在 Vercel（免費）
│ Tailwind CSS + TanStack     │  純網頁版，不做 App、不需要 Capacitor
│ Router                      │
└──────────┬──────────────────┘
           │
     ┌─────┴──────────────┐
     ▼                    ▼
┌──────────────┐   ┌──────────────────────┐
│ Supabase     │   │ 後端  FastAPI (Python) │  部署在 Render
│ ・登入認證    │   │ ・AI 週分析（Claude）   │
│ ・PostgreSQL │   │ ・語音轉文字（Whisper） │
│ ・RLS 權限   │   │ ・任何需要保密金鑰的事  │
└──────────────┘   └──────────────────────┘
```

**分工原則（跟 MindGym 完全一樣）：**
- 「讀寫資料」（貼文、留言、按讚、個人資料）→ 前端直接連 Supabase，靠 RLS（Row Level Security）控制誰能看誰。
- 「需要 AI 或 API 金鑰」（Claude 分析、Whisper 語音）→ 一律走 FastAPI 後端，金鑰只存在 Render 環境變數，永遠不進前端。

**為什麼不換技術棧：** 團隊已經會、程式碼可以直接搬、除錯經驗可以複用。10 人規模用任何技術都跑得動，選熟的最快。

**跟現有 MindGym 的關係：** 完全獨立的四樣新東西——新 GitHub repo、新 Supabase 專案、新 Vercel 專案、新 Render 服務。互不影響，MindGym 出事不會拖累它，反之亦然。程式碼用「複製檔案過去」的方式重用，不共用資料庫。

---

## 第 1 章：產品規格（做什麼）

### 1.1 角色與權限

| 角色 | 人數 | 能做什麼 |
|------|------|---------|
| 成員（member） | 9 | 寫 PERMA 日記、發布到社群、看全社群貼文、留言按讚、看自己的 AI 週分析 |
| 教練（coach） | 1（陳郁敏老師） | 成員能做的全部＋教練儀表板：看每位成員的書寫紀錄、週分析、參與度 |

只有 10 個固定的人，**不開放註冊**：用「Email 白名單」，只有名單內的 email 能登入（Supabase Magic Link 免密碼登入，點信箱連結即進入，對非工程背景的學員最友善）。

### 1.2 功能一：PERMA 五題書寫

- 五個維度沿用 InMind 測驗原題（已存在於 `src/components/pretest/types.ts`）：
  - **P 情緒力**：請分享你上一次發自內心感到愉悅的經驗。
  - **E 投入力**：請分享你最近一次全神貫注做一件事的感受。
  - **R 連結力**：分享一次你在日常生活中感受到被身邊的人支持、被愛的時刻。
  - **M 意義力**：在你的生命中，有哪些活動或重要的時刻對你來說是有意義的？
  - **A 成就力**：在過去三個月，你覺得你是離你的目標越來越近，還是越來越遠？
- 每題附三條引導提示（hints，原檔已有），維度配色沿用（琥珀／青／玫瑰／紫／綠）。
- 書寫框架沿用現有「手寫感」輸入介面；輸入方式二選一：
  1. 打字（textarea）
  2. 語音輸入：瀏覽器 MediaRecorder 錄音 → 後端 `/api/transcribe`（Whisper）→ 轉成文字回填輸入框（此端點已存在於 `backend/app.py:1903`，整段可搬）。
- 使用節奏建議：一天寫一題（自選維度），寫完可選擇「發布到社群」或「只留給自己」。

### 1.3 功能二：社群分享（10 人封閉社群）

- 寫完 PERMA 書寫後一鍵發布，像日記牆。
- 只有這 10 人看得到彼此（靠 RLS 保證，資料庫層強制，不是前端擋而已）。
- 互動：按讚、留言（表結構直接沿用 MindGym 的 `likes`、`comments`）。
- 教練的貼文與留言在 UI 上加「教練」識別標（用現有 SVG 圖示風格，不用 emoji）。

### 1.4 功能三：AI 週分析

- 沿用 MindGym 現有 weekly_digest 框架（`backend/app.py:1542` 的 prompt 架構）：
  - **emotions**：本週最常出現的情緒詞（2–4 種＋次數）
  - **keywords**：最常提到的具體詞彙（2–6 個＋次數）
  - **narrative**：四向度統整回饋（accuracy 準確性／surprise 驚喜感／awareness 自我覺察／insight 洞察與行動）
  - depth 四層次原本是為感恩日記設計，改成「**PERMA 五維度本週書寫分布**」（本週各維度寫了幾篇），更貼題。
- 生成規則沿用：每週日生成一次、該週 ≥ 2 篇才生成、生成後快取不重算。
- 教練端可以看到每位成員的週分析（成員本人只能看自己的）。

### 1.5 教練儀表板（教練平台）

- 成員總覽：9 人清單，各自本週書寫篇數、最近書寫日期、連續週數。
- 點入單一成員：時間軸看該成員的所有公開書寫＋每週 AI 分析。
- 全群概況：本週全群共寫幾篇、五維度分布圓餅、最活躍維度。
- 隱私原則（已決定）：成員選「只留給自己」的內容**不進社群牆，但陳郁敏老師看得到**。寫作頁必須明確標示「你的教練可以看到所有書寫內容」，這是信任的前提，不能只寫在條款裡。

---

## 第 2 章：資料庫設計（Supabase / PostgreSQL）

新 Supabase 專案跑以下 SQL（在 Supabase Dashboard → SQL Editor 貼上執行）。

```sql
-- ============================================
-- 1. 個人資料（登入後自動建立）
-- ============================================
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default '',
  avatar_key text not null default 'avatar1',   -- 沿用 MindGym 頭像機制
  role text not null default 'member' check (role in ('member', 'coach')),
  created_at timestamptz not null default now()
);

-- ============================================
-- 2. Email 白名單（只有名單內的人能用）
-- ============================================
create table allowed_emails (
  email text primary key,
  role text not null default 'member' check (role in ('member', 'coach')),
  note text  -- 備註姓名用
);

-- ============================================
-- 3. PERMA 書寫（核心表）
-- ============================================
create table perma_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  dimension text not null check (dimension in ('P','E','R','M','A')),
  content text not null,
  is_public boolean not null default true,   -- false = 只留給自己
  input_method text not null default 'text' check (input_method in ('text','voice')),
  created_at timestamptz not null default now()
);
create index on perma_entries (user_id, created_at desc);
create index on perma_entries (is_public, created_at desc);

-- ============================================
-- 4. 按讚與留言（沿用 MindGym 結構）
-- ============================================
create table likes (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references perma_entries(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (entry_id, user_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references perma_entries(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

-- ============================================
-- 5. AI 週分析結果（快取）
-- ============================================
create table weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  period_start date not null,          -- 該週的星期一
  entry_count int not null default 0,
  content jsonb not null,              -- emotions / keywords / dimension_dist / narrative
  created_at timestamptz not null default now(),
  unique (user_id, period_start)
);

-- ============================================
-- 6. RLS：資料庫層的權限牆
-- ============================================
alter table profiles enable row level security;
alter table perma_entries enable row level security;
alter table likes enable row level security;
alter table comments enable row level security;
alter table weekly_reviews enable row level security;
alter table allowed_emails enable row level security;

-- 判斷目前登入者是否為教練
create or replace function is_coach() returns boolean
language sql stable security definer as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'coach');
$$;

-- profiles：所有登入者互相可見（只有 10 人）；只能改自己的
create policy "read all profiles" on profiles for select to authenticated using (true);
create policy "update own profile" on profiles for update to authenticated using (id = auth.uid());
create policy "insert own profile" on profiles for insert to authenticated with check (id = auth.uid());

-- perma_entries：公開的大家看得到；私人的只有本人＋教練看得到
create policy "read entries" on perma_entries for select to authenticated
  using (is_public = true or user_id = auth.uid() or is_coach());
create policy "insert own entries" on perma_entries for insert to authenticated
  with check (user_id = auth.uid());
create policy "update own entries" on perma_entries for update to authenticated
  using (user_id = auth.uid());
create policy "delete own entries" on perma_entries for delete to authenticated
  using (user_id = auth.uid());

-- likes / comments：只能對看得到的貼文互動；只能刪自己的
create policy "read likes" on likes for select to authenticated using (true);
create policy "insert own like" on likes for insert to authenticated with check (user_id = auth.uid());
create policy "delete own like" on likes for delete to authenticated using (user_id = auth.uid());
create policy "read comments" on comments for select to authenticated using (true);
create policy "insert own comment" on comments for insert to authenticated with check (user_id = auth.uid());
create policy "delete own comment" on comments for delete to authenticated using (user_id = auth.uid());

-- weekly_reviews：本人或教練可讀；寫入只走後端（service_role，繞過 RLS）
create policy "read own or coach" on weekly_reviews for select to authenticated
  using (user_id = auth.uid() or is_coach());

-- allowed_emails：一般人不可讀寫（後端用 service_role 查）
-- （不建任何 policy = 前端完全碰不到）

-- ============================================
-- 7. 新使用者登入時自動建 profile ＋ 白名單檢查
-- ============================================
create or replace function handle_new_user() returns trigger
language plpgsql security definer as $$
declare allowed record;
begin
  select * into allowed from allowed_emails where email = new.email;
  if allowed is null then
    raise exception '此 Email 不在允許名單內';
  end if;
  insert into profiles (id, display_name, role)
  values (new.id, coalesce(allowed.note, split_part(new.email, '@', 1)), allowed.role);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

最後把 10 個人加進白名單：

```sql
insert into allowed_emails (email, role, note) values
  ('chen.coach@example.com', 'coach', '陳郁敏老師'),
  ('member1@company.com', 'member', '成員一'),
  -- ...其餘 8 位
  ('member9@company.com', 'member', '成員九');
```

---

## 第 3 章：API 設計（FastAPI 後端）

只有需要 AI 的部分走後端，全部從 MindGym 的 `backend/app.py` 改寫搬過來：

| 端點 | 方法 | 用途 | 沿用來源 |
|------|------|------|---------|
| `/healthz` | GET | Render 健康檢查 | 原樣照搬 |
| `/api/transcribe` | POST | 語音檔 → Whisper → 文字 | `app.py:1903` 原樣照搬 |
| `/api/weekly-review` | POST | 撈該使用者本週 perma_entries → Claude 分析 → 存 weekly_reviews | 改寫 `app.py:1568` weekly_digest |

共通機制照搬：`get_user_id()`（拿前端傳來的 Supabase JWT 驗證身分）、`meter_claude` / `meter_whisper` 用量計費紀錄、rate limit、CORS 設定。

`/api/weekly-review` 的 prompt 改動點（其餘沿用 `_WEEKLY_DIGEST_SYSTEM`）：
- 輸入從「感恩日記」改成「PERMA 五維度書寫，每篇標維度」。
- `depth` 四層次改成 `dimension_dist`（P/E/R/M/A 各幾篇）。
- 模型沿用 `claude-haiku-4-5-20251001`（便宜、夠用；10 人每週 10 次呼叫，成本趨近於零）。

環境變數（存在 Render，不進 git）：

```
ANTHROPIC_API_KEY=（Claude 用）
OPENAI_API_KEY=（Whisper 用）
SUPABASE_URL=https://<新專案id>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=（Supabase 後台拿，絕不能進前端）
ALLOWED_ORIGINS=https://<你的網域>,http://localhost:5173
```

---

## 第 4 章：前端頁面規劃

網頁版路由（TanStack Router，檔案結構沿用 MindGym）：

```
/login                 Magic Link 登入頁
/app                   （殼層：驗證登入、底部導覽）
/app/home              今日書寫：選維度 → 書寫框架（打字/語音）→ 發布
/app/community         社群牆：時間軸、按讚、留言
/app/review            我的週分析：情緒詞、關鍵詞、維度分布、四向度回饋
/app/profile           個人資料：頭像、名稱、我的歷史書寫
/coach                 教練儀表板（role=coach 才進得來，前端擋＋RLS 擋）
/coach/member/$id      單一成員時間軸＋週分析
```

**可直接複製的 MindGym 檔案（最省力清單）：**

| 從 MindGym 複製 | 用在哪 |
|----|----|
| `src/components/pretest/types.ts` | PERMA 五題、hints、五維度配色，原封不動 |
| `src/components/pretest/QuestionnaireScreen.tsx` | 書寫框架 UI（拆掉「五題連答」改成「單題書寫」） |
| 語音輸入相關元件（錄音鈕、呼叫 /api/transcribe） | 書寫頁 |
| `src/routes/app.community.tsx` ＋社群卡片元件 | 社群牆 |
| `src/routes/app.weekly-review.tsx` | 週分析頁（depth 圖表改維度分布） |
| Tailwind 設定、字體、色票、手寫感樣式 | 全站風格一致 |
| `src/lib/supabase.ts`（client 初始化） | 原樣照搬 |

前端環境變數（`.env`，Vercel 上也要設同樣三個）：

```
VITE_SUPABASE_URL=https://<新專案id>.supabase.co
VITE_SUPABASE_ANON_KEY=（anon key 是公開的，安全性靠 RLS）
VITE_API_BASE=https://<render服務名>.onrender.com
```

---

## 第 5 章：從零開始的實作手冊（照著做就能上線）

### Step 1：開四個帳號／專案（約 30 分鐘）

1. **GitHub**：開新 repo，例如 `perma-coach`（private）。
2. **Supabase**（supabase.com）：New Project → 區域選 `Northeast Asia (Tokyo)` → 記下 Project URL、anon key、service_role key。
3. **Vercel**（vercel.com）：先不用動，等 repo 有程式碼再連。
4. **Render**（render.com）：先不用動，等後端程式碼進 repo 再連。
5. API 金鑰：Anthropic Console 開新的 API key（跟 MindGym 分開，方便各自看用量）；OpenAI 同理。

### Step 2：建立前端骨架（約 1 小時）

```bash
# 在你放專案的資料夾
npm create vite@latest perma-coach -- --template react-ts
cd perma-coach
npm install
npm install @supabase/supabase-js @tanstack/react-router tailwindcss@3 autoprefixer postcss
npm install -D @tanstack/router-plugin @tanstack/router-vite-plugin
npx tailwindcss init -p
```

然後把 MindGym 的 `tailwind.config.js`、`vite.config.ts`（拿掉 PWA/Capacitor 部分）、`src/index.css`、`vercel.json` 複製過來，確認 `npm run dev` 能在 `http://localhost:5173` 看到畫面。

### Step 3：建資料庫（約 20 分鐘）

Supabase Dashboard → SQL Editor → 貼上第 2 章整段 SQL → Run。
再到 Authentication → Providers → 只開 Email（Magic Link），關閉「Allow new users to sign up」以外的社群登入。
最後 insert 10 筆 `allowed_emails`。

### Step 4：登入流程（約半天）

複製 MindGym 的 `login.tsx` 改成 Magic Link：輸入 email → `supabase.auth.signInWithOtp({ email })` → 使用者去信箱點連結 → 回站即登入。白名單外的 email 會被第 2 章的 trigger 擋下。
`/app` 殼層：沒登入導回 `/login`；讀 `profiles.role`，coach 顯示「教練儀表板」入口。

### Step 5：書寫功能（約 1–2 天）

1. 首頁五個維度卡片（沿用五色配色）→ 點選進入書寫頁。
2. 書寫頁：題目＋三條 hints＋手寫感輸入框（從 QuestionnaireScreen 拆出）。
3. 語音鈕：MediaRecorder 錄音 → POST `/api/transcribe` → 回填文字。
4. 發布：insert 進 `perma_entries`，`is_public` 由「發布到社群／只留給自己」切換鈕決定。

### Step 6：社群牆（約 1–2 天）

複製 `app.community.tsx` 改資料來源為 `perma_entries`（含 join profiles 拿名字頭像）、貼文卡片顯示維度色標、按讚留言直接沿用。

### Step 7：後端＋AI 週分析（約 1–2 天）

1. repo 內開 `backend/` 資料夾，複製 MindGym 的 `backend/app.py` 精簡成三個端點（第 3 章）＋ `requirements.txt` ＋ `usage_metering.py`。
2. 本機測試：`uvicorn app:app --reload`，用 curl 打 `/healthz`。
3. Render：New Web Service → 連 GitHub repo → Root Directory 設 `backend` → Build `pip install -r requirements.txt` → Start `uvicorn app:app --host 0.0.0.0 --port $PORT` → 填第 3 章環境變數。
4. 前端週分析頁：週日打開時呼叫 `/api/weekly-review`，其餘日子顯示上一次快取結果（讀 `weekly_reviews` 表）。

### Step 8：教練儀表板（約 1–2 天）

`/coach`：查 `profiles` 全員 → 各自 `perma_entries` 統計（本週篇數、最近日期）。
`/coach/member/$id`：該成員公開書寫時間軸＋ `weekly_reviews`。
RLS 已保證教練查得到、成員查不到別人的週分析，前端只要做畫面。

### Step 9：部署上線（約半天）

1. Vercel：Import GitHub repo → Framework 自動偵測 Vite → 填三個 `VITE_` 環境變數 → Deploy。
2. 網域：Vercel 專案 Settings → Domains 綁自訂網域（或先用 `xxx.vercel.app`）。
3. Supabase：Authentication → URL Configuration → Site URL 填正式網址（Magic Link 信件連結才會導對地方）。
4. Render 的 `ALLOWED_ORIGINS` 補上正式網址。

### Step 10：上線前檢查清單

- [ ] 白名單外的 email 登入會被擋
- [ ] A 成員看不到 B 成員「只留給自己」的書寫（開兩個瀏覽器測）
- [ ] 成員看不到 `/coach`（直接輸入網址也進不去、API 也拿不到資料）
- [ ] 語音輸入在 iPhone Safari 與 Android Chrome 都能錄（HTTPS 下才有麥克風權限）
- [ ] 週日觸發週分析、其餘日子讀快取
- [ ] 手機版面（375px 寬）所有頁面不破版
- [ ] 全站文案 grep 檢查：不得出現「心理諮商」「心理治療」字眼（法遵紅線，統一用「心理諮詢」）
- [ ] UI 不使用 emoji（沿用 SVG 圖示規範）

---

## 第 6 章：時程與成本

**時程（1 人全職，或 Claude Code 協作可再壓縮）：**

| 週次 | 里程碑 |
|------|--------|
| 第 1 週 | Step 1–4：帳號、骨架、資料庫、登入 → 可以登入的空站 |
| 第 2 週 | Step 5–6：書寫＋社群 → 核心體驗完整 |
| 第 3 週 | Step 7–8：AI 週分析＋教練儀表板 |
| 第 4 週 | Step 9–10：部署、全流程測試、找 2 位真實使用者試用、修 bug |

**每月成本估算（10 人規模）：**

| 項目 | 費用 |
|------|------|
| Vercel（前端） | $0（免費額度綽綽有餘） |
| Supabase | $0（免費方案：500MB DB、5 萬月活躍認證） |
| Render（後端） | $0（免費方案會休眠、首次喚醒慢 30 秒）或 $7/月（不休眠，建議） |
| Claude Haiku（週分析） | < $1/月（每週 10 次呼叫） |
| Whisper（語音） | 約 $1–3/月（$0.006/分鐘） |
| 網域（選配） | 約 $12/年 |
| **合計** | **約 $8–11/月** |

---

## 第 7 章：開工前決定事項（已確認）

1. **私人書寫教練是否可見**：✅ 已決定「教練可見」。RLS 已對應調整；寫作頁必須明確標示「你的教練可以看到所有書寫內容」。
2. **社群是否允許成員刪改已發布內容**：✅ 已決定「允許刪除自己的貼文」（RLS 已開）。
3. **正式網域與站名**：建議先用 psybypsy 子網域上線（免費、隨時可換），若定位為教練自有品牌，再花約 $12/年買一個以課程或教練品牌命名的獨立網域，Vercel 上切換網域不影響任何資料。
