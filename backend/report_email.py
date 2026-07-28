"""學員版 PERMA 報告的 Email 內容產生。

純函式、不碰網路，方便單獨測試。實際寄送在 app.py（用 Resend API）。

信件排版刻意走「內嵌樣式的簡單 HTML」：email client 對 CSS 的支援差異很大，
外部樣式表、flex/grid 幾乎都不能用，所以這裡只用 inline style 與基本標籤。
"""

from __future__ import annotations

import html
import re

# 品牌：Ipsen Taiwan 為主、教練名為輔（寄件網域雖是 psybypsy.com，
# 但信件內容與寄件人顯示名稱一律用 Ipsen Taiwan）。
BRAND_NAME = "Ipsen Taiwan"
COACH_NAME = "Yee Ming Tan"

_INK = "#1C2530"
_SOFT = "#54606E"
_MUTED = "#8993A1"
_PRIMARY = "#1E3A5F"
_BORDER = "#E2E5EA"


def _inline(text: str) -> str:
    """處理行內語法：**粗體**、*斜體*。先跳脫 HTML 再套語法。"""
    escaped = html.escape(text)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*(?!\*)(.+?)\*(?!\*)", r"<em>\1</em>", escaped)
    return escaped


def md_to_email_html(md: str) -> str:
    """把客戶交付版的 Markdown 子集轉成 email 用的 HTML。

    支援 ## 標題、- 條列、**粗體**、*斜體*、段落——
    這些正是 _CLIENT_REPORT_SYSTEM_ZH 會產出的語法。
    """
    out: list[str] = []
    in_list = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    for raw in str(md or "").split("\n"):
        line = raw.strip()
        if not line:
            continue

        bullet = re.match(r"^[-*•‣]\s+(.*)$", line)
        if bullet:
            if not in_list:
                out.append(
                    f'<ul style="margin:0 0 16px;padding-left:20px;color:{_SOFT};'
                    'font-size:15px;line-height:1.75">'
                )
                in_list = True
            out.append(f'<li style="margin:0 0 8px">{_inline(bullet.group(1))}</li>')
            continue

        close_list()

        heading = re.match(r"^(#{1,3})\s+(.*)$", line)
        if heading:
            level = len(heading.group(1))
            size = {1: 22, 2: 18, 3: 16}[level]
            out.append(
                f'<h{level} style="margin:28px 0 10px;font-size:{size}px;'
                f'font-weight:700;color:{_INK};line-height:1.4">'
                f"{_inline(heading.group(2))}</h{level}>"
            )
            continue

        out.append(
            f'<p style="margin:0 0 14px;font-size:15px;line-height:1.8;'
            f'color:{_SOFT}">{_inline(line)}</p>'
        )

    close_list()
    return "".join(out)


def build_report_email(
    display_name: str, week_number: int, body_md: str, report_url: str
) -> tuple[str, str]:
    """回傳 (主旨, HTML 內文)。"""
    subject = f"你的第 {week_number} 週 PERMA 回顧"
    greeting = f"{display_name}，" if display_name else ""

    return subject, f"""\
<div style="margin:0;padding:24px 12px;background:#F4F5F7">
  <div style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid {_BORDER};border-radius:12px;padding:32px 28px">

    <div style="text-align:center;padding-bottom:20px;border-bottom:2px solid {_PRIMARY}">
      <div style="font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:{_MUTED}">
        {html.escape(BRAND_NAME)}
      </div>
      <div style="margin-top:8px;font-size:24px;font-weight:700;color:{_INK}">個人福祉回顧</div>
      <div style="margin-top:6px;font-size:13px;color:{_MUTED}">
        {html.escape(greeting)}第 {week_number} 週
      </div>
    </div>

    <div style="padding-top:24px">
      <p style="margin:0 0 20px;font-size:15px;line-height:1.8;color:{_SOFT}">
        謝謝你完成這一週的記錄。以下是這次的回顧：
      </p>
      {md_to_email_html(body_md)}
    </div>

    <div style="margin-top:28px;padding-top:24px;border-top:1px solid {_BORDER};text-align:center">
      <a href="{html.escape(report_url, quote=True)}"
         style="display:inline-block;padding:13px 28px;background:{_PRIMARY};color:#FFFFFF;
                text-decoration:none;border-radius:8px;font-size:15px;font-weight:600">
        看完整報告（含圖表）
      </a>
      <p style="margin:14px 0 0;font-size:13px;line-height:1.7;color:{_MUTED}">
        完整報告有你的情緒趨勢圖、五面向剖面與情緒詞雲，<br>
        也可以在頁面上下載 PDF。
      </p>
    </div>

    <div style="margin-top:28px;padding-top:18px;border-top:1px solid {_BORDER};text-align:center;
                font-size:12px;color:{_MUTED};line-height:1.7">
      教練　{html.escape(COACH_NAME)}<br>
      {html.escape(BRAND_NAME)}
    </div>

  </div>
</div>"""
