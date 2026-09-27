#!/usr/bin/env python3
"""
一次性回補歷史工具：往回抓過去幾十個「日曆天」裡有開盤的交易日資料，
把 data/price_history.csv 一次補到接近可用的天數，不用等每天累積。

只在本機手動跑一次用，不是每天排程的一部分（daily_signal_scan.py 本身
只抓「今天」，不需要帶日期參數回補的能力，所以獨立成這支工具）。

跑完之後，記得再跑一次 daily_signal_scan.py 讓 signals/latest.json
用回補後的完整歷史重新計算訊號。

用法：
  python3 scripts/backfill_history.py [目標交易日數，預設 25]
"""
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from daily_signal_scan import (  # noqa: E402
    HISTORY_CSV,
    PLAIN_STOCK_CODE,
    fetch_json,
    load_history,
    save_history,
    to_float,
)

TWSE_HIST_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={date}&type=ALLBUT0999&response=json"
TPEX_HIST_URL = "https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d={roc_date}&se=EW&o=json"

MAX_CALENDAR_DAYS_BACK = 60  # 保險上限，避免碰到長假或端點異常時無限往前找
REQUEST_DELAY_SECONDS = 0.4  # 對端點客氣一點，不要連續轟炸


def to_roc_date(d: "datetime") -> str:
    return f"{d.year - 1911}/{d.month:02d}/{d.day:02d}"


def fetch_twse_day(iso_date: str) -> list[dict]:
    date_compact = iso_date.replace("-", "")
    data = fetch_json(TWSE_HIST_URL.format(date=date_compact), referer="https://www.twse.com.tw/")
    if data.get("stat") != "OK":
        return []
    table = next((t for t in data.get("tables", []) if t.get("fields") and "證券代號" in t["fields"]), None)
    if not table:
        return []
    rows = []
    for row in table["data"]:
        code = row[0].strip()
        if not PLAIN_STOCK_CODE.match(code):
            continue
        close = to_float(row[8])
        volume = to_float(row[2])
        if close != close or volume != volume:
            continue
        rows.append({
            "date": iso_date, "code": code, "name": row[1].strip(),
            "market": "TWSE", "close": close, "volume": volume,
        })
    return rows


def fetch_tpex_day(iso_date: str, roc_date: str) -> list[dict]:
    data = fetch_json(TPEX_HIST_URL.format(roc_date=roc_date), referer="https://www.tpex.org.tw/")
    tables = data.get("tables", [])
    if not tables or not tables[0].get("data"):
        return []
    rows = []
    for row in tables[0]["data"]:
        code = row[0].strip()
        if not PLAIN_STOCK_CODE.match(code):
            continue
        close = to_float(row[2])
        volume = to_float(row[7])
        if close != close or volume != volume:
            continue
        rows.append({
            "date": iso_date, "code": code, "name": row[1].strip(),
            "market": "TPEx", "close": close, "volume": volume,
        })
    return rows


def main() -> int:
    target_trading_days = int(sys.argv[1]) if len(sys.argv) > 1 else 25

    existing = load_history()
    existing_dates = {r["date"] for r in existing}
    by_key = {(r["code"], r["date"]): r for r in existing}

    today = datetime.now(timezone.utc).date()
    collected_days = 0
    calendar_days_tried = 0
    cursor = today - timedelta(days=1)  # 從昨天開始往回找，今天的資料交給 daily_signal_scan.py 自己抓

    while collected_days < target_trading_days and calendar_days_tried < MAX_CALENDAR_DAYS_BACK:
        calendar_days_tried += 1
        if cursor.weekday() >= 5:  # 六、日一定沒開盤，不用打 API
            cursor -= timedelta(days=1)
            continue

        iso_date = cursor.isoformat()
        if iso_date in existing_dates:
            print(f"{iso_date} 已經有資料了，跳過")
            cursor -= timedelta(days=1)
            continue

        try:
            twse_rows = fetch_twse_day(iso_date)
            time.sleep(REQUEST_DELAY_SECONDS)
            tpex_rows = fetch_tpex_day(iso_date, to_roc_date(cursor))
            time.sleep(REQUEST_DELAY_SECONDS)
        except Exception as e:
            print(f"{iso_date} 抓取失敗，跳過：{e}", file=sys.stderr)
            cursor -= timedelta(days=1)
            continue

        day_rows = twse_rows + tpex_rows
        if not day_rows:
            print(f"{iso_date} 沒有資料（應該是假日），跳過")
            cursor -= timedelta(days=1)
            continue

        for r in day_rows:
            by_key[(r["code"], r["date"])] = r
        collected_days += 1
        print(f"{iso_date} 回補了 {len(day_rows)} 檔（累計已回補 {collected_days} 個交易日）")
        cursor -= timedelta(days=1)

    if collected_days == 0:
        print("沒有新增任何一天的資料，不需要寫檔")
        return 0

    save_history(list(by_key.values()))
    print(f"完成，共回補 {collected_days} 個交易日，price_history.csv 已更新")
    print("記得再跑一次 python3 scripts/daily_signal_scan.py 讓 signals/latest.json 用新的歷史重新計算")
    return 0


if __name__ == "__main__":
    sys.exit(main())
