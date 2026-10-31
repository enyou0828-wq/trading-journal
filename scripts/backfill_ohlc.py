#!/usr/bin/env python3
"""
一次性工具：把 data/price_history.csv 裡指定日期起、還沒有開高低價的列補上 open/high/low。
（2026-10-31 以前每日掃描只存收盤價與成交量。）

用法：python3 scripts/backfill_ohlc.py [起始日，預設 2026-08-01]
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from daily_signal_scan import fetch_json, load_history, save_history, to_float  # noqa: E402
from backfill_history import TWSE_HIST_URL, TPEX_HIST_URL, REQUEST_DELAY_SECONDS  # noqa: E402


def twse_ohlc(iso):
    data = fetch_json(TWSE_HIST_URL.format(date=iso.replace("-", "")), referer="https://www.twse.com.tw/")
    if data.get("stat") != "OK":
        return {}
    table = next((t for t in data.get("tables", []) if t.get("fields") and "證券代號" in t["fields"]), None)
    if not table:
        return {}
    f = [x.strip() for x in table["fields"]]
    io, ih, il = f.index("開盤價"), f.index("最高價"), f.index("最低價")
    return {row[0].strip(): (to_float(row[io]), to_float(row[ih]), to_float(row[il])) for row in table["data"]}


def tpex_ohlc(iso):
    y, m, d = iso.split("-")
    data = fetch_json(TPEX_HIST_URL.format(roc_date=f"{int(y) - 1911}/{m}/{d}"), referer="https://www.tpex.org.tw/")
    tables = data.get("tables", [])
    if not tables or not tables[0].get("data"):
        return {}
    f = [x.strip() for x in tables[0].get("fields", [])]
    io, ih, il = (f.index("開盤"), f.index("最高"), f.index("最低")) if "開盤" in f else (4, 5, 6)
    return {row[0].strip(): (to_float(row[io]), to_float(row[ih]), to_float(row[il])) for row in tables[0]["data"]}


def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "2026-08-01"
    rows = load_history()
    by_date = {}
    for r in rows:
        if r["date"] >= start and r["low"] != r["low"]:
            by_date.setdefault(r["date"], []).append(r)
    filled = 0
    for iso in sorted(by_date):
        try:
            tw = twse_ohlc(iso); time.sleep(REQUEST_DELAY_SECONDS)
            tp = tpex_ohlc(iso); time.sleep(REQUEST_DELAY_SECONDS)
        except Exception as e:
            print(f"{iso} 抓取失敗：{e}", file=sys.stderr)
            continue
        n = 0
        for r in by_date[iso]:
            v = (tw if r["market"] == "TWSE" else tp).get(r["code"])
            if v:
                r["open"], r["high"], r["low"] = v
                n += 1
        filled += n
        print(f"{iso} 補 {n}/{len(by_date[iso])}")
    save_history(rows)
    print(f"完成，共補 {filled} 列")


if __name__ == "__main__":
    main()
