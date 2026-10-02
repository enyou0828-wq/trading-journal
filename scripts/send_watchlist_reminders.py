#!/usr/bin/env python3
"""每天台北時間 8:30 執行：掃描所有使用者的觀察清單，把「加入後隔天」到期但還沒推播過的
項目透過 Firebase Cloud Messaging 推播提醒。由 .github/workflows/watchlist-reminder.yml 排程呼叫。

這個 app 的資料模型是每個使用者一份 Firestore 文件（journals/{uid}，見 app.js 的
save()/loadFromCloud()），watchlist 是裡面的一個陣列欄位，不是獨立的 collection，
所以這裡直接整個 journals collection 掃過一輪找到期項目——使用者數量很小，這樣最簡單，
不需要額外維護一份「使用者清單」。
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import credentials, firestore, messaging

TAIPEI_TZ = timezone(timedelta(hours=8))
APP_URL = "https://enyou0828-wq.github.io/trading-journal/"
ICON_URL = APP_URL + "icon-192.png"


def today_taipei_str() -> str:
    return datetime.now(TAIPEI_TZ).strftime("%Y-%m-%d")


def main() -> int:
    key_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_KEY")
    if not key_json:
        print("缺少 FIREBASE_SERVICE_ACCOUNT_KEY 環境變數（GitHub repo secret 還沒設定）", file=sys.stderr)
        return 1

    cred = credentials.Certificate(json.loads(key_json))
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    today = today_taipei_str()
    sent_count = 0
    checked_users = 0

    for doc in db.collection("journals").stream():
        checked_users += 1
        data = doc.to_dict() or {}
        watchlist = data.get("watchlist") or []
        tokens = data.get("fcmTokens") or []
        if not watchlist or not tokens:
            continue

        due_items = [w for w in watchlist if not w.get("notified") and w.get("reminderDate", "") <= today]
        if not due_items:
            continue

        names = "、".join(f"{w.get('code', '')} {w.get('name', '')}".strip() for w in due_items)
        title = "觀察清單提醒"
        body = f"該複查這些標的了：{names}"

        invalid_tokens = set()
        for token in tokens:
            try:
                messaging.send(messaging.Message(
                    notification=messaging.Notification(title=title, body=body),
                    token=token,
                    webpush=messaging.WebpushConfig(
                        notification=messaging.WebpushNotification(icon=ICON_URL),
                        fcm_options=messaging.WebpushFCMOptions(link=APP_URL),
                    ),
                ))
                sent_count += 1
            except messaging.UnregisteredError:
                invalid_tokens.add(token)  # token 已失效（例如使用者在該裝置清除了通知權限），之後一併清掉
            except Exception as e:
                print(f"推播失敗（user={doc.id}, token 結尾 …{token[-8:]}）：{e}", file=sys.stderr)

        due_ids = {w["id"] for w in due_items}
        updated_watchlist = [
            {**w, "notified": True} if w.get("id") in due_ids else w
            for w in watchlist
        ]
        update_payload = {"watchlist": updated_watchlist}
        if invalid_tokens:
            update_payload["fcmTokens"] = [t for t in tokens if t not in invalid_tokens]
        doc.reference.update(update_payload)

    print(f"完成：掃描 {checked_users} 位使用者，送出 {sent_count} 則推播通知。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
