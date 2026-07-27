from __future__ import annotations

import io
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import anthropic
import httpx
import openai
from dotenv import load_dotenv

import usage_metering
from report_email import build_report_email
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import OpenAI
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

logger = logging.getLogger("perma-coach")

load_dotenv()

SUPABASE_URL: str = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY: str = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ANTHROPIC_API_KEY: str = os.environ["ANTHROPIC_API_KEY"]
PORT: int = int(os.environ.get("PORT", 8000))
ALLOWED_ORIGINS: list[str] = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

# ── 學員報告 Email（Resend）──
# 三個都是選填：沒設定 RESEND_API_KEY 時就完全不寄信，其餘功能照常運作。
RESEND_API_KEY: str | None = os.environ.get("RESEND_API_KEY")
# 寄件人須為已在 Resend 驗證過的網域。顯示名稱用 Ipsen Taiwan（品牌決定）。
REPORT_FROM: str = os.environ.get("REPORT_FROM", "Ipsen Taiwan <report@psybypsy.com>")
APP_BASE_URL: str = os.environ.get("APP_BASE_URL", "https://coach-roan-eta.vercel.app")

SUPABASE_REST = f"{SUPABASE_URL}/rest/v1"
SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

TW_TZ = timezone(timedelta(hours=8))
_REVIEW_MODEL = "claude-haiku-4-5-20251001"
_MAX_AUDIO_BYTES = 10 * 1024 * 1024
_ALLOWED_AUDIO_TYPES = {
    "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
    "audio/wav", "audio/x-wav", "audio/m4a", "audio/x-m4a",
}

_http: httpx.AsyncClient | None = None
_claude: anthropic.AsyncAnthropic | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http, _claude
    _http = httpx.AsyncClient(timeout=30)
    _claude = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    yield
    await _http.aclose()
    await _claude.close()


app = FastAPI(title="Coach Platform API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

openai_client: OpenAI | None = None
try:
    openai_client = OpenAI()
except Exception as exc:
    logger.warning("OpenAI initialization failed: %s", exc)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return get_remote_address(request)


limiter = Limiter(key_func=_client_ip)
app.state.limiter = limiter


async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(status_code=429, content={"error": "請求過於頻繁，請稍後再試"})


app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)


def db() -> httpx.AsyncClient:
    assert _http is not None
    return _http


def claude() -> anthropic.AsyncAnthropic:
    assert _claude is not None
    return _claude


async def _post_ai_usage(row: dict) -> None:
    try:
        await db().post(f"{SUPABASE_REST}/ai_usage_log", headers=SUPABASE_HEADERS, json=row)
    except Exception as exc:
        logger.warning("ai_usage_log write failed [%s]: %s", type(exc).__name__, exc)


def meter_claude(source: str, model: str, usage, user_id: str | None = None) -> None:
    try:
        import asyncio
        cost, tokens = usage_metering.claude_cost(model, usage)
        row = {
            "provider": "anthropic", "source": source, "model": model,
            "user_id": user_id, "cost_usd": cost, **tokens,
        }
        asyncio.create_task(_post_ai_usage(row))
    except Exception as exc:
        logger.warning("meter_claude failed [%s]: %s", type(exc).__name__, exc)


def meter_whisper(source: str, model: str, seconds: float, user_id: str | None = None) -> None:
    try:
        import asyncio
        row = {
            "provider": "openai", "source": source, "model": model,
            "user_id": user_id, "audio_seconds": round(float(seconds), 2),
            "cost_usd": usage_metering.whisper_cost(seconds),
        }
        asyncio.create_task(_post_ai_usage(row))
    except Exception as exc:
        logger.warning("meter_whisper failed [%s]: %s", type(exc).__name__, exc)


async def get_user_id(token: str) -> str:
    resp = await db().get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {token}"},
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid auth token")
    return resp.json()["id"]


def is_sunday_tw() -> bool:
    return datetime.now(TW_TZ).weekday() == 6


@app.get("/healthz")
async def health():
    return {"ok": True}


@app.post("/api/transcribe")
@limiter.limit("20/minute")
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    authorization: str = Header(...),
):
    token = authorization.removeprefix("Bearer ").strip()
    user_id = await get_user_id(token)

    if openai_client is None:
        return JSONResponse(content={"error": "語音辨識服務未啟用，請設定 OPENAI_API_KEY"}, status_code=503)

    content_type = (audio.content_type or "").split(";")[0].strip().lower()
    if content_type and content_type not in _ALLOWED_AUDIO_TYPES:
        return JSONResponse(content={"error": "不支援的檔案格式，此功能僅接受語音錄音"}, status_code=415)

    data = await audio.read()
    if len(data) == 0:
        return JSONResponse(content={"error": "音訊檔案為空，請重新錄音"}, status_code=400)
    if len(data) > _MAX_AUDIO_BYTES:
        return JSONResponse(content={"error": "錄音過長（上限約 10MB），請縮短錄音時間"}, status_code=400)

    buf = io.BytesIO(data)
    buf.name = audio.filename or "recording.webm"

    try:
        result = openai_client.audio.transcriptions.create(
            model="whisper-1",
            file=buf,
            language="zh",
            prompt="以下是繁體中文的內容。",
            response_format="verbose_json",
        )
        meter_whisper("whisper", "whisper-1", getattr(result, "duration", 0) or 0, user_id)
        return {"text": (result.text or "").strip()}
    except openai.AuthenticationError:
        return JSONResponse(content={"error": "OpenAI 金鑰無效，請檢查 OPENAI_API_KEY 環境變數"}, status_code=401)
    except Exception as exc:
        logger.warning("transcribe failed [%s]: %s", type(exc).__name__, exc)
        return JSONResponse(content={"error": "語音辨識失敗，請再試一次"}, status_code=502)


_WEEKLY_REVIEW_SYSTEM = (
    "你是職場幸福感教練的週統整分析師，語氣專業、具體、不批判、不做診斷，"
    "用繁體中文、以「你」稱呼使用者，不使用 emoji 與 markdown 符號。\n"
    "請閱讀使用者一週的 PERMA 書寫（逐篇列出，附維度標籤），產出：\n\n"
    "1. emotions：本週文字中最常出現的情緒詞（3-6 種），與大約出現次數。\n"
    "2. keywords：本週最常提到的具體詞彙／主題（6-12 個，2-4 字詞），與出現次數"
    "（用於文字雲呈現，數量盡量多一點以利視覺化）。\n"
    "3. narrative：四段專業回饋，每段 2-3 條條列短句（每條 15-35 字，整段不超過 100 字）：\n"
    "   - accuracy（準確觀察）：精準描繪這週使用者的真實工作／生活樣貌。\n"
    "   - surprise（意外發現）：指出使用者自己可能沒注意到的模式或轉變。\n"
    "   - awareness（自我覺察）：點出內在還沒被意識到的需求或狀態。\n"
    "   - insight（洞察與行動）：轉化為正向意義，並給出具體、可行的下一步建議。\n\n"
    "只回傳 JSON，不要任何前言或 markdown。"
)


class WeeklyReviewRequest(BaseModel):
    period_start: str


