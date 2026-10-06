#!/usr/bin/env python3
"""
每個交易日更新 data/otc_index.json：呼叫 TPEx OpenAPI 補上當天的櫃買指數收盤，
給交易日誌「報酬累計曲線」跟「各月份資金加權報酬」這兩個圖表當對照基準用
（app.js 的 ensureOtcData() 在頁面載入時 fetch 這份 JSON）。

這支腳本本身是 idempotent：同一天的資料已經存在且數值相同就不會造成變更，
.github/workflows/daily-otc-update.yml 裡的 commit 步驟會因為沒有 diff 而跳過。

TPEx 這個 openapi 端點（/v1/tpex_index）目前的行為是「只回傳當天這一筆」，
不像以前那樣能一次拿到整段歷史，所以採逐日累積、每天呼叫一次補一筆的設計；
遇到非交易日（週末、國定假日）通常會拿到空陣列，直接跳過、不是錯誤。
"""
import http.client
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "otc_index.json"

TPEX_INDEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_index"

BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
FETCH_RETRIES = 3
FETCH_BACKOFF_SECONDS = 4  # 每次重試間隔翻倍：4s, 8s, 16s


def fetch_json(url: str, referer: str) -> list:
    """抓取 JSON，帶重試與可診斷的錯誤訊息（跟 daily_signal_scan.py 的 fetch_json 同款邏輯）。

    每次都在網址加上帶時間戳的查詢參數破壞快取，避免 GitHub Actions 執行環境
    連續好幾天抓到同一份舊資料。
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
            last_error = f"連線失敗（第 {attempt} 次）：{e}"
            print(last_error, file=sys.stderr)
            if attempt < FETCH_RETRIES:
                time.sleep(FETCH_BACKOFF_SECONDS * attempt)
            continue

        if status != 200:
            last_error = f"{url} 回傳 HTTP {status}（第 {attempt} 次），前 200 字元：{body[:200]!r}"
            print(last_error, file=sys.stderr)
            if attempt < FETCH_RETRIES:
                time.sleep(FETCH_BACKOFF_SECONDS * attempt)
            continue

        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as e:
            last_error = f"{url} 回傳 HTTP 200 但不是合法 JSON（第 {attempt} 次）：{body[:200]!r}"
            print(last_error, file=sys.stderr)
            if attempt < FETCH_RETRIES:
                time.sleep(FETCH_BACKOFF_SECONDS * attempt)
            continue

    raise RuntimeError(f"{url} 重試 {FETCH_RETRIES} 次後仍失敗：{last_error}")


def parse_index_date(raw: str) -> str:
    """轉成 YYYY-MM-DD。這個端點目前回傳西元 8 碼（20261001），
    但保留民國 7 碼（1151001）的容錯，以防之後格式變動。"""
    raw = raw.strip()
    if len(raw) == 8:
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    if len(raw) == 7:
        year = int(raw[:-4]) + 1911
        return f"{year}-{raw[-4:-2]}-{raw[-2:]}"
    raise ValueError(f"無法辨識的日期格式：{raw!r}")


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
    rows = fetch_json(TPEX_INDEX_URL, referer="https://www.tpex.org.tw/")
    if not rows:
        print("今天沒有資料（可能是非交易日），略過。")
        return 0

    # 這個端點原本的行為是「只回傳當天這一筆」，但後來觀察到它改成一次回傳最近幾個
    # 交易日（依日期由舊到新排列）——如果還是像以前只取 rows[0]，抓到的會是這批資料裡
    # 最舊的一筆，日期永遠卡在同一天，不會往前進（這個 bug 實際發生過：連續好幾天
    # 都回報「2026-10-01 已經是最新」，但當時其實已經是 10/6）。改成把回傳的每一筆都
    # 當作可能的新資料處理，不管端點這次回傳一筆還是好幾筆都能正確更新到最新。
    data = load_existing()
    changed = []
    for row in rows:
        date = parse_index_date(row["Date"])
        close = float(str(row["Close"]).replace(",", ""))
        existing = data.get(date)
        if existing is not None and abs(existing - close) < 1e-9:
            continue
        data[date] = close
        changed.append((date, close, existing))

    if not changed:
        print(f"抓到的 {len(rows)} 筆資料都已經是最新的，沒有變更。")
        return 0

    save(data)
    for date, close, existing in changed:
        verb = "更新" if existing is not None else "新增"
        print(f"{verb} {date}: {close}" + (f"（原本是 {existing}）" if existing is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
