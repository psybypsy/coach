"""替學員設定登入密碼（教練／管理者專用，在本機跑）。

用途：學員的公司郵件閘道把驗證碼信擋掉或延遲放行，他連第一次都登入不進來。
這支腳本用 service_role 直接設定密碼，完全不經過 email；產生的密碼請用
**email 以外的管道**交給學員（當面、通訊軟體、電話）——用 email 寄就白做了。

學員拿到密碼後可以在「個人資料 → 登入密碼」自己改成好記的密碼。

用法：
    cd backend
    .venv/bin/python tools/set_member_password.py someone@example.com
    .venv/bin/python tools/set_member_password.py someone@example.com --password 自訂密碼

沒帶 --password 就自動產生一組好唸的隨機密碼並印出來。
需要 backend/.env 裡的 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。
"""
from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv
import os

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""

if not SUPABASE_URL or not SERVICE_KEY:
    print("✗ 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（請確認 backend/.env）")
    sys.exit(2)

ADMIN = f"{SUPABASE_URL}/auth/v1/admin"
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

# 去掉容易看錯的字元（0/O、1/l/I），因為這組密碼是要用唸的或用手打的。
_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def make_password(length: int = 12) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def find_user(client: httpx.Client, email: str) -> dict | None:
    """用 email 找 auth 使用者。

    GoTrue 的 admin API 沒有穩定的「用 email 查單一使用者」端點，所以直接列出來自己比對。
    這個梯次的人數是數十人等級，一頁就撈得完，不必分頁。
    """
    resp = client.get(f"{ADMIN}/users", headers=HEADERS, params={"per_page": 200})
    resp.raise_for_status()
    users = resp.json().get("users") or []
    target = email.strip().lower()
    return next((u for u in users if str(u.get("email") or "").lower() == target), None)


def main() -> int:
    ap = argparse.ArgumentParser(description="替學員設定登入密碼")
    ap.add_argument("email", help="學員的 email（必須已在 allowed_emails 白名單內）")
    ap.add_argument("--password", help="指定密碼；不給就自動產生")
    args = ap.parse_args()

    email = args.email.strip()
    password = args.password or make_password()
    if len(password) < 8:
        print("✗ 密碼至少要 8 個字元")
        return 2

    with httpx.Client(timeout=30) as client:
        user = find_user(client, email)
        action = "已更新現有帳號的密碼"

        if not user:
            # 還沒登入過的學員在 auth.users 沒有那一列，要先建立。
            # email_confirm=True 讓帳號直接是已驗證狀態，不會再寄任何確認信。
            # schema.sql 的 handle_new_user() trigger 仍會擋掉不在 allowed_emails 的人。
            resp = client.post(
                f"{ADMIN}/users",
                headers=HEADERS,
                json={"email": email, "email_confirm": True},
            )
            if resp.status_code not in (200, 201):
                body = resp.text[:400]
                print(f"✗ 建立帳號失敗（HTTP {resp.status_code}）：{body}")
                if "不在允許名單內" in body or "allowed_emails" in body:
                    print("\n→ 這個 email 不在 allowed_emails 白名單裡。請先在 Supabase 執行：")
                    print(f"   insert into allowed_emails (email, role, note) values ('{email}', 'member', '姓名');")
                return 1
            user = resp.json()
            action = "已建立帳號並設定密碼"

        # 密碼一律走 PUT，連剛建立的帳號也是。
        # 實測（2026-08-03）：建立帳號時把 password 一起帶進 POST /admin/users，帳號會建起來、
        # 回 200，但那組密碼登入不了（grant_type=password 回 invalid_credentials）——
        # 建立時不會產生對應的 email identity。事後補一次 PUT 才會真的生效。
        # 這條路徑正是「從沒登入過的學員」會走的，不補這一步等於這支腳本的主要用途是壞的。
        resp = client.put(
            f"{ADMIN}/users/{user['id']}",
            headers=HEADERS,
            json={"password": password},
        )
        if resp.status_code not in (200, 201):
            print(f"✗ 設定密碼失敗（HTTP {resp.status_code}）：{resp.text[:400]}")
            return 1

    print(f"✓ {action}")
    print(f"  Email    : {email}")
    print(f"  密碼      : {password}")
    print("\n  請用 email 以外的管道交給學員（當面／通訊軟體／電話）。")
    print("  學員登入後可到「個人資料 → 登入密碼」自己改成好記的密碼。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
