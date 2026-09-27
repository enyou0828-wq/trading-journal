#!/usr/bin/env python3
"""
每日盤後訊號掃描：抓 TWSE / TPEx 全市場日收盤資料，累積到本地歷史，
同時用多組「創 N 日新高 + 爆量」條件（見 SIGNAL_SETS）各自獨立篩出
突破訊號，並比對 supply-chain-map 的 companies.csv 標出族群與供應鏈相關股。

執行後更新：
  - data/price_history.csv   累積的每日收盤/成交量歷史（自動裁到最近 max(lookback)*3 天）
  - signals/latest.json      當天每組條件各自篩出的訊號（signals/latest.json 的 "sets" 陣列）

要加/改篩選條件組合，直接改 SIGNAL_SETS 這個 list。
"""
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HISTORY_CSV = REPO_ROOT / "data" / "price_history.csv"
SIGNALS_JSON = REPO_ROOT / "signals" / "latest.json"
COMPANIES_CSV = REPO_ROOT / "supply-chain-map" / "data" / "companies.csv"
FLOWS_CSV = REPO_ROOT / "supply-chain-map" / "data" / "flows.csv"

TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"

# 同時算多組篩選條件，各自獨立產出訊號清單。之後要加/改組合，直接改這個 list。
SIGNAL_SETS = [
    {"key": "swing", "label": "中期（10日新高＋量增2倍）", "lookback": 10, "volume_multiplier": 2.0},
    {"key": "fast", "label": "短線（5日新高＋量增1.5倍）", "lookback": 5, "volume_multiplier": 1.5},
]
HISTORY_KEEP_DAYS = max(s["lookback"] for s in SIGNAL_SETS) * 3  # 歷史檔只保留這麼多天，避免無限膨脹

PLAIN_STOCK_CODE = re.compile(r"^(?!00)\d{4}$")  # 只留 4 碼數字股票，濾掉 00 開頭的 ETF 與帶字母的權證等

# 模擬真實瀏覽器的標頭：純 UA 字串在部分反爬蟲/WAF 規則下會被視為可疑，
# 補齊 Accept / Accept-Language / Referer 讓請求更接近正常瀏覽器行為。
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
FETCH_RETRIES = 3
FETCH_BACKOFF_SECONDS = 4  # 每次重試間隔翻倍：4s, 8s, 16s


def fetch_json(url: str, referer: str) -> list:
    """抓取 JSON，帶重試與可診斷的錯誤訊息（區分「被擋/回傳非 JSON」跟其他錯誤）。"""
    headers = {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Referer": referer,
    }
    last_error = None
    for attempt in range(1, FETCH_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.status
                body = resp.read()
        except urllib.error.HTTPError as e:
            status = e.code
            body = e.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_error = f"連線失敗（第 {attempt} 次）：{e}"
            print(last_error, file=sys.stderr)
            if attempt < FETCH_RETRIES:
                time.sleep(FETCH_BACKOFF_SECONDS * attempt)
            continue

        if status != 200:
            last_error = (
                f"{url} 回傳 HTTP {status}（第 {attempt} 次）"
                f"——可能是被擋（rate limit/WAF），前 200 字元：{body[:200]!r}"
            )
            print(last_error, file=sys.stderr)
            if attempt < FETCH_RETRIES:
                time.sleep(FETCH_BACKOFF_SECONDS * attempt)
            continue

        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as e:
            last_error = (
                f"{url} 回傳 HTTP 200 但不是合法 JSON（第 {attempt} 次）"
                f"——很可能是 WAF 的攔截頁面而非真資料，前 200 字元：{body[:200]!r}"
            )
            print(last_error, file=sys.stderr)
            if attempt < FETCH_RETRIES:
                time.sleep(FETCH_BACKOFF_SECONDS * attempt)
            continue

    raise RuntimeError(f"{url} 重試 {FETCH_RETRIES} 次後仍失敗：{last_error}")


def roc_date_to_iso(roc: str) -> str:
    # 民國年轉西元，例："1150924" -> "2026-09-24"
    roc = roc.strip()
    year = int(roc[:-4]) + 1911
    month = roc[-4:-2]
    day = roc[-2:]
    return f"{year}-{month}-{day}"


def to_float(value) -> float:
    if value is None:
        return float("nan")
    s = str(value).strip().replace(",", "")
    if s in ("", "--", "---", "N/A"):
        return float("nan")
    try:
        return float(s)
    except ValueError:
        return float("nan")


def fetch_twse_rows() -> list[dict]:
    data = fetch_json(TWSE_URL, referer="https://www.twse.com.tw/")
    rows = []
    for r in data:
        code = r.get("Code", "").strip()
        if not PLAIN_STOCK_CODE.match(code):
            continue
        close = to_float(r.get("ClosingPrice"))
        volume = to_float(r.get("TradeVolume"))
        if close != close or volume != volume:  # NaN check
            continue
        rows.append({
            "date": roc_date_to_iso(r["Date"]),
            "code": code,
            "name": r.get("Name", "").strip(),
            "market": "TWSE",
            "close": close,
            "volume": volume,
        })
    return rows


def fetch_tpex_rows() -> list[dict]:
    data = fetch_json(TPEX_URL, referer="https://www.tpex.org.tw/")
    rows = []
    for r in data:
        code = r.get("SecuritiesCompanyCode", "").strip()
        if not PLAIN_STOCK_CODE.match(code):
            continue
        close = to_float(r.get("Close"))
        volume = to_float(r.get("TradingShares"))
        if close != close or volume != volume:
            continue
        rows.append({
            "date": roc_date_to_iso(r["Date"]),
            "code": code,
            "name": r.get("CompanyName", "").strip(),
            "market": "TPEx",
            "close": close,
            "volume": volume,
        })
    return rows


def load_history() -> list[dict]:
    if not HISTORY_CSV.exists():
        return []
    with open(HISTORY_CSV, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = []
        for r in reader:
            r["close"] = to_float(r["close"])
            r["volume"] = to_float(r["volume"])
            rows.append(r)
        return rows


def save_history(rows: list[dict]) -> None:
    HISTORY_CSV.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: (r["code"], r["date"]))
    with open(HISTORY_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "code", "name", "market", "close", "volume"])
        writer.writeheader()
        writer.writerows(rows)