@app.post("/api/weekly-review")
async def weekly_review(req: WeeklyReviewRequest, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ").strip()
    user_id = await get_user_id(token)

    try:
        start = datetime.strptime(req.period_start, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="period_start 格式錯誤")
    end = start + timedelta(days=6)

    existing_resp = await db().get(
        f"{SUPABASE_REST}/weekly_reviews",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{user_id}"),
            ("period_start", f"eq.{start.isoformat()}"),
            ("select", "*"),
            ("limit", "1"),
        ],
    )
    existing_rows = existing_resp.json() if existing_resp.status_code == 200 else []
    if existing_rows:
        return existing_rows[0]

    entries_resp = await db().get(
        f"{SUPABASE_REST}/perma_entries",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{user_id}"),
            ("created_at", f"gte.{start.isoformat()}T00:00:00"),
            ("created_at", f"lte.{end.isoformat()}T23:59:59"),
            ("select", "id,dimension,content,created_at"),
            ("order", "created_at.asc"),
        ],
    )
    entries = entries_resp.json() if entries_resp.status_code == 200 else []
    if len(entries) < 2:
        raise HTTPException(status_code=409, detail="這週書寫不足 2 篇")
    entry_count = len(entries)

    if not is_sunday_tw():
        raise HTTPException(status_code=409, detail="AI 分析將在本週日生成")

    dimension_dist = {"P": 0, "E": 0, "R": 0, "M": 0, "A": 0}
    lines = []
    for e in entries:
        dim = e.get("dimension")
        if dim in dimension_dist:
            dimension_dist[dim] += 1
        lines.append(f"[{dim}] {e.get('content', '').strip()}")
    joined = "\n".join(lines)

    emotions, keywords, narrative = [], [], {}
    try:
        msg = await claude().messages.create(
            model=_REVIEW_MODEL,
            max_tokens=1600,
            system=_WEEKLY_REVIEW_SYSTEM,
            messages=[{
                "role": "user",
                "content": (
                    f"以下是使用者本週（{start.isoformat()} ~ {end.isoformat()}）的 PERMA 書寫，"
                    f"共 {entry_count} 篇：\n{joined}\n\n"
                    "只回傳 JSON："
                    '{"emotions":[{"label":"專注","count":3}],'
                    '"keywords":[{"label":"團隊合作","count":4}],'
                    '"narrative":{"accuracy":["...","..."],"surprise":["...","..."],'
                    '"awareness":["...","..."],"insight":["...","..."]}}'
                ),
            }],
        )
        meter_claude("weekly-review", _REVIEW_MODEL, msg.usage, user_id)
        raw = msg.content[0].text if msg.content else ""
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            data = json.loads(match.group())
            emotions = data.get("emotions") or []
            keywords = data.get("keywords") or []
            narrative = data.get("narrative") or {}
    except Exception as exc:
        logger.warning("weekly_review AI failed [%s]: %s", type(exc).__name__, exc)

    content_json = {
        "v": 1,
        "emotions": emotions,
        "keywords": keywords,
        "dimension_dist": dimension_dist,
        "narrative": narrative,
    }

    insert_resp = await db().post(
        f"{SUPABASE_REST}/weekly_reviews",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        json={
            "user_id": user_id,
            "period_start": start.isoformat(),
            "entry_count": entry_count,
            "content": content_json,
        },
    )
    if insert_resp.status_code in (200, 201):
        rows = insert_resp.json()
        if rows:
            return rows[0]

    logger.warning("weekly_review insert failed: %s", insert_resp.text)
    return {
        "id": None, "user_id": user_id, "period_start": start.isoformat(),
        "entry_count": entry_count, "content": content_json, "created_at": None,
    }


# ── 教練深度分析 ───────────────────────────────────────────────
# 只有教練能呼叫。讀成員的 journal_posts（每週一列，內含 PERMA 五答案），
# 呼叫 Claude 產出每週情緒 valence 分數＋教練情報簡報，存進 coach_analyses。
# 移植自 Ming Websit/ipsen-perma.html 的分析層，AI 改走此後端代理。
_COACH_ANALYSIS_MODEL = "claude-sonnet-5"
_PERMA_KEYS = ["P", "E", "R", "M", "A"]
_PERMA_DIM = {
    "P": "Positive Emotions", "E": "Engagement", "R": "Relationships",
    "M": "Meaning", "A": "Accomplishment",
}
_TOPIC_KEYS = ["work", "relationships", "health", "rest", "growth", "other"]
_REMOVED_BLOCK_TITLES = {
    "cross-cutting themes & patterns", "橫向主題與模式",
    "the unsaid", "未言之事",
    "coaching hypotheses", "教練假設",
    "worth watching", "值得關注",
    "session preparation", "會談準備",
}
# 客戶交付版預設納入的圖表（教練可在前端調整）。
_CLIENT_CHART_DEFAULTS = {
    "summary": True, "trend": True, "dims": True,
    "topics": True, "radar": True, "affect": False, "cloud": False,
}
# 學員版報告的圖表：比教練的客戶交付版多一張情緒詞雲。
_MEMBER_CHART_DEFAULTS = {**_CLIENT_CHART_DEFAULTS, "cloud": True}

# ── 課程週次（week 1 = 2026/07/27 那一週）──
# 同一組設定也寫在前端 src/lib/week.ts，兩邊要一起改。
PROGRAM_WEEK_1_START = "2026-07-27"
COACH_REVIEW_WEEKS = {4, 8}


def _program_week_number(week_start: str) -> int:
    """由該週的週一日期換算成課程第幾週。"""
    start = datetime.strptime(PROGRAM_WEEK_1_START, "%Y-%m-%d").date()
    target = datetime.strptime(week_start, "%Y-%m-%d").date()
    return (target - start).days // 7 + 1


async def require_coach(token: str) -> str:
    """驗證呼叫者已登入且角色為 coach，回傳其 user_id；否則 401/403。"""
    user_id = await get_user_id(token)
    resp = await db().get(
        f"{SUPABASE_REST}/profiles",
        headers=SUPABASE_HEADERS,
        params=[("id", f"eq.{user_id}"), ("select", "role"), ("limit", "1")],
    )
    rows = resp.json() if resp.status_code == 200 else []
    if not rows or rows[0].get("role") != "coach":
        raise HTTPException(status_code=403, detail="僅限教練使用")
    return user_id


