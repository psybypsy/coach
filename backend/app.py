from __future__ import annotations

import asyncio
import io
import base64
import hashlib
import html
import hmac
import json
import logging
import os
import re
import smtplib
import socket
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr

import anthropic
import httpx
import openai
from dotenv import load_dotenv

import usage_metering
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
REPORT_WEBHOOK_SECRET: str = os.environ.get("REPORT_WEBHOOK_SECRET", "")
# 每位學員每小時可觸發幾次 /api/member/report（防止刷爆 AI 費用）。
# 測試期間可在 Render 設 MEMBER_REPORT_RATE_LIMIT 調寬（例如 "100/hour"），
# 正式上線前記得拿掉這個環境變數或改回小數字，回到 6/hour 的預設值。
MEMBER_REPORT_RATE_LIMIT: str = os.environ.get("MEMBER_REPORT_RATE_LIMIT", "6/hour")

# ── 學員報告 Email ──
# 用 Gmail 自己的 SMTP 寄信：不需要自有網域、不必設定 DNS。
# GMAIL_APP_PASSWORD 是 Google 帳號的「應用程式密碼」（需先開啟兩步驟驗證），
# 不是 Gmail 的登入密碼。沒設定時就完全不寄信，其餘功能照常運作。
GMAIL_ADDRESS: str | None = os.environ.get("GMAIL_ADDRESS")
GMAIL_APP_PASSWORD: str | None = os.environ.get("GMAIL_APP_PASSWORD")
# 收件人看到的寄件者顯示名稱。品牌決定：一律 Ipsen Taiwan，不出現 PSYbyPSY。
REPORT_FROM_NAME: str = os.environ.get("REPORT_FROM_NAME", "Ipsen Taiwan")
APP_BASE_URL: str = os.environ.get("APP_BASE_URL", "https://coach-roan-eta.vercel.app")
_GMAIL_SMTP_HOST = "smtp.gmail.com"
_GMAIL_SMTP_PORT = 465  # SSL

# ── 寄信管道：優先走 Gmail API（HTTPS 443），SMTP 只留給本機開發 ──
# Render 免費方案封鎖所有對外 SMTP 連接埠（25／465／587），封包被靜靜丟掉，
# smtplib 一定以 TimeoutError 收場——調長 timeout 或重試都沒有用，這是防火牆。
# Gmail API 走 https://gmail.googleapis.com（443），不在封鎖範圍內，而且寄件者
# 仍然是 Gmail 本人，DKIM／SPF 完全對齊，不會被判成垃圾信。
# 設定方式見 docs/gmail-api-setup.md。這三個變數沒設齊就自動退回 SMTP。
GMAIL_OAUTH_CLIENT_ID: str | None = os.environ.get("GMAIL_OAUTH_CLIENT_ID")
GMAIL_OAUTH_CLIENT_SECRET: str | None = os.environ.get("GMAIL_OAUTH_CLIENT_SECRET")
GMAIL_OAUTH_REFRESH_TOKEN: str | None = os.environ.get("GMAIL_OAUTH_REFRESH_TOKEN")
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


def _gmail_api_ready() -> bool:
    return bool(GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN)


# ── Brevo（正式環境實際採用的管道）──
# 一樣走 HTTPS 443，不受 SMTP 埠封鎖影響，而且只要一把 API key，
# 不必像 Gmail API 那樣去 Google Cloud 建專案、跑 OAuth 流程。
# 免費方案每天 300 封。設定方式見 docs/brevo-setup.md。
BREVO_API_KEY: str | None = os.environ.get("BREVO_API_KEY")
_BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email"
# 寄件地址。走 Brevo 時這個位址必須先在 Brevo 後台完成「寄件者驗證」；
# 沒設就沿用 GMAIL_ADDRESS（走 Gmail 的兩條管道一定得用 GMAIL_ADDRESS，
# 因為 Gmail 不允許代寄任意位址）。
REPORT_FROM_EMAIL: str | None = os.environ.get("REPORT_FROM_EMAIL") or GMAIL_ADDRESS

# 不支援 HTML 的信件軟體看到的備援內容；三條管道共用。
_PLAIN_TEXT_FALLBACK = "這封信包含你的 PERMA 個人回顧，請用支援 HTML 的信件軟體開啟。"


def _mail_channel() -> str:
    """目前實際會用哪一條寄信管道；沒有任何一條設定齊全時回 ""。

    優先序：Brevo → Gmail API → Gmail SMTP。SMTP 排最後是因為 Render 免費方案
    封鎖對外 SMTP 埠（25／465／587），那條路線只有在本機開發跑得動。
    """
    if BREVO_API_KEY and REPORT_FROM_EMAIL:
        return "Brevo"
    if GMAIL_ADDRESS and _gmail_api_ready():
        return "Gmail API"
    if GMAIL_ADDRESS and GMAIL_APP_PASSWORD:
        return "Gmail SMTP"
    return ""


# smtp.gmail.com 同時有 IPv4／IPv6 位址；Render 免費方案的對外網路沒有可用的
# IPv6 路由，若 DNS 解析挑到 IPv6 位址會直接連線失敗（OSError: [Errno 101]
# Network is unreachable，實測發生過）。其他呼叫（Anthropic／Supabase／OpenAI）
# 都正常，代表整體網路沒問題，只有這個特定組合會撞到，所以只在 process 層級
# 全域過濾成只回傳 IPv4 位址——不影響其他服務（它們本來就沒有走到 IPv6）。
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(*args, **kwargs):
    return [ai for ai in _orig_getaddrinfo(*args, **kwargs) if ai[0] == socket.AF_INET]


socket.getaddrinfo = _ipv4_only_getaddrinfo

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

# asyncio 只對 create_task() 的結果持有弱參照；沒有其他地方保留強參照的話，
# 任務可能在還沒跑完時就被 GC 回收（"Task was destroyed but it is pending"）。
# 背景寄信（_email_report）就是用這個模式，這裡統一存放。
_background_tasks: set[asyncio.Task] = set()

# 正在寄送中的報告 id。學員的報告頁會輪詢、Supabase webhook 也會觸發，
# 沒有這道鎖就可能同時開好幾個背景寄信任務、把同一封信寄很多次。
_emailing_reports: set[str] = set()

# 正在重跑深度分析的成員 id。學員前端與 Supabase webhook 會同時觸發同一週的報告，
# 沒有這道鎖就可能同時開兩個背景任務、把全期間分析的錢付兩次。
_analyzing_members: set[str] = set()


