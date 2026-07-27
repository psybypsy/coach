from __future__ import annotations

import io
import base64
import hashlib
import html
import hmac
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
RESEND_API_KEY: str = os.environ.get("RESEND_API_KEY", "")
REPORT_EMAIL_FROM: str = os.environ.get("REPORT_EMAIL_FROM", "")
REPORT_EMAIL_REPLY_TO: str = os.environ.get("REPORT_EMAIL_REPLY_TO", "")
REPORT_WEBHOOK_SECRET: str = os.environ.get("REPORT_WEBHOOK_SECRET", "")

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
_ALLOWED_BLOCK_TITLES = {
    "perma five-dimension profile", "perma 五面向剖析",
}
# 報告只保留四個量化圖表。
_CLIENT_CHART_DEFAULTS = {
    "dims": True, "topics": True, "radar": True, "cloud": True,
}


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

Include only this block. Do not create any other brief block:
[[BLOCK]] PERMA Five-Dimension Profile

This block must: (a) stay tied to this person's specific quotes with week citations; (b) end with a "**References**" sub-heading listing 2-3 APA-format references (journal or book titles in * italics *).

Per-block requirements:
- PERMA Five-Dimension Profile: analyze P/E/R/M/A one by one, noting fullness (abundant / stable / thin / absent), change over time and key quotes, then integrate the overall pattern through a PERMA lens. References may draw from: Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.; Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218-226.; Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
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

務必只包含以下一個區塊，不得產生其他情報簡報區塊：
[[BLOCK]] PERMA 五面向剖析

此區塊必須：(a) 全程扣合此人的具體引文並註明第幾次；(b) 在內文最後另起一行、以「**參考文獻**」為小標，再用 - 條列 2 至 3 筆 APA 格式文獻（期刊名或書名以 * 斜體 * 標示）。

各區塊要求：
- PERMA 五面向剖析：逐一分析 P/E/R/M/A 五面向，標飽滿度（充沛／穩定／稀薄／缺席）、變化與關鍵引文，並以 PERMA 觀點整合此人整體樣態。參考文獻可從下列擇要引用：Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.；Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218–226.；Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
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
- End with 1 to 2 warm, forward-looking invitations.
- Entirely in English. No emoji.
- Do not repeat the title page or signature (the system adds them)."""


_CLIENT_REPORT_SYSTEM_ZH = """你是教練 陳郁敏 的寫作助理。以下是教練勾選要納入客戶交付版的分析內容。請改寫成一份給客戶本人閱讀的正式、溫暖、賦能的「個人福祉回顧」。

