"""取得 Gmail API 的 refresh token —— 整個專案只需要跑這一次。

為什麼需要這支：Render 免費方案封鎖所有對外 SMTP 連接埠（25／465／587），
所以寄信改走 Gmail API（HTTPS 443）。Gmail API 不吃「應用程式密碼」，
只吃 OAuth token，而 refresh token 沒辦法在 Google Cloud 主控台裡直接複製，
必須跑一次授權流程換出來。

用法（在自己的電腦上跑，不是在 Render 上）：

    cd backend
    python tools/get_gmail_refresh_token.py

它會開瀏覽器請你用寄件用的 Gmail 帳號登入授權，然後把 refresh token 印出來。
完整步驟（含 Google Cloud 那邊怎麼設定）見 docs/gmail-api-setup.md。

只用標準函式庫，不需要額外安裝任何套件。
"""
from __future__ import annotations

import http.server
import json
import secrets
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

# 只要求「代為寄信」這一個權限，不要求讀信——權限越小越好，
# 也是 Google 審核時最容易過的組合。
SCOPE = "https://www.googleapis.com/auth/gmail.send"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"

_result: dict[str, str] = {}
_done = threading.Event()


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    """接住 Google 授權後導回本機的那一下，把網址上的 code 撈出來。"""

    def do_GET(self) -> None:  # noqa: N802 （BaseHTTPRequestHandler 規定的名稱）
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _result.update({k: v[0] for k, v in query.items()})
        # 真正的 state 比對在 main() 裡做，這裡只負責回一個看得懂的畫面。
        ok = "code" in _result
        message = "授權完成，可以關掉這個分頁回到終端機了。" if ok else "授權失敗，請看終端機的訊息。"
        body = f"<html><meta charset='utf-8'><body style='font-family:sans-serif;padding:3rem'><h2>{message}</h2></body></html>"
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))
        _done.set()

    def log_message(self, *args) -> None:  # 不要把 HTTP log 印出來干擾畫面
        pass


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def main() -> int:
    print("=" * 66)
    print(" 取得 Gmail API refresh token")
    print("=" * 66)
    print("請先照 docs/gmail-api-setup.md 建好『桌面應用程式』類型的 OAuth 用戶端，")
    print("然後把該用戶端的兩個值貼進來。\n")
    client_id = input("Client ID: ").strip()
    client_secret = input("Client secret: ").strip()
    if not client_id or not client_secret:
        print("\n✗ Client ID／secret 不可為空。")
        return 1

    port = _free_port()
    redirect_uri = f"http://localhost:{port}"
    state = secrets.token_urlsafe(16)

    server = http.server.HTTPServer(("127.0.0.1", port), _CallbackHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    # access_type=offline 才會發 refresh token；prompt=consent 強制每次都重發，
    # 否則同一個帳號第二次授權時 Google 只會給 access token，refresh token 會是空的。
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    auth_url = f"{AUTH_URL}?{urllib.parse.urlencode(params)}"
    print(f"\n正在開啟瀏覽器…若沒自動開啟，請手動貼上這個網址：\n{auth_url}\n")
    print("※ 若看到「Google 尚未驗證這個應用程式」，點『進階』→『前往（不安全）』即可——")
    print("  那是你自己建立、只授權給自己用的應用程式。\n")
    webbrowser.open(auth_url)

    print("等待授權中…（最多 5 分鐘）")
    if not _done.wait(timeout=300):
        print("\n✗ 逾時，沒有等到授權回傳。請重跑一次。")
        return 1
    server.shutdown()

    if "code" not in _result:
        print(f"\n✗ 授權失敗：{_result.get('error', '未知錯誤')}")
        return 1
    if _result.get("state") != state:
        print("\n✗ state 不符，可能被攔截，請重跑一次。")
        return 1

    payload = urllib.parse.urlencode({
        "code": _result["code"],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=payload)) as resp:
            tokens = json.load(resp)
    except urllib.error.HTTPError as exc:
        print(f"\n✗ 換 token 失敗 {exc.code}：{exc.read().decode()[:400]}")
        return 1

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        print("\n✗ Google 沒有回傳 refresh token。")
        print("  通常是這個帳號先前已經授權過。請到 https://myaccount.google.com/permissions")
        print("  移除這個應用程式的存取權後再跑一次。")
        return 1

    print("\n" + "=" * 66)
    print(" ✓ 成功！請把下面三個值設進 Render 的環境變數")
    print("=" * 66)
    print(f"GMAIL_OAUTH_CLIENT_ID={client_id}")
    print(f"GMAIL_OAUTH_CLIENT_SECRET={client_secret}")
    print(f"GMAIL_OAUTH_REFRESH_TOKEN={refresh_token}")
    print("=" * 66)
    print("⚠ 這三個值等同於「可以用你的 Gmail 寄信」的權限，請當成密碼保管，")
    print("  不要 commit 進 Git、不要貼在聊天群組。")
    print("⚠ 另外務必確認 OAuth 同意畫面的發布狀態是「正式版」而非「測試中」——")
    print("  停在「測試中」的話，Google 會在 7 天後撤銷這個 refresh token，信就又寄不出去了。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
