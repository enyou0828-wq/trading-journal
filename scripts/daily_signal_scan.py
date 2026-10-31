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

準確性原則（2026-10-02 重寫）：寧可少顯示，也不要顯示失真的資料。具體處理兩種
過去會被靜默吃掉的情況：
  1. TWSE 跟 TPEx 公告的「最新交易日」可能不同步（其中一邊還沒發布完）——不再用單一
     today_date 去判斷「今天」，而是用兩個市場各自實際抓到的日期分開處理；不同步時
     signals.json 會把兩個日期都標出來，而不是假裝兩邊資料是同一天。
  2. 個股資料中間有缺（停牌/臨時抓取失敗/新上市前的空白）會讓「過去 N 日」的視窗悄悄
     位移，算出的新高/漲跌幅其實涵蓋了比預期更長的區間——現在會拿「所有股票實際出現過的
     交易日」建出一份交易日曆，驗證視窗內日期跟日曆完全連續對應，兜不起來就跳過這檔
     （當作資料不足，不勉強算出一個可能失真的訊號）。

執行後更新：
  - data/price_history.csv   累積的每日收盤/成交量歷史（自動裁到最近 max(lookback)*3 天）
  - signals/latest.json      當天每組條件各自篩出的訊號（"sets" 陣列）＋族群輪動結果（"group_rotation"）

