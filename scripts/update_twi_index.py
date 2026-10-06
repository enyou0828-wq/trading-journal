#!/usr/bin/env python3
"""
每個交易日更新 data/twi_index.json：抓當天的加權指數（發行量加權股價指數／TAIEX／TWI）
收盤值，補上一筆，給交易日誌「報酬累計曲線」當對照線用
（app.js 的 ensureTwiData() 在頁面載入時 fetch 這份 JSON）。

這支腳本本身是 idempotent：同一天的資料已經存在且數值相同就不會造成變更，
.github/workflows/daily-twi-update.yml 裡的 commit 步驟會因為沒有 diff 而跳過。

只抓「今天」這一筆（不像 backfill_twi_index.py 可以指定起始日期回補整段歷史）——
跟 update_otc_index.py 同一套設計：每天排程呼叫一次，逐日累積。
"""
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backfill_twi_index import fetch_twi_close, load_existing, save  # noqa: E402

TAIPEI_TZ = timezone(timedelta(hours=8))


def main() -> int:
    today = datetime.now(TAIPEI_TZ).strftime("%Y-%m-%d")

    try:
        close = fetch_twi_close(today)
    except Exception as e:
        print(f"抓取失敗：{e}", file=sys.stderr)
        return 1

    if close is None:
        print(f"{today} 沒有資料（可能是非交易日，或資料還沒發布），略過。")
        return 0

    data = load_existing()
    existing = data.get(today)
    if existing is not None and abs(existing - close) < 1e-9:
        print(f"{today} 的資料已經是最新（{close}），沒有變更。")
        return 0

    data[today] = close
    save(data)
    verb = "更新" if existing is not None else "新增"
    print(f"{verb} {today}: {close}" + (f"（原本是 {existing}）" if existing is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