def load_companies() -> dict[str, dict]:
    if not COMPANIES_CSV.exists():
        return {}
    with open(COMPANIES_CSV, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return {row["代號"].strip(): row for row in reader if row.get("代號", "").strip()}


def load_flows() -> list[dict]:
    if not FLOWS_CSV.exists():
        return []
    with open(FLOWS_CSV, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def related_groups(group: str, flows: list[dict]) -> dict[str, list[str]]:
    upstream = [f["from_group"] for f in flows if f["to_group"] == group]
    downstream = [f["to_group"] for f in flows if f["from_group"] == group]
    return {"upstream": upstream, "downstream": downstream}


def compute_signals(
    by_code: dict[str, list[dict]],
    today_date: str,
    lookback: int,
    volume_multiplier: float,
    companies: dict[str, dict],
    flows: list[dict],
) -> tuple[list[dict], bool]:
    signals = []
    warmup = False
    for code, rows in by_code.items():
        if rows[-1]["date"] != today_date:
            continue  # 今天没有這檔的資料（新上市/資料缺漏），跳過
        if len(rows) < lookback + 1:
            warmup = True
            continue  # 歷史還不夠長，跳過（暖機期）

        prior = rows[-(lookback + 1):-1]
        today = rows[-1]
        prior_high = max(r["close"] for r in prior)
        prior_avg_vol = sum(r["volume"] for r in prior) / len(prior)

        is_breakout = today["close"] > prior_high
        is_volume_surge = prior_avg_vol > 0 and today["volume"] >= volume_multiplier * prior_avg_vol

        if is_breakout and is_volume_surge:
            info = companies.get(code)
            entry = {
                "code": code,
                "name": today["name"],
                "market": today["market"],
                "close": today["close"],
                "volume": today["volume"],
                "prior_high": round(prior_high, 2),
                "volume_multiple": round(today["volume"] / prior_avg_vol, 2),
                "in_supply_chain_map": info is not None,
            }
            if info:
                group = info["族群"]
                entry.update({
                    "industry": info["產業"],
                    "group": group,
                    "supply_chain_position": info["供應鏈位置"],
                    "related_groups": related_groups(group, flows),
                })
            signals.append(entry)

    signals.sort(key=lambda s: s["volume_multiple"], reverse=True)
    return signals, warmup


def main() -> int:
    try:
        today_rows = fetch_twse_rows() + fetch_tpex_rows()
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError) as e:
        print(f"抓取資料失敗，中止（不寫入任何檔案）：{e}", file=sys.stderr)
        return 1

    if not today_rows:
        print("抓到的資料是空的，中止", file=sys.stderr)
        return 1

    today_date = today_rows[0]["date"]
    history = load_history()
    already_have_today = any(r["date"] == today_date for r in history)

    if already_have_today:
        print(f"{today_date} 的資料已經在歷史裡了，跳過重複寫入，直接用現有歷史算訊號")
        combined = history
    else:
        combined = history + today_rows

    # 依股票分組，裁掉太舊的資料避免歷史檔無限成長
    by_code: dict[str, list[dict]] = defaultdict(list)
    for r in combined:
        by_code[r["code"]].append(r)
    trimmed = []
    for code, rows in by_code.items():
        rows.sort(key=lambda r: r["date"])
        trimmed.extend(rows[-HISTORY_KEEP_DAYS:])

    save_history(trimmed)

    companies = load_companies()
    flows = load_flows()

    sets_output = []
    for spec in SIGNAL_SETS:
        signals, warmup = compute_signals(
            by_code, today_date, spec["lookback"], spec["volume_multiplier"], companies, flows
        )
        sets_output.append({
            "key": spec["key"],
            "label": spec["label"],
            "params": {
                "breakout_lookback_days": spec["lookback"],
                "volume_multiplier": spec["volume_multiplier"],
            },
            "warmup": warmup,
            "signal_count": len(signals),
            "signals": signals,
        })
        print(f"[{spec['key']}] 篩出 {len(signals)} 檔訊號" + ("（部分股票仍在暖機期）" if warmup else ""))

    SIGNALS_JSON.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "scan_date": today_date,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sets": sets_output,
    }
    with open(SIGNALS_JSON, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"完成：{today_date}，共 {len(by_code)} 檔有資料")
    return 0


if __name__ == "__main__":
    sys.exit(main())