要加/改篩選條件組合，直接改 SIGNAL_SETS 這個 list；族群輪動的門檻改
GROUP_ROTATION_THRESHOLD_PCT / GROUP_ROTATION_MIN_FRACTION / GROUP_ROTATION_MIN_STOCKS。
"""
import csv
import http.client
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
        "key": "fast", "label": "創20日新高＋量增2倍＋當日漲幅5%以上", "type": "breakout_volume",
        "lookback": 20, "volume_multiplier": 2.0, "min_daily_change_pct": 5.0,
    },
    {
        "key": "streak", "label": "近3日收盤站上5日扣抵值＋近3日平均率3%以上", "type": "deduction_uptrend",
        "lookback": 8, "consecutive_days": 3, "deduct_days": 5, "avg_slope_days": 3, "min_avg_slope_pct": 3.0,
    },
    {
        # "lookback" 這裡只用來撐大下面的 HISTORY_KEEP_DAYS（跟 streak 那組一樣是佔位用途，
        # compute_vcp_breakout_signals 實際需要的天數門檻寫在函式自己的預設參數裡）。
        # 這個策略要看 120 日高點＋整理期前 60 日的漲幅，需要比其他兩組更長的歷史，
        # 50*3=150 天，比函式內部最低需求（約131天）多留一點緩衝。
        "key": "vcp", "label": "量縮整理突破(VCP)", "type": "vcp_breakout",
        "lookback": 50,
    },
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
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as e:
            # http.client.HTTPException 涵蓋 IncompleteRead 這類「連線建立成功、
            # 但資料傳輸到一半就斷掉」的狀況——實際發生過一次：Content-Length 說有
            # 4.6MB，結果只收到 45 萬 bytes 就斷線。這種跟逾時/連不上是同一類暫時性
            # 網路問題，所以跟它們一起重試，而不是讓整支腳本直接噴例外中止。
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


# 當天資料來源：證交所／櫃買中心網站的「每日收盤行情」查詢（指定日期，收盤後約 14:30–15:00 就有）。
# OpenAPI（TWSE_URL／TPEX_URL）的上市資料常常要到隔天上午才更新，只當備援：當天查不到時
# 用它補上最近一個交易日，也順便補回前一天萬一漏掉的資料。
TWSE_DAY_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={date}&type=ALLBUT0999&response=json"
TPEX_DAY_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date={date}&type=EW&response=json"  # 成交股數含零股，與 OpenAPI 一致


def _row(iso, code, name, market, close, volume, o, h, l):
    if not PLAIN_STOCK_CODE.match(code) or close != close or volume != volume:
        return None
    return {"date": iso, "code": code, "name": name, "market": market, "close": close, "volume": volume,
            "open": o, "high": h, "low": l}


def fetch_twse_day(iso: str) -> list[dict]:
    data = fetch_json(TWSE_DAY_URL.format(date=iso.replace("-", "")), referer="https://www.twse.com.tw/")
    if not isinstance(data, dict) or data.get("stat") != "OK" or data.get("date") != iso.replace("-", ""):
        return []
    table = next((t for t in data.get("tables", []) if t.get("fields") and "證券代號" in t["fields"]), None)
    if not table:
        return []
    f = [x.strip() for x in table["fields"]]
    ic, iv, io, ih, il, ip = (f.index(k) for k in ("證券名稱", "成交股數", "開盤價", "最高價", "最低價", "收盤價"))
    rows = [_row(iso, r[0].strip(), r[ic].strip(), "TWSE", to_float(r[ip]), to_float(r[iv]),
                 to_float(r[io]), to_float(r[ih]), to_float(r[il])) for r in table.get("data", [])]
    return [r for r in rows if r]


def fetch_tpex_day(iso: str) -> list[dict]:
    data = fetch_json(TPEX_DAY_URL.format(date=iso.replace("-", "%2F")), referer="https://www.tpex.org.tw/")
    if not isinstance(data, dict) or str(data.get("date")) != iso.replace("-", ""):
        return []
    tables = data.get("tables") or []
    if not tables or not tables[0].get("data"):
        return []
    f = [x.strip() for x in tables[0].get("fields", [])]
    ic, ip, io, ih, il, iv = (f.index(k) for k in ("名稱", "收盤", "開盤", "最高", "最低", "成交股數"))
    rows = [_row(iso, r[0].strip(), r[ic].strip(), "TPEx", to_float(r[ip]), to_float(r[iv]),
                 to_float(r[io]), to_float(r[ih]), to_float(r[il])) for r in tables[0]["data"]]
    return [r for r in rows if r]


def fetch_twse_openapi() -> list[dict]:
    data = fetch_json(TWSE_URL, referer="https://www.twse.com.tw/")
    rows = [_row(roc_date_to_iso(r["Date"]), r.get("Code", "").strip(), r.get("Name", "").strip(), "TWSE",
                 to_float(r.get("ClosingPrice")), to_float(r.get("TradeVolume")), to_float(r.get("OpeningPrice")),
                 to_float(r.get("HighestPrice")), to_float(r.get("LowestPrice"))) for r in data]
    return [r for r in rows if r]


def fetch_tpex_openapi() -> list[dict]:
    data = fetch_json(TPEX_URL, referer="https://www.tpex.org.tw/")
    rows = [_row(roc_date_to_iso(r["Date"]), r.get("SecuritiesCompanyCode", "").strip(),
                 r.get("CompanyName", "").strip(), "TPEx", to_float(r.get("Close")), to_float(r.get("TradingShares")),
                 to_float(r.get("Open")), to_float(r.get("High")), to_float(r.get("Low"))) for r in data]
    return [r for r in rows if r]


def _fetch_market(day_fn, openapi_fn, label: str) -> list[dict]:
    """先查今天（台北時間）的當日行情；再用 OpenAPI 補最近一個交易日。兩邊重疊時以當日行情為準。"""
    today = datetime.now(TAIPEI_TZ).strftime("%Y-%m-%d")
    day_rows = []
    try:
        day_rows = day_fn(today)
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError, KeyError, ValueError) as e:
        print(f"{label} 當日行情查詢失敗，改用 OpenAPI：{e}", file=sys.stderr)
    try:
        api_rows = openapi_fn()
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError) as e:
        if not day_rows:
            raise
        print(f"{label} OpenAPI 失敗，只用當日行情：{e}", file=sys.stderr)
        api_rows = []
    seen = {(r["code"], r["date"]) for r in day_rows}
    rows = day_rows + [r for r in api_rows if (r["code"], r["date"]) not in seen]
    print(f"{label}：當日行情 {len(day_rows)} 檔（{today}），OpenAPI {len(api_rows)} 檔")
    return rows


def fetch_twse_rows() -> list[dict]:
    return _fetch_market(fetch_twse_day, fetch_twse_openapi, "TWSE")


def fetch_tpex_rows() -> list[dict]:
    return _fetch_market(fetch_tpex_day, fetch_tpex_openapi, "TPEx")


OHLC_FIELDS = ("open", "high", "low")


def load_history() -> list[dict]:
    if not HISTORY_CSV.exists():
        return []
    with open(HISTORY_CSV, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = []
        for r in reader:
            r["close"] = to_float(r["close"])
            r["volume"] = to_float(r["volume"])
            for k in OHLC_FIELDS:  # 2026-10-31 起才有開高低，舊資料是空字串 → NaN
                r[k] = to_float(r.get(k))
            rows.append(r)
        return rows


def save_history(rows: list[dict]) -> None:
    HISTORY_CSV.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: (r["code"], r["date"]))
    def clean(r):
        out = dict(r)
        for k in OHLC_FIELDS:
            v = out.get(k)
            out[k] = "" if v is None or v != v else v
        return out
    with open(HISTORY_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "code", "name", "market", "close", "volume", *OHLC_FIELDS], extrasaction="ignore")
        writer.writeheader()
        writer.writerows(clean(r) for r in rows)


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


def build_trading_calendar(by_code: dict[str, list[dict]]) -> tuple[list[str], dict[str, int]]:
    """用『所有股票實際出現過的交易日』的聯集建出一份交易日曆，用來驗證任何一檔股票的
    連續 N 天視窗有沒有被停牌/漏抓資料悄悄挖掉其中幾天。回傳 (排序後的日期列表, 日期->索引)。
    """
    dates = set()
    for rows in by_code.values():
        for r in rows:
            dates.add(r["date"])
    calendar = sorted(dates)
    return calendar, {d: i for i, d in enumerate(calendar)}


def calendar_window_dates(calendar: list[str], date_index: dict[str, int], end_date: str, length: int):
    """回傳以 end_date 結尾、往前數 length 個交易日（依交易日曆）的日期列表；
    end_date 不在日曆裡、或日曆長度不夠，回傳 None。"""
    idx = date_index.get(end_date)
    if idx is None or idx - length + 1 < 0:
        return None
    return calendar[idx - length + 1: idx + 1]


def rows_match_calendar(rows_window: list[dict], expected_dates) -> bool:
    return expected_dates is not None and [r["date"] for r in rows_window] == expected_dates


def calendar_change_pct(rows: list[dict], calendar: list[str], date_index: dict[str, int], days_back: int = 1):
    """今天收盤相對『日曆上回溯 days_back 個交易日』收盤的漲跌幅（%）。

    刻意不用 rows[-(days_back+1)]（陣列上的前幾筆）直接當作「回溯 N 天」——如果這檔股票
    中間有停牌或漏抓資料，陣列上的前幾筆實際上可能是好幾天前的收盤，拿來算漲跌幅會嚴重
    失真（例如停牌恢復交易，一比較就是個假的巨幅漲跌）。改成明確比對交易日曆，兜不起來
    就回傳 None（顯示「–」），比顯示一個算錯的數字更符合「必須真實」。
    """
    if len(rows) < days_back + 1:
        return None
    today = rows[-1]
    window = rows[-(days_back + 1):]
    expected = calendar_window_dates(calendar, date_index, today["date"], days_back + 1)
    if not rows_match_calendar(window, expected):
        return None
    start_close = window[0]["close"]
    if not start_close:
        return None
    return (today["close"] / start_close - 1) * 100


def daily_change_pct(rows: list[dict], calendar: list[str], date_index: dict[str, int]):
    return calendar_change_pct(rows, calendar, date_index, days_back=1)


def build_entry(
    code: str, name: str, close, daily_change_pct_value, volume_multiple, volume, companies: dict, industries: dict
) -> dict:
    official = industries.get(code)
    curated = companies.get(code)
    return {
        "code": code,
        "name": name,
        "close": round(close, 2) if close is not None else None,
        "daily_change_pct": round(daily_change_pct_value, 2) if daily_change_pct_value is not None else None,
        "volume_multiple": round(volume_multiple, 2) if volume_multiple is not None else None,
        "volume": round(volume) if volume is not None else None,  # 當日成交股數
        "industry": official["industry"] if official else None,
        "sub_group": curated["族群"] if curated else None,
    }


def compute_signals(
    by_code: dict[str, list[dict]],
    expected_date_by_market: dict[str, str],
    calendar: list[str],
    date_index: dict[str, int],
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
        expected_today = expected_date_by_market.get(rows[-1]["market"])
        if expected_today is None or rows[-1]["date"] != expected_today:
            continue  # 這檔所屬的市場今天沒有新資料，或這檔本身今天沒更新，跳過
        if len(rows) < lookback + 1:
            warmup = True
            continue  # 歷史還不夠長，跳過（暖機期）

        window_dates = calendar_window_dates(calendar, date_index, rows[-1]["date"], lookback + 1)
        window_rows = rows[-(lookback + 1):]
        if not rows_match_calendar(window_rows, window_dates):
            continue  # 這段期間內有缺資料（停牌/漏抓），視窗其實位移了，寧可跳過不算

        prior = window_rows[:-1]
        today = window_rows[-1]
        prior_high = max(r["close"] for r in prior)
        prior_avg_vol = sum(r["volume"] for r in prior) / len(prior)

        is_breakout = today["close"] > prior_high
        is_volume_surge = prior_avg_vol > 0 and today["volume"] >= volume_multiplier * prior_avg_vol
        change = daily_change_pct(rows, calendar, date_index)
        is_strong_enough = min_daily_change_pct is None or (change is not None and change >= min_daily_change_pct)

        if is_breakout and is_volume_surge and is_strong_enough:
            signals.append(build_entry(
                code, today["name"], today["close"], change, today["volume"] / prior_avg_vol, today["volume"],
                companies, industries
            ))

    signals.sort(key=lambda s: priority_sort_key(s, s["volume_multiple"]))
    return signals, warmup


def compute_consecutive_high_signals(
    by_code: dict[str, list[dict]],
    expected_date_by_market: dict[str, str],
    calendar: list[str],
    date_index: dict[str, int],
    lookback: int,
    consecutive_days: int,
    companies: dict[str, dict],
    industries: dict[str, dict],
    avg_slope_days: int | None = None,
    min_avg_slope_pct: float | None = None,
) -> tuple[list[dict], bool]:
    """連續 consecutive_days 天，每一天收盤都各自創下當天的 N 日新高（不看量）。

    可選再加一個力道門檻：近 avg_slope_days 天的「平均斜率」（最近 N 天總漲幅 ÷ N，
    不是逐日漲幅的平均）要達到 min_avg_slope_pct 以上，用來濾掉那種「技術上連兩天
    創新高，但其實是緩慢爬升、沒什麼動能」的訊號。
    """
    signals = []
    warmup = False
    needed = lookback + consecutive_days
    for code, rows in by_code.items():
        expected_today = expected_date_by_market.get(rows[-1]["market"])
        if expected_today is None or rows[-1]["date"] != expected_today:
            continue
        if len(rows) < needed:
            warmup = True
            continue

        window_dates = calendar_window_dates(calendar, date_index, rows[-1]["date"], needed)
        window = rows[-needed:]
        if not rows_match_calendar(window, window_dates):
            continue  # 這段期間內有缺資料，視窗位移了，跳過不算

        all_new_high = True
        for offset in range(consecutive_days):
            day = window[lookback + offset]
            preceding = window[offset:offset + lookback]
            if day["close"] <= max(r["close"] for r in preceding):
                all_new_high = False
                break

        if not all_new_high:
            continue

        avg_slope = None
        if min_avg_slope_pct is not None:
            total_change = calendar_change_pct(rows, calendar, date_index, days_back=avg_slope_days)
            avg_slope = total_change / avg_slope_days if total_change is not None else None
            if avg_slope is None or avg_slope < min_avg_slope_pct:
                continue  # 近 N 日平均斜率不到門檻（或中間有缺資料算不出來），跳過不算

        today = rows[-1]
        signals.append(build_entry(
            code, today["name"], today["close"], daily_change_pct(rows, calendar, date_index), None,
            today["volume"], companies, industries
        ))

    signals.sort(key=lambda s: priority_sort_key(s, s["daily_change_pct"] or 0))
    return signals, warmup


def compute_deduction_uptrend_signals(
    by_code: dict[str, list[dict]],
    expected_date_by_market: dict[str, str],
    calendar: list[str],
    date_index: dict[str, int],
    consecutive_days: int,
    deduct_days: int,
    companies: dict[str, dict],
    industries: dict[str, dict],
    avg_slope_days: int | None = None,
    min_avg_slope_pct: float | None = None,
) -> tuple[list[dict], bool]:
    """近 consecutive_days 天，每一天收盤都要「站上扣抵值」：今天收盤 > deduct_days 個
    交易日前的收盤。扣抵值是技術分析常講的詞——deduct_days 日均線往前走一天，窗口裡最舊
    的那筆收盤價就會被「扣除」；今天收盤只要大於那筆即將被扣掉的舊收盤，均線明天還會
    延續上揚（反之今天收盤 < 扣抵值，代表均線明天會轉折向下，即使今天價格是漲的）。
    連續 consecutive_days 天都站上各自對應的扣抵值，代表這條均線至少已經上揚好幾天。

    可選再加平均斜率門檻，算法跟 compute_consecutive_high_signals 的 avg_slope 完全一樣
    （近 N 日總漲幅 ÷ N，不是逐日漲幅的平均），濾掉技術上站上扣抵值、但漲勢很弱的訊號。
    """
    signals = []
    warmup = False
    needed = consecutive_days + deduct_days
    for code, rows in by_code.items():
        expected_today = expected_date_by_market.get(rows[-1]["market"])
        if expected_today is None or rows[-1]["date"] != expected_today:
            continue
        if len(rows) < needed:
            warmup = True
            continue

        window_dates = calendar_window_dates(calendar, date_index, rows[-1]["date"], needed)
        window = rows[-needed:]
        if not rows_match_calendar(window, window_dates):
            continue  # 這段期間內有缺資料，視窗位移了，跳過不算

        all_above_deduction = True
        for offset in range(consecutive_days):
            idx = deduct_days + offset
            if window[idx]["close"] <= window[idx - deduct_days]["close"]:
                all_above_deduction = False
                break

        if not all_above_deduction:
            continue

        avg_slope = None
        if min_avg_slope_pct is not None:
            total_change = calendar_change_pct(rows, calendar, date_index, days_back=avg_slope_days)
            avg_slope = total_change / avg_slope_days if total_change is not None else None
            if avg_slope is None or avg_slope < min_avg_slope_pct:
                continue  # 近 N 日平均斜率不到門檻（或中間有缺資料算不出來），跳過不算

        today = rows[-1]
        signals.append(build_entry(
            code, today["name"], today["close"], daily_change_pct(rows, calendar, date_index), None,
            today["volume"], companies, industries
        ))

    signals.sort(key=lambda s: priority_sort_key(s, s["daily_change_pct"] or 0))
    return signals, warmup


def find_zigzag_swings(closes: list[float], min_pct: float) -> list[tuple[int, float, str]]:
    """在收盤價序列上找交替的波段高低點（zigzag）：價格從目前極值反轉超過 min_pct，
    才確認上一個極值是一次真正的轉折（濾掉單日雜訊），回傳依時間順序排列的
    (在序列中的索引, 價格, 'peak' 或 'trough') 列表。

    最後一筆是「目前還在追蹤、尚未被反向確認」的極值——VCP 偵測刻意需要這個，因為
    最後一次收縮的低點，常常就是還沒出現反轉就被突破帶量拉上去的那個低點。
    """
    if len(closes) < 2:
        return []
    swings = []
    extreme_idx, extreme_val = 0, closes[0]
    direction = None  # None／'up'：目前在追蹤一個可能的波段高點；'down'：在追蹤一個可能的波段低點
    for i in range(1, len(closes)):
        price = closes[i]
        if direction != "down":
            if price >= extreme_val:
                extreme_idx, extreme_val = i, price
                direction = "up"
            else:
                drop_pct = (extreme_val - price) / extreme_val * 100
                if drop_pct >= min_pct:
                    swings.append((extreme_idx, extreme_val, "peak"))
                    direction = "down"
                    extreme_idx, extreme_val = i, price
            continue
        if price <= extreme_val:
            extreme_idx, extreme_val = i, price
        else:
            rise_pct = (price - extreme_val) / extreme_val * 100
            if rise_pct >= min_pct:
                swings.append((extreme_idx, extreme_val, "trough"))
                direction = "up"
                extreme_idx, extreme_val = i, price
    swings.append((extreme_idx, extreme_val, "trough" if direction == "down" else "peak"))
    return swings


def extract_down_legs(swings: list[tuple[int, float, str]]) -> list[dict]:
    """從 zigzag 的波段高低點裡，依時間順序取出每一段「高點→低點」的下跌段（收縮）。"""
    legs = []
    for (idx1, val1, kind1), (idx2, val2, kind2) in zip(swings, swings[1:]):
        if kind1 == "peak" and kind2 == "trough" and val1 > 0:
            legs.append({
                "peak_idx": idx1, "peak_val": val1,
                "trough_idx": idx2, "trough_val": val2,
                "pct": (val1 - val2) / val1 * 100,
            })
    return legs


def compute_vcp_breakout_signals(
    by_code: dict[str, list[dict]],
    expected_date_by_market: dict[str, str],
    calendar: list[str],
    date_index: dict[str, int],
    companies: dict[str, dict],
    industries: dict[str, dict],
    ma_short: int = 20,
    ma_long: int = 60,
    ma_long_slope_days: int = 10,
    high_lookback: int = 120,
    near_high_max_pct: float = 15.0,
    prior_rally_lookback: int = 60,
    prior_rally_min_pct: float = 25.0,
    consolidation_min_days: int = 10,
    consolidation_max_days: int = 25,
    min_contractions: int = 2,
    contraction_shrink_ratio: float = 0.6,
    first_contraction_max_pct: float = 25.0,
    last_contraction_max_pct: float = 7.0,
    volume_dryup_ratio: float = 0.7,
    baseline_volume_days: int = 20,
    breakout_volume_multiplier: float = 1.5,
    zigzag_min_pct: float = 2.0,
) -> tuple[list[dict], bool]:
    """VCP（量縮整理突破）訊號——使用者策略：趨勢向上＋前段漲幅≥25%＋整理期10~25天內
    至少2次一次比一次小的收縮（第一次≤25%、最後一次≤7%，每次≤前一次60%）＋最後一次
    收縮量縮到20日均量70%以下，然後帶量(≥1.5倍)突破最後一次收縮的高點。

    這份資料來源只有每日收盤價＋成交量，沒有日內最高/最低價，所以「收縮幅度」改用
    zigzag（find_zigzag_swings）在收盤價序列上找交替高低點來近似，不是用真正的日內高低點
    算的回檔幅度——跟真正的 K 線圖看起來的回檔會有些落差,但方向與大小關係是一致的。
    zigzag_min_pct（預設2%）故意設得比「最後一次收縮上限7%」小很多，這樣才抓得到真正
    很小的最後一次收縮,不會被雜訊濾掉。

    「貼近120日高點」「前段漲幅」「整理期收縮」都只用「突破前一天」(pre，不含今天)的
    資料判斷,不會用到突破當天的漲幅去墊高這些本來該是突破前就成立的條件。「收盤>20日線
    >60日線、60日線上揚」則用含今天收盤的均線去比（跟看盤軟體上的均線一樣，EOD後本來
    就含當天）——這組屬於進場當下該成立的條件，不是突破前就該成立的條件，20日均線期間
    短，整理期才10~25天時很容易被不含今天的算法在最後一天算出「收盤還在均線下方」。
    「60日線上揚」用 10 個交易日前的 60日均線來比,不是每天比前一天——用意是濾掉單日
    雜訊造成的假上揚/假下彎。「前段漲幅近60個交易日」解讀成整理期開始之前緊接著的60個
    交易日(不含整理期本身),因為使用者的策略敘述是「先前段漲幅、再整理」的順序。
    """
    signals = []
    warmup = False
    min_pre_len = max(
        high_lookback,
        prior_rally_lookback + consolidation_max_days,
        ma_long + ma_long_slope_days,
    ) + 10

    for code, rows in by_code.items():
        expected_today = expected_date_by_market.get(rows[-1]["market"])
        if expected_today is None or rows[-1]["date"] != expected_today:
            continue
        if len(rows) < min_pre_len + 1:
            warmup = True
            continue

        today = rows[-1]
        pre = rows[:-1]
        closes_pre = [r["close"] for r in pre]
        volumes_pre = [r["volume"] for r in pre]

        # 趨勢：收盤>20日線>60日線，60日線比10個交易日前還高（上揚）。
        # 20日線/60日線用「含今天」的收盤序列算（跟一般看盤軟體上的均線一樣，EOD 收盤後
        # 均線本來就會納入當天）；但「離120日高點15%以內」刻意只看突破前一天的收盤，
        # 不讓今天的噴出漲幅去墊高這個應該在突破前就成立的條件。
        closes_all = closes_pre + [today["close"]]
        ma20 = sum(closes_all[-ma_short:]) / ma_short
        ma60 = sum(closes_all[-ma_long:]) / ma_long
        ma60_prior = sum(closes_all[-(ma_long + ma_long_slope_days):-ma_long_slope_days]) / ma_long
        if not (today["close"] > ma20 > ma60 and ma60 > ma60_prior):
            continue
        close_pre = closes_pre[-1]
        high120 = max(closes_pre[-high_lookback:])
        if high120 <= 0 or (high120 - close_pre) / high120 * 100 > near_high_max_pct:
            continue

        # 整理期：由長(25天)往短(10天)試窗格去找 zigzag——視窗比真正的整理期長也沒關係
        # （前面多出來的那段漸漲通常不會被 zigzag 判定出額外的收縮），但找到收縮序列後，
        # 真正的整理期天數要用第一次收縮的高點(legs[0]["peak_idx"])往後算，不能直接拿視窗
        # 長度當整理期天數，否則視窗裡夾帶的前段漲幅尾段會被誤算成整理期的一部分，連帶讓
        # 「整理期開始之前的60個交易日漲幅」那段窗口往前錯位、少算到漲幅。
        base = None
        for length in range(consolidation_max_days, consolidation_min_days - 1, -1):
            window = pre[-length:]
            swings = find_zigzag_swings([r["close"] for r in window], zigzag_min_pct)
            legs = extract_down_legs(swings)
            if len(legs) < min_contractions:
                continue
            if legs[0]["pct"] > first_contraction_max_pct:
                continue
            if legs[-1]["pct"] > last_contraction_max_pct:
                continue
            if not all(legs[k]["pct"] <= legs[k - 1]["pct"] * contraction_shrink_ratio for k in range(1, len(legs))):
                continue
            base_span = length - legs[0]["peak_idx"]
            if not (consolidation_min_days <= base_span <= consolidation_max_days):
                continue
            base = (base_span, window, legs)
            break
        if base is None:
            continue
        base_span, window, legs = base
        last_leg = legs[-1]
        breakout_level = last_leg["peak_val"]

        # 前段漲幅：整理期開始之前緊接著的60個交易日內，低點到低點之後的高點至少+25%
        rally_closes = [r["close"] for r in pre[-(base_span + prior_rally_lookback):-base_span]]
        if len(rally_closes) < 2:
            continue
        rally_low_idx = min(range(len(rally_closes)), key=lambda i: rally_closes[i])
        rally_low = rally_closes[rally_low_idx]
        rally_high_after_low = max(rally_closes[rally_low_idx:])
        if rally_low <= 0 or (rally_high_after_low - rally_low) / rally_low * 100 < prior_rally_min_pct:
            continue

        # 量縮：最後一次收縮(高點→低點)期間的平均成交量 ≤ 20日均量 * 70%
        baseline_vol = sum(volumes_pre[-baseline_volume_days:]) / baseline_volume_days
        if baseline_vol <= 0:
            continue
        leg_vol_rows = window[last_leg["peak_idx"]: last_leg["trough_idx"] + 1]
        if not leg_vol_rows:
            continue
        leg_avg_vol = sum(r["volume"] for r in leg_vol_rows) / len(leg_vol_rows)
        if leg_avg_vol > baseline_vol * volume_dryup_ratio:
            continue

        # 進場：今天收盤突破最後一次收縮的高點，且今天成交量達20日均量的1.5倍以上。
        # 「昨天收盤還沒突破」這個條件是必要的——否則突破後只要股價一直撐在那個高點之上，
        # 之後任何一天只要成交量又放大（即使是下跌的那種爆量，例如出貨），都會被誤判成
        # 又一次「突破當天」，變成同一次突破被重複觸發好幾天。
        if not (close_pre <= breakout_level < today["close"] and today["volume"] >= breakout_volume_multiplier * baseline_vol):
            continue

        change = daily_change_pct(rows, calendar, date_index)
        entry = build_entry(
            code, today["name"], today["close"], change, today["volume"] / baseline_vol, today["volume"],
            companies, industries,
        )
        entry["consolidation_days"] = base_span
        entry["contraction_count"] = len(legs)
        entry["breakout_level"] = round(breakout_level, 2)
        entry["last_contraction_low"] = round(last_leg["trough_val"], 2)
        signals.append(entry)

    signals.sort(key=lambda s: priority_sort_key(s, s["volume_multiple"] or 0))
    return signals, warmup


def compute_group_rotation(
    by_code: dict[str, list[dict]],
    expected_date_by_market: dict[str, str],
    calendar: list[str],
    date_index: dict[str, int],
    companies: dict[str, dict],
    threshold_pct: float = GROUP_ROTATION_THRESHOLD_PCT,
    min_fraction: float = GROUP_ROTATION_MIN_FRACTION,
    min_stocks: int = GROUP_ROTATION_MIN_STOCKS,
) -> list[dict]:
    """companies.csv 現成的細分族群裡，今天漲幅達 threshold_pct 的家數超過該族群總家數的
    min_fraction（且至少 min_stocks 檔），判定該族群今天在輪動。

    分母（total_in_group）只算「今天這個市場確實有新資料」的家數，不是 companies.csv
    裡整個族群的掛牌家數——如果族群裡有股票今天剛好沒資料（例如所屬市場還沒發布），
    用整個掛牌家數當分母會讓比例失真（分母偏大，看起來比實際更不像輪動；或反過來
    分子分母都用到不同天的資料，比例本身就沒意義）。只用「今天真的能判斷的家數」。
    """
    codes_by_group: dict[str, list[str]] = defaultdict(list)
    for code, info in companies.items():
        group = info.get("族群")
        if group:
            codes_by_group[group].append(code)

    results = []
    for group, codes in codes_by_group.items():
        reportable = []  # 今天確實有新資料可以判斷的股票
        triggered = []
        for code in codes:
            rows = by_code.get(code)
            if not rows:
                continue
            expected_today = expected_date_by_market.get(rows[-1]["market"])
            if expected_today is None or rows[-1]["date"] != expected_today:
                continue
            reportable.append(code)
            change = daily_change_pct(rows, calendar, date_index)
            if change is not None and change >= threshold_pct:
                triggered.append({"code": code, "name": rows[-1]["name"], "daily_change_pct": round(change, 2)})

        if len(reportable) >= min_stocks and len(triggered) > len(reportable) * min_fraction and len(triggered) >= min_stocks:
            triggered.sort(key=lambda s: s["daily_change_pct"], reverse=True)
            results.append({
                "group": group,
                "total_in_group": len(reportable),
                "triggered_count": len(triggered),
                "stocks": triggered,
            })

    results.sort(key=lambda r: r["triggered_count"], reverse=True)
    return results


def main() -> int:
    try:
        twse_rows = fetch_twse_rows()
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError) as e:
        print(f"抓 TWSE（上市）資料失敗，中止（不寫入任何檔案）：{e}", file=sys.stderr)
        return 1

    try:
        tpex_rows = fetch_tpex_rows()
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError) as e:
        print(f"抓 TPEx（上櫃）資料失敗，中止（不寫入任何檔案）：{e}", file=sys.stderr)
        return 1

    # 兩個市場正常是同一天一起開市、一起休市，不會只有一邊完全沒資料；
    # 如果真的發生，比較可能是抓取異常（例如某一邊被擋下只回空陣列），而不是真的市場狀況，
    # 寧可整次中止，也不要用「只有一半市場」的資料假裝是完整的一天。
    if not twse_rows or not tpex_rows:
        print(
            f"其中一個市場抓到空資料（TWSE {len(twse_rows)} 檔／TPEx {len(tpex_rows)} 檔）"
            f"——兩個市場應該同時有／沒有資料，這種落差比較像抓取異常，中止（不寫入任何檔案）",
            file=sys.stderr,
        )
        return 1

    twse_date = max(r["date"] for r in twse_rows)
    tpex_date = max(r["date"] for r in tpex_rows)

    # 防呆：如果抓回來的「最新交易日」離今天太多天，很可能是抓到舊快取資料（不是真的長假），
    # 之前發生過連續好幾天都抓到同一份舊資料、腳本卻回報成功的狀況——與其靜默略過讓人幾天後
    # 才發現，寧可讓這次執行直接失敗（GitHub Actions 會顯示紅色叉叉），逼自己去查。
    # 兩個市場分開檢查：允許其中一邊比另一邊晚發布個一兩天（正常的發布時間差），但只要
    # 任何一邊落後太多天，就當作異常中止。
    today_local = datetime.now(TAIPEI_TZ).date()
    twse_stale_days = (today_local - datetime.strptime(twse_date, "%Y-%m-%d").date()).days
    tpex_stale_days = (today_local - datetime.strptime(tpex_date, "%Y-%m-%d").date()).days
    if twse_stale_days > MAX_STALE_DAYS or tpex_stale_days > MAX_STALE_DAYS:
        print(
            f"資料太舊：TWSE 最新 {twse_date}（距今 {twse_stale_days} 天）、"
            f"TPEx 最新 {tpex_date}（距今 {tpex_stale_days} 天），門檻 {MAX_STALE_DAYS} 天，"
            f"懷疑抓到舊的快取資料，中止（不寫入任何檔案）",
            file=sys.stderr,
        )
        return 1

    markets_in_sync = twse_date == tpex_date
    scan_date = max(twse_date, tpex_date)
    if not markets_in_sync:
        print(
            f"兩個市場資料日期不同步：TWSE 最新 {twse_date}，TPEx 最新 {tpex_date}"
            f"——這次訊號會各自用自己市場的最新日期計算，不會假裝兩邊是同一天",
            file=sys.stderr,
        )

    history = load_history()
    # 用 (code, date) 判斷哪些是真的新資料，而不是用單一「今天日期」整批判斷——
    # 這樣就算兩個市場其中一邊這次才補上（例如備援排程追上了白天漏掉的那個市場），
    # 也能正確併入，不會因為另一個市場「今天」已經有資料就整批跳過。
    existing_keys = {(r["code"], r["date"]) for r in history}
    new_rows = [r for r in (twse_rows + tpex_rows) if (r["code"], r["date"]) not in existing_keys]
    if not new_rows:
        print(f"TWSE {twse_date}／TPEx {tpex_date} 的資料都已經在歷史裡了，跳過重複寫入，直接用現有歷史算訊號")
    combined = history + new_rows

    # 依股票分組，裁掉太舊的資料避免歷史檔無限成長
    by_code: dict[str, list[dict]] = defaultdict(list)
    for r in combined:
        by_code[r["code"]].append(r)
    trimmed = []
    for code, rows in by_code.items():
        rows.sort(key=lambda r: r["date"])
        trimmed.extend(rows[-HISTORY_KEEP_DAYS:])

    save_history(trimmed)

    # 重新用裁切後的資料分組（跟存檔內容一致），並建出交易日曆供缺資料檢查用
    by_code = defaultdict(list)
    for r in trimmed:
        by_code[r["code"]].append(r)
    for rows in by_code.values():
        rows.sort(key=lambda r: r["date"])
    calendar, date_index = build_trading_calendar(by_code)

    expected_date_by_market = {"TWSE": twse_date, "TPEx": tpex_date}

    companies = load_companies()
    industries = load_industries()

    sets_output = []
    for spec in SIGNAL_SETS:
        set_type = spec.get("type", "breakout_volume")
        if set_type == "breakout_volume":
            signals, warmup = compute_signals(
                by_code, expected_date_by_market, calendar, date_index,
                spec["lookback"], spec["volume_multiplier"], companies, industries,
                min_daily_change_pct=spec.get("min_daily_change_pct"),
            )
            params = {"breakout_lookback_days": spec["lookback"], "volume_multiplier": spec["volume_multiplier"]}
            if spec.get("min_daily_change_pct") is not None:
                params["min_daily_change_pct"] = spec["min_daily_change_pct"]
        elif set_type == "consecutive_high":
            signals, warmup = compute_consecutive_high_signals(
                by_code, expected_date_by_market, calendar, date_index,
                spec["lookback"], spec["consecutive_days"], companies, industries,
                avg_slope_days=spec.get("avg_slope_days"), min_avg_slope_pct=spec.get("min_avg_slope_pct"),
            )
            params = {"lookback_days": spec["lookback"], "consecutive_days": spec["consecutive_days"]}
            if spec.get("min_avg_slope_pct") is not None:
                params["avg_slope_days"] = spec["avg_slope_days"]
                params["min_avg_slope_pct"] = spec["min_avg_slope_pct"]
        elif set_type == "deduction_uptrend":
            signals, warmup = compute_deduction_uptrend_signals(
                by_code, expected_date_by_market, calendar, date_index,
                spec["consecutive_days"], spec["deduct_days"], companies, industries,
                avg_slope_days=spec.get("avg_slope_days"), min_avg_slope_pct=spec.get("min_avg_slope_pct"),
            )
            params = {"consecutive_days": spec["consecutive_days"], "deduct_days": spec["deduct_days"]}
            if spec.get("min_avg_slope_pct") is not None:
                params["avg_slope_days"] = spec["avg_slope_days"]
                params["min_avg_slope_pct"] = spec["min_avg_slope_pct"]
        elif set_type == "vcp_breakout":
            signals, warmup = compute_vcp_breakout_signals(by_code, expected_date_by_market, calendar, date_index, companies, industries)
            params = {
                "consolidation_days": "10-25", "min_contractions": 2, "contraction_shrink_ratio": 0.6,
                "first_contraction_max_pct": 25.0, "last_contraction_max_pct": 7.0,
                "volume_dryup_ratio": 0.7, "breakout_volume_multiplier": 1.5,
                "prior_rally_min_pct": 25.0, "near_120d_high_max_pct": 15.0,
            }
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

    rotating_groups = compute_group_rotation(by_code, expected_date_by_market, calendar, date_index, companies)
    print(f"[group_rotation] {len(rotating_groups)} 個族群同步噴出")

    SIGNALS_JSON.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "scan_date": scan_date,
        "twse_date": twse_date,
        "tpex_date": tpex_date,
        "markets_in_sync": markets_in_sync,
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

    print(f"完成：TWSE {twse_date}／TPEx {tpex_date}，共 {len(by_code)} 檔有資料")
    return 0


if __name__ == "__main__":
    sys.exit(main())
