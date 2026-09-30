#!/usr/bin/env python3
"""
每日盤後訊號掃描：抓 TWSE / TPEx 全市場日收盤資料，累積到本地歷史，
同時用多組「創 N 日新高 + 爆量」條件（見 SIGNAL_SETS）各自獨立篩出
突破訊號。族群欄位同時標出兩層：data/industries.csv 的官方產業別
（涵蓋幾乎全部股票，見 scripts/build_industries.py）＋
supply-chain-map/companies.csv 手動查證過的細分族群（僅涵蓋部分股票，
命中時會再往下顯示這一層）。

另外用 companies.csv 現成的細分族群（光通訊、被動元件、PCB…）偵測「族群同步噴出」：
同一族群裡今天有多檔股票同時大漲，判定該族群今天在輪動（見 compute_group_rotation）。

執行後更新：
  - data/price_history.csv   累積的每日收盤/成交量歷史（自動裁到最近 max(lookback)*3 天）
  - signals/latest.json      當天每組條件各自篩出的訊號（"sets" 陣列）＋族群輪動結果（"group_rotation"）

要加/改篩選條件組合，直接改 SIGNAL_SETS 這個 list；族群輪動的門檻改
GROUP_ROTATION_THRESHOLD_PCT / GROUP_ROTATION_MIN_FRACTION / GROUP_ROTATION_MIN_STOCKS。
"""
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

TAIPEI_TZ = timezone(timedelta(hours=8))

REPO_ROOT = Path(__file__).resolve().parent.parent
HISTORY_CSV = REPO_ROOT / "data" / "price_history.csv"
SIGNALS_JSON = REPO_ROOT / "signals" / "latest.json"
COMPANIES_CSV = REPO_ROOT / "supply-chain-map" / "data" / "companies.csv"
INDUSTRIES_CSV = REPO_ROOT / "data" / "industries.csv"

TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"

# 同時算多組篩選條件，各自獨立產出訊號清單。之後要加/改組合，直接改這個 list。
SIGNAL_SETS = [
    {
        "key": "fast", "label": "短線（5日新高＋量增1.5倍＋當日漲幅5%以上）", "type": "breakout_volume",
        "lookback": 5, "volume_multiplier": 1.5, "min_daily_change_pct": 5.0,
    },
    {"key": "streak", "label": "連續2天創5日新高", "type": "consecutive_high", "lookback": 5, "consecutive_days": 2},
]
HISTORY_KEEP_DAYS = max(s["lookback"] for s in SIGNAL_SETS) * 3  # 歷史檔只保留這麼多天，避免無限膨脹

# 這些官方產業別優先顯示（置頂），同一組內其餘排序邏輯不變
PRIORITY_INDUSTRIES = {
    "半導體業", "電腦及週邊設備業", "光電業", "通信網路業",
    "電子零組件業", "電子通路業", "資訊服務業", "其他電子業",
}

# 族群同步噴出：用 companies.csv 現成的細分族群（不額外合併），一個族群裡同一天漲幅達到
# GROUP_ROTATION_THRESHOLD_PCT 的家數，超過該族群總家數的 GROUP_ROTATION_MIN_FRACTION（1/3）
# 就判定這個族群今天在輪動。額外要求至少 2 檔（「同步」本來就該是多檔一起動，只有 1 家的
# 族群不該用比例算出「1 家也算輪動」）。這些數字是起始猜測值，之後可以再調整。
GROUP_ROTATION_THRESHOLD_PCT = 5.0
GROUP_ROTATION_MIN_FRACTION = 1 / 3
GROUP_ROTATION_MIN_STOCKS = 2


def priority_sort_key(entry: dict, secondary: float) -> tuple:
    return (entry["industry"] not in PRIORITY_INDUSTRIES, -secondary)

PLAIN_STOCK_CODE = re.compile(r"^(?!00)\d{4}$")  # 只留 4 碼數字股票，濾掉 00 開頭的 ETF 與帶字母的權證等

# 模擬真實瀏覽器的標頭：純 UA 字串在部分反爬蟲/WAF 規則下會被視為可疑，
# 補齊 Accept / Accept-Language / Referer 讓請求更接近正常瀏覽器行為。
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
FETCH_RETRIES = 3
FETCH_BACKOFF_SECONDS = 4  # 每次重試間隔翻倍：4s, 8s, 16s
MAX_STALE_DAYS = 6  # 抓到的最新交易日若比今天舊超過這麼多天，視為異常（見 main() 的防呆檢查）


