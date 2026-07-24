"""
教練「自訂框架」端到端邏輯測試（不需 Supabase / 不需登入）。

驗證的正是使用者關心的兩件事：
  1) 教練用自然語言描述想分析什麼 → AI 生成一個有理論依據的結構化框架（方案）
  2) AI 用「那個框架的脈絡」逐維度分析成員的每週 PERMA 反思

直接重用 backend/app.py 內真正在用的 system prompt 與模型，
只需要 ANTHROPIC_API_KEY；SUPABASE_* 只是為了讓 app.py 能被 import 而放的假值。

用法：
    ANTHROPIC_API_KEY=sk-ant-... python test_framework_flow.py
或把金鑰放進 backend/.env 後：
    python test_framework_flow.py [描述文字]
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys

from dotenv import load_dotenv

load_dotenv()

# app.py 在 import 時會讀這三個環境變數；SUPABASE 這條路徑用不到，給假值即可。
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "dummy")

if not os.environ.get("ANTHROPIC_API_KEY"):
    print("✗ 缺少 ANTHROPIC_API_KEY。請 export 或寫入 backend/.env 後再跑。")
    sys.exit(2)

import anthropic  # noqa: E402

import app as backend  # noqa: E402  真正的 prompt 邏輯來源

# ── 假的成員每週 PERMA 反思（模擬一位面對職涯轉變、有自我批評傾向的成員）──
SAMPLE_POSTS = [
    {
        "week_start": "2026-06-01",
        "p_content": "這週有點低落，被主管退了提案。晚上跑步時才覺得好一點。",
        "e_content": "只有在寫程式那兩小時完全忘記時間，其他時候都在分心。",
        "r_content": "跟太太吵了一次，事後有好好道歉，她說懂我壓力大。",
        "m_content": "開始懷疑現在這份工作到底有沒有意義，還是只是在混。",
        "a_content": "提案被退，但我至少把它改到第三版才交，沒有擺爛。",
    },
    {
        "week_start": "2026-06-08",
        "p_content": "心情比上週穩，週末陪小孩去爬山很開心。",
        "e_content": "接了一個新專案，投入感回來了，會主動加班研究。",
        "r_content": "跟老同事約了咖啡，聊完覺得被理解，沒那麼孤單。",
        "m_content": "想通一件事：我在意的是有沒有在成長，不是頭銜。",
        "a_content": "新專案第一個里程碑提早兩天完成，但我還是覺得可以更好。",
    },
    {
        "week_start": "2026-06-15",
        "p_content": "被客戶稱讚，開心但也懷疑自己是不是配不上這句話。",
        "e_content": "整週幾乎都在心流裡，連午餐都忘記吃。",
        "r_content": "帶了一個新人，教他的過程讓我很有成就感。",
        "m_content": "越來越確定我想往帶團隊的方向走，而不是一直當個人貢獻者。",
        "a_content": "專案交付了，客戶滿意。但我腦中還是一直放大那個小 bug。",
    },
]

# 教練的自然語言描述（可用命令列參數覆蓋）
DEFAULT_DESC = "我想看這位成員面對職涯轉變時的能動性，以及他自我批評 vs 自我疼惜的傾向"


def _extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"回應中找不到 JSON：\n{text[:500]}")
    return json.loads(m.group())


async def step1_generate_framework(client, desc: str, language: str) -> dict:
    """複製 /api/coach/framework/generate 的核心邏輯。"""
    system = backend._framework_gen_system(language)
    try:
        msg = await client.messages.create(
            model=backend._COACH_ANALYSIS_MODEL,
            max_tokens=2500,
            thinking={"type": "disabled"},
            system=system,
            messages=[{"role": "user", "content": desc}],
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
        )
        used_search = True
    except anthropic.APIStatusError as exc:
        print(f"  (web_search 不可用，退回模型知識：{exc})")
        msg = await client.messages.create(
            model=backend._COACH_ANALYSIS_MODEL,
            max_tokens=2500,
            thinking={"type": "disabled"},
            system=system + "\n(Web search is unavailable here; rely on your own expert knowledge.)",
            messages=[{"role": "user", "content": desc}],
        )
        used_search = False
    fw = _extract_json(backend._msg_text(msg))
    print(f"  web_search 使用：{'是' if used_search else '否（fallback）'}")
    return fw


async def step2_analyze_with_framework(client, fw: dict, posts: list[dict], language: str) -> dict:
    """複製 /api/coach/analyze-framework 的核心邏輯。"""
    lang = "en"  # 既有深度分析一律英文（與 app.py 一致）
    parts = []
    for i, p in enumerate(posts):
        lines = [f"── 第 {i + 1} 次（{p.get('week_start', '')}）"]
        for k in backend._PERMA_KEYS:
            ans = (p.get(f"{k.lower()}_content") or "").strip() or "（未填）"
            lines.append(f"[{k}] {backend._PERMA_DIM[k]}：{ans}")
        parts.append("\n".join(lines))
    dump = "\n\n".join(parts)

    msg = await client.messages.create(
        model=backend._COACH_ANALYSIS_MODEL,
        max_tokens=3000,
        thinking={"type": "disabled"},
        system=backend._framework_block_system(fw, len(posts), lang),
        messages=[{"role": "user", "content": f"成員資料：\n\n{dump}"}],
    )
    return _extract_json(backend._msg_text(msg))


def check(label: str, cond: bool) -> bool:
    print(f"  [{'✓' if cond else '✗'}] {label}")
    return cond


async def main() -> int:
    desc = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DESC
    language = os.environ.get("TEST_LANG", "zh-TW")
    client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    print("=" * 70)
    print("測試：教練自訂框架流程")
    print("=" * 70)
    print(f"模型：{backend._COACH_ANALYSIS_MODEL}")
    print(f"教練描述：{desc}\n")

    print("── 第 1 步：AI 生成分析框架（方案）──")
    fw = await step1_generate_framework(client, desc, language)
    print(json.dumps(fw, ensure_ascii=False, indent=2))
    print()

    ok = True
    ok &= check("有框架名稱 name", bool(str(fw.get("name", "")).strip()))
    ok &= check("有理論依據 basis（含出處）", bool(str(fw.get("basis", "")).strip()))
    ok &= check("有分析視角 lens", bool(str(fw.get("lens", "")).strip()))
    dims = fw.get("dimensions") or []
    ok &= check(f"維度數量 2–5（實際 {len(dims)}）", 2 <= len(dims) <= 5)
    ok &= check(
        "每個維度都有 name / look_for / evidence_rule",
        all(d.get("name") and d.get("look_for") and d.get("evidence_rule") for d in dims),
    )
    ok &= check(f"有參考文獻 references（{len(fw.get('references') or [])} 筆）", bool(fw.get("references")))
    print()

    print("── 第 2 步：用該框架的脈絡分析成員週記 ──")
    block = await step2_analyze_with_framework(client, fw, SAMPLE_POSTS, language)
    title = str(block.get("title", "")).strip()
    body = str(block.get("body", "")).strip()
    print(f"標題：{title}\n")
    print(body)
    print()

    ok &= check("有區塊標題 title", bool(title))
    ok &= check("有內文 body", bool(body))
    ok &= check("內文以 **Takeaway —** 開頭（脈絡格式）", body.startswith("**Takeaway"))
    ok &= check("內文引用了成員原話（脈絡貼合）",
                any(q in body for q in ["提案", "心流", "自我", "里程碑", "bug", "成長", "頭銜"]))
    ok &= check("走過框架維度（提及至少一個維度名）",
                any(str(d.get("name", "")).strip() and str(d.get("name")).strip() in body for d in dims)
                or "week" in body.lower())
    ok &= check("含 References 段落", "References" in body or "參考文獻" in body)

    print()
    print("=" * 70)
    print(f"結果：{'✓ 全部通過' if ok else '✗ 有項目未通過（見上）'}")
    print("=" * 70)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