def _coach_analysis_system_en(week_count: int) -> str:
    return f"""You are the analysis assistant to Tan Yee Ming, an executive well-being coach. You will receive one team member's {week_count} weekly PERMA reflections (P=Positive Emotions, E=Engagement, R=Relationships, M=Meaning, A=Accomplishment). Produce two parts: a quantified emotional-valence analysis of each week (with reasons), and a coach-only intelligence brief.

Output in exactly this format; both markers must appear:
<<<SCORES>>>
{{"sessions":[
 {{"overall":integer -100..100,
  "overallReason":"why this week's overall tone got that score, quoting the person's own words",
  "dims":{{"P":{{"v":-100..100,"reason":"basis"}},"E":{{"v":0,"reason":""}},"R":{{"v":0,"reason":""}},"M":{{"v":0,"reason":""}},"A":{{"v":0,"reason":""}}}},
  "topics":{{"work":0..100,"relationships":0..100,"health":0..100,"rest":0..100,"growth":0..100,"other":0..100}},
  "emotions":[{{"word":"an emotion word from the text","valence":"positive|negative|neutral","intensity":1..5}}]}}
]}}
<<<BRIEF>>>
[[BLOCK]] Block title
Block body
[[BLOCK]] Next block title
...

Scoring rules:
- sessions length must be exactly {week_count}, in order from week 1 to week {week_count}.
- valence is emotional tone: -100 extremely negative, 0 neutral, +100 extremely positive. Judge only from the text; every score needs a concrete reason quoting the person's words; give near 0 when blank or vague.
- extract 6 to 12 emotion words per week.
- topics are that week's share of attention across exactly six stable categories: work (work/study), relationships, health, rest (rest/recovery), growth (personal growth), and other. Return non-negative integers that sum to exactly 100 for every week. Classify by semantic units, not raw word count; down-weight repetitive passages and put genuinely uncategorisable material in other.

Intelligence-brief rules: stay evidence-based, quote the person's words and cite which week. Do not add hypothesis, risk, diagnostic, "unsaid", watch-list, or session-preparation sections. Separate blocks with [[BLOCK]]; the first line of each block is its title, the rest is the body (Markdown: ## headings, ** bold **, * italics *, - bullets).

FORMATTING — keep every block skimmable: write in short paragraphs and - bullet points, prefer bullets over dense prose, and keep sentences short.

Include these blocks in exactly this order:
[[BLOCK]] Overall Emotional & Well-being Trajectory
[[BLOCK]] PERMA Five-Dimension Profile
[[BLOCK]] Strengths & Inner Resources
[[BLOCK]] Self-Determination Motivation
[[BLOCK]] Linguistic Fingerprint
[[BLOCK]] Actions for the Next Four Weeks

The three theory columns — "PERMA Five-Dimension Profile", "Strengths & Inner Resources", "Self-Determination Motivation" — must each: (a) stay tied to this person's specific quotes with week citations; (b) end with a "**References**" sub-heading listing 2-3 APA-format references (journal or book titles in * italics *) relevant only to that column.

Per-block requirements:
- PERMA Five-Dimension Profile: analyze P/E/R/M/A one by one, noting fullness (abundant / stable / thin / absent), change over time and key quotes, then integrate the overall pattern through a PERMA lens. References may draw from: Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.; Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218-226.; Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
- Strengths & Inner Resources: identify character strengths and reusable inner resources, each tied to quotes. References may draw from: Peterson, C., & Seligman, M. E. P. (2004). *Character strengths and virtues: A handbook and classification*. Oxford University Press.; Linley, P. A., Nielsen, K. M., Gillett, R., & Biswas-Diener, R. (2010). Using signature strengths in pursuit of goals. *International Coaching Psychology Review, 5*(1), 6-15.; Niemiec, R. M. (2013). VIA character strengths: Research and practice. In *Well-being and cultures* (pp. 11-29). Springer.
- Self-Determination Motivation: assess the three basic psychological needs — autonomy, competence, relatedness — as satisfied or frustrated, and read the resulting motivation quality (toward intrinsic vs controlled). References may draw from: Deci, E. L., & Ryan, R. M. (2000). The 'what' and 'why' of goal pursuits. *Psychological Inquiry, 11*(4), 227-268.; Ryan, R. M., & Deci, E. L. (2017). *Self-determination theory: Basic psychological needs in motivation, development, and wellness*. Guilford Press.; Gagné, M., & Deci, E. L. (2005). Self-determination theory and work motivation. *Journal of Organizational Behavior, 26*(4), 331-362.
- Linguistic Fingerprint: agency (active vs passive voice), connectedness (I / we / they balance), time orientation, energy vs depletion words, certainty vs hesitation.
- Actions for the Next Four Weeks: propose 2-3 small, client-safe experiments grounded in this person's evidence. For each action include **Action**, **Why this fits**, **Cadence**, and **Success signal**. Keep the actions observable and achievable; do not diagnose, prescribe treatment, or claim causality.

Language: English. No emoji anywhere. Tone: professional, precise, theoretically grounded — like a senior coach's clinical notes."""


def _coach_analysis_system(week_count: int, language: str = "en") -> str:
    if language != "zh-TW":
        return _coach_analysis_system_en(week_count)
    return f"""你是資深高階主管教練的分析助理，服務於教練 陳郁敏。你會收到一位團隊成員 {week_count} 次每週 PERMA 反思的原始回答（P=Positive Emotions、E=Engagement、R=Relationships、M=Meaning、A=Accomplishment）。請產出兩部分：每次的情緒 valence 量化分析（含理由），與一份僅供教練的情報簡報。

嚴格照此格式輸出，兩個標記都要出現：
<<<SCORES>>>
{{"sessions":[
 {{"overall":-100至100的整數,
  "overallReason":"該次整體情緒基調的評分依據，引用回答原話",
  "dims":{{"P":{{"v":-100至100,"reason":"依據"}},"E":{{"v":0,"reason":""}},"R":{{"v":0,"reason":""}},"M":{{"v":0,"reason":""}},"A":{{"v":0,"reason":""}}}},
  "topics":{{"work":0至100,"relationships":0至100,"health":0至100,"rest":0至100,"growth":0至100,"other":0至100}},
  "emotions":[{{"word":"回答原文中的情緒詞","valence":"positive|negative|neutral","intensity":1至5}}]}}
]}}
<<<BRIEF>>>
[[BLOCK]] 區塊標題
區塊內文
[[BLOCK]] 下一個區塊標題
...

分數規則：
- sessions 長度必須剛好 {week_count}，依第 1 到第 {week_count} 次順序。
- valence 為情緒效價：−100 為極度負面、0 為中性、+100 為極度正面。只依文字內容判定，每個分數都要有具體理由並引用當事人原話；未填或空泛給接近 0。
- 每次抽 6 至 12 個情緒詞。
- topics 是每週日記在六個固定主題中的關注占比：work（工作／學業）、relationships（關係）、health（健康）、rest（休息與恢復）、growth（自我成長）、other（其他）。每週都回傳非負整數且總和必須剛好為 100。以語意單位判斷，不以原始字數直接計算；重複內容降低權重，真正無法歸類的內容放入 other。

情報簡報規則：保持以證據為本，每個判斷都引用原話並註明第幾次；不得另外產生假設、風險、未言之事、關注清單或會談準備區塊。以 [[BLOCK]] 分隔，每塊第一行為標題、其後為內文（可用 Markdown 的 ## 標題、** 粗體、* 斜體 *、- 條列）。

排版（教練要能快速掃讀）：內文用簡短段落與 - 條列呈現，多用條列、少用長段落、句子精簡。逐一分析多個項目（例如 P/E/R/M/A 五面向、SDT 三需求）時，每個項目先用一行「- **項目名稱**」當作該項目的粗體標籤，再用縮排兩格的子條列「  - 證據 / 引文」列出其下的具體證據，形成有層級的巢狀條列，不要把標籤與證據全部擠在同一層。

務必依序包含這些區塊：
[[BLOCK]] 整體情緒與福祉軌跡
[[BLOCK]] PERMA 五面向剖析
[[BLOCK]] 優勢與內在資源
[[BLOCK]] 自我決定論動機
[[BLOCK]] 語言指紋
[[BLOCK]] 未來四週行動

其中「PERMA 五面向剖析」「優勢與內在資源」「自我決定論動機」是三個各自獨立的理論專欄，每一欄都必須：(a) 全程扣合此人的具體引文並註明第幾次；(b) 在該欄內文最後另起一行、以「**參考文獻**」為小標，再用 - 條列 2 至 3 筆 APA 格式文獻（期刊名或書名以 * 斜體 * 標示），且只列與該欄主題直接相關者，不得跨欄混用。

各區塊要求：
- PERMA 五面向剖析：逐一分析 P/E/R/M/A 五面向，標飽滿度（充沛／穩定／稀薄／缺席）、變化與關鍵引文，並以 PERMA 觀點整合此人整體樣態。參考文獻可從下列擇要引用：Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.；Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218–226.；Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
- 優勢與內在資源：辨識此人的性格優勢與可再運用的內在資源，逐一扣合引文。參考文獻可從下列擇要引用：Peterson, C., & Seligman, M. E. P. (2004). *Character strengths and virtues: A handbook and classification*. Oxford University Press.；Linley, P. A., Nielsen, K. M., Gillett, R., & Biswas-Diener, R. (2010). Using signature strengths in pursuit of goals. *International Coaching Psychology Review, 5*(1), 6–15.；Niemiec, R. M. (2013). VIA character strengths: Research and practice. In *Well-being and cultures* (pp. 11–29). Springer.
- 自我決定論動機：以自我決定論的三項基本心理需求——自主（Autonomy）、勝任（Competence）、關聯（Relatedness）——分別評估其滿足或受挫，並據此判讀其動機品質（趨近內在動機或受控動機）。參考文獻可從下列擇要引用：Deci, E. L., & Ryan, R. M. (2000). The 'what' and 'why' of goal pursuits: Human needs and the self-determination of behavior. *Psychological Inquiry, 11*(4), 227–268.；Ryan, R. M., & Deci, E. L. (2017). *Self-determination theory: Basic psychological needs in motivation, development, and wellness*. Guilford Press.；Gagné, M., & Deci, E. L. (2005). Self-determination theory and work motivation. *Journal of Organizational Behavior, 26*(4), 331–362.
- 語言指紋：能動性（主動 vs 被動語態）、連結性（我／我們／他們的比重）、時間定向、能量詞 vs 耗竭詞、確定 vs 遲疑。
- 未來四週行動：提出 2 至 3 個根據此人文字證據、適合交付給客戶的小型行動實驗。每項包含 **行動**、**為何適合**、**執行頻率**、**成功訊號**；必須具體可觀察且容易執行，不得診斷、提供治療處方或宣稱因果。

語言：繁體中文（台灣）。全篇不得使用任何 emoji。語氣專業、精確，兼具實證理論素養，如資深教練結合學理的臨床筆記。"""


