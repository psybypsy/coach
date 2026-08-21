"""把既有的每週報告改寫成新的排版規則（不呼叫 AI、不花錢）。

背景：報告內文（member_reports.body_md）是產生當下就寫進資料庫的文字，
所以改了規則之後，舊報告不會自動跟上。但這兩項轉換其實都是純文字運算，
資料庫裡已經有需要的東西，不需要重跑分析：

  1. 面向小標的等級 —— 依同一列已存的 sessions 分數重算成 Level 1–5
     （舊資料寫的是「充沛／穩定／正在萌芽」，甚至有照抄提示詞的「飽滿度」）
  2. 優勢章節 —— 從內文裡的「- **你的優勢與內在資源**」升級成 ## 大章節，
     並補上固定的前言與結語

兩者都沿用 app.py 裡產生報告時的同一組函式，所以補寫結果與新報告完全一致。

用法：
    cd backend
    .venv/bin/python tools/backfill_report_format.py            # 只看會改什麼，不寫入
    .venv/bin/python tools/backfill_report_format.py --apply    # 實際寫入
    .venv/bin/python tools/backfill_report_format.py --apply --user <user_id>

寫入前會把原始 body_md 備份成 JSON 檔，出事可以還原。
需要 backend/.env 裡的 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402

import app  # noqa: E402


def rewrite(body_md: str, sessions: list) -> str:
    """對單份報告套用兩項轉換，回傳新的 body_md。

    只取 sessions 的最後一筆：member_reports.sessions 存的是「累積到這一週」的
    歷史（趨勢圖要用），但報告內文只描述當週。_normalise_level_labels 遇到多筆
    會取平均——那是為教練的跨週分析設計的，用在這裡會把當週的等級算成跨週平均，
    把原本正確的報告改錯。
    """
    latest = [sessions[-1]] if sessions else []
    blocks = [{"title": "PERMA 五面向回顧", "body": body_md}]
    app._normalise_level_labels(latest, blocks)
    app._inject_strengths_frame(blocks)
    return blocks[0]["body"]


def summarise(before: str, after: str) -> list[str]:
    """列出這份報告實際變了什麼，方便 dry-run 時判斷。"""
    import re

    changes = []
    old_labels = re.findall(r"[PERMA]（[^）]+）：(充沛|穩定|正在萌芽|飽滿度|稀薄|缺席|這週較少著墨)", before)
    new_labels = re.findall(r"[PERMA]（[^）]+）：(Level \d|這週較少著墨)", after)
    if old_labels and new_labels:
        changes.append(f"等級 {'/'.join(old_labels)} → {'/'.join(new_labels)}")
    if "## 你的優勢與內在資源" in after and "## 你的優勢與內在資源" not in before:
        changes.append("優勢升級為 ## 大章節")
    if app.STRENGTHS_INTRO[:12] in after and app.STRENGTHS_INTRO[:12] not in before:
        changes.append("補上優勢前言與結語")
    return changes


async def main() -> int:
    parser = argparse.ArgumentParser(description="把既有每週報告補寫成新的排版規則")
    parser.add_argument("--apply", action="store_true", help="實際寫入；不加只做預演")
    parser.add_argument("--user", help="只處理這一位學員的 user_id")
    args = parser.parse_args()

    app._http = httpx.AsyncClient(timeout=60)
    try:
        params = [("select", "user_id,week_start,week_number,body_md,sessions"),
                  ("order", "user_id,week_number")]
        if args.user:
            params.append(("user_id", f"eq.{args.user}"))
        resp = await app.db().get(
            f"{app.SUPABASE_REST}/member_reports", headers=app.SUPABASE_HEADERS, params=params
        )
        if resp.status_code != 200:
            print(f"✗ 讀取失敗：{resp.text[:200]}")
            return 1
        rows = resp.json()

        pending = []
        for row in rows:
            before = row.get("body_md") or ""
            if not before:
                continue
            after = rewrite(before, row.get("sessions") or [])
            if after != before:
                pending.append((row, before, after))

        print(f"共 {len(rows)} 份報告，其中 {len(pending)} 份需要補寫\n")
        for row, before, after in pending:
            uid = str(row.get("user_id"))[:8]
            print(f"  第 {row.get('week_number')} 週 ({row.get('week_start')}) user={uid}")
            for line in summarise(before, after):
                print(f"      - {line}")

        if not pending:
            print("沒有需要補寫的報告。")
            return 0
        if not args.apply:
            print("\n這是預演，沒有寫入任何資料。確認無誤後加 --apply 實際執行。")
            return 0

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"backfill-backup-{stamp}.json")
        with open(backup, "w", encoding="utf-8") as f:
            json.dump(
                [{"user_id": r.get("user_id"), "week_start": r.get("week_start"), "body_md": b}
                 for r, b, _ in pending],
                f, ensure_ascii=False, indent=2,
            )
        print(f"\n原始內容已備份到 {backup}")

        ok = 0
        for row, _, after in pending:
            r = await app.db().patch(
                f"{app.SUPABASE_REST}/member_reports",
                headers=app.SUPABASE_HEADERS,
                params=[("user_id", f"eq.{row['user_id']}"), ("week_start", f"eq.{row['week_start']}")],
                json={"body_md": after},
            )
            if r.status_code in (200, 204):
                ok += 1
            else:
                print(f"  ✗ 第 {row.get('week_number')} 週寫入失敗：{r.text[:120]}")
        print(f"完成：{ok}/{len(pending)} 份已更新")
        return 0 if ok == len(pending) else 1
    finally:
        await app._http.aclose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
