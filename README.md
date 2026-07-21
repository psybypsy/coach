# perma-coach

Tan Yee Ming（陳郁敏）教練的職場幸福感書寫平台。PERMA 五題書寫（文字／語音）→ 發布到社群 → AI 每週個人幸福報告。

技術棧：Vite + React + TypeScript + Tailwind CSS + TanStack Router（前端）／FastAPI（後端）／Supabase（資料庫＋登入）。

---

## 環境需求

- [Node.js](https://nodejs.org)(LTS 版本)
- [Git](https://git-scm.com)
- （只有要碰後端／語音轉文字／AI 分析的人才需要）[Python 3.11+](https://www.python.org/downloads/)

---

## 第一次上手：前端

```bash
git clone https://github.com/PSY-by-PSY/coach.git
cd coach
npm install
cp .env.example .env
npm run dev
```

瀏覽器打開終端機顯示的網址（通常是 `http://localhost:5173`）。

`.env.example` 裡已經填好 Supabase 的網址跟 **anon key**——這把 key 設計上就是公開的（前端程式碼裡本來就看得到），安全性是靠資料庫的 RLS 權限規則把關，不是靠隱藏這把 key，所以直接複製貼上即可，不需要另外跟人要。

---

## 第一次上手：後端（只有要跑語音轉文字／AI 週分析的人需要）

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

接著打開 `backend/.env`，填入以下三個值——**這些是機密資訊，不會放在 GitHub 上，也不會寫在這份文件裡，請跟專案負責人直接要（用私訊或密碼管理工具傳，不要貼在群組裡）**：

| 變數 | 說明 | 去哪裡拿 |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI 週分析用 | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | 語音轉文字（Whisper）用 | [platform.openai.com](https://platform.openai.com/api-keys) |
| `SUPABASE_SERVICE_ROLE_KEY` | 後端寫入資料庫用（權限極高，絕對不能外流） | Supabase 專案 → Settings → API Keys |

`SUPABASE_URL` 已經幫你填好了，不用改。

填完後啟動：

```bash
uvicorn app:app --reload --port 8000
```

`/healthz` 打得通（`http://localhost:8000/healthz` 回傳 `{"ok":true}`）就代表成功。

---

## Git 協作流程

1. 開工前先拿最新版本：
   ```bash
   git pull
   ```
2. 開一個新分支做修改（不要直接改 `main`）：
   ```bash
   git checkout -b 你的名字-這次要做的事
   ```
3. 改完後：
   ```bash
   git add .
   git commit -m "說明這次改了什麼"
   git push -u origin 你的名字-這次要做的事
   ```
4. 到 [GitHub](https://github.com/PSY-by-PSY/coach) 開一個 **Pull Request**，等 review 過再合併進 `main`——避免大家同時改同一份程式碼互相覆蓋。

---

## 專案結構

```
src/                前端原始碼
  routes/           頁面（TanStack Router 檔案式路由）
  lib/               共用邏輯（Supabase client、PERMA 題目、i18n 字典）
  components/        共用元件
backend/             FastAPI 後端（語音轉文字、AI 週分析）
supabase/schema.sql  資料庫結構存底（實際套用在 Supabase Dashboard 執行）
```

## 風格規範

- 視覺調性：專業、簡潔，不用可愛風／手寫字體
- UI 不使用 emoji，一律用 SVG 圖示
- 文案不得出現「心理諮商」「心理治療」字眼，統一用「心理諮詢」（法遵要求）