def _framework_gen_system(language: str = "en") -> str:
    """教練用自然語言描述想分析什麼 → AI 上網找對應的實證理論 → 生成可套用的結構化框架。"""
    if language == "zh-TW":
        return """你是結合心理學文獻與高階主管教練實務的「分析框架設計師」，服務於教練 陳郁敏。教練會用自然語言描述他想在一位成員的每週 PERMA 反思書寫中分析什麼，請優先使用網路搜尋，找出對應且有實證基礎的心理學／諮商／教練理論或模型（例如「面對轉變的能動性」→ 自我決定理論 SDT；「完美主義」→ Frost 多維完美主義；「情緒調節方式」→ Gross 情緒調節歷程模型；「自我批評 vs 自我疼惜」→ Neff 自我疼惜），再轉化成一個可實際套用在反思文字上的結構化分析框架。

規則：
- 框架必須紮根於具名的理論／模型，並在 basis 標明出處（作者, 年份）。
- 拆成 2–5 個可觀察的維度；每個維度用 look_for 說明「在反思文字中要留意哪些語言或行為線索」。
- 每個維度都要有 evidence_rule，要求分析時引用成員原話為證。
- references 給 2–3 筆與此框架直接相關的 APA 格式文獻（期刊名或書名可用 * 斜體 *）。
- 這是給教練反思用的分析視角，不是給成員評分的量表。

只輸出 JSON（不要任何其他文字、不要 code fence）：
{"name":"框架名稱（12字內，好記）","basis":"理論／模型名稱與出處（作者, 年份）","lens":"一句話說明這個框架在看什麼","dimensions":[{"name":"維度名","look_for":"要留意的語言或行為線索","evidence_rule":"引用成員原話作為證據"}],"references":["APA 格式文獻"],"note":"適用情境與限制，一句話"}"""
    return """You are an analysis-framework designer combining psychology literature with executive-coaching practice, assisting coach Tan Yee Ming. The coach will describe in natural language what they want to analyze in one member's weekly PERMA reflections. Prefer web search to find a validated, evidence-based psychology / counseling / coaching theory or model that matches (e.g. "agency through change" -> Self-Determination Theory; "perfectionism" -> Frost Multidimensional Perfectionism; "how they regulate emotion" -> Gross process model of emotion regulation; "self-criticism vs self-compassion" -> Neff Self-Compassion), then turn it into a structured analysis framework that can actually be applied to the reflection text.

Rules:
- The framework must be grounded in a named theory/model; state its source in basis (Author, Year).
- Break it into 2-5 observable dimensions; each dimension's look_for explains which language or behavioral cues to watch for in the reflection text.
- Every dimension needs an evidence_rule requiring the analysis to quote the member's own words.
- references: give 2-3 APA-format references directly relevant to this framework (journal or book titles may use * italics *).
- This is an analytical lens for the coach's reflection, not a scored scale for the member.

Output JSON only (no other text, no code fences):
{"name":"framework name (short, memorable)","basis":"theory/model name and source (Author, Year)","lens":"one line on what this framework looks at","dimensions":[{"name":"dimension name","look_for":"language or behavioral cues to watch for","evidence_rule":"quote the member's own words as evidence"}],"references":["APA-format reference"],"note":"one line on fit and limitations"}"""


def _framework_to_text(fw: dict) -> str:
    lines = [
        f"Framework: {fw.get('name', '')}",
        f"Theory basis: {fw.get('basis', '')}",
        f"Lens: {fw.get('lens', '')}",
        "Dimensions:",
    ]
    for d in (fw.get("dimensions") or []):
        lines.append(
            f"- {d.get('name', '')}: watch for {d.get('look_for', '')} | evidence: {d.get('evidence_rule', '')}"
        )
    refs = fw.get("references") or []
    if refs:
        lines.append("References to draw from: " + "; ".join(str(r) for r in refs))
    if fw.get("note"):
        lines.append(f"Note: {fw['note']}")
    return "\n".join(lines)