def _spawn_background(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task

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
# 已淘汰的情報簡報區塊：教練後台仍可能有舊資料，但一律不納入交付給客戶的版本。
_REMOVED_BLOCK_TITLES = {
    "cross-cutting themes & patterns", "橫向主題與模式",
    "the unsaid", "未言之事",
    "coaching hypotheses", "教練假設",
    "worth watching", "值得關注",
    "session preparation", "會談準備",
}
_ALLOWED_BLOCK_TITLES = {
    "perma five-dimension profile", "perma 五面向剖析",
    "strengths & inner resources", "優勢與內在資源",
    # 每週客戶版用「回顧」而非「剖析」；漏了它會讓單週分析的區塊被過濾掉、整個生成失敗
    "perma 五面向回顧",
}
# 報告只保留四個量化圖表。
_CLIENT_CHART_DEFAULTS = {
    "dims": True, "topics": True, "radar": True, "cloud": True,
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

Include only these two blocks, in this order. Do not create any other brief block:
[[BLOCK]] PERMA Five-Dimension Profile
[[BLOCK]] Strengths & Inner Resources

Both blocks must: (a) stay tied to this person's specific quotes with week citations; (b) end with a "**References**" sub-heading listing 2-3 APA-format references (journal or book titles in * italics *) relevant only to that block.

Per-block requirements:
- PERMA Five-Dimension Profile: analyze P/E/R/M/A one by one, noting fullness (abundant / stable / thin / absent), change over time and key quotes, then integrate the overall pattern through a PERMA lens. References may draw from: Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.; Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218-226.; Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
- Strengths & Inner Resources: identify the character strengths and reusable inner resources this person demonstrates, naming them with VIA character-strength vocabulary (e.g. zest, curiosity, perseverance, perspective, social intelligence, gratitude, self-regulation, bravery, kindness, fairness, humour, hope). Lead each strength with a line "- **Strength name**", then indented two-space sub-bullets giving the supporting quote (with week citation) and where this strength could be drawn on again. Judge across all weeks and pick the 3-4 best-evidenced; do not enumerate exhaustively. References may draw from: Peterson, C., & Seligman, M. E. P. (2004). *Character strengths and virtues: A handbook and classification*. Oxford University Press.; Niemiec, R. M. (2018). *Character strengths interventions: A field guide for practitioners*. Hogrefe.; Linley, P. A., Nielsen, K. M., Gillett, R., & Biswas-Diener, R. (2010). Using signature strengths in pursuit of goals. *International Coaching Psychology Review, 5*(1), 6-15.
Language: English. No emoji anywhere. Tone: professional, precise, theoretically grounded — like a senior coach's clinical notes."""


def _coach_analysis_system(week_count: int, language: str = "zh-TW") -> str:
    if language != "zh-TW":
        return _coach_analysis_system_en(week_count)
    return f"""你是資深高階主管教練的分析助理，服務於教練 Yee Ming Tan。你會收到一位團隊成員 {week_count} 次每週 PERMA 反思的原始回答（P=Positive Emotions、E=Engagement、R=Relationships、M=Meaning、A=Accomplishment）。請產出兩部分：每次的情緒 valence 量化分析（含理由），與一份僅供教練的情報簡報。

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

務必只包含以下兩個區塊、依此順序，不得產生其他情報簡報區塊：
[[BLOCK]] PERMA 五面向剖析
[[BLOCK]] 優勢與內在資源

兩個區塊都必須：(a) 全程扣合此人的具體引文並註明第幾次；(b) 在內文最後另起一行、以「**參考文獻**」為小標，再用 - 條列 2 至 3 筆 APA 格式文獻（期刊名或書名以 * 斜體 * 標示），且只列與該區塊主題直接相關者，不得跨區塊混用。

各區塊要求：
- PERMA 五面向剖析：逐一分析 P/E/R/M/A 五面向，標飽滿度（充沛／穩定／稀薄／缺席）、變化與關鍵引文，並以 PERMA 觀點整合此人整體樣態。參考文獻可從下列擇要引用：Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.；Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218–226.；Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
- 優勢與內在資源：辨識此人展現的性格優勢與可再次運用的內在資源，以 VIA 性格優勢架構的語彙命名（例如熱情與活力、好奇心、毅力、洞察力、社會智慧、感恩、自我調節、勇氣、仁慈、公平、幽默、希望）。每項優勢先用一行「- **優勢名稱**」當標籤，再用縮排兩格的子條列寫：扣合的原話證據（註明第幾次）、以及這項優勢可以再被動用在哪裡。跨全部週綜合判斷，挑 3 至 4 項最有證據支持者，不要窮舉。參考文獻可從下列擇要引用：Peterson, C., & Seligman, M. E. P. (2004). *Character strengths and virtues: A handbook and classification*. Oxford University Press.；Niemiec, R. M. (2018). *Character strengths interventions: A field guide for practitioners*. Hogrefe.；Linley, P. A., Nielsen, K. M., Gillett, R., & Biswas-Diener, R. (2010). Using signature strengths in pursuit of goals. *International Coaching Psychology Review, 5*(1), 6–15.
語言：繁體中文（台灣）。全篇不得使用任何 emoji。語氣專業、精確，兼具實證理論素養，如資深教練結合學理的臨床筆記。"""


def _weekly_client_analysis_system() -> str:
    """每週報告專用：內容會原文放進寄給客戶的 PDF，所以直接用「對客戶說話」的第二人稱書寫。
    量化欄位（valence／topics／emotions）規則與教練版完全一致，圖表才不會因版本不同而失準。"""
    return """你是教練 Yee Ming Tan 的寫作助理。你會收到一位成員「這一週」的 PERMA 反思原始回答（P=正向情緒、E=投入、R=人際關係、M=意義、A=成就）。請產出兩部分：這一週的情緒 valence 量化分析，與一份「直接寫給這位成員本人閱讀」的 PERMA 五面向回顧。

嚴格照此格式輸出，兩個標記都要出現：
<<<SCORES>>>
{"sessions":[
 {"overall":-100至100的整數,
  "overallReason":"這一週整體情緒基調的評分依據，引用回答原話",
  "dims":{"P":{"v":-100至100,"reason":"依據"},"E":{"v":0,"reason":""},"R":{"v":0,"reason":""},"M":{"v":0,"reason":""},"A":{"v":0,"reason":""}},
  "topics":{"work":0至100,"relationships":0至100,"health":0至100,"rest":0至100,"growth":0至100,"other":0至100},
  "emotions":[{"word":"回答原文中的情緒詞","valence":"positive|negative|neutral","intensity":1至5}]}
]}
<<<BRIEF>>>
[[BLOCK]] PERMA 五面向回顧
區塊內文

分數規則：
- sessions 長度必須剛好 1。
- valence 為情緒效價：−100 為極度負面、0 為中性、+100 為極度正面。只依文字內容判定，每個分數都要有具體理由並引用原話；未填或空泛給接近 0。
- 抽 6 至 12 個情緒詞。
- topics 是這週書寫在六個固定主題的關注占比：work（工作／學業）、relationships（關係）、health（健康）、rest（休息與恢復）、growth（自我成長）、other（其他）。回傳非負整數且總和必須剛好為 100。以語意單位判斷，不以原始字數直接計算。

【最重要】書寫視角：這份內容會原封不動放進寄給這位成員本人的報告裡，所以整篇都要「直接對他說話」。
- 一律使用第二人稱「你」。嚴禁出現「此人」「這位成員」「該員」「個案」等第三人稱指稱。
- 語氣溫暖、具體、賦能，像教練當面回顧，而不是臨床筆記或評鑑報告。
- 引用他自己的原話當證據（例如：你提到「完全忘記時間」）。
- 描述現象與可能性，不下診斷、不評好壞、不使用風險或病理語言。

區塊內文格式：
- 逐一走過 P/E/R/M/A 五面向。每個面向先一行「- **P（正向情緒）：飽滿度**」（飽滿度用：充沛／穩定／正在萌芽／這週較少著墨），再用縮排兩格的子條列「  - …」寫 1 至 2 點具體觀察，每點都扣合你引用的原話。
- 五面向之後，另起一行「- **你的優勢與內在資源**」，接著用縮排兩格的子條列寫 2 至 3 點。每一點的寫法：先點名一項這週真的展現出來的性格優勢（用 VIA 性格優勢的語彙，例如：熱情與活力、好奇心、毅力、洞察力、社會智慧、感恩、自我調節、勇氣、仁慈、公平、幽默、希望），緊接著用他自己的原話當證據，最後一句點出這項優勢「還可以用在哪裡」，讓他知道這是可再次動用的資源，而不只是一個標籤。
- 優勢之後，另起一行「- **這週的整體樣貌**」，用縮排子條列寫給客戶的總結：先點出這週最突出的能量來源，再指出一個溫和的觀察或邀請。
- 總結的最後，另起一行單獨寫一句**金句**，格式為「> 一句話的金句」（以 > 開頭）。這句要短、有畫面、能帶來希望感，並且是從他這週自己的文字裡長出來的，不是空泛勵志語。
- 最後另起一行，以「**參考文獻**」為小標，用 - 條列 2 至 3 筆 APA 格式文獻（期刊名或書名以 * 斜體 * 標示）。既然談了優勢，請至少納入一筆 VIA 性格優勢文獻。可從下列擇要引用：Peterson, C., & Seligman, M. E. P. (2004). *Character strengths and virtues: A handbook and classification*. Oxford University Press.；Niemiec, R. M. (2018). *Character strengths interventions: A field guide for practitioners*. Hogrefe.；Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.；Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218–226.；Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.

語言：繁體中文（台灣）。全篇不得使用任何 emoji。"""


def _framework_gen_system(language: str = "zh-TW") -> str:
    """教練用自然語言描述想分析什麼 → AI 上網找對應的實證理論 → 生成可套用的結構化框架。"""
    if language == "zh-TW":
        return """你是結合心理學文獻與高階主管教練實務的「分析框架設計師」，服務於教練 Yee Ming Tan。教練會用自然語言描述他想在一位成員的每週 PERMA 反思書寫中分析什麼，請優先使用網路搜尋，找出對應且有實證基礎的心理學／諮商／教練理論或模型（例如「面對轉變的能動性」→ 自我決定理論 SDT；「完美主義」→ Frost 多維完美主義；「情緒調節方式」→ Gross 情緒調節歷程模型；「自我批評 vs 自我疼惜」→ Neff 自我疼惜），再轉化成一個可實際套用在反思文字上的結構化分析框架。

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


def _framework_block_system(fw: dict, week_count: int, language: str = "zh-TW") -> str:
    """用一個(教練生成的)框架，對成員 {week_count} 次每週反思生成單一情報簡報區塊。
    輸出格式與既有 block 一致，可直接 append 進 coach_analyses.blocks。"""
    fw_text = _framework_to_text(fw)
    if language == "zh-TW":
        return f"""你是資深高階主管教練 Yee Ming Tan 的分析助理。教練提供了一個自訂分析框架，請只用「這個框架」分析一位成員 {week_count} 次每週 PERMA 反思，產出一個情報簡報區塊（僅教練可見、可含坦率假設）。

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
- End with 1 to 2 warm, forward-looking invitations.
- Entirely in English. No emoji.
- Do not repeat the title page or signature (the system adds them)."""


_CLIENT_REPORT_SYSTEM_ZH = """你是教練 Yee Ming Tan 的寫作助理。以下是教練勾選要納入客戶交付版的分析內容。請改寫成一份給客戶本人閱讀的正式、溫暖、賦能的「個人福祉回顧」。

要求：
- 移除所有假設、臨床推測、風險或診斷性語言；聚焦優勢、軌跡、意義與前瞻。
- 保留並適度引用客戶自己的語言。
- 用 Markdown，以 ## 分節，段落清晰、專業；多用 - 條列（不要用數字條列），少用長段落。
- 每段用 **粗體** 標出這段的重點短語（一段一個重點、標短語即可，不要整句加粗），讓人快速掃過粗體就能抓到重點。
- 最後以 1 至 2 個溫暖的前瞻邀請作結。
- 全篇繁體中文（台灣），不得使用任何 emoji。
- 不要重複標題頁與署名（系統會自動加上）。"""


def _client_report_system(language: str = "zh-TW") -> str:
    return _CLIENT_REPORT_SYSTEM_ZH if language == "zh-TW" else _CLIENT_REPORT_SYSTEM_EN


def _font_missing_chars(font_name: str, text: str) -> set[str]:
    """回傳 text 裡「這個字型沒有的字符」。查不到字型資訊時回空集合（不擋流程）。"""
    try:
        from reportlab.pdfbase import pdfmetrics

        face = pdfmetrics.getFont(font_name).face
        cmap = getattr(face, "charToGlyph", None)
        if not cmap:
            return set()
        return {ch for ch in set(text) if ch.strip() and ord(ch) > 127 and ord(ch) not in cmap}
    except Exception:
        return set()


def _plain_markdown(value: str) -> str:
    """ReportLab 內文使用的輕量 Markdown 清理。"""
    text = re.sub(r"^#{1,3}\s+", "", value, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*(.+?)\*(?!\*)", r"\1", text)
    return text.strip()


async def _member_identity(member_id: str) -> tuple[str, str]:
    """用 service role 讀取會員 email；profiles 只存顯示名稱。"""
    auth_resp = await db().get(
        f"{SUPABASE_URL}/auth/v1/admin/users/{member_id}",
        headers={"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}"},
    )
    email = str((auth_resp.json() if auth_resp.status_code == 200 else {}).get("email") or "").strip()
    profile_resp = await db().get(
        f"{SUPABASE_REST}/profiles",
        headers=SUPABASE_HEADERS,
        params=[("id", f"eq.{member_id}"), ("select", "display_name"), ("limit", "1")],
    )
    profiles = profile_resp.json() if profile_resp.status_code == 200 else []
    name = str((profiles[0] if profiles else {}).get("display_name") or "你好").strip()
    return name, email


_TRANSLATE_SYSTEM_EN = """You translate an executive-coaching analysis from Traditional Chinese (Taiwan) into English.

You will receive a JSON object with "blocks" and "sessions". Return ONLY a JSON object with the exact same structure, keys, and array lengths, translating these human-readable text fields into natural, professional English:
- blocks[].title, blocks[].body
- sessions[].overallReason, sessions[].dims.P/E/R/M/A.reason, sessions[].emotions[].word

Rules:
- Preserve ALL Markdown syntax in bodies (##, **, *, -) exactly.
- Keep academic citations / APA references and *italic* work titles in their original language — do NOT translate author names, journal names, or book titles.
- Do NOT change any numbers, any "valence" values (positive/negative/neutral), "intensity", "v", "include", or any JSON keys.
- No emoji. Output valid JSON only — no commentary, no code fences."""

_TRANSLATE_SYSTEM_ZH = """You translate an executive-coaching analysis from English into Traditional Chinese (Taiwan, 繁體中文).

You will receive a JSON object with "blocks" and "sessions". Return ONLY a JSON object with the exact same structure, keys, and array lengths, translating these human-readable text fields into natural, professional Traditional Chinese:
- blocks[].title, blocks[].body
- sessions[].overallReason, sessions[].dims.P/E/R/M/A.reason, sessions[].emotions[].word

Rules:
- Preserve ALL Markdown syntax in bodies (##, **, *, -) exactly.
- Keep academic citations / APA references and *italic* work titles in their original language.
- Do NOT change numbers, valence values, intensity, v, include, or JSON keys.
- No emoji. Output valid JSON only — no commentary, no code fences."""


def _translate_system(target: str) -> str:
    return _TRANSLATE_SYSTEM_EN if target == "en" else _TRANSLATE_SYSTEM_ZH


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

    # 新版只產生 PERMA 五面向剖析，並預設納入客戶版。
    parts = [p.strip() for p in brief_part.split("[[BLOCK]]") if p.strip()]
    blocks = []
    for idx, part in enumerate(parts):
        nl = part.find("\n")
        title = (part[:nl] if nl >= 0 else part).strip()
        body = (part[nl + 1:] if nl >= 0 else "").strip()
        if title.lower() in _ALLOWED_BLOCK_TITLES:
            blocks.append({"title": title, "body": body, "include": True})

    return sessions, blocks


def _detect_lang(text: str) -> str:
    """依內容裡中文字 vs 拉丁字母的多寡，判斷學員書寫語言；判斷不出來預設繁中。
    政策：分析與客戶回顧都跟隨「學員書寫的語言」，而非教練介面語言。"""
    cjk = sum(1 for ch in text if 0x4E00 <= ord(ch) <= 0x9FFF)
    latin = sum(1 for ch in text if "a" <= ch.lower() <= "z")
    return "en" if latin > cjk else "zh-TW"


async def _fetch_member_posts(member_id: str) -> list[dict]:
    resp = await db().get(
        f"{SUPABASE_REST}/journal_posts",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{member_id}"),
            ("select", "id,week_start,p_content,e_content,r_content,m_content,a_content,created_at"),
            ("order", "week_start.asc,created_at.asc"),
        ],
    )
    return resp.json() if resp.status_code == 200 else []


def _posts_dump(posts: list[dict]) -> str:
    dump_parts = []
    for i, post in enumerate(posts):
        lines = [f"── 第 {i + 1} 次（{post.get('week_start', '')}）"]
        for key in _PERMA_KEYS:
            answer = (post.get(f"{key.lower()}_content") or "").strip() or "（未填）"
            lines.append(f"[{key}] {_PERMA_DIM[key]}：{answer}")
        dump_parts.append("\n".join(lines))
    return "\n\n".join(dump_parts)


async def _analyze_completed_posts(posts: list[dict], coach_id: str) -> tuple[list, list]:
    """自動完成 webhook 與 coach API 共用的繁中分析核心。"""
    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=8000,
        thinking={"type": "disabled"},
        system=_coach_analysis_system(len(posts), "zh-TW"),
        messages=[{"role": "user", "content": f"成員資料：\n\n{_posts_dump(posts)}"}],
    )
    meter_claude("coach-auto-complete-analysis", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)
    return _parse_analysis(_msg_text(msg))


async def _analyze_week_for_client(post: dict, coach_id: str) -> tuple[list, list]:
    """單週分析，但內文以第二人稱寫給客戶本人（會原文放進寄出的 PDF）。
    量化欄位規則與教練版一致，因此圖表資料可互通。"""
    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=4000,
        thinking={"type": "disabled"},
        system=_weekly_client_analysis_system(),
        messages=[{"role": "user", "content": f"成員這一週的書寫：\n\n{_posts_dump([post])}"}],
    )
    meter_claude("coach-weekly-client-analysis", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)
    return _parse_analysis(_msg_text(msg))


def _baseline_valence(value: object) -> int:
    try:
        score = max(0.0, min(10.0, float(value)))
    except (TypeError, ValueError):
        score = 5.0
    return round((score - 5) * 20)


_PERMA_CHART_COLORS = {
    "P": "#B5843A", "E": "#487A64", "R": "#95586A", "M": "#3D6390", "A": "#6F5E97",
}
_TOPIC_CHART_COLORS = ["#3D6390", "#95586A", "#487A64", "#B5843A", "#6F5E97", "#8A94A2"]


def _weekly_radar_drawing(baseline: dict, dims: dict, week_number: int, font_name: str):
    """T0 vs 本週的五面向雷達圖。刻意與網頁版 coachViz.valRadar 用同一套幾何與配色，
    讓客戶收到的 PDF 跟教練在後台預覽的長得一樣。"""
    import math

    from reportlab.graphics.charts.legends import Legend
    from reportlab.graphics.shapes import Circle, Drawing, Line, Polygon, String
    from reportlab.lib import colors

    width, height = 460, 258
    cx, cy = width / 2, height / 2 - 6
    radius = 95
    drawing = Drawing(width, height)

    def angle(index: int) -> float:
        return math.radians(-90 + index * 72)

    def point(index: int, factor: float) -> tuple[float, float]:
        # ReportLab 的 y 軸向上、SVG 向下，因此 sin 取負號才能與網頁版同方向
        return (cx + math.cos(angle(index)) * radius * factor,
                cy - math.sin(angle(index)) * radius * factor)

    def to_factor(value: int) -> float:
        return (max(-100, min(100, int(value))) + 100) / 200

    for factor in (0.25, 0.5, 0.75, 1.0):
        coords: list[float] = []
        for index in range(5):
            coords.extend(point(index, factor))
        drawing.add(Polygon(
            coords, fillColor=None,
            strokeColor=colors.HexColor("#CBD1DA" if factor == 0.5 else "#E2E5EA"),
            strokeWidth=1.5 if factor == 0.5 else 1,
        ))

    for index, key in enumerate(_PERMA_KEYS):
        x, y = point(index, 1.0)
        drawing.add(Line(cx, cy, x, y, strokeColor=colors.HexColor("#E2E5EA"), strokeWidth=1))
        lx, ly = point(index, 1.17)
        drawing.add(String(
            lx, ly - 4, key, fontName=font_name, fontSize=12,
            fillColor=colors.HexColor(_PERMA_CHART_COLORS[key]), textAnchor="middle",
        ))

    def polygon(values: list[int], stroke: str, fill, stroke_width: float, dashed: bool):
        coords: list[float] = []
        for index, value in enumerate(values):
            coords.extend(point(index, to_factor(value)))
        shape = Polygon(coords, fillColor=fill, strokeColor=colors.HexColor(stroke),
                        strokeWidth=stroke_width, strokeLineJoin=1)
        if dashed:
            shape.strokeDashArray = [5, 4]
        return shape

    t0_values = [_baseline_valence(baseline.get(key)) for key in _PERMA_KEYS]
    week_values = [int((dims.get(key) or {}).get("v", 0)) for key in _PERMA_KEYS]
    drawing.add(polygon(t0_values, "#8993A1", colors.Color(0.537, 0.576, 0.635, 0.12), 1.5, True))
    drawing.add(polygon(week_values, "#1F3A5C", colors.Color(0.122, 0.227, 0.361, 0.14), 2, False))
    for index, value in enumerate(week_values):
        x, y = point(index, to_factor(value))
        drawing.add(Circle(x, y, 3, fillColor=colors.HexColor("#1F3A5C"), strokeColor=None))

    legend = Legend()
    legend.x, legend.y = 150, 14
    legend.fontName = font_name
    legend.fontSize = 9
    legend.alignment = "right"
    legend.columnMaximum = 1
    legend.deltax = 104
    legend.dxTextSpace = 5
    legend.colorNamePairs = [
        (colors.HexColor("#8993A1"), "T0 基準（虛線）"),
        (colors.HexColor("#1F3A5C"), f"第 {week_number} 週"),
    ]
    drawing.add(legend)
    return drawing


def _weekly_wordcloud_drawing(emotions: list, font_name: str):
    """本週情緒詞雲：字級隨強度、顏色隨效價，與網頁版 emotionWordCloud 的視覺邏輯一致。
    沒有情緒詞時回傳 None。"""
    from reportlab.graphics.shapes import Drawing, Rect, String
    from reportlab.lib import colors
    from reportlab.pdfbase.pdfmetrics import stringWidth

    palette = {"positive": "#2E7057", "negative": "#B0542C", "neutral": "#8A94A2"}
    items = []
    for item in emotions or []:
        word = str((item or {}).get("word") or "").strip()
        if not word:
            continue
        try:
            intensity = max(1, min(5, int((item or {}).get("intensity") or 3)))
        except (TypeError, ValueError):
            intensity = 3
        valence = str((item or {}).get("valence") or "neutral")
        items.append((word, intensity, palette.get(valence, palette["neutral"])))
    if not items:
        return None

    # 強度高的排中間（與網頁版一樣由中央向外擴散），視覺重心才會落在最強烈的情緒
    items.sort(key=lambda entry: -entry[1])
    ordered: list = []
    for index, entry in enumerate(items):
        ordered.append(entry) if index % 2 else ordered.insert(0, entry)

    width = 460
    pad_x, gap_x, line_gap = 16, 16, 10
    rows: list[list[tuple[str, float, str, float]]] = [[]]
    row_width = 0.0
    for word, intensity, color in ordered:
        size = 12 + intensity * 3.2  # 強度 1→15.2、5→28
        text_width = stringWidth(word, font_name, size)
        if row_width and row_width + gap_x + text_width > width - pad_x * 2:
            rows.append([])
            row_width = 0.0
        rows[-1].append((word, size, color, text_width))
        row_width += (gap_x if row_width else 0) + text_width

    row_heights = [max(entry[1] for entry in row) for row in rows]
    height = sum(row_heights) + line_gap * (len(rows) - 1) + 30
    drawing = Drawing(width, height)
    drawing.add(Rect(0, 0, width, height, fillColor=colors.HexColor("#EEF0F3"),
                     strokeColor=colors.HexColor("#E2E5EA"), strokeWidth=1))

    y = height - 15
    for row, row_height in zip(rows, row_heights):
        y -= row_height
        total = sum(entry[3] for entry in row) + gap_x * (len(row) - 1)
        x = (width - total) / 2
        for word, size, color, text_width in row:
            drawing.add(String(x, y, word, fontName=font_name, fontSize=size,
                               fillColor=colors.HexColor(color)))
            x += text_width + gap_x
        y -= line_gap
    return drawing


def _weekly_topic_pie_drawing(topics: dict, font_name: str):
    """本週主題占比圓餅圖；沒有資料時回傳 None。"""
    from reportlab.graphics.charts.legends import Legend
    from reportlab.graphics.charts.piecharts import Pie
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib import colors

    labels = {
        "work": "工作／學業", "relationships": "關係", "health": "健康",
        "rest": "休息與恢復", "growth": "自我成長", "other": "其他",
    }
    pairs = [(labels[key], int(topics.get(key) or 0)) for key in labels]
    pairs = [(name, value) for name, value in pairs if value > 0]
    if not pairs:
        return None

    from reportlab.pdfbase.pdfmetrics import stringWidth

    # 依實際內容量測寬度再置中：餅圖與圖例若用固定座標，整組會偏左、右側空一大塊
    width, pie_size, gap = 460, 140, 26
    label_margin = 30  # 圓餅外圈的百分比標籤會超出餅身，兩側各留一段
    legend_font, swatch_width, text_space = 9, 9, 5
    legend_labels = [f"{name}　{value}%" for name, value in pairs]
    legend_width = swatch_width + text_space + max(
        stringWidth(label, font_name, legend_font) for label in legend_labels
    )
    total_width = label_margin + pie_size + label_margin + gap + legend_width
    start_x = max(0.0, (width - total_width) / 2)

    row_gap = 15
    legend_height = (len(pairs) - 1) * row_gap
    height = max(pie_size + label_margin * 2, legend_height + 40)
    pie_y = (height - pie_size) / 2
    pie_center_y = pie_y + pie_size / 2

    drawing = Drawing(width, height)
    pie = Pie()
    pie.x, pie.y = start_x + label_margin, pie_y
    pie.width = pie.height = pie_size
    pie.data = [value for _, value in pairs]
    pie.labels = [f"{value}%" for _, value in pairs]
    pie.slices.fontName = font_name
    pie.slices.fontSize = 8
    pie.slices.strokeColor = colors.white
    pie.slices.strokeWidth = 1
    pie.sideLabels = 0
    for index in range(len(pairs)):
        pie.slices[index].fillColor = colors.HexColor(_TOPIC_CHART_COLORS[index % len(_TOPIC_CHART_COLORS)])
    drawing.add(pie)

    legend = Legend()
    # legend.y 是圖例區塊的頂端，往下堆疊；加回半個區塊高度才會與餅圖垂直置中
    legend.x = start_x + label_margin + pie_size + label_margin + gap
    legend.y = pie_center_y + legend_height / 2
    legend.fontName = font_name
    legend.fontSize = legend_font
    legend.alignment = "right"
    legend.columnMaximum = len(pairs)
    legend.dxTextSpace = text_space
    legend.deltay = row_gap
    legend.colorNamePairs = [
        (colors.HexColor(_TOPIC_CHART_COLORS[index % len(_TOPIC_CHART_COLORS)]), label)
        for index, label in enumerate(legend_labels)
    ]
    drawing.add(legend)
    return drawing


def _build_weekly_report_pdf(
    member_name: str,
    week_number: int,
    week_start: str,
    baseline: dict,
    session: dict,
    block: dict,
    strengths_body: str = "",
) -> bytes:
    """產生只根據單週書寫、並與 T0 比較的繁中 PDF。
    strengths_body 為「優勢與內在資源」段落（取自教練深度分析），有值才附在最後。"""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    font_name = "NotoSansTC"
    font_path = os.path.join(os.path.dirname(__file__), "assets", "fonts", "NotoSansTC-Regular.ttf")
    try:
        pdfmetrics.getFont(font_name)
    except KeyError:
        pdfmetrics.registerFont(TTFont(font_name, font_path))

    # NotoSansTC 是繁中字型，少數「簡體專用」字（例：鹏 U+9E4F、陈 U+9648）不在字符集裡，
    # reportlab 沒有字型 fallback，缺字會靜靜地畫成空白方框 ▯。這裡至少讓它留下紀錄，
    # 不然學員名字變成方框也沒人會發現。要根治得換成同時涵蓋繁簡的 Noto Sans CJK。
    missing = _font_missing_chars(font_name, member_name + _plain_markdown(str(block.get("body") or "")))
    if missing:
        logger.warning(
            "PDF 缺字（NotoSansTC 沒有這些字符，會顯示為 ▯）第 %s 週: %s",
            week_number, "".join(sorted(missing)),
        )

    out = io.BytesIO()
    doc = SimpleDocTemplate(
        out,
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"{member_name} 第 {week_number} 週 PERMA 幸福感回顧",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "WeeklyTitleZH", parent=styles["Title"], fontName=font_name, fontSize=20,
        leading=28, alignment=TA_CENTER, textColor=colors.HexColor("#1F3A5C"),
    )
    heading = ParagraphStyle(
        "WeeklyHeadingZH", parent=styles["Heading2"], fontName=font_name, fontSize=14,
        leading=20, spaceBefore=10, spaceAfter=7, textColor=colors.HexColor("#1F3A5C"),
    )
    body = ParagraphStyle(
        "WeeklyBodyZH", parent=styles["BodyText"], fontName=font_name, fontSize=10,
        leading=17, spaceAfter=7, textColor=colors.HexColor("#283444"),
    )

    dims = session.get("dims") or {}

    quote_style = ParagraphStyle(
        "WeeklyQuoteZH", parent=body, fontSize=12, leading=20, alignment=TA_CENTER,
        textColor=colors.HexColor("#1F3A5C"), spaceBefore=8, spaceAfter=8,
        leftIndent=10 * mm, rightIndent=10 * mm, borderPadding=6,
        backColor=colors.HexColor("#F1F4F8"),
    )
    sub_style = ParagraphStyle(
        "WeeklySubZH", parent=body, leftIndent=7 * mm, fontSize=9.5, leading=15,
        spaceAfter=3, textColor=colors.HexColor("#3D4A5A"),
    )
    dim_style = ParagraphStyle(
        "WeeklyDimZH", parent=body, fontSize=10.5, leading=16, spaceBefore=5, spaceAfter=2,
        textColor=colors.HexColor("#1C2530"),
    )

    story = [
        Paragraph(f"第 {week_number} 週 PERMA 幸福感回顧", title_style),
        Paragraph(f"{html.escape(member_name)}　｜　週起始日 {html.escape(week_start)}", ParagraphStyle(
            "WeeklyMetaZH", parent=body, alignment=TA_CENTER, textColor=colors.HexColor("#6A7685"),
        )),
        Spacer(1, 6 * mm),
        Paragraph("五面向 valence 剖面", heading),
        _weekly_radar_drawing(baseline, dims, week_number, font_name),
        Paragraph("內圈為 −100、中圈為 0（中性）、外圈為 +100。",
                  ParagraphStyle("WeeklyRadarNoteZH", parent=body, fontSize=8.5, leading=13,
                                 alignment=TA_CENTER, textColor=colors.HexColor("#6A7685"))),
        Spacer(1, 5 * mm),
    ]

    topic_pie = _weekly_topic_pie_drawing(session.get("topics") or {}, font_name)
    if topic_pie is not None:
        story.extend([Paragraph("本週主題占比", heading), topic_pie, Spacer(1, 3 * mm)])

    wordcloud = _weekly_wordcloud_drawing(session.get("emotions") or [], font_name)
    if wordcloud is not None:
        story.extend([Paragraph("本週情緒詞雲", heading), wordcloud, Spacer(1, 4 * mm)])

    story.append(Paragraph("本週 PERMA 五面向回顧", heading))
    for raw_line in _plain_markdown(str(block.get("body") or "")).split("\n"):
        line = raw_line.rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        text = line.strip()
        if text.startswith(">"):  # 金句：置中、淺底色框，作為整份報告的收束
            story.append(Paragraph(html.escape(text.lstrip("> ").strip()), quote_style))
        elif text.startswith("- ") and indent >= 2:  # 縮排子條列＝該面向的具體觀察
            story.append(Paragraph("・" + html.escape(text[2:].strip()), sub_style))
        elif text.startswith("- "):  # 面向標籤
            story.append(Paragraph(html.escape(text[2:].strip()), dim_style))
        else:
            story.append(Paragraph(html.escape(text), body))

    # 優勢與內在資源（取自教練深度分析，跨全部週）；有內容才附上
    if strengths_body.strip():
        story.append(Spacer(1, 4 * mm))
        story.append(Paragraph("優勢與內在資源", heading))
        for raw_line in _plain_markdown(strengths_body).split("\n"):
            line = raw_line.rstrip()
            if not line.strip():
                continue
            indent = len(line) - len(line.lstrip())
            text = line.strip()
            if text.startswith("- ") and indent >= 2:
                story.append(Paragraph("・" + html.escape(text[2:].strip()), sub_style))
            elif text.startswith("- "):
                story.append(Paragraph(html.escape(text[2:].strip()), dim_style))
            else:
                story.append(Paragraph(html.escape(text), body))

    story.extend([
        Spacer(1, 4 * mm),
        Paragraph(
            "這份報告只根據本週書寫與 T0 起始狀態整理，不使用其他週內容；它不是診斷或好壞評分。",
            ParagraphStyle("WeeklyFootZH", parent=body, fontSize=8.5, leading=13,
                           textColor=colors.HexColor("#6A7685")),
        ),
    ])
    doc.build(story)
    return out.getvalue()


async def _fetch_strengths_body(member_id: str) -> str:
    """取教練深度分析裡的「優勢與內在資源」內文，附在每週 PDF 最後。沒有就回空字串。"""
    try:
        resp = await db().get(
            f"{SUPABASE_REST}/coach_analyses",
            headers=SUPABASE_HEADERS,
            params=[("member_id", f"eq.{member_id}"), ("select", "blocks"), ("limit", "1")],
        )
        rows = resp.json() if resp.status_code == 200 else []
        blocks = (rows[0].get("blocks") if rows else None) or []
        for blk in blocks:
            if str(blk.get("title") or "").strip() in ("優勢與內在資源", "Strengths & Inner Resources"):
                return str(blk.get("body") or "")
    except Exception as exc:
        logger.warning("fetch strengths failed [%s]: %s", type(exc).__name__, exc)
    return ""


def _weekly_email_subject(week_number: int) -> str:
    return f"你的第 {week_number} 週 PERMA 幸福感回顧"


def _weekly_email_html(member_name: str, report_url: str = "") -> str:
    """每週報告的信件內文（教練提供的固定模板）。
    預覽與實際寄送共用這個函式，確保教練看到的就是學員收到的。"""
    link = (
        f'<p>也可以直接在網站上看：<a href="{html.escape(report_url)}">{html.escape(report_url)}</a></p>'
        if report_url
        else ""
    )
    return f"""
    <p>{html.escape(member_name)}，你好：</p>
    <p>謝謝你完成本週的 PERMA 書寫，這是很扎實的開始。</p>
    <p>我們花了些時間讀完你這一週留下的紀錄，也從中看到了一些日常裡幸福感起伏的痕跡。</p>
    <p>我們也整理了這週幸福感的變化趨勢（見附件），供你參考。建議你自己重新翻閱時，可以帶著兩個問題去看：這一週最讓你有感的收穫是什麼？如果重來一次，有沒有哪個部分想試著調整？</p>
    <p>也提醒你，下週記得同步填寫 PERMA 的覺察練習，讓紀錄能更完整。</p>
    {link}
    <p>一切安好，<br>Yee Ming Tan 教練</p>
    """


class CoachMemberRequest(BaseModel):
    member_id: str
    language: str = "zh-TW"  # 分析與客戶報告的語言，跟隨教練介面（預設繁中）


@app.post("/api/coach/report-completed-webhook")
async def coach_report_completed_webhook(
    request: Request,
    x_report_webhook_secret: str = Header(default="", alias="X-Report-Webhook-Secret"),
):
    """Supabase Database Webhook：學員把某一週的 P／E／R／M／A 全部寫完後自動產生報告。

    這條路徑存在的理由是可靠性——前端呼叫 /api/member/report 是「射後不理」，
    學員關掉分頁請求就斷了。webhook 在伺服器端跑，不受瀏覽器影響。
    與前端呼叫共用 _ensure_member_report，兩邊都具冪等性，重複觸發不會產生兩份。
    """
    if not REPORT_WEBHOOK_SECRET or not hmac.compare_digest(x_report_webhook_secret, REPORT_WEBHOOK_SECRET):
        raise HTTPException(status_code=401, detail="Webhook 驗證失敗")

    payload = await request.json()
    record = payload.get("record") or payload.get("new") or {}
    member_id = str(record.get("user_id") or "").strip()
    week_start = str(record.get("week_start") or "").strip()
    if not member_id or not week_start:
        raise HTTPException(status_code=400, detail="Webhook 缺少 record.user_id 或 record.week_start")

    try:
        report = await _ensure_member_report(member_id, week_start, member_id)
    except HTTPException as exc:
        # 這一週還沒寫滿五題是正常狀態，不是錯誤——回 200 讓 Supabase 不要重試。
        if exc.status_code == 409:
            return {"status": "waiting_for_complete_week", "detail": exc.detail}
        raise
    except Exception as exc:
        logger.exception("webhook 產生報告失敗 member=%s week=%s", member_id, week_start)
        raise HTTPException(status_code=502, detail=f"報告生成失敗：{str(exc)[:180]}")

    return {
        "status": "report_ready",
        "week_number": report.get("week_number"),
        "report_status": report.get("status"),
        "emailed": bool(report.get("emailed_at")),
    }


@app.post("/api/coach/weekly-reports/generate")
async def coach_weekly_reports_generate(req: CoachMemberRequest, authorization: str = Header(...)):
    """教練替某位成員補產生所有缺漏的每週報告（存進 member_reports）。

    每份只依該週內容分析、與 T0 比較。已存在的週次不重跑、不重複花錢；
    第 4／8 週一樣是 pending_coach 草稿，不會直接寄給學員。
    """
    token = authorization.removeprefix("Bearer ").strip()
    await require_coach(token)
    member_id = req.member_id

    posts = await _fetch_member_posts(member_id)
    # 只處理「五面向都填寫」的完整週；同一週多次提交取最後一筆完整內容。
    by_week: dict[str, dict] = {}
    for post in posts:
        if all(str(post.get(f"{key.lower()}_content") or "").strip() for key in _PERMA_KEYS):
            by_week[str(post.get("week_start") or "")] = post
    if not by_week:
        raise HTTPException(status_code=409, detail="這位成員還沒有『五面向都填寫』的完整週")

    results = []
    for week_start in sorted(by_week):
        try:
            report = await _ensure_member_report(member_id, week_start, member_id)
            results.append({
                "week_start": week_start,
                "week_number": report.get("week_number"),
                "status": report.get("status"),
                "emailed": bool(report.get("emailed_at")),
            })
        except HTTPException as exc:  # 單週失敗不影響其他週
            results.append({"week_start": week_start, "status": "error", "detail": str(exc.detail)[:180]})
        except Exception as exc:
            logger.exception("coach weekly report failed member=%s week=%s", member_id, week_start)
            results.append({"week_start": week_start, "status": "error", "detail": str(exc)[:180]})
    return {"generated": len(results), "reports": results}


_MONTHLY_MILESTONES = (4, 8)


async def _completed_weeks_and_baseline(member_id: str) -> tuple[list[dict], dict]:
    """取「五面向都填寫」的完整週（依週排序、同週取最後一筆）與 T0 基準；缺任一則丟 409。"""
    posts = await _fetch_member_posts(member_id)
    completed_all = [
        post for post in posts
        if all(str(post.get(f"{key.lower()}_content") or "").strip() for key in _PERMA_KEYS)
    ]
    by_week: dict[str, dict] = {}
    for post in completed_all:
        by_week[str(post.get("week_start") or "")] = post
    completed = [by_week[key] for key in sorted(by_week)]
    if not completed:
        raise HTTPException(status_code=409, detail="這位成員還沒有『五面向都填寫』的完整週")

    resp = await db().get(
        f"{SUPABASE_REST}/coach_analyses",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{member_id}"), ("select", "*"), ("limit", "1")],
    )
    rows = resp.json() if resp.status_code == 200 else []
    baseline = (rows[0].get("baseline") if rows else None)
    if not isinstance(baseline, dict) or not all(key in baseline for key in _PERMA_KEYS):
        raise HTTPException(status_code=409, detail="請先在成員頁最上方填寫完整 T0 基準點（五面向）")
    return completed, baseline


@app.post("/api/coach/monthly-reports/generate")
async def coach_monthly_reports_generate(req: CoachMemberRequest, authorization: str = Header(...)):
    """第 4 週與第 8 週各產生一份跨週回顧（第 4 週看 1–4 週、第 8 週看 1–8 週），
    與 T0 基準比較，存進 perma_monthly_reports。僅教練端閱讀，不寄信。"""
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)
    member_id = req.member_id

    completed, baseline = await _completed_weeks_and_baseline(member_id)

    results = []
    for milestone in _MONTHLY_MILESTONES:
        if len(completed) < milestone:
            results.append({"milestone_week": milestone, "status": "not_enough_weeks",
                            "detail": f"目前只有 {len(completed)} 個完整週"})
            continue
        window = completed[:milestone]
        try:
            sessions, blocks = await _analyze_completed_posts(window, coach_id)
        except Exception as exc:
            logger.exception("monthly report failed member=%s milestone=%s", member_id, milestone)
            results.append({"milestone_week": milestone, "status": "error", "detail": str(exc)[:180]})
            continue
        saved = {
            "member_id": member_id,
            "milestone_week": milestone,
            "weeks_covered": len(window),
            "week_start_from": str(window[0].get("week_start") or ""),
            "week_start_to": str(window[-1].get("week_start") or ""),
            "content": {
                "v": 1,
                "baseline": baseline,
                "sessions": sessions,
                "blocks": blocks,
                "scope": f"weeks_1_to_{milestone}",
            },
            "updated_at": datetime.now(TW_TZ).isoformat(),
        }
        save_resp = await db().post(
            f"{SUPABASE_REST}/perma_monthly_reports",
            headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
            json=saved,
        )
        if save_resp.status_code not in (200, 201):
            results.append({"milestone_week": milestone, "status": "save_failed",
                            "detail": save_resp.text[:180]})
            continue
        results.append({"milestone_week": milestone, "status": "ok", "weeks_covered": len(window)})
    return {"reports": results}


class CoachMonthlyFrameworkRequest(BaseModel):
    member_id: str
    milestone_week: int
    framework: dict
    language: str = "zh-TW"


@app.post("/api/coach/monthly-reports/analyze-framework")
async def coach_monthly_analyze_framework(
    req: CoachMonthlyFrameworkRequest, authorization: str = Header(...)
):
    """用教練自訂的 AI 框架，只針對該里程碑涵蓋的週次做分析，並把新區塊追加進該份月報告。"""
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)

    fw = req.framework or {}
    if not isinstance(fw.get("dimensions"), list) or not fw["dimensions"]:
        raise HTTPException(status_code=400, detail="框架不完整，請至少保留一個維度")
    if req.milestone_week not in _MONTHLY_MILESTONES:
        raise HTTPException(status_code=400, detail="只支援第 4 週與第 8 週的月報告")

    resp = await db().get(
        f"{SUPABASE_REST}/perma_monthly_reports",
        headers=SUPABASE_HEADERS,
        params=[
            ("member_id", f"eq.{req.member_id}"),
            ("milestone_week", f"eq.{req.milestone_week}"),
            ("select", "*"),
            ("limit", "1"),
        ],
    )
    rows = resp.json() if resp.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=409, detail="請先生成這份月報告")
    row = rows[0]
    content = row.get("content") if isinstance(row.get("content"), dict) else {}

    completed, _ = await _completed_weeks_and_baseline(req.member_id)
    window = completed[: req.milestone_week]
    if not window:
        raise HTTPException(status_code=409, detail="找不到這段期間的完整週")

    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=3000,
        thinking={"type": "disabled"},
        system=_framework_block_system(fw, len(window), "zh-TW"),
        messages=[{"role": "user", "content": f"成員資料：\n\n{_posts_dump(window)}"}],
    )
    meter_claude("coach-monthly-analyze-framework", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)

    match = re.search(r"\{.*\}", _msg_text(msg), re.DOTALL)
    if not match:
        raise HTTPException(status_code=502, detail="框架分析失敗，請重新生成")
    try:
        parsed = json.loads(match.group())
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="框架分析失敗，請重新生成")

    title = str(parsed.get("title") or fw.get("name") or "自訂框架").strip()
    body = str(parsed.get("body") or "").strip()
    if not body:
        raise HTTPException(status_code=502, detail="框架分析失敗，請重新生成")

    blocks = list(content.get("blocks") or []) + [
        {"title": title, "body": body, "include": False, "custom": True}
    ]
    new_content = {**content, "blocks": blocks}
    update_resp = await db().patch(
        f"{SUPABASE_REST}/perma_monthly_reports",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        params=[("member_id", f"eq.{req.member_id}"), ("milestone_week", f"eq.{req.milestone_week}")],
        json={"content": new_content, "updated_at": datetime.now(TW_TZ).isoformat()},
    )
    if update_resp.status_code in (200, 201) and update_resp.json():
        return update_resp.json()[0]
    return {**row, "content": new_content}


class CoachWeeklyPreviewRequest(BaseModel):
    member_id: str
    week_start: str


@app.post("/api/coach/weekly-reports/preview")
async def coach_weekly_report_preview(req: CoachWeeklyPreviewRequest, authorization: str = Header(...)):
    """預覽某一週「學員實際會收到」的信件內文與 PDF 附件。

    直接讀 member_reports 已存的內容重建，不重跑 AI、不寄信、不寫入資料；
    信件內文與 PDF 都走與寄送相同的函式，所以教練看到的就是學員收到的。
    第 4／8 週的 pending_coach 草稿也能預覽——那正是教練要先確認的東西。
    """
    token = authorization.removeprefix("Bearer ").strip()
    await require_coach(token)

    resp = await db().get(
        f"{SUPABASE_REST}/member_reports",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{req.member_id}"),
            ("week_start", f"eq.{req.week_start}"),
            ("select", "*"),
            ("limit", "1"),
        ],
    )
    rows = resp.json() if resp.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=404, detail="找不到這一週的報告，請先生成每週報告")
    row = rows[0]
    sessions = row.get("sessions") or []
    if not sessions:
        raise HTTPException(status_code=409, detail="這一週的報告沒有 session 資料，請重新生成")

    week_number = int(row.get("week_number") or 0)
    name, email = await _member_identity(req.member_id)
    strengths_body = await _fetch_strengths_body(req.member_id)
    pdf_bytes = await asyncio.to_thread(
        _build_weekly_report_pdf,
        name,
        week_number,
        req.week_start,
        row.get("baseline") or {},
        sessions[-1],
        {"title": "PERMA 五面向回顧", "body": row.get("body_md") or ""},
        strengths_body,
    )
    return {
        "week_number": week_number,
        "week_start": req.week_start,
        "recipient_name": name,
        "recipient_email": email,
        "subject": _weekly_email_subject(week_number),
        "email_html": _weekly_email_html(name, f"{APP_BASE_URL}/app/report"),
        "pdf_filename": f"第{week_number}週-PERMA幸福感回顧.pdf",
        "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
        "emailed_at": row.get("emailed_at"),
        "report_status": row.get("status"),
    }


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

    # 深度分析一律以繁中生成（全站預設繁中）；英文由前端點「EN」時
    # 呼叫 /api/coach/translate 即時翻譯並快取，見遷移 003。
    lang = "zh-TW"

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

    # 教練的策展成果——「納入客戶版」勾選、自訂框架區塊——不是這次 AI 生成的產物，
    # 重新生成時要接回去。學員每寫完一週就會自動重跑一次（見 _auto_refresh_coach_analysis），
    # 少了這段，教練的勾選與框架區塊會在毫無預警下被清掉。
    prev_resp = await db().get(
        f"{SUPABASE_REST}/coach_analyses",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{member_id}"), ("select", "blocks,client_charts"), ("limit", "1")],
    )
    prev_rows = prev_resp.json() if prev_resp.status_code == 200 else []
    prev = prev_rows[0] if prev_rows else {}
    prev_blocks = [b for b in (prev.get("blocks") or []) if isinstance(b, dict)]
    # 依標題對齊而非索引：自訂區塊會 append 在後面，索引對不上。
    prev_include = {
        str(b.get("title") or "").strip().lower(): bool(b.get("include"))
        for b in prev_blocks
        if not b.get("custom")
    }
    for block in blocks:
        key = str(block.get("title") or "").strip().lower()
        if key in prev_include:
            block["include"] = prev_include[key]
    blocks = blocks + [b for b in prev_blocks if b.get("custom")]

    prev_charts = prev.get("client_charts")
    client_charts = prev_charts if isinstance(prev_charts, dict) and prev_charts else _CLIENT_CHART_DEFAULTS

    row = {
        "member_id": member_id,
        "based_on": len(posts),
        "sessions": sessions,
        "blocks": blocks,
        "client_charts": client_charts,
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


async def _auto_refresh_coach_analysis(member_id: str) -> None:
    """學員新產生一份週報告後，順手把教練端的縱向深度分析重跑一次。

    在這之前，coach_analyses 只有教練親自按「重新生成分析」才會更新，所以學員
    自己看得到每週報告、教練頁卻一直停在「基於 0 週」、圖表與情報簡報全空。
    在背景跑、不 await：分析失敗或逾時都不該影響學員拿到自己的報告，
    教練仍可隨時手動按按鈕補跑。coach_id 不帶入，避免把既有教練歸屬蓋掉。
    """
    if member_id in _analyzing_members:
        return
    _analyzing_members.add(member_id)
    try:
        await _analyze_member(member_id, member_id, "member-report-auto-analysis")
    except Exception:
        logger.exception("自動重跑教練深度分析失敗 member=%s", member_id)
    finally:
        _analyzing_members.discard(member_id)


@app.post("/api/coach/analyze")
async def coach_analyze(req: CoachMemberRequest, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)
    return await _analyze_member(req.member_id, coach_id, "coach-analyze", coach_id=coach_id)


class CoachFrameworkGenerateRequest(BaseModel):
    description: str
    language: str = "zh-TW"


class CoachFrameworkAnalyzeRequest(BaseModel):
    member_id: str
    framework: dict
    language: str = "zh-TW"


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

    # 自訂區塊與既有分析同語言（既有深度分析一律繁中，見 /api/coach/analyze）。
    lang = "zh-TW"
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
    學員版報告仍明確指定 zh-TW，確保不會因為學員用英文書寫就收到英文報告。
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
    result = (
        update_resp.json()[0]
        if update_resp.status_code in (200, 201) and update_resp.json()
        else {**analysis, "client_text": client_text, "client_date": client_date}
    )

    # 客戶交付版只產生文件，不寄信——寄給學員的一律是 member_reports 那條路
    # （每週自動寄、第 4／8 週教練審核後寄），避免同一份內容從兩個地方寄出。
    return result


class CoachTranslateRequest(BaseModel):
    member_id: str
    target: str = "en"  # 目前只支援翻成英文；繁中為原生生成語言


@app.post("/api/coach/translate")
async def coach_translate(req: CoachTranslateRequest, authorization: str = Header(...)):
    """把繁中原生分析（blocks + sessions 的文字欄位）翻成英文並快取。
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
    if req.target not in {"en", "zh-TW"}:
        raise HTTPException(status_code=400, detail="只支援繁中與英文")

    translations = analysis.get("translations") or {}
    if req.target in translations:  # 已快取，直接回傳
        return analysis

    source = {"blocks": analysis.get("blocks") or [], "sessions": analysis.get("sessions") or []}
    # 區塊多、內文長時輸出可達上萬 token；上限太低會把 JSON 截斷導致解析失敗，
    # 而高 max_tokens 的長請求 SDK 要求必須用串流。
    async with claude().messages.stream(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=32000,
        thinking={"type": "disabled"},
        system=_translate_system(req.target),
        messages=[{"role": "user", "content": json.dumps(source, ensure_ascii=False)}],
    ) as stream:
        msg = await stream.get_final_message()
    meter_claude("coach-translate", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)

    if getattr(msg, "stop_reason", None) == "max_tokens":
        logger.warning("coach_translate truncated by max_tokens (member=%s)", req.member_id)
        raise HTTPException(status_code=502, detail="分析內容過長，翻譯被截斷；請減少區塊數量後再試")

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


def _build_email(
    to_email: str,
    subject: str,
    html_body: str,
    attachment: tuple[str, bytes] | None = None,
) -> EmailMessage:
    """組出一封 HTML 信（可選擇附加一份 PDF）。SMTP 與 Gmail API 兩條管道共用。"""
    message = EmailMessage()
    message["Subject"] = subject
    # formataddr 會在顯示名稱含非 ASCII 字元時自動做 RFC 2047 編碼。
    # 註：不要用 email.header.Header——這個檔案後面 import 了 fastapi.Header，名稱會被蓋掉。
    message["From"] = formataddr((REPORT_FROM_NAME, GMAIL_ADDRESS or ""), charset="utf-8")
    message["To"] = to_email
    # 純文字備援：不支援 HTML 的信件軟體至少看得到提示與連結。
    message.set_content(_PLAIN_TEXT_FALLBACK)
    message.add_alternative(html_body, subtype="html")
    if attachment:
        filename, payload = attachment
        # add_attachment 必須在 add_alternative 之後呼叫，訊息才會變成
        # multipart/mixed（內含 multipart/alternative + 附件）的正確結構。
        message.add_attachment(payload, maintype="application", subtype="pdf", filename=filename)
    return message


def _send_via_smtp(message: EmailMessage) -> None:
    """走 Gmail SMTP 寄出。阻塞式，呼叫端請用 to_thread 包起來。
    註：Render 免費方案封鎖對外 SMTP 埠，這條路線只在本機開發能用。
    """
    with smtplib.SMTP_SSL(_GMAIL_SMTP_HOST, _GMAIL_SMTP_PORT, timeout=60) as smtp:
        smtp.login(GMAIL_ADDRESS or "", GMAIL_APP_PASSWORD or "")
        smtp.send_message(message)


# access token 有效期約一小時，快取起來免得每封信都去換一次。
_gmail_token: str | None = None
_gmail_token_expiry: float = 0.0
_gmail_token_lock = asyncio.Lock()


async def _gmail_access_token() -> str:
    """用 refresh token 換一張短效 access token（快取到快過期為止）。"""
    global _gmail_token, _gmail_token_expiry
    async with _gmail_token_lock:
        # 提早 60 秒換新，避免拿到一張在路上剛好過期的 token。
        if _gmail_token and time.monotonic() < _gmail_token_expiry - 60:
            return _gmail_token
        resp = await db().post(
            _GOOGLE_TOKEN_URL,
            data={
                "client_id": GMAIL_OAUTH_CLIENT_ID or "",
                "client_secret": GMAIL_OAUTH_CLIENT_SECRET or "",
                "refresh_token": GMAIL_OAUTH_REFRESH_TOKEN or "",
                "grant_type": "refresh_token",
            },
        )
        if resp.status_code != 200:
            # invalid_grant 幾乎都是 refresh token 失效：OAuth 同意畫面若停在
            # 「測試中」，Google 會在 7 天後撤銷 token（見 docs/gmail-api-setup.md）。
            raise RuntimeError(f"取得 Gmail access token 失敗 {resp.status_code}: {resp.text[:200]}")
        payload = resp.json()
        _gmail_token = str(payload["access_token"])
        _gmail_token_expiry = time.monotonic() + float(payload.get("expires_in") or 3600)
        return _gmail_token


async def _send_via_gmail_api(message: EmailMessage) -> None:
    """走 Gmail API（HTTPS 443）寄出，繞開平台對 SMTP 埠的封鎖。"""
    token = await _gmail_access_token()
    resp = await db().post(
        _GMAIL_SEND_URL,
        headers={"Authorization": f"Bearer {token}"},
        json={"raw": base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")},
        timeout=60,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Gmail API 寄送失敗 {resp.status_code}: {resp.text[:300]}")


async def _send_via_brevo(
    to_email: str,
    subject: str,
    html_body: str,
    attachment: tuple[str, bytes] | None = None,
) -> None:
    """走 Brevo 的 HTTP API（443 埠）寄出，繞開平台對 SMTP 埠的封鎖。

    Brevo 收的是結構化 JSON 而不是 RFC 822 原文，所以這裡不共用 _build_email。
    """
    body: dict = {
        "sender": {"name": REPORT_FROM_NAME, "email": REPORT_FROM_EMAIL or ""},
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html_body,
        "textContent": _PLAIN_TEXT_FALLBACK,
    }
    if attachment:
        filename, payload = attachment
        body["attachment"] = [
            {"name": filename, "content": base64.b64encode(payload).decode("ascii")}
        ]
    resp = await db().post(
        _BREVO_SEND_URL,
        headers={"api-key": BREVO_API_KEY or "", "accept": "application/json"},
        json=body,
        timeout=60,
    )
    if resp.status_code not in (200, 201):
        # 401 = API key 錯；400 且訊息含 sender 多半是寄件位址還沒在 Brevo 驗證。
        raise RuntimeError(f"Brevo 寄送失敗 {resp.status_code}: {resp.text[:300]}")


async def _send_report_mail(
    to_email: str,
    subject: str,
    html_body: str,
    attachment: tuple[str, bytes] | None = None,
) -> None:
    """依 _mail_channel() 選出的管道寄出一封信。"""
    channel = _mail_channel()
    if channel == "Brevo":
        await _send_via_brevo(to_email, subject, html_body, attachment)
        return
    message = _build_email(to_email, subject, html_body, attachment)
    if channel == "Gmail API":
        await _send_via_gmail_api(message)
        return
    # smtplib 是阻塞式的，丟到執行緒避免卡住 event loop。
    await asyncio.to_thread(_send_via_smtp, message)


async def _email_report(report: dict) -> bool:
    """把已發布的報告寄給學員。回傳是否真的寄出。

    信件內文用教練提供的固定模板，報告本身以 reportlab 產生的 PDF 附件寄出
    （雷達圖／主題占比圓餅圖／情緒詞雲皆在後端畫，不需要瀏覽器）。

    刻意設計成「失敗不影響主流程」：沒設定 Gmail 認證、拿不到 email、
    或寄送管道出錯，都只記 log 並把原因寫進 email_error 欄（見遷移 010）——
    報告本身在網站上還是看得到。已寄過（emailed_at 有值）就不重複寄。
    """
    if not _mail_channel():
        logger.info("沒有任何寄信管道設定齊全（Brevo／Gmail API／Gmail SMTP），略過寄送報告 email")
        return False
    if report.get("emailed_at"):
        return False

    # 同一份報告同時只跑一支寄送任務（見 _emailing_reports 的說明）。
    report_id = str(report.get("id") or "")
    if report_id and report_id in _emailing_reports:
        logger.info("報告 %s 已有寄送任務進行中，略過這次觸發", report_id)
        return False
    _emailing_reports.add(report_id)
    try:
        return await _deliver_report_email(report)
    finally:
        _emailing_reports.discard(report_id)


async def _deliver_report_email(report: dict) -> bool:
    """實際產生 PDF 並寄出；呼叫端請用 _email_report（它負責前置檢查與併發鎖）。"""
    user_id = report["user_id"]
    week_number = report["week_number"]

    async def _fail(detail: str) -> bool:
        logger.warning("報告 email 未寄出 [第 %s 週]: %s", week_number, detail)
        await db().patch(
            f"{SUPABASE_REST}/member_reports",
            headers=SUPABASE_HEADERS,
            params=[("id", f"eq.{report['id']}")],
            json={"email_error": detail[:500]},
        )
        return False

    display_name, to_email = await _member_identity(user_id)
    if not to_email:
        return await _fail("找不到學員 email")

    sessions = report.get("sessions") or []
    if not sessions:
        return await _fail("報告沒有 session 資料，無法產生 PDF")

    try:
        strengths_body = await _fetch_strengths_body(user_id)
        # PDF 只呈現這一週（sessions 最後一筆）與 T0 的比較。
        pdf_bytes = await asyncio.to_thread(
            _build_weekly_report_pdf,
            display_name,
            week_number,
            str(report.get("week_start") or ""),
            report.get("baseline") or {},
            sessions[-1],
            {"title": "PERMA 五面向回顧", "body": report.get("body_md") or ""},
            strengths_body,
        )
    except Exception as exc:
        return await _fail(f"PDF 產生失敗 [{type(exc).__name__}]: {exc}")

    subject = _weekly_email_subject(week_number)
    html_body = _weekly_email_html(display_name, f"{APP_BASE_URL}/app/report")
    filename = f"第{week_number}週-PERMA幸福感回顧.pdf"

    # Render 對外的 SMTP 連線偶爾會逾時（實測遇過），值得重試一次；
    # 現在寄信已經是背景執行（見呼叫端 asyncio.create_task），
    # 多等一次不會拖到任何使用者正在等的請求。
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            await _send_report_mail(to_email, subject, html_body, (filename, pdf_bytes))
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            if attempt == 0:
                await asyncio.sleep(3)
    if last_exc is not None:
        # 逾時（而不是被拒絕或認證失敗）代表封包被靜靜丟掉，最典型的原因是
        # 主機平台封鎖對外 SMTP 連接埠——Render 免費方案就會擋 25／465／587。
        # 把這個線索直接寫進 email_error，免得下次又只看到一句「timed out」。
        channel = _mail_channel()
        hint = ""
        if isinstance(last_exc, TimeoutError) and channel == "Gmail SMTP":
            hint = (
                f"；連線在交握階段就逾時，最可能是主機平台封鎖對外 SMTP 連接埠 {_GMAIL_SMTP_PORT}"
                "（Render 免費方案會擋 25／465／587）。請設定 BREVO_API_KEY 改走 Brevo"
                "（見 docs/brevo-setup.md）；調長 timeout／重試都沒有用。"
            )
        return await _fail(
            f"{channel} 寄送失敗（已重試一次）[{type(last_exc).__name__}]: {last_exc}{hint}"
        )

    # 內容雜湊：教練改過內文再發布一次時，才需要重寄（見遷移 010）。
    content_hash = hashlib.sha256((report.get("body_md") or "").encode("utf-8")).hexdigest()
    await db().patch(
        f"{SUPABASE_REST}/member_reports",
        headers=SUPABASE_HEADERS,
        params=[("id", f"eq.{report['id']}")],
        json={
            "emailed_at": datetime.now(TW_TZ).isoformat(),
            "email_content_hash": content_hash,
            "email_error": None,
        },
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


async def _member_baseline(user_id: str) -> dict | None:
    """學員自填的 T0 起始分數（見遷移 007）。沒填過回 None。"""
    resp = await db().get(
        f"{SUPABASE_REST}/baseline_scores",
        headers=SUPABASE_HEADERS,
        params=[("user_id", f"eq.{user_id}"), ("select", "p,e,r,m,a"), ("limit", "1")],
    )
    rows = resp.json() if resp.status_code == 200 else []
    if not rows:
        return None
    b = rows[0]
    return {k: b[k.lower()] for k in _PERMA_KEYS}


async def _accumulated_sessions(user_id: str, upto_week_start: str) -> list[dict]:
    """把這位學員先前各週報告已存下的 session 依序取出，供趨勢圖使用。

    每份報告只分析「當週」（見 _weekly_client_analysis_system），所以趨勢是靠
    累積歷史 session 得到，而不是每週重跑一次全期間的縱向分析——這樣既符合
    「單週分析 + 與 T0 比較」的設計，也不會每週都付一次全期間分析的費用。
    """
    resp = await db().get(
        f"{SUPABASE_REST}/member_reports",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{user_id}"),
            ("week_start", f"lt.{upto_week_start}"),
            ("select", "week_start,sessions"),
            ("order", "week_start.asc"),
        ],
    )
    rows = resp.json() if resp.status_code == 200 else []
    out: list[dict] = []
    for row in rows:
        sessions = row.get("sessions") or []
        # 每份報告存的是「到當週為止」的累積，取最後一筆才是那一週本身。
        if sessions:
            out.append(sessions[-1])
    return out


async def _ensure_member_report(user_id: str, week_start: str, actor_id: str) -> dict:
    """產生（或取回）某位學員某一週的報告。三個觸發點共用這一支，且具冪等性：

    1. 學員在前端填完五題後呼叫 /api/member/report
    2. Supabase Database Webhook 在週記寫入後自動觸發（不依賴瀏覽器留著）
    3. 學員在報告頁按「產生我的報告」補救先前失敗的週次

    內容用 _weekly_client_analysis_system：只分析這一週、直接用第二人稱寫給
    學員本人（含優勢與內在資源、金句），因此不需要再跑一次改寫，一週只花一次 AI 呼叫。

    第 4、8 週產生的是草稿（pending_coach）——學員看不到，也不寄信，
    等教練在後台親自編輯確認後按「發布」才轉成 published。
    """
    week_number = _program_week_number(week_start)
    if week_number < 1:
        raise HTTPException(status_code=400, detail="這一週在課程開始之前")

    # 已經有這週的報告就直接回傳，不重複花錢跑分析。
    existing_resp = await db().get(
        f"{SUPABASE_REST}/member_reports",
        headers=SUPABASE_HEADERS,
        params=[
            ("user_id", f"eq.{user_id}"),
            ("week_start", f"eq.{week_start}"),
            ("select", "*"),
            ("limit", "1"),
        ],
    )
    existing = existing_resp.json() if existing_resp.status_code == 200 else []
    if existing:
        report = existing[0]
        # 報告已存在但上次寄信失敗（email_error 有值、emailed_at 還是空）就再試一次。
        # 沒有這段的話，寄信只會在「報告第一次被建立」的那一瞬間嘗試一次——
        # 之後不管學員按幾次「產生我的報告」、webhook 重觸發幾次，都會走到這裡
        # 直接回傳既有報告，那封信就永遠不會補寄出去（實測第 1 週就卡在這）。
        if (
            report.get("status") == "published"
            and not report.get("emailed_at")
            and report.get("email_error")
        ):
            _spawn_background(_email_report(report))
        return report

    posts = await _fetch_member_posts(user_id)
    post = next((p for p in posts if str(p.get("week_start") or "") == week_start), None)
    if not post:
        raise HTTPException(status_code=409, detail="這一週還沒有週記")
    if not all(str(post.get(f"{k.lower()}_content") or "").strip() for k in _PERMA_KEYS):
        raise HTTPException(status_code=409, detail="這一週的 P／E／R／M／A 還沒全部完成")

    sessions, blocks = await _analyze_week_for_client(post, actor_id)
    if not sessions or not blocks:
        raise HTTPException(status_code=502, detail="單週 PERMA 分析沒有回傳完整內容")
    body_md = str(blocks[0].get("body") or "").strip()
    if not body_md:
        raise HTTPException(status_code=502, detail="單週 PERMA 分析內容為空")

    baseline = await _member_baseline(user_id)
    history = await _accumulated_sessions(user_id, week_start)

    needs_review = week_number in COACH_REVIEW_WEEKS
    now = datetime.now(TW_TZ).isoformat()
    row = {
        "user_id": user_id,
        "week_start": week_start,
        "post_id": post.get("id"),
        "week_number": week_number,
        "status": "pending_coach" if needs_review else "published",
        "body_md": body_md,
        "charts": _MEMBER_CHART_DEFAULTS,
        "sessions": [*history, sessions[0]],
        "baseline": baseline,
        "published_at": None if needs_review else now,
    }
    insert_resp = await db().post(
        f"{SUPABASE_REST}/member_reports",
        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
        json=row,
    )
    if insert_resp.status_code not in (200, 201) or not insert_resp.json():
        logger.warning("member_reports insert failed: %s", insert_resp.text[:300])
        return row

    saved = insert_resp.json()[0]
    # 教練端的深度分析跟著一起重跑，教練不必手動點「重新生成分析」。
    # 放在這裡（而非 webhook 或前端）是因為三個觸發點都走這支，且上面已經
    # 用「報告已存在就直接回傳」擋掉重複，所以只有真的新增一週才會多花一次分析。
    _spawn_background(_auto_refresh_coach_analysis(user_id))
    # 自動發布的週次才寄信；第 4／8 週等教練按「發布給學員」時才寄。
    # 用 create_task 讓寄信在背景執行、不 await——Render 對外的 SMTP 連線
    # 有時會慢或整個逾時（實測遇過 Errno 101 與 TimeoutError），若同步等待
    # 會拖慢這支函式的回應時間，甚至可能讓呼叫端（Supabase webhook）
    # 判定逾時。報告本身已經存進 member_reports，寄信結果與這裡的回傳
    # 完全無關，成功或失敗都會分別寫進 emailed_at／email_error。
    if saved.get("status") == "published":
        _spawn_background(_email_report(saved))
    return saved


class MemberReportRequest(BaseModel):
    week_start: str  # 該週的週一（YYYY-MM-DD）


@app.post("/api/member/report")
@limiter.limit(MEMBER_REPORT_RATE_LIMIT)
async def member_report(
    request: Request, req: MemberReportRequest, authorization: str = Header(...)
):
    """學員填完當週五題後產生自己的 PERMA 報告。"""
    token = authorization.removeprefix("Bearer ").strip()
    user_id = await get_user_id(token)
    try:
        _program_week_number(req.week_start)
    except ValueError:
        raise HTTPException(status_code=400, detail="週次日期格式錯誤")
    return await _ensure_member_report(user_id, req.week_start, user_id)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT)
