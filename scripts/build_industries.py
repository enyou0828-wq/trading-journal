#!/usr/bin/env python3
"""
一次性／偶爾手動重跑的工具：從證交所 ISIN 對照表抓「全部上市＋上櫃股票」的
官方產業別分類（紡織纖維、鋼鐵工業、半導體業…共 32 類），寫成 data/industries.csv。

這份資料幾乎不會變動（只有新股上市/下市才會變），不需要每天排程重抓，
跟每天都要更新的 price_history.csv 是不同性質的資料，所以獨立成這支工具，
手動需要更新時再跑一次就好。

用法：
  python3 scripts/build_industries.py
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from daily_signal_scan import PLAIN_STOCK_CODE, fetch_json  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_CSV = REPO_ROOT / "data" / "industries.csv"

# strMode=2 上市、strMode=4 上櫃。回傳的是 Big5 編碼的 HTML 表格，不是 JSON。
ISIN_URL = "https://isin.twse.com.tw/isin/C_public.jsp?strMode={mode}"
MIN_ROWS_EXPECTED = {"上市": 800, "上櫃": 700}  # 防呆：解析結果異常少就中止，不要用壞資料覆蓋

ROW_RE = re.compile(
    r"<tr[^>]*><td[^>]*>([^<]*)</td><td[^>]*>([^<]*)</td><td[^>]*>([^<]*)</td>"
    r"<td[^>]*>([^<]*)</td><td[^>]*>([^<]*)</td>"
)


def fetch_isin_table(mode: str, market_label: str) -> list[dict]:
    import urllib.request

    req = urllib.request.Request(
        ISIN_URL.format(mode=mode),
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://isin.twse.com.tw/"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    html = raw.decode("big5", errors="replace")

    rows = []
    for m in ROW_RE.finditer(html):
        code_name, _isin, _listed_date, market, industry = (g.strip() for g in m.groups())
        if market != market_label or not industry:
            continue
        parts = code_name.split("　", 1)  # 全形空白分隔「代號　名稱」
        if len(parts) != 2:
            continue
        code, name = parts[0].strip(), parts[1].strip()
        if not PLAIN_STOCK_CODE.match(code):
            continue
        rows.append({"code": code, "name": name, "industry": industry, "market": market_label})

    if len(rows) < MIN_ROWS_EXPECTED[market_label]:
        raise RuntimeError(
            f"{market_label} 只解析到 {len(rows)} 筆，遠低於預期的 {MIN_ROWS_EXPECTED[market_label]} 筆，"
            "很可能是網頁結構變了，中止、不覆蓋現有檔案"
        )
    return rows


def main() -> int:
    try:
        listed = fetch_isin_table("2", "上市")
        otc = fetch_isin_table("4", "上櫃")
    except (RuntimeError, OSError) as e:
        print(f"抓取失敗，中止（不寫入檔案）：{e}", file=sys.stderr)
        return 1

    all_rows = listed + otc
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w", encoding="utf-8", newline="") as f:
        import csv
        writer = csv.DictWriter(f, fieldnames=["code", "name", "industry", "market"])
        writer.writeheader()
        writer.writerows(sorted(all_rows, key=lambda r: r["code"]))

    print(f"完成：上市 {len(listed)} 檔、上櫃 {len(otc)} 檔，共 {len(all_rows)} 檔寫入 {OUT_CSV}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