def _framework_block_system(fw: dict, week_count: int, language: str = "en") -> str:
    """用一個(教練生成的)框架，對成員 {week_count} 次每週反思生成單一情報簡報區塊。
    輸出格式與既有 block 一致，可直接 append 進 coach_analyses.blocks。"""
    fw_text = _framework_to_text(fw)
    if language == "zh-TW":
        return f"""你是資深高階主管教練 陳郁敏 的分析助理。教練提供了一個自訂分析框架，請只用「這個框架」分析一位成員 {week_count} 次每週 PERMA 反思，產出一個情報簡報區塊（僅教練可見、可含坦率假設）。

自訂框架：
{fw_text}

要求：
- 全程扣合此人的具體引文並註明第幾次（如「第 3 次」）。
- 逐一走過框架的每個維度：對照 look_for 找線索、依 evidence_rule 引用原話。每個維度先用一行「- **維度名稱**」當作粗體標籤，再用縮排兩格的子條列「  - 證據 / 引文」列出該維度下的具體證據，形成有層級的巢狀條列，不要把維度標籤跟證據擠在同一層。
- 內文以一行粗體重點開頭，格式「**重點 —** …」，接著空一行，再依上述巢狀條列格式逐一走過各維度。
- 內文最後另起一行，以「**參考文獻**」為小標，用 - 條列該框架的參考文獻（APA 格式，書名／期刊名以 * 斜體 *）。
- 可用 Markdown（## 標題、** 粗體、* 斜體、- 條列、縮排子條列）。全篇不得使用 emoji，語氣如資深教練結合學理的臨床筆記。
- 繁體中文（台灣）。

只輸出 JSON（不要 code fence）：{{"title":"區塊標題（用框架名稱）","body":"區塊內文"}}"""
    return f"""You are the analysis assistant to executive well-being coach Tan Yee Ming. The coach supplied a custom analysis framework. Using ONLY this framework, analyze one member's {week_count} weekly PERMA reflections and produce one intelligence-brief block (coach-only; may contain candid hypotheses).

Custom framework:
{fw_text}

Requirements:
- Stay tied to this person's specific quotes with week citations (e.g. "week 3").
- Walk through each dimension of the framework: for each dimension, write one top-level bullet "- **Dimension Name**" as a bold label, then nest its supporting quotes/evidence underneath as indented (2-space) sub-bullets "  - ...". Do not flatten the dimension label and its evidence into the same list level.
- Start the body with one bold single-line takeaway "**Takeaway —** ...", then a blank line, then the nested-bullet dimension walkthrough described above.
- End the body with a "**References**" sub-heading listing the framework's references as - bullets (APA format; book/journal titles in * italics *).
- Use Markdown (## headings, ** bold **, * italics *, - bullets, indented sub-bullets). No emoji. Tone: a senior coach's theoretically grounded clinical notes.
- Language: English.

Output JSON only (no code fences): {{"title":"block title (use the framework name)","body":"block body"}}"""


_CLIENT_REPORT_SYSTEM_EN = """You are the writing assistant to coach Tan Yee Ming. Below is the analysis content the coach selected to include in the client version. Rewrite it into a formal, warm, empowering "Personal Well-being Review" for the client to read.

Requirements:
- Remove all hypotheses, clinical speculation, risk or diagnostic language; focus on strengths, trajectory, meaning and the way forward.
- Preserve and lightly quote the client's own words.
- Use Markdown, with ## sections; keep paragraphs short and clear, and use - bullets (not numbered lists) where they aid readability — prefer bullets over long paragraphs.
- Bold (**...**) the key insight or takeaway phrase in each paragraph — 1 short bolded phrase per paragraph, not whole sentences — so a reader skimming just the bold text gets the gist.
- Include a final client-facing section named "Actions for the Next Four Weeks" with 2-3 small experiments. Address the client directly. Each action must state the action, why it fits this client based on the supplied evidence, cadence, and an observable success signal; keep it empowering and avoid diagnostic or treatment language.
- End with 1 to 2 warm, forward-looking invitations after the action section.
- Entirely in English. No emoji.
- Do not repeat the title page or signature (the system adds them)."""


_CLIENT_REPORT_SYSTEM_ZH = """你是教練 陳郁敏 的寫作助理。以下是教練勾選要納入客戶交付版的分析內容。請改寫成一份給客戶本人閱讀的正式、溫暖、賦能的「個人福祉回顧」。

要求：
- 移除所有假設、臨床推測、風險或診斷性語言；聚焦優勢、軌跡、意義與前瞻。
- 保留並適度引用客戶自己的語言。
- 用 Markdown，以 ## 分節，段落清晰、專業；多用 - 條列（不要用數字條列），少用長段落。
- 每段用 **粗體** 標出這段的重點短語（一段一個重點、標短語即可，不要整句加粗），讓人快速掃過粗體就能抓到重點。
- 加入最後一節「未來四週行動」，以直接對客戶說話的方式提出 2 至 3 個小型行動實驗；每項都要包含行動、根據提供證據說明為何適合這位客戶、執行頻率與可觀察的成功訊號。語氣應溫暖賦能，不得使用診斷或治療語言。
- 在行動區塊之後，以 1 至 2 個溫暖的前瞻邀請作結。
- 全篇繁體中文（台灣），不得使用任何 emoji。
- 不要重複標題頁與署名（系統會自動加上）。"""


def _client_report_system(language: str = "en") -> str:
    return _CLIENT_REPORT_SYSTEM_ZH if language == "zh-TW" else _CLIENT_REPORT_SYSTEM_EN


_TRANSLATE_SYSTEM = """You translate an executive-coaching analysis from English into Traditional Chinese (Taiwan, 繁體中文).

You will receive a JSON object with "blocks" and "sessions". Return ONLY a JSON object with the exact same structure, keys, and array lengths, translating these human-readable text fields into natural, professional Traditional Chinese:
- blocks[].title, blocks[].body
- sessions[].overallReason, sessions[].dims.P/E/R/M/A.reason, sessions[].emotions[].word

Rules:
- Preserve ALL Markdown syntax in bodies (##, **, *, -) exactly.
- Keep academic citations / APA references and *italic* work titles in their original language — do NOT translate author names, journal names, or book titles.
- Do NOT change any numbers, any "valence" values (positive/negative/neutral), "intensity", "v", "include", or any JSON keys.
- No emoji. Output valid JSON only — no commentary, no code fences."""


def _clamp_v(v) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        n = 0
    return max(-100, min(100, n))


def _msg_text(msg) -> str:
    return "".join(b.text for b in (msg.content or []) if getattr(b, "type", None) == "text")


def _normalise_topic_shares(raw: object) -> dict[str, int]:
    """把模型回傳的六類主題權重清理並正規化成總和恰好 100 的整數占比。"""
    source = raw if isinstance(raw, dict) else {}
    values: dict[str, float] = {}
    for key in _TOPIC_KEYS:
        try:
            values[key] = max(0.0, float(source.get(key) or 0))
        except (TypeError, ValueError):
            values[key] = 0.0
    total = sum(values.values())
    if total <= 0:
        return {**{key: 0 for key in _TOPIC_KEYS}, "other": 100}
    scaled = {key: int(round(value * 100 / total)) for key, value in values.items()}
    # 四捨五入後可能是 99/101；把誤差補到原始權重最大的主題。
    largest = max(_TOPIC_KEYS, key=lambda key: values[key])
    scaled[largest] += 100 - sum(scaled.values())
    return scaled


