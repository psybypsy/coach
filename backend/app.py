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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT)