要求：
- 移除所有假設、臨床推測、風險或診斷性語言；聚焦優勢、軌跡、意義與前瞻。
- 保留並適度引用客戶自己的語言。
- 用 Markdown，以 ## 分節，段落清晰、專業；多用 - 條列（不要用數字條列），少用長段落。
- 每段用 **粗體** 標出這段的重點短語（一段一個重點、標短語即可，不要整句加粗），讓人快速掃過粗體就能抓到重點。
- 最後以 1 至 2 個溫暖的前瞻邀請作結。
- 全篇繁體中文（台灣），不得使用任何 emoji。
- 不要重複標題頁與署名（系統會自動加上）。"""


def _client_report_system(language: str = "en") -> str:
    return _CLIENT_REPORT_SYSTEM_ZH if language == "zh-TW" else _CLIENT_REPORT_SYSTEM_EN


def _plain_markdown(value: str) -> str:
    """ReportLab 內文使用的輕量 Markdown 清理。"""
    text = re.sub(r"^#{1,3}\s+", "", value, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*(.+?)\*(?!\*)", r"\1", text)
    return text.strip()


def _build_report_pdf(member_name: str, analysis: dict, client_text: str) -> bytes:
    """產生可直接附加於電子郵件的繁中 PDF；只含四個量化圖表與 PERMA 分析。"""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    font_name = "NotoSansTC"
    font_path = os.path.join(os.path.dirname(__file__), "assets", "fonts", "NotoSansTC-Variable.ttf")
    try:
        pdfmetrics.getFont(font_name)
    except KeyError:
        pdfmetrics.registerFont(TTFont(font_name, font_path))

    out = io.BytesIO()
    doc = SimpleDocTemplate(
        out,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=f"{member_name} 的八週幸福感回顧",
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "TitleZH", parent=styles["Title"], fontName=font_name, fontSize=22,
        leading=30, alignment=TA_CENTER, textColor=colors.HexColor("#1F3A5C"),
    )
    heading = ParagraphStyle(
        "HeadingZH", parent=styles["Heading2"], fontName=font_name, fontSize=14,
        leading=20, spaceBefore=10, spaceAfter=7, textColor=colors.HexColor("#1F3A5C"),
    )
    body = ParagraphStyle(
        "BodyZH", parent=styles["BodyText"], fontName=font_name, fontSize=10,
        leading=16, spaceAfter=6, textColor=colors.HexColor("#283444"),
    )
    small = ParagraphStyle(
        "SmallZH", parent=body, fontSize=8, leading=11, textColor=colors.HexColor("#5A6676"),
    )

    story = [
        Spacer(1, 24 * mm),
        Paragraph("八週幸福感回顧", title),
        Spacer(1, 5 * mm),
        Paragraph(html.escape(member_name), ParagraphStyle("NameZH", parent=body, alignment=TA_CENTER, fontSize=13)),
        Spacer(1, 4 * mm),
        Paragraph("這份報告整理你八週書寫中的情緒變化、主題重心與可持續運用的內在資源。內容不是診斷或評分，而是一份理解近期經驗的回顧。", body),
        PageBreak(),
    ]

    sessions = analysis.get("sessions") or []
    dim_labels = {"P": "正向情緒", "E": "投入", "R": "關係", "M": "意義", "A": "成就"}
    story.append(Paragraph("1. 五面向情緒效價", heading))
    dim_rows = [["週次", *[f"{key} {dim_labels[key]}" for key in _PERMA_KEYS]]]
    for index, session in enumerate(sessions):
        dims = session.get("dims") or {}
        dim_rows.append([f"第 {index + 1} 週", *[str((dims.get(key) or {}).get("v", 0)) for key in _PERMA_KEYS]])
    dim_table = Table(dim_rows, repeatRows=1, colWidths=[24 * mm] + [28 * mm] * 5)
    dim_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), font_name),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E9EEF4")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#CAD2DC")),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.extend([dim_table, Spacer(1, 5 * mm)])

    story.append(Paragraph("2. 每週主題占比", heading))
    topic_labels = {
        "work": "工作／學業", "relationships": "關係", "health": "健康",
        "rest": "休息恢復", "growth": "自我成長", "other": "其他",
    }
    topic_rows = [["週次", *topic_labels.values()]]
    for index, session in enumerate(sessions):
        topics = session.get("topics") or {}
        topic_rows.append([f"第 {index + 1} 週", *[f"{topics.get(key, 0)}%" for key in topic_labels]])
    topic_table = Table(topic_rows, repeatRows=1, colWidths=[20 * mm] + [25 * mm] * 6)
    topic_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), font_name),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E9EEF4")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#CAD2DC")),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
        ("FONTSIZE", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.extend([topic_table, Spacer(1, 5 * mm)])

    story.append(Paragraph("3. 五面向情緒效價剖面", heading))
    if sessions:
        first_dims = sessions[0].get("dims") or {}
        last_dims = sessions[-1].get("dims") or {}
        profile_rows = [["面向", "第一週", "最近一週", "變化"]]
        for key in _PERMA_KEYS:
            first = int((first_dims.get(key) or {}).get("v", 0))
            latest = int((last_dims.get(key) or {}).get("v", 0))
            profile_rows.append([f"{key} {dim_labels[key]}", str(first), str(latest), f"{latest - first:+d}"])
        profile_table = Table(profile_rows, colWidths=[55 * mm, 35 * mm, 35 * mm, 35 * mm])
        profile_table.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), font_name),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E9EEF4")),
            ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#CAD2DC")),
            ("ALIGN", (1, 1), (-1, -1), "CENTER"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
        ]))
        story.append(profile_table)

    story.append(Paragraph("4. 情緒詞雲", heading))
    emotion_counts: dict[str, int] = {}
    for session in sessions:
        for emotion in session.get("emotions") or []:
            word = str(emotion.get("word") or "").strip()
            if word:
                emotion_counts[word] = emotion_counts.get(word, 0) + int(emotion.get("intensity") or 1)
    words = sorted(emotion_counts.items(), key=lambda item: (-item[1], item[0]))[:30]
    story.append(Paragraph("　".join(f"{html.escape(word)}（{weight}）" for word, weight in words) or "目前沒有足夠的情緒詞資料。", body))

    story.append(PageBreak())
    story.append(Paragraph("5. PERMA 五面向剖析", heading))
    for paragraph in _plain_markdown(client_text).split("\n"):
        line = paragraph.strip()
        if line:
            story.append(Paragraph(html.escape(line), body if not line.startswith("- ") else small))

    doc.build(story)
    return out.getvalue()


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


async def _send_completed_report(member_id: str, analysis: dict, client_text: str) -> dict:
    """寄出八週完成報告。相同內容雜湊只寄一次。"""
    content_hash = hashlib.sha256(client_text.encode("utf-8")).hexdigest()
    if analysis.get("report_email_content_hash") == content_hash and analysis.get("report_emailed_at"):
        return {"status": "already_sent"}
    if not RESEND_API_KEY or not REPORT_EMAIL_FROM:
        return {"status": "not_configured", "detail": "缺少 RESEND_API_KEY 或 REPORT_EMAIL_FROM"}

    name, email = await _member_identity(member_id)
    if not email:
        return {"status": "missing_email", "detail": "找不到會員 email"}

    pdf_bytes = _build_report_pdf(name, analysis, client_text)
    greeting_name = html.escape(name)
    email_html = f"""
    <p>{greeting_name}，你好：</p>
    <p>謝謝你完成這 8 週的 PERMA 幸福感書寫。這段期間留下的內容，讓你可以重新看見自己的情緒變化、關注重心、內在優勢，以及不同生活面向之間的連結。</p>
    <p>我們已將你的回顧整理成 PDF，隨信附上。報告包含：</p>
    <ul>
      <li>五面向情緒效價趨勢</li><li>每週主題占比</li><li>五面向情緒效價剖面</li>
      <li>情緒詞彙</li><li>PERMA 五面向分析</li>
    </ul>
    <p>這份報告不是診斷或評分，而是一份幫助你理解近期經驗的整理。建議你找一段不被打擾的時間閱讀，並標記最有共鳴、最想進一步探索的內容。</p>
    <p>若有任何疑問，或希望在教練會談中一起討論，歡迎直接回覆這封信。</p>
    <p>祝福你，<br>陳郁敏 教練</p>
    """
    payload: dict = {
        "from": REPORT_EMAIL_FROM,
        "to": [email],
        "subject": "你的 8 週幸福感回顧已完成",
        "html": email_html,
        "attachments": [{
            "filename": "八週幸福感回顧.pdf",
            "content": base64.b64encode(pdf_bytes).decode("ascii"),
        }],
    }
    if REPORT_EMAIL_REPLY_TO:
        payload["reply_to"] = REPORT_EMAIL_REPLY_TO
    send_resp = await db().post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
        json=payload,
    )
    if send_resp.status_code not in (200, 201):
        raise RuntimeError(f"Resend {send_resp.status_code}: {send_resp.text[:300]}")
    return {
        "status": "sent",
        "email": email,
        "content_hash": content_hash,
        "provider_id": str(send_resp.json().get("id") or ""),
    }


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


async def _client_text_from_blocks(blocks: list[dict], coach_id: str) -> str:
    included = [
        block for block in blocks
        if block.get("include")
        and str(block.get("title") or "").strip().lower() in _ALLOWED_BLOCK_TITLES
    ]
    if not included:
        raise ValueError("沒有可納入客戶版的分析區塊")
    material = "\n\n".join(f"## {block['title']}\n{block['body']}" for block in included)
    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=3000,
        thinking={"type": "disabled"},
        system=_client_report_system("zh-TW"),
        messages=[{"role": "user", "content": material}],
    )
    meter_claude("coach-auto-complete-client-report", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)
    return _msg_text(msg).strip()


def _baseline_valence(value: object) -> int:
    try:
        score = max(0.0, min(10.0, float(value)))
    except (TypeError, ValueError):
        score = 5.0
    return round((score - 5) * 20)


def _build_weekly_report_pdf(
    member_name: str,
    week_number: int,
    week_start: str,
    baseline: dict,
    session: dict,
    block: dict,
) -> bytes:
    """產生只根據單週書寫、並與 T0 比較的繁中 PDF。"""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    font_name = "NotoSansTC"
    font_path = os.path.join(os.path.dirname(__file__), "assets", "fonts", "NotoSansTC-Variable.ttf")
    try:
        pdfmetrics.getFont(font_name)
    except KeyError:
        pdfmetrics.registerFont(TTFont(font_name, font_path))

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
    dim_labels = {"P": "正向情緒", "E": "投入", "R": "關係", "M": "意義", "A": "成就"}
    rows = [["面向", "T0", f"第 {week_number} 週", "變化"]]
    for key in _PERMA_KEYS:
        t0 = _baseline_valence(baseline.get(key))
        current = int((dims.get(key) or {}).get("v", 0))
        rows.append([f"{key} {dim_labels[key]}", str(t0), str(current), f"{current - t0:+d}"])
    comparison = Table(rows, colWidths=[58 * mm, 34 * mm, 34 * mm, 34 * mm])
    comparison.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), font_name),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E9EEF4")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CAD2DC")),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    story = [
        Paragraph(f"第 {week_number} 週 PERMA 幸福感回顧", title_style),
        Paragraph(f"{html.escape(member_name)}　｜　週起始日 {html.escape(week_start)}", ParagraphStyle(
            "WeeklyMetaZH", parent=body, alignment=TA_CENTER, textColor=colors.HexColor("#6A7685"),
        )),
        Spacer(1, 7 * mm),
        Paragraph("本週與 T0 比較", heading),
        comparison,
        Spacer(1, 6 * mm),
        Paragraph("本週 PERMA 五面向分析", heading),
    ]
    for raw_line in _plain_markdown(str(block.get("body") or "")).split("\n"):
        line = raw_line.strip()
        if line:
            story.append(Paragraph(html.escape(line), body))
    story.extend([
        Spacer(1, 5 * mm),
        Paragraph(
            "這份報告只根據本週書寫與 T0 起始狀態整理，不使用其他週內容；它不是診斷或好壞評分。",
            body,
        ),
    ])
    doc.build(story)
    return out.getvalue()


async def _send_weekly_report(
    member_id: str,
    week_number: int,
    week_start: str,
    baseline: dict,
    session: dict,
    block: dict,
    content_hash: str,
) -> dict:
    if not RESEND_API_KEY or not REPORT_EMAIL_FROM:
        return {"status": "not_configured", "detail": "缺少 RESEND_API_KEY 或 REPORT_EMAIL_FROM"}
    name, email = await _member_identity(member_id)
    if not email:
        return {"status": "missing_email", "detail": "找不到會員 email"}

    pdf_bytes = _build_weekly_report_pdf(name, week_number, week_start, baseline, session, block)
    email_html = f"""
    <p>{html.escape(name)}，你好：</p>
    <p>謝謝你完成第 {week_number} 週的 PERMA 書寫。</p>
    <p>附件是本週幸福感回顧，只根據你這一週留下的內容進行分析，並與開始計畫時的 T0 狀態比較。報告中的變化不是好壞評分，而是幫助你看見這一週哪些面向有所移動。</p>
    <p>閱讀時可以留意：哪一個變化最符合你的實際感受？哪一段文字是你接下來想繼續探索的？</p>
    <p>若希望在教練會談中一起討論，歡迎直接回覆這封信。</p>
    <p>祝福你，<br>陳郁敏 教練</p>
    """
    payload: dict = {
        "from": REPORT_EMAIL_FROM,
        "to": [email],
        "subject": f"你的第 {week_number} 週 PERMA 幸福感回顧",
        "html": email_html,
        "attachments": [{
            "filename": f"第{week_number}週-PERMA幸福感回顧.pdf",
            "content": base64.b64encode(pdf_bytes).decode("ascii"),
        }],
    }
    if REPORT_EMAIL_REPLY_TO:
        payload["reply_to"] = REPORT_EMAIL_REPLY_TO
    send_resp = await db().post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
        json=payload,
    )
    if send_resp.status_code not in (200, 201):
        raise RuntimeError(f"Resend {send_resp.status_code}: {send_resp.text[:300]}")
    return {
        "status": "sent",
        "email": email,
        "content_hash": content_hash,
        "provider_id": str(send_resp.json().get("id") or ""),
    }


async def _generate_and_send_weekly_report(
    member_id: str,
    post: dict,
    week_number: int,
    baseline: dict,
    coach_id: str,
) -> dict:
    """為一個完整週次產生 PERMA-only 報告；內容或 T0 未變時不重複寄送。"""
    week_start = str(post.get("week_start") or "")
    fingerprint_source = {
        "post": {key: post.get(key) for key in ["p_content", "e_content", "r_content", "m_content", "a_content"]},
        "baseline": baseline,
    }
    content_hash = hashlib.sha256(
        json.dumps(fingerprint_source, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    existing_resp = await db().get(
        f"{SUPABASE_REST}/perma_weekly_reports",
        headers=SUPABASE_HEADERS,
        params=[
            ("member_id", f"eq.{member_id}"),
            ("week_start", f"eq.{week_start}"),
            ("select", "*"),
            ("limit", "1"),
        ],
    )
    existing_rows = existing_resp.json() if existing_resp.status_code == 200 else []
    existing = existing_rows[0] if existing_rows else {}
    if existing.get("report_emailed_at") and existing.get("report_email_content_hash") == content_hash:
        return {"status": "already_sent", "week_number": week_number}

    sessions, blocks = await _analyze_completed_posts([post], coach_id)
    if not sessions or not blocks:
        raise RuntimeError("單週 PERMA 分析沒有回傳完整內容")
    session, block = sessions[0], blocks[0]
    content = {
        "v": 1,
        "baseline": baseline,
        "session": session,
        "block": block,
        "scope": "single_week_only",
    }
    saved = {
        "member_id": member_id,
        "week_start": week_start,
        "post_id": post.get("id"),
        "week_number": week_number,
        "content": content,
        "updated_at": datetime.now(TW_TZ).isoformat(),
    }
    save_resp = await db().post(
        f"{SUPABASE_REST}/perma_weekly_reports",
        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
        json=saved,
    )
    if save_resp.status_code not in (200, 201):
        raise RuntimeError(f"單週報告儲存失敗：{save_resp.text[:300]}")

    delivery = await _send_weekly_report(
        member_id, week_number, week_start, baseline, session, block, content_hash
    )
    email_patch = {
        "report_email_error": None if delivery.get("status") == "sent" else delivery.get("detail"),
    }
    if delivery.get("status") == "sent":
        email_patch.update({
            "report_emailed_at": datetime.now(TW_TZ).isoformat(),
            "report_email_recipient": delivery.get("email"),
            "report_email_content_hash": content_hash,
            "report_email_provider_id": delivery.get("provider_id"),
        })
    await db().patch(
        f"{SUPABASE_REST}/perma_weekly_reports",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{member_id}"), ("week_start", f"eq.{week_start}")],
        json=email_patch,
    )
    return {**delivery, "week_number": week_number, "week_start": week_start}


class CoachMemberRequest(BaseModel):
    member_id: str
    language: str = "zh-TW"


@app.post("/api/coach/report-completed-webhook")
async def coach_report_completed_webhook(
    request: Request,
    x_report_webhook_secret: str = Header(default="", alias="X-Report-Webhook-Secret"),
):
    """Supabase Database Webhook：每週完整提交即寄單週報告；第 8 週另寄總結。"""
    if not REPORT_WEBHOOK_SECRET or not hmac.compare_digest(x_report_webhook_secret, REPORT_WEBHOOK_SECRET):
        raise HTTPException(status_code=401, detail="Webhook 驗證失敗")

    payload = await request.json()
    record = payload.get("record") or payload.get("new") or {}
    member_id = str(record.get("user_id") or "").strip()
    if not member_id:
        raise HTTPException(status_code=400, detail="Webhook 缺少 record.user_id")

    posts = await _fetch_member_posts(member_id)
    completed_posts_all = [
        post for post in posts
        if all(str(post.get(f"{key.lower()}_content") or "").strip() for key in _PERMA_KEYS)
    ]
    # 同一週若有多次提交，以最後一筆完整內容為該週報告來源。
    by_week: dict[str, dict] = {}
    for post in completed_posts_all:
        by_week[str(post.get("week_start") or "")] = post
    completed_posts = [by_week[key] for key in sorted(by_week)]
    current_week_start = str(record.get("week_start") or "")
    current_post = by_week.get(current_week_start)
    if not current_post:
        return {
            "status": "waiting_for_complete_week",
            "completed_weeks": len(completed_posts),
            "detail": "本週 P／E／R／M／A 尚未全部完成",
        }

    existing_resp = await db().get(
        f"{SUPABASE_REST}/coach_analyses",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{member_id}"), ("select", "*"), ("limit", "1")],
    )
    existing_rows = existing_resp.json() if existing_resp.status_code == 200 else []
    existing = existing_rows[0] if existing_rows else {}
    baseline = existing.get("baseline") if isinstance(existing.get("baseline"), dict) else None
    if not baseline or not all(key in baseline for key in _PERMA_KEYS):
        return {
            "status": "waiting_for_t0",
            "detail": "請先由 coach 填寫完整 T0，系統才會生成單週比較報告",
        }

    coach_id = str(existing.get("coach_id") or "")
    if not coach_id:
        coach_resp = await db().get(
            f"{SUPABASE_REST}/profiles",
            headers=SUPABASE_HEADERS,
            params=[("role", "eq.coach"), ("select", "id"), ("limit", "1")],
        )
        coach_rows = coach_resp.json() if coach_resp.status_code == 200 else []
        coach_id = str((coach_rows[0] if coach_rows else {}).get("id") or "")
    if not coach_id:
        raise HTTPException(status_code=409, detail="找不到可歸屬的 coach 帳號")

    week_number = next(
        index + 1 for index, post in enumerate(completed_posts)
        if str(post.get("week_start") or "") == current_week_start
    )
    try:
        weekly_delivery = await _generate_and_send_weekly_report(
            member_id, current_post, week_number, baseline, coach_id
        )
    except Exception as exc:
        logger.exception("automatic weekly report failed for member %s", member_id)
        raise HTTPException(status_code=502, detail=f"單週報告生成或寄送失敗：{str(exc)[:180]}")

    if len(completed_posts) < 8:
        return {
            "status": "weekly_report_processed",
            "weekly": weekly_delivery,
            "completed_weeks": len(completed_posts),
            "eight_week_summary": "waiting",
        }

    if existing.get("report_emailed_at") and int(existing.get("based_on") or 0) >= 8:
        return {
            "status": "weekly_report_processed",
            "weekly": weekly_delivery,
            "eight_week_summary": "already_sent",
        }
    report_posts = completed_posts[-8:]

    try:
        sessions, blocks = await _analyze_completed_posts(report_posts, coach_id)
        client_text = await _client_text_from_blocks(blocks, coach_id)
    except Exception as exc:
        logger.exception("automatic completed report generation failed for member %s", member_id)
        raise HTTPException(status_code=502, detail=f"自動報告生成失敗：{str(exc)[:180]}")

    client_date = datetime.now(TW_TZ).date().isoformat()
    analysis = {
        **existing,
        "member_id": member_id,
        "based_on": 8,
        "sessions": sessions,
        "blocks": blocks,
        "client_charts": _CLIENT_CHART_DEFAULTS,
        "client_text": client_text,
        "client_date": client_date,
        "translations": {},
        "coach_id": coach_id,
        "updated_at": datetime.now(TW_TZ).isoformat(),
    }
    save_resp = await db().post(
        f"{SUPABASE_REST}/coach_analyses",
        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
        json=analysis,
    )
    if save_resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="自動報告儲存失敗")
    if save_resp.json():
        analysis = save_resp.json()[0]

    try:
        delivery = await _send_completed_report(member_id, analysis, client_text)
    except Exception as exc:
        logger.exception("automatic completed report email failed for member %s", member_id)
        await db().patch(
            f"{SUPABASE_REST}/coach_analyses",
            headers=SUPABASE_HEADERS,
            params=[("member_id", f"eq.{member_id}")],
            json={"report_email_error": str(exc)[:500]},
        )
        raise HTTPException(status_code=502, detail="報告已產生，但寄信失敗")

    if delivery.get("status") != "sent":
        return {
            "status": delivery.get("status"),
            "detail": delivery.get("detail"),
            "weekly": weekly_delivery,
        }

    email_patch = {
        "report_emailed_at": datetime.now(TW_TZ).isoformat(),
        "report_email_recipient": delivery.get("email"),
        "report_email_content_hash": delivery.get("content_hash"),
        "report_email_provider_id": delivery.get("provider_id"),
        "report_email_error": None,
    }
    await db().patch(
        f"{SUPABASE_REST}/coach_analyses",
        headers=SUPABASE_HEADERS,
        params=[("member_id", f"eq.{member_id}")],
        json=email_patch,
    )
    return {
        "status": "sent",
        "member_id": member_id,
        "recipient": delivery.get("email"),
        "weekly": weekly_delivery,
        "eight_week_summary": "sent",
    }


@app.post("/api/coach/analyze")
async def coach_analyze(req: CoachMemberRequest, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)

    posts = await _fetch_member_posts(req.member_id)
    if len(posts) < 1:
        raise HTTPException(status_code=409, detail="這位成員還沒有任何週記")

    # 報告原生語言固定為繁中；英文由教練選取後才翻譯並快取。
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
    meter_claude("coach-analyze", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)

    try:
        sessions, blocks = _parse_analysis(_msg_text(msg))
    except Exception as exc:
        logger.warning("coach_analyze parse failed [%s]: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="分析解析失敗，請重新生成")

    row = {
        "member_id": req.member_id,
        "based_on": len(posts),
        "sessions": sessions,
        "blocks": blocks,
        "client_charts": _CLIENT_CHART_DEFAULTS,
        "translations": {},  # 重新生成 → 舊翻譯作廢
        "coach_id": coach_id,
        "updated_at": datetime.now(TW_TZ).isoformat(),
    }
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

    included = [
        b for b in (analysis.get("blocks") or [])
        if b.get("include")
        and str(b.get("title") or "").strip().lower() in _ALLOWED_BLOCK_TITLES
    ]
    if not included:
        raise HTTPException(status_code=409, detail="請先在教練分析勾選要納入客戶版的區塊")

    material = "\n\n".join(f"## {b['title']}\n{b['body']}" for b in included)
    # 客戶版同樣以繁中為預設；英文只由介面明確選擇後查看。
    lang = "zh-TW"
    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=3000,
        thinking={"type": "disabled"},
        system=_client_report_system(lang),
        messages=[{"role": "user", "content": material}],
    )
    meter_claude("coach-client-report", _COACH_ANALYSIS_MODEL, msg.usage, coach_id)

    client_text = _msg_text(msg).strip()
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

    # 8 週內容完成後寄送一次；同一份 client_text 以內容雜湊防止重複寄件。
    if int(result.get("based_on") or 0) >= 8:
        try:
            delivery = await _send_completed_report(req.member_id, result, client_text)
            if delivery.get("status") == "sent":
                email_patch = {
                    "report_emailed_at": datetime.now(TW_TZ).isoformat(),
                    "report_email_recipient": delivery.get("email"),
                    "report_email_content_hash": delivery.get("content_hash"),
                    "report_email_provider_id": delivery.get("provider_id"),
                    "report_email_error": None,
                }
                await db().patch(
                    f"{SUPABASE_REST}/coach_analyses",
                    headers=SUPABASE_HEADERS,
                    params=[("member_id", f"eq.{req.member_id}")],
                    json=email_patch,
                )
                result.update(email_patch)
            elif delivery.get("status") not in {"already_sent"}:
                result["report_email_error"] = delivery.get("detail") or delivery.get("status")
        except Exception as exc:
            logger.exception("completed report email failed for member %s", req.member_id)
            error_text = str(exc)[:500]
            await db().patch(
                f"{SUPABASE_REST}/coach_analyses",
                headers=SUPABASE_HEADERS,
                params=[("member_id", f"eq.{req.member_id}")],
                json={"report_email_error": error_text},
            )
            result["report_email_error"] = error_text

    return result


class CoachTranslateRequest(BaseModel):
    member_id: str
    target: str = "en"


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
    msg = await claude().messages.create(
        model=_COACH_ANALYSIS_MODEL,
        max_tokens=8000,
        thinking={"type": "disabled"},
        system=_translate_system(req.target),
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT)