def _parse_analysis(out: str) -> tuple[list, list]:
    """把 <<<SCORES>>> JSON 與 <<<BRIEF>>> [[BLOCK]] 拆成 sessions 與 blocks。"""
    bi = out.find("<<<BRIEF>>>")
    scores_part = out[:bi] if bi >= 0 else out
    brief_part = out[bi + len("<<<BRIEF>>>"):] if bi >= 0 else ""
    scores_part = scores_part.replace("<<<SCORES>>>", "")

    match = re.search(r"\{.*\}", scores_part, re.DOTALL)
    if not match:
        raise ValueError("分數解析失敗")
    data = json.loads(match.group())

    sessions = []
    for s in data.get("sessions") or []:
        dims_in = s.get("dims") or {}
        dims = {}
        for k in _PERMA_KEYS:
            d = dims_in.get(k) or {}
            dims[k] = {"v": _clamp_v(d.get("v")), "reason": str(d.get("reason") or "")}
        emotions = []
        for e in (s.get("emotions") or []):
            val = e.get("valence")
            emotions.append({
                "word": str(e.get("word") or "")[:20],
                "valence": val if val in ("positive", "negative", "neutral") else "neutral",
                "intensity": max(1, min(5, int(round(float(e.get("intensity") or 3))))) if str(e.get("intensity") or "").strip() else 3,
            })
        sessions.append({
            "overall": _clamp_v(s.get("overall")),
            "overallReason": str(s.get("overallReason") or ""),
            "dims": dims,
            "topics": _normalise_topic_shares(s.get("topics")),
            "emotions": emotions,
        })

    # 前 4 塊（軌跡／PERMA／優勢／SDT）與最後的未來行動預設納入客戶版；
    # 語言指紋保留在教練分析。用順序判斷才能同時支援中英文標題。
    parts = [p.strip() for p in brief_part.split("[[BLOCK]]") if p.strip()]
    blocks = []
    for idx, part in enumerate(parts):
        nl = part.find("\n")
        title = (part[:nl] if nl >= 0 else part).strip()
        body = (part[nl + 1:] if nl >= 0 else "").strip()
        # 目前保留的六個標準區塊全部預設納入客戶版。
        blocks.append({"title": title, "body": body, "include": idx < 6})

    return sessions, blocks


def _detect_lang(text: str) -> str:
    """依內容裡中文字 vs 拉丁字母的多寡，判斷學員書寫語言；判斷不出來預設英文。
    政策：分析與客戶回顧都跟隨「學員書寫的語言」，而非教練介面語言。"""
    cjk = sum(1 for ch in text if 0x4E00 <= ord(ch) <= 0x9FFF)
    latin = sum(1 for ch in text if "a" <= ch.lower() <= "z")
    return "zh-TW" if cjk > latin else "en"


async def _fetch_member_posts(member_id: str) -> list[dict]:
    resp = await db().get(
        f"{SUPABASE_REST}/journal_posts",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{member_id}"),
            ("select", "week_start,p_content,e_content,r_content,m_content,a_content"),
            ("order", "week_start.asc"),
        ],
    )
    return resp.json() if resp.status_code == 200 else []


class CoachMemberRequest(BaseModel):
    member_id: str
    language: str = "en"  # 分析與客戶報告的語言，跟隨教練介面（預設英文）


async def _analyze_member(
    member_id: str, actor_id: str, source: str, coach_id: str | None = None
) -> dict:
    """跑一次完整的縱向分析並 upsert 進 coach_analyses，回傳該列。

    教練後台與學員版報告共用這條路徑，確保兩邊看到的分析結果一致。
    actor_id 只用於 AI 用量歸戶；source 用於區分呼叫來源。
    coach_id 只有教練親自觸發時才帶入——學員自己觸發時保持原值不動，
    否則會把 coach_analyses.coach_id 蓋成學員自己的 id。
    """
    posts = await _fetch_member_posts(member_id)
    if len(posts) < 1:
        raise HTTPException(status_code=409, detail="這位成員還沒有任何週記")

    # 深度分析一律以英文生成（教練工作語言預設英文）；中文由前端點「中文」時
    # 呼叫 /api/coach/translate 即時翻譯並快取，見遷移 003。
    lang = "en"

    dump_parts = []
    for i, p in enumerate(posts):
        lines = [f"── 第 {i + 1} 次（{p.get('week_start', '')}）"]
        for k in _PERMA_KEYS:
            ans = (p.get(f"{k.lower()}_content") or "").strip() or "（未填）"
            lines.append(f"[{k}] {_PERMA_DIM[k]}：{ans}")
        dump_parts.append("\n".join(lines))
    dump = "\n\n".join(dump_parts)

    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=8000,
        thinking={"type": "disabled"},
        system=_coach_analysis_system(len(posts), lang),
        messages=[{"role": "user", "content": f"成員資料：\n\n{dump}"}],
    )
    meter_claude(source, _COACH_ANALYSIS_MODEL, msg.usage, actor_id)

    try:
        sessions, blocks = _parse_analysis(_msg_text(msg))
    except Exception as exc:
        logger.warning("%s parse failed [%s]: %s", source, type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="分析解析失敗，請重新生成")

    row = {
        "member_id": member_id,
        "based_on": len(posts),
        "sessions": sessions,
        "blocks": blocks,
        "client_charts": _CLIENT_CHART_DEFAULTS,
        "translations": {},  # 重新生成 → 舊翻譯作廢
        "updated_at": datetime.now(TW_TZ).isoformat(),
    }
    if coach_id:
        row["coach_id"] = coach_id
    upsert_resp = await db().post(
        f"{SUPABASE_REST}/coach_analyses",
        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
        json=row,
    )
    if upsert_resp.status_code in (200, 201):
        rows = upsert_resp.json()
        if rows:
            return rows[0]
    logger.warning("coach_analyses upsert failed: %s", upsert_resp.text)
    return row


@app.post("/api/coach/analyze")
async def coach_analyze(req: CoachMemberRequest, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)
    return await _analyze_member(req.member_id, coach_id, "coach-analyze", coach_id=coach_id)


class CoachFrameworkGenerateRequest(BaseModel):
    description: str
    language: str = "en"


class CoachFrameworkAnalyzeRequest(BaseModel):
    member_id: str
    framework: dict
    language: str = "en"


@app.post("/api/coach/framework/generate")
async def coach_framework_generate(
    req: CoachFrameworkGenerateRequest, authorization: str = Header(...)
):
    """教練描述想分析什麼 → AI 上網找對應的實證理論 → 回傳可編輯的結構化框架 JSON。"""
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)

    desc = (req.description or "").strip()
    if len(desc) < 4:
        raise HTTPException(status_code=400, detail="請先描述你想分析什麼")

    system = _framework_gen_system(req.language)
    try:
        msg = await claude().messages.create(
            model=_COACH_ANALYSIS_MODEL,
            max_tokens=2500,
            thinking={"type": "disabled"},
            system=system,
            messages=[{"role": "user", "content": desc}],
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
        )
    except anthropic.APIStatusError:
        # 組織未開通網路搜尋等情況：退回模型既有知識
        msg = await claude().messages.create(
            model=_COACH_ANALYSIS_MODEL,
            max_tokens=2500,
            thinking={"type": "disabled"},
            system=system + "\n(Web search is unavailable here; rely on your own expert knowledge to pick the best-matching validated theory.)",
            messages=[{"role": "user", "content": desc}],
        )
    meter_claude("coach-framework-generate", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)

    text = _msg_text(msg)
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise HTTPException(status_code=502, detail="框架生成失敗，請換個描述再試一次")
    try:
        fw = json.loads(match.group())
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="框架生成失敗，請換個描述再試一次")
    if not isinstance(fw.get("dimensions"), list) or not fw["dimensions"]:
        raise HTTPException(status_code=502, detail="框架生成失敗，請換個描述再試一次")
    return fw


