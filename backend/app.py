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
# 標題含這些關鍵字的情報簡報區塊，預設「僅教練可見」（不納入客戶版）。
_COACH_ONLY_KW = ["假設", "未言", "值得關注", "會談準備", "語言指紋", "風險", "理論"]
# 客戶交付版預設納入的圖表（教練可在前端調整）。
_CLIENT_CHART_DEFAULTS = {
    "summary": True, "trend": True, "dims": True,
    "radar": True, "affect": False, "cloud": False,
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

Intelligence-brief rules (coach-only; may contain candid hypotheses; quote the person's words and cite which week). Separate blocks with [[BLOCK]]; the first line of each block is its title, the rest is the body (Markdown: ## headings, ** bold **, * italics *, - bullets).

FORMATTING — keep every block skimmable: write in short paragraphs and - bullet points, prefer bullets over dense prose, and keep sentences short.

Include these blocks in exactly this order:
[[BLOCK]] Overall Emotional & Well-being Trajectory
[[BLOCK]] PERMA Five-Dimension Profile
[[BLOCK]] Strengths & Inner Resources
[[BLOCK]] Self-Determination Motivation
[[BLOCK]] Linguistic Fingerprint
[[BLOCK]] Cross-cutting Themes & Patterns
[[BLOCK]] The Unsaid
[[BLOCK]] Coaching Hypotheses
[[BLOCK]] Worth Watching
[[BLOCK]] Session Preparation

The three theory columns — "PERMA Five-Dimension Profile", "Strengths & Inner Resources", "Self-Determination Motivation" — must each: (a) stay tied to this person's specific quotes with week citations; (b) end with a "**References**" sub-heading listing 2-3 APA-format references (journal or book titles in * italics *) relevant only to that column.

Per-block requirements:
- PERMA Five-Dimension Profile: analyze P/E/R/M/A one by one, noting fullness (abundant / stable / thin / absent), change over time and key quotes, then integrate the overall pattern through a PERMA lens. References may draw from: Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.; Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218-226.; Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
- Strengths & Inner Resources: identify character strengths and reusable inner resources, each tied to quotes. References may draw from: Peterson, C., & Seligman, M. E. P. (2004). *Character strengths and virtues: A handbook and classification*. Oxford University Press.; Linley, P. A., Nielsen, K. M., Gillett, R., & Biswas-Diener, R. (2010). Using signature strengths in pursuit of goals. *International Coaching Psychology Review, 5*(1), 6-15.; Niemiec, R. M. (2013). VIA character strengths: Research and practice. In *Well-being and cultures* (pp. 11-29). Springer.
- Self-Determination Motivation: assess the three basic psychological needs — autonomy, competence, relatedness — as satisfied or frustrated, and read the resulting motivation quality (toward intrinsic vs controlled). References may draw from: Deci, E. L., & Ryan, R. M. (2000). The 'what' and 'why' of goal pursuits. *Psychological Inquiry, 11*(4), 227-268.; Ryan, R. M., & Deci, E. L. (2017). *Self-determination theory: Basic psychological needs in motivation, development, and wellness*. Guilford Press.; Gagné, M., & Deci, E. L. (2005). Self-determination theory and work motivation. *Journal of Organizational Behavior, 26*(4), 331-362.
- Linguistic Fingerprint: agency (active vs passive voice), connectedness (I / we / they balance), time orientation, energy vs depletion words, certainty vs hesitation.
- The Unsaid: which dimension stays persistently thin or absent, avoided topics.
- Coaching Hypotheses: label each explicitly as a hypothesis, with an evidence quote and one question to explore.
- Session Preparation: an opening suggestion, points to probe, and three powerful questions tailored to this person.

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

情報簡報規則（僅教練可見、可含坦率假設、每個判斷都引用原話並註明第幾次）：以 [[BLOCK]] 分隔，每塊第一行為標題、其後為內文（可用 Markdown 的 ## 標題、** 粗體、* 斜體 *、- 條列）。

排版（教練要能快速掃讀）：內文用簡短段落與 - 條列呈現，多用條列、少用長段落、句子精簡。

務必依序包含這些區塊：
[[BLOCK]] 整體情緒與福祉軌跡
[[BLOCK]] PERMA 五面向剖析
[[BLOCK]] 優勢與內在資源
[[BLOCK]] 自我決定論動機
[[BLOCK]] 語言指紋
[[BLOCK]] 橫向主題與模式
[[BLOCK]] 未言之事
[[BLOCK]] 教練假設
[[BLOCK]] 值得關注
[[BLOCK]] 會談準備

其中「PERMA 五面向剖析」「優勢與內在資源」「自我決定論動機」是三個各自獨立的理論專欄，每一欄都必須：(a) 全程扣合此人的具體引文並註明第幾次；(b) 在該欄內文最後另起一行、以「**參考文獻**」為小標，再用 - 條列 2 至 3 筆 APA 格式文獻（期刊名或書名以 * 斜體 * 標示），且只列與該欄主題直接相關者，不得跨欄混用。

各區塊要求：
- PERMA 五面向剖析：逐一分析 P/E/R/M/A 五面向，標飽滿度（充沛／穩定／稀薄／缺席）、變化與關鍵引文，並以 PERMA 觀點整合此人整體樣態。參考文獻可從下列擇要引用：Seligman, M. E. P. (2011). *Flourish: A visionary new understanding of happiness and well-being*. Free Press.；Fredrickson, B. L. (2001). The role of positive emotions in positive psychology: The broaden-and-build theory of positive emotions. *American Psychologist, 56*(3), 218–226.；Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row.
- 優勢與內在資源：辨識此人的性格優勢與可再運用的內在資源，逐一扣合引文。參考文獻可從下列擇要引用：Peterson, C., & Seligman, M. E. P. (2004). *Character strengths and virtues: A handbook and classification*. Oxford University Press.；Linley, P. A., Nielsen, K. M., Gillett, R., & Biswas-Diener, R. (2010). Using signature strengths in pursuit of goals. *International Coaching Psychology Review, 5*(1), 6–15.；Niemiec, R. M. (2013). VIA character strengths: Research and practice. In *Well-being and cultures* (pp. 11–29). Springer.
- 自我決定論動機：以自我決定論的三項基本心理需求——自主（Autonomy）、勝任（Competence）、關聯（Relatedness）——分別評估其滿足或受挫，並據此判讀其動機品質（趨近內在動機或受控動機）。參考文獻可從下列擇要引用：Deci, E. L., & Ryan, R. M. (2000). The 'what' and 'why' of goal pursuits: Human needs and the self-determination of behavior. *Psychological Inquiry, 11*(4), 227–268.；Ryan, R. M., & Deci, E. L. (2017). *Self-determination theory: Basic psychological needs in motivation, development, and wellness*. Guilford Press.；Gagné, M., & Deci, E. L. (2005). Self-determination theory and work motivation. *Journal of Organizational Behavior, 26*(4), 331–362.
- 語言指紋：能動性（主動 vs 被動語態）、連結性（我／我們／他們的比重）、時間定向、能量詞 vs 耗竭詞、確定 vs 遲疑。
- 未言之事：哪個面向始終稀薄或缺席、被迴避的主題。
- 教練假設：每條明確標為「假設」，附證據引文與一個可探詢的問題。
- 會談準備：開場建議、要探詢的點、三個為此人量身的有力提問。

語言：繁體中文（台灣）。全篇不得使用任何 emoji。語氣專業、精確，兼具實證理論素養，如資深教練結合學理的臨床筆記。"""


_CLIENT_REPORT_SYSTEM_EN = """You are the writing assistant to coach Tan Yee Ming. Below is the analysis content the coach selected to include in the client version. Rewrite it into a formal, warm, empowering "Personal Well-being Review" for the client to read.

Requirements:
- Remove all hypotheses, clinical speculation, risk or diagnostic language; focus on strengths, trajectory, meaning and the way forward.
- Preserve and lightly quote the client's own words.
- Use Markdown, with ## sections; keep paragraphs short and clear, and use - bullets where they aid readability.
- End with 1 to 2 warm, forward-looking invitations.
- Entirely in English. No emoji.
- Do not repeat the title page or signature (the system adds them)."""


_CLIENT_REPORT_SYSTEM_ZH = """你是教練 陳郁敏 的寫作助理。以下是教練勾選要納入客戶交付版的分析內容。請改寫成一份給客戶本人閱讀的正式、溫暖、賦能的「個人福祉回顧」。

要求：
- 移除所有假設、臨床推測、風險或診斷性語言；聚焦優勢、軌跡、意義與前瞻。
- 保留並適度引用客戶自己的語言。
- 用 Markdown，以 ## 分節，段落清晰、專業。
- 結尾給 1 至 2 個溫暖的前瞻邀請。
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
            "emotions": emotions,
        })

    # 前 4 塊（軌跡／PERMA／優勢／SDT）預設納入客戶版；其餘（語言指紋、假設、風險、
    # 會談準備等）僅教練。用順序判斷而非標題關鍵字，才能同時支援中英文標題。
    parts = [p.strip() for p in brief_part.split("[[BLOCK]]") if p.strip()]
    blocks = []
    for idx, part in enumerate(parts):
        nl = part.find("\n")
        title = (part[:nl] if nl >= 0 else part).strip()
        body = (part[nl + 1:] if nl >= 0 else "").strip()
        blocks.append({"title": title, "body": body, "include": idx < 4})

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


@app.post("/api/coach/analyze")
async def coach_analyze(req: CoachMemberRequest, authorization: str = Header(...)):
    token = authorization.removeprefix("Bearer ").strip()
    coach_id = await require_coach(token)

    posts = await _fetch_member_posts(req.member_id)
    if len(posts) < 1:
        raise HTTPException(status_code=409, detail="這位成員還沒有任何週記")

    # 教練深度分析一律以英文生成（教練工作語言預設英文）；中文由前端點「中文」時
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

    included = [b for b in (analysis.get("blocks") or []) if b.get("include")]
    if not included:
        raise HTTPException(status_code=409, detail="請先在教練分析勾選要納入客戶版的區塊")

    material = "\n\n".join(f"## {b['title']}\n{b['body']}" for b in included)
    # 客戶回顧同樣跟隨學員書寫語言（分析區塊已是該語言，直接由內容判斷）
    lang = _detect_lang(material)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT)