def fetch_json(url: str, referer: str) -> list:
    """抓取 JSON，帶重試與可診斷的錯誤訊息（區分「被擋/回傳非 JSON」跟其他錯誤）。

    每次都在網址加上帶時間戳的查詢參數破壞快取：GitHub Actions 的執行環境（Azure IP）
    曾經連續好幾天抓到同一份舊資料，即使原始伺服器標頭是 no-store/no-cache，也可能是
    中間某層（CDN、代理）用網址當快取 key，沒理會標頭——加隨機參數讓每次都是不同網址，
    繞過這種以網址為主的快取。
    """
    headers = {
        "User-Agent": BROWSER_USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Referer": referer,
    }
    last_error = None
    for attempt in range(1, FETCH_RETRIES + 1):
        separator = "&" if "?" in url else "?"
        cache_busted_url = f"{url}{separator}_={int(time.time() * 1000)}_{attempt}"
        try:
            req = urllib.request.Request(cache_busted_url, headers=headers)
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


def load_industries() -> dict[str, dict]:
    if not INDUSTRIES_CSV.exists():
        return {}
    with open(INDUSTRIES_CSV, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return {row["code"].strip(): row for row in reader if row.get("code", "").strip()}


def build_entry(
    code: str, name: str, daily_change_pct, volume_multiple, volume, companies: dict, industries: dict
) -> dict:
    official = industries.get(code)
    curated = companies.get(code)
    return {
        "code": code,
        "name": name,
        "daily_change_pct": round(daily_change_pct, 2) if daily_change_pct is not None else None,
        "volume_multiple": round(volume_multiple, 2) if volume_multiple is not None else None,
        "volume": round(volume) if volume is not None else None,  # 當日成交股數
        "industry": official["industry"] if official else None,
        "sub_group": curated["族群"] if curated else None,
    }


def daily_change_pct(rows: list[dict]) -> float | None:
    """今天收盤相對昨天收盤的漲跌幅（%）。rows 需已按日期排序。"""
    if len(rows) < 2:
        return None
    prev_close = rows[-2]["close"]
    if not prev_close:
        return None
    return (rows[-1]["close"] / prev_close - 1) * 100


def compute_signals(
    by_code: dict[str, list[dict]],
    today_date: str,
    lookback: int,
    volume_multiplier: float,
    companies: dict[str, dict],
    industries: dict[str, dict],
    min_daily_change_pct: float | None = None,
) -> tuple[list[dict], bool]:
    """今天創 N 日新高，且量增達到過去均量的指定倍數（可選：當日漲幅也要達標）。"""
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
        change = daily_change_pct(rows)
        is_strong_enough = min_daily_change_pct is None or (change is not None and change >= min_daily_change_pct)

        if is_breakout and is_volume_surge and is_strong_enough:
            signals.append(build_entry(
                code, today["name"], change, today["volume"] / prior_avg_vol, today["volume"], companies, industries
            ))

    signals.sort(key=lambda s: priority_sort_key(s, s["volume_multiple"]))
    return signals, warmup


def compute_consecutive_high_signals(
    by_code: dict[str, list[dict]],
    today_date: str,
    lookback: int,
    consecutive_days: int,
    companies: dict[str, dict],
    industries: dict[str, dict],
) -> tuple[list[dict], bool]:
    """連續 consecutive_days 天，每一天收盤都各自創下當天的 N 日新高（不看量）。"""
    signals = []
    warmup = False
    needed = lookback + consecutive_days
    for code, rows in by_code.items():
        if rows[-1]["date"] != today_date:
            continue
        if len(rows) < needed:
            warmup = True
            continue

        window = rows[-needed:]
        all_new_high = True
        for offset in range(consecutive_days):
            day = window[lookback + offset]
            preceding = window[offset:offset + lookback]
            if day["close"] <= max(r["close"] for r in preceding):
                all_new_high = False
                break

        if all_new_high:
            today = rows[-1]
            signals.append(build_entry(
                code, today["name"], daily_change_pct(rows), None, today["volume"], companies, industries
            ))

    signals.sort(key=lambda s: priority_sort_key(s, s["daily_change_pct"] or 0))
    return signals, warmup


def compute_group_rotation(
    by_code: dict[str, list[dict]],
    today_date: str,
    companies: dict[str, dict],
    threshold_pct: float = GROUP_ROTATION_THRESHOLD_PCT,
    min_fraction: float = GROUP_ROTATION_MIN_FRACTION,
    min_stocks: int = GROUP_ROTATION_MIN_STOCKS,
) -> list[dict]:
    """companies.csv 現成的細分族群裡，今天漲幅達 threshold_pct 的家數超過該族群總家數的
    min_fraction（且至少 min_stocks 檔），判定該族群今天在輪動。"""
    codes_by_group: dict[str, list[str]] = defaultdict(list)
    for code, info in companies.items():
        group = info.get("族群")
        if group:
            codes_by_group[group].append(code)

    results = []
    for group, codes in codes_by_group.items():
        triggered = []
        for code in codes:
            rows = by_code.get(code)
            if not rows or rows[-1]["date"] != today_date:
                continue
            change = daily_change_pct(rows)
            if change is not None and change >= threshold_pct:
                triggered.append({"code": code, "name": rows[-1]["name"], "daily_change_pct": round(change, 2)})

        if len(triggered) > len(codes) * min_fraction and len(triggered) >= min_stocks:
            triggered.sort(key=lambda s: s["daily_change_pct"], reverse=True)
            results.append({
                "group": group,
                "total_in_group": len(codes),
                "triggered_count": len(triggered),
                "stocks": triggered,
            })

    results.sort(key=lambda r: r["triggered_count"], reverse=True)
    return results


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

    # 防呆：如果抓回來的「最新交易日」離今天太多天，很可能是抓到舊快取資料（不是真的長假），
    # 之前發生過連續好幾天都抓到同一份舊資料、腳本卻回報成功的狀況——與其靜默略過讓人幾天後
    # 才發現，寧可讓這次執行直接失敗（GitHub Actions 會顯示紅色叉叉），逼自己去查。
    fetched = datetime.strptime(today_date, "%Y-%m-%d").date()
    stale_days = (datetime.now(TAIPEI_TZ).date() - fetched).days
    if stale_days > MAX_STALE_DAYS:
        print(
            f"抓到的最新交易日是 {today_date}，距離今天已經 {stale_days} 天"
            f"（門檻 {MAX_STALE_DAYS} 天），懷疑抓到舊的快取資料，中止（不寫入任何檔案）",
            file=sys.stderr,
        )
        return 1

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
    industries = load_industries()

    sets_output = []
    for spec in SIGNAL_SETS:
        set_type = spec.get("type", "breakout_volume")
        if set_type == "breakout_volume":
            signals, warmup = compute_signals(
                by_code, today_date, spec["lookback"], spec["volume_multiplier"], companies, industries,
                min_daily_change_pct=spec.get("min_daily_change_pct"),
            )
            params = {"breakout_lookback_days": spec["lookback"], "volume_multiplier": spec["volume_multiplier"]}
            if spec.get("min_daily_change_pct") is not None:
                params["min_daily_change_pct"] = spec["min_daily_change_pct"]
        elif set_type == "consecutive_high":
            signals, warmup = compute_consecutive_high_signals(
                by_code, today_date, spec["lookback"], spec["consecutive_days"], companies, industries
            )
            params = {"lookback_days": spec["lookback"], "consecutive_days": spec["consecutive_days"]}
        else:
            raise ValueError(f"未知的 signal set type：{set_type}")

        sets_output.append({
            "key": spec["key"],
            "label": spec["label"],
            "params": params,
            "warmup": warmup,
            "signal_count": len(signals),
            "signals": signals,
        })
        print(f"[{spec['key']}] 篩出 {len(signals)} 檔訊號" + ("（部分股票仍在暖機期）" if warmup else ""))

    rotating_groups = compute_group_rotation(by_code, today_date, companies)
    print(f"[group_rotation] {len(rotating_groups)} 個族群同步噴出")

    SIGNALS_JSON.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "scan_date": today_date,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sets": sets_output,
        "group_rotation": {
            "params": {
                "threshold_pct": GROUP_ROTATION_THRESHOLD_PCT,
                "min_fraction": GROUP_ROTATION_MIN_FRACTION,
                "min_stocks": GROUP_ROTATION_MIN_STOCKS,
            },
            "groups": rotating_groups,
        },
    }
    with open(SIGNALS_JSON, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"完成：{today_date}，共 {len(by_code)} 檔有資料")
    return 0


if __name__ == "__main__":
    sys.exit(main())