@app.post("/api/coach/analyze-framework")
async def coach_analyze_framework(
    req: CoachFrameworkAnalyzeRequest, authorization: str = Header(...)
):
    """用教練(生成並確認)的自訂框架，對成員週記生成一個情報簡報區塊，append 進既有分析。"""
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)

    fw = req.framework or {}
    if not isinstance(fw.get("dimensions"), list) or not fw["dimensions"]:
        raise HTTPException(status_code=400, detail="框架不完整，請至少保留一個維度")

    resp = await db().get(
        f"{SUPABASE_REST}/coach_analyses",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{req.member_id}"), ("select", "*"), ("limit", "1")],
    )
    rows = resp.json() if resp.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=409, detail="請先生成教練分析")
    analysis = rows[0]

    posts = await _fetch_member_posts(req.member_id)
    if len(posts) < 1:
        raise HTTPException(status_code=409, detail="這位成員還沒有任何週記")

    # 自訂區塊與既有分析同語言（既有深度分析一律英文，見 /api/coach/analyze）。
    lang = "en"
    dump_parts = []
    for i, p in enumerate(posts):
        lines = [f"── 第 {i + 1} 次（{p.get('week_start', '')}）"]
        for k in _PERMA_KEYS:
            ans = (p.get(f"{k.lower()}_content") or "").strip() or "（未填）"
            lines.append(f"[{k}] {_PERMA_DIM[k]}：{ans}")
        dump_parts.append("\n".join(lines))
    dump = "\n\n".join(dump_parts)

    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=3000,
        thinking={"type": "disabled"},
        system=_framework_block_system(fw, len(posts), lang),
        messages=[{"role": "user", "content": f"成員資料：\n\n{dump}"}],
    )
    meter_claude("coach-analyze-framework", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)

    text = _msg_text(msg)
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise HTTPException(status_code=502, detail="框架分析失敗，請重新生成")
    try:
        parsed = json.loads(match.group())
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="框架分析失敗，請重新生成")

    title = str(parsed.get("title") or fw.get("name") or "Custom framework").strip()
    body = str(parsed.get("body") or "").strip()
    if not body:
        raise HTTPException(status_code=502, detail="框架分析失敗，請重新生成")

    # 新區塊預設「僅教練」；custom=True 讓前端標記為 AI 框架、可刪。
    new_block = {"title": title, "body": body, "include": False, "custom": True}
    blocks = list(analysis.get("blocks") or []) + [new_block]

    update_resp = await db().patch(
        f"{SUPABASE_REST}/coach_analyses",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        params=[("member_id", f"eq.{req.member_id}")],
        # 追加區塊後，舊翻譯快取的區塊數已對不上 → 作廢，讓教練需要時重新翻譯
        json={"blocks": blocks, "translations": {}, "updated_at": datetime.now(TW_TZ).isoformat()},
    )
    if update_resp.status_code in (200, 201) and update_resp.json():
        return update_resp.json()[0]
    return {**analysis, "blocks": blocks, "translations": {}}


def _included_blocks(analysis: dict) -> list[dict]:
    """教練勾選要納入交付版的區塊（語言指紋一律納入、已淘汰的區塊一律排除）。"""
    return [
        b for b in (analysis.get("blocks") or [])
        if (
            b.get("include")
            or str(b.get("title") or "").strip().lower() in {"linguistic fingerprint", "語言指紋"}
        )
        and str(b.get("title") or "").strip().lower() not in _REMOVED_BLOCK_TITLES
    ]


async def _write_client_report(
    analysis: dict, actor_id: str, source: str, language: str | None = None
) -> str:
    """把勾選的分析區塊改寫成給本人閱讀的回顧文件（Markdown）。

    language 留空時沿用原本行為：由分析內容自動判斷語言。
    學員版報告會明確指定 zh-TW，因為分析本身是英文生成、但學員要讀中文。
    """
    included = _included_blocks(analysis)
    if not included:
        raise HTTPException(status_code=409, detail="請先在教練分析勾選要納入客戶版的區塊")

    material = "\n\n".join(f"## {b['title']}\n{b['body']}" for b in included)
    lang = language or _detect_lang(material)
    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=3000,
        thinking={"type": "disabled"},
        system=_client_report_system(lang),
        messages=[{"role": "user", "content": material}],
    )
    meter_claude(source, _COACH_ANALYSIS_MODEL, msg.usage, actor_id)
    return _msg_text(msg).strip()


@app.post("/api/coach/client-report")
async def coach_client_report(req: CoachMemberRequest, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)

    resp = await db().get(
        f"{SUPABASE_REST}/coach_analyses",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{req.member_id}"), ("select", "*"), ("limit", "1")],
    )
    rows = resp.json() if resp.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=409, detail="請先生成教練分析")
    analysis = rows[0]

    client_text = await _write_client_report(analysis, coach_id, "coach-client-report")
    client_date = datetime.now(TW_TZ).date().isoformat()
    update_resp = await db().patch(
        f"{SUPABASE_REST}/coach_analyses",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        params=[("member_id", f"eq.{req.member_id}")],
        json={"client_text": client_text, "client_date": client_date},
    )
    if update_resp.status_code in (200, 201) and update_resp.json():
        return update_resp.json()[0]
    return {**analysis, "client_text": client_text, "client_date": client_date}


class CoachTranslateRequest(BaseModel):
    member_id: str
    target: str = "zh-TW"  # 目前只支援翻成繁體中文；英文為原生生成語言


