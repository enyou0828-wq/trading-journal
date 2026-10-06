#!/usr/bin/env python3
"""
一次性回補工具：把 data/twi_index.json 從 EQUITY_CURVE_START（app.js 裡定義，目前是 6/1）
一路補到昨天，給交易日誌「報酬累計曲線」畫加權指數對照線用。只在本機手動跑一次，
之後每天的新資料交給 scripts/update_twi_index.py（由 .github/workflows/daily-twi-update.yml
排程呼叫）用 idempotent 的方式逐日補上。

資料來源：TWSE 網站本身的 MI_INDEX（type=IND）端點，回傳當天所有價格指數（大盤、臺灣50…），
這裡只取「發行量加權股價指數」那一列的收盤指數（就是一般講的「加權指數」/TAIEX/TWI）。
非交易日（週末、國定假日）這個端點會回傳空的 data 陣列，直接跳過，不是錯誤。

用法：
  python3 scripts/backfill_twi_index.py [起始日期 YYYY-MM-DD，預設 2026-06-01]
"""
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from daily_signal_scan import fetch_json  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "twi_index.json"

TWSE_INDEX_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={date}&type=IND&response=json"
INDEX_ROW_NAME = "發行量加權股價指數"

DEFAULT_START = "2026-06-01"
REQUEST_DELAY_SECONDS = 0.4  # 對端點客氣一點，不要連續轟炸


def fetch_twi_close(iso_date: str):
    """回傳某天的加權指數收盤值；非交易日或抓不到就回傳 None。"""
    date_compact = iso_date.replace("-", "")
    data = fetch_json(TWSE_INDEX_URL.format(date=date_compact), referer="https://www.twse.com.tw/")
    if data.get("stat") != "OK":
        return None
    table = next((t for t in data.get("tables", []) if t.get("fields") and "指數" in t["fields"]), None)
    if not table or not table.get("data"):
        return None
    row = next((r for r in table["data"] if r[0].strip() == INDEX_ROW_NAME), None)
    if not row:
        return None
    try:
        return float(row[1].replace(",", ""))
    except (ValueError, IndexError):
        return None


def load_existing() -> dict:
    if not DATA_PATH.exists():
        return {}
    with DATA_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def save(data: dict) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DATA_PATH.open("w", encoding="utf-8") as f:
        json.dump(dict(sorted(data.items())), f, indent=2, ensure_ascii=False)
        f.write("\n")


def main() -> int:
    start_date = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_START
    cursor = datetime.strptime(start_date, "%Y-%m-%d").date()
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)  # 今天交給每日排程自己抓

    data = load_existing()
    added = 0
    while cursor <= yesterday:
        iso_date = cursor.isoformat()
        if iso_date in data:
            cursor += timedelta(days=1)
            continue
        if cursor.weekday() >= 5:  # 六、日一定沒開盤，不用打 API
            cursor += timedelta(days=1)
            continue

        try:
            close = fetch_twi_close(iso_date)
        except Exception as e:
            print(f"{iso_date} 抓取失敗，跳過：{e}", file=sys.stderr)
            cursor += timedelta(days=1)
            time.sleep(REQUEST_DELAY_SECONDS)
            continue

        if close is None:
            print(f"{iso_date} 沒有資料（應該是假日），跳過")
        else:
            data[iso_date] = close
            added += 1
            print(f"{iso_date}: {close}")

        cursor += timedelta(days=1)
        time.sleep(REQUEST_DELAY_SECONDS)

    if added == 0:
        print("沒有新增任何一天的資料")
        return 0

    save(data)
    print(f"完成，共新增 {added} 天，data/twi_index.json 已更新")
    return 0


if __name__ == "__main__":
    sys.exit(main())