@app.post("/api/coach/translate")
async def coach_translate(req: CoachTranslateRequest, authorization: str = Header(...)):
    """把已生成的英文分析（blocks + sessions 的文字欄位）翻成目標語言並快取。
    已快取則直接回傳，不重複呼叫模型。"""
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)

    resp = await db().get(
        f"{SUPABASE_REST}/coach_analyses",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{req.member_id}"), ("select", "*"), ("limit", "1")],
    )
    rows = resp.json() if resp.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=409, detail="請先生成教練分析")
    analysis = rows[0]

    translations = analysis.get("translations") or {}
    if req.target in translations:  # 已快取，直接回傳
        return analysis

    source = {"blocks": analysis.get("blocks") or [], "sessions": analysis.get("sessions") or []}
    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=8000,
        thinking={"type": "disabled"},
        system=_TRANSLATE_SYSTEM,
        messages=[{"role": "user", "content": json.dumps(source, ensure_ascii=False)}],
    )
    meter_claude("coach-translate", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)

    try:
        match = re.search(r"\{.*\}", _msg_text(msg), re.DOTALL)
        if not match:
            raise ValueError("找不到 JSON")
        translated = json.loads(match.group())
        if not isinstance(translated.get("blocks"), list) or not isinstance(translated.get("sessions"), list):
            raise ValueError("結構不符")
        if len(translated["blocks"]) != len(source["blocks"]) or len(translated["sessions"]) != len(source["sessions"]):
            raise ValueError("長度不符")
    except Exception as exc:
        logger.warning("coach_translate parse failed [%s]: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="翻譯解析失敗，請重新嘗試")

    translations[req.target] = {"blocks": translated["blocks"], "sessions": translated["sessions"]}
    update_resp = await db().patch(
        f"{SUPABASE_REST}/coach_analyses",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        params=[("member_id", f"eq.{req.member_id}")],
        json={"translations": translations},
    )
    if update_resp.status_code in (200, 201) and update_resp.json():
        return update_resp.json()[0]
    return {**analysis, "translations": translations}


async def _get_user_email(user_id: str) -> str | None:
    """用 service_role 讀 auth.users 拿 email（profiles 沒有存 email）。"""
    resp = await db().get(
        f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        },
    )
    if resp.status_code != 200:
        logger.warning("fetch user email failed: %s", resp.status_code)
        return None
    return resp.json().get("email")


async def _email_report(report: dict) -> bool:
    """把已發布的報告寄給學員。回傳是否真的寄出。

    刻意設計成「失敗不影響主流程」：沒設定 RESEND_API_KEY、拿不到 email、
    或 Resend 回錯，都只記 log 就算了——報告本身在網站上還是看得到。
    已寄過（emailed_at 有值）就不重複寄。
    """
    if not RESEND_API_KEY:
        logger.info("RESEND_API_KEY 未設定，略過寄送報告 email")
        return False
    if report.get("emailed_at"):
        return False

    user_id = report["user_id"]
    to_email = await _get_user_email(user_id)
    if not to_email:
        return False

    profile_resp = await db().get(
        f"{SUPABASE_REST}/profiles",
        headers=SUPABASE_HEADERS,
        params=[("id", f"eq.{user_id}"), ("select", "display_name"), ("limit", "1")],
    )
    profile_rows = profile_resp.json() if profile_resp.status_code == 200 else []
    display_name = profile_rows[0].get("display_name", "") if profile_rows else ""

    subject, html_body = build_report_email(
        display_name=display_name,
        week_number=report["week_number"],
        body_md=report.get("body_md") or "",
        report_url=f"{APP_BASE_URL}/app/report",
    )

    send_resp = await db().post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"from": REPORT_FROM, "to": [to_email], "subject": subject, "html": html_body},
    )
    if send_resp.status_code not in (200, 201):
        logger.warning("Resend 寄送失敗 %s: %s", send_resp.status_code, send_resp.text)
        return False

    await db().patch(
        f"{SUPABASE_REST}/member_reports",
        headers=SUPABASE_HEADERS,
        params=[("id", f"eq.{report['id']}")],
        json={"emailed_at": datetime.now(TW_TZ).isoformat()},
    )
    return True


class CoachPublishReportRequest(BaseModel):
    report_id: str


@app.post("/api/coach/publish-report")
async def coach_publish_report(req: CoachPublishReportRequest, authorization: str = Header(...)):
    """教練確認第 4／8 週的草稿後發布給學員，並寄出報告 email。"""
    token = authorization.removeprefix("Bearer ").strip()
    await require_coach(token)

    update_resp = await db().patch(
        f"{SUPABASE_REST}/member_reports",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        params=[("id", f"eq.{req.report_id}")],
        json={"status": "published", "published_at": datetime.now(TW_TZ).isoformat()},
    )
    rows = update_resp.json() if update_resp.status_code in (200, 201) else []
    if not rows:
        raise HTTPException(status_code=404, detail="找不到這份報告")

    report = rows[0]
    emailed = await _email_report(report)
    return {**report, "emailed": emailed}


class MemberReportRequest(BaseModel):
    week_start: str  # 該週的週一（YYYY-MM-DD）


@app.post("/api/member/report")
@limiter.limit("6/hour")
async def member_report(
    request: Request, req: MemberReportRequest, authorization: str = Header(...)
):
    """學員填完當週五題後產生自己的 PERMA 報告。

    內容與排版沿用教練後台的「客戶交付版」，確保學員看到的與教練手上的一致：
    先跑一次完整縱向分析（同一支 prompt），再改寫成給本人閱讀的回顧。

    第 4、8 週產生的是草稿（pending_coach）——學員看不到，也不寄信，
    等教練在後台親自編輯確認後按「發布」才轉成 published。
    """
    token = authorization.removeprefix("Bearer ").strip()
    user_id = await get_user_id(token)

    try:
        week_number = _program_week_number(req.week_start)
    except ValueError:
        raise HTTPException(status_code=400, detail="週次日期格式錯誤")
    if week_number < 1:
        raise HTTPException(status_code=400, detail="這一週在課程開始之前")

    # 已經有這週的報告就直接回傳，不重複花錢跑分析。
    existing_resp = await db().get(
        f"{SUPABASE_REST}/member_reports",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{user_id}"),
            ("week_start", f"eq.{req.week_start}"),
            ("select", "*"),
            ("limit", "1"),
        ],
    )
    existing = existing_resp.json() if existing_resp.status_code == 200 else []
    if existing:
        return existing[0]

    analysis = await _analyze_member(user_id, user_id, "member-report")
    # 學員讀的是中文；分析本身是英文生成，這裡明確指定改寫成繁中。
    body_md = await _write_client_report(analysis, user_id, "member-report-text", language="zh-TW")

    baseline_resp = await db().get(
        f"{SUPABASE_REST}/baseline_scores",
        headers=SUPABASE_HEADERS,
        params=[("user_id", f"eq.{user_id}"), ("select", "p,e,r,m,a"), ("limit", "1")],
    )
    baseline_rows = baseline_resp.json() if baseline_resp.status_code == 200 else []
    baseline = None
    if baseline_rows:
        b = baseline_rows[0]
        baseline = {k: b[k.lower()] for k in _PERMA_KEYS}

    needs_review = week_number in COACH_REVIEW_WEEKS
    now = datetime.now(TW_TZ).isoformat()
    row = {
        "user_id": user_id,
        "week_start": req.week_start,
        "week_number": week_number,
        "status": "pending_coach" if needs_review else "published",
        "body_md": body_md,
        "charts": _MEMBER_CHART_DEFAULTS,
        "sessions": analysis.get("sessions") or [],
        "baseline": baseline,
        "published_at": None if needs_review else now,
    }
    insert_resp = await db().post(
        f"{SUPABASE_REST}/member_reports",
        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
        json=row,
    )
    if insert_resp.status_code in (200, 201):
        rows = insert_resp.json()
        if rows:
            saved = rows[0]
            # 自動發布的週次才寄信；第 4／8 週等教練按「發布給學員」時才寄。
            if saved.get("status") == "published":
                await _email_report(saved)
            return saved
    logger.warning("member_reports insert failed: %s", insert_resp.text)
    return row


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT)
