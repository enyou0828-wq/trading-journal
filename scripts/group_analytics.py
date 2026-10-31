# -*- coding: utf-8 -*-
"""
族群分析：每日收盤掃描後執行，產出 signals/groups.json，給 App「族群」分頁用。

族群定義來自 supply-chain-map/data/companies.csv 的「族群」欄，備註裡「亦屬：X」的公司也算進族群 X。
族群指數 = 成員等權平均日報酬（單日報酬截在 ±10.5%，避免除權息、減資造成的假跳空）。
大盤基準 = 全市場一般股（4 碼、非 00 開頭）等權平均日報酬。

四個功能：
  heatmap ：每檔今日／5日／20日漲跌、近 5 日平均成交值
  rrg     ：相對輪動圖。RS = 族群指數 ÷ 大盤指數
            RS-Ratio = 100 × EMA5(RS ÷ SMA20(RS))；RS-Momentum = 100 × RS-Ratio ÷ 5 天前的 RS-Ratio
  baton   ：供應鏈「上下游」。flows.csv 每條 上游→下游 連線兩個方向都檢查：領漲端 5 日超額報酬 ≥ HOT_PCT
            且另一端 ≤ LAG_PCT 時觸發（dir=down 上游帶下游、dir=up 下游帶上游），
            回測落後端之後 FWD_DAYS 天的超額報酬（命中＝超額 > 0），並和落後端任意一天的基準比較
  tennis  ：網球 vs 雞蛋。近 20 日最高收盤 → 之後最低收盤 = 這次拉回；收復比例 =（現價 − 低點）÷（高點 − 低點）

只用標準函式庫，GitHub Actions 不用另外安裝套件。
"""
import csv
import json
import re
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HISTORY_CSV = REPO_ROOT / "data" / "price_history.csv"
COMPANIES_CSV = REPO_ROOT / "supply-chain-map" / "data" / "companies.csv"
FLOWS_CSV = REPO_ROOT / "supply-chain-map" / "data" / "flows.csv"
OUT_JSON = REPO_ROOT / "signals" / "groups.json"

PLAIN_STOCK_CODE = re.compile(r"^(?!00)\d{4}$")
DAILY_CLIP = 0.105
COMPLETE_DAY_FRACTION = 0.9   # 當天筆數 ≥ 中位數 × 0.9 才算完整交易日（上市或上櫃其中一邊還沒發布就跳過）

RRG_SMA = 20
RRG_EMA = 5
RRG_MOM = 5
RRG_TAIL = 10

HOT_PCT = 5.0      # 領漲端 5 日超額報酬門檻（%）
LAG_PCT = 1.0      # 落後端 5 日超額報酬上限（%）
FWD_DAYS = 10      # 觸發後觀察天數
COOLDOWN = 10      # 同一條路徑兩次觸發至少相隔幾天
RECENT_DAYS = 3    # 最近幾天內觸發算「目前觸發」

TENNIS_LOOKBACK = 20
MIN_PULLBACK_PCT = 3.0


def r2(x, n=2):
    return None if x is None else round(x, n)


# ---------------------------------------------------------------- 資料
def load_prices():
    by_code = defaultdict(dict)
    names = {}
    per_day = defaultdict(int)
    with open(HISTORY_CSV, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            code = r["code"].strip()
            if not PLAIN_STOCK_CODE.match(code):
                continue
            try:
                close = float(r["close"])
                vol = float(r["volume"] or 0)
            except ValueError:
                continue
            if close <= 0:
                continue
            by_code[code][r["date"]] = (close, vol)
            names[code] = r["name"]
            per_day[r["date"]] += 1
    med = statistics.median(per_day.values())
    dates = sorted(d for d, n in per_day.items() if n >= med * COMPLETE_DAY_FRACTION)
    return by_code, names, dates


def parse_also(note, group_names):
    m = re.search(r"亦屬[：:]\s*([^。]*)", note or "")
    if not m:
        return []
    seg = re.sub(r"（[^）]*）|\([^)]*\)", "", m.group(1))
    out = []
    for x in re.split(r"[；;、,]", seg):
        x = x.strip().split("/")[0].strip()
        if x in group_names:
            out.append(x)
    return out


def load_groups():
    with open(COMPANIES_CSV, encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f) if r.get("代號", "").strip()]
    group_names = {r["族群"] for r in rows}
    group_industry = {}
    members = defaultdict(list)       # 族群 -> [代號]
    companies = []
    sub_to_group = {}
    for r in rows:
        code, g = r["代號"].strip(), r["族群"]
        group_industry.setdefault(g, r["產業"])
        members[g].append(code)
        if r.get("子族群"):
            sub_to_group[r["子族群"]] = g
        also = parse_also(r.get("備註"), group_names)
        for a in also:
            if code not in members[a]:
                members[a].append(code)
        companies.append({"code": code, "name": r["公司"], "group": g, "industry": r["產業"],
                          "sub": r.get("子族群", ""), "also": also})
    return companies, dict(members), group_industry, sub_to_group


def load_flows(group_names, sub_to_group):
    def resolve(n):
        if n in group_names:
            return n
        return sub_to_group.get(n)
    edges = {}
    with open(FLOWS_CSV, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            a, b = resolve(r["from_group"]), resolve(r["to_group"])
            if a and b and a != b and (a, b) not in edges:
                edges[(a, b)] = r["item"]
    return edges


# ---------------------------------------------------------------- 序列
def daily_returns(by_code, dates):
    """每檔在完整交易日上的日報酬（前一個完整交易日也要有價才算）。"""
    rets = {}
    for code, px in by_code.items():
        s = [None] * len(dates)
        for i in range(1, len(dates)):
            a, b = px.get(dates[i - 1]), px.get(dates[i])
            if a and b:
                s[i] = max(-DAILY_CLIP, min(DAILY_CLIP, b[0] / a[0] - 1))
        rets[code] = s
    return rets


def ew_index(codes, rets, n):
    idx, level = [], 1.0
    for i in range(n):
        vals = [rets[c][i] for c in codes if c in rets and rets[c][i] is not None]
        if i > 0 and vals:
            level *= 1 + sum(vals) / len(vals)
        idx.append(level)
    return idx


def window_return(idx, i, k):
    return (idx[i] / idx[i - k] - 1) * 100 if i - k >= 0 else None


def ema(values, span):
    out, k, cur = [], 2 / (span + 1), None
    for v in values:
        if v is None:
            out.append(None)
            continue
        cur = v if cur is None else cur + k * (v - cur)
        out.append(cur)
    return out


# ---------------------------------------------------------------- 功能
def build_heatmap(companies, by_code, dates):
    last = len(dates) - 1
    out = []

    def chg(px, k):
        if last - k < 0:
            return None
        a, b = px.get(dates[last - k]), px.get(dates[last])
        return (b[0] / a[0] - 1) * 100 if a and b else None

    for c in companies:
        px = by_code.get(c["code"])
        if not px or dates[last] not in px:
            continue
        vals = [px[d][0] * px[d][1] for d in dates[-5:] if d in px]
        out.append({"code": c["code"], "name": c["name"], "group": c["group"], "industry": c["industry"],
                    "close": px[dates[last]][0], "c1": r2(chg(px, 1)), "c5": r2(chg(px, 5)),
                    "c20": r2(chg(px, 20)), "value": round(sum(vals) / len(vals)) if vals else 0})
    return out


def build_rrg(group_idx, mkt_idx, group_industry, dates):
    n = len(dates)
    out = []
    for g, idx in group_idx.items():
        rs = [idx[i] / mkt_idx[i] for i in range(n)]
        norm = [None] * n
        for i in range(RRG_SMA - 1, n):
            sma = sum(rs[i - RRG_SMA + 1:i + 1]) / RRG_SMA
            norm[i] = rs[i] / sma
        rsr = [None if v is None else 100 * v for v in ema(norm, RRG_EMA)]
        rsm = [None] * n
        for i in range(n):
            if i - RRG_MOM >= 0 and rsr[i] is not None and rsr[i - RRG_MOM] is not None:
                rsm[i] = 100 * rsr[i] / rsr[i - RRG_MOM]
        tail = [{"d": dates[i], "x": r2(rsr[i], 3), "y": r2(rsm[i], 3)}
                for i in range(max(0, n - RRG_TAIL), n) if rsr[i] is not None and rsm[i] is not None]
        if not tail:
            continue
        out.append({"group": g, "industry": group_industry.get(g, ""), "tail": tail,
                    "quadrant": quadrant(tail[-1]["x"], tail[-1]["y"]),
                    "entered": entered_days(tail)})
    return out


def quadrant(x, y):
    if x >= 100:
        return "領先" if y >= 100 else "轉弱"
    return "改善" if y >= 100 else "落後"


def entered_days(tail):
    """目前象限已經待了幾天（只看尾巴範圍內）。"""
    q = quadrant(tail[-1]["x"], tail[-1]["y"])
    k = 0
    for p in reversed(tail):
        if quadrant(p["x"], p["y"]) != q:
            break
        k += 1
    return k


def build_baton(edges, group_idx, mkt_idx, dates):
    n = len(dates)
    ex5 = {g: [None if window_return(idx, i, 5) is None else window_return(idx, i, 5) - window_return(mkt_idx, i, 5)
               for i in range(n)] for g, idx in group_idx.items()}

    def fwd_excess(g, i):
        if i + FWD_DAYS >= n:
            return None
        return ((group_idx[g][i + FWD_DAYS] / group_idx[g][i]) - (mkt_idx[i + FWD_DAYS] / mkt_idx[i])) * 100

    paths, all_events, base_all = [], [], []
    by_dir = {"down": ([], []), "up": ([], [])}
    pairs = [(u, d, item, "down") for (u, d), item in edges.items()] + \
            [(d, u, item, "up") for (u, d), item in edges.items()]
    for a, b, item, direction in pairs:  # a＝領漲端，b＝落後端
        if a not in ex5 or b not in ex5:
            continue
        base = [fwd_excess(b, i) for i in range(5, n)]
        base = [v for v in base if v is not None]
        events, last_trig, prev = [], -10**9, False
        for i in range(5, n):
            ea, eb = ex5[a][i], ex5[b][i]
            trig = ea is not None and eb is not None and ea >= HOT_PCT and eb <= LAG_PCT
            if trig and not prev and i - last_trig >= COOLDOWN:
                events.append({"i": i, "d": dates[i], "a5": r2(ea), "b5": r2(eb), "fwd": r2(fwd_excess(b, i))})
                last_trig = i
            prev = trig
        done = [e["fwd"] for e in events if e["fwd"] is not None]
        recent = [e for e in events if e["i"] >= n - RECENT_DAYS]
        cur = recent[-1] if recent else None
        since = None
        if cur:
            since = r2(((group_idx[b][-1] / group_idx[b][cur["i"]]) - (mkt_idx[-1] / mkt_idx[cur["i"]])) * 100)
        paths.append({
            "from": a, "to": b, "item": item, "dir": direction,
            "a5": r2(ex5[a][-1]), "b5": r2(ex5[b][-1]),
            "n": len(done), "hit": r2(sum(v > 0 for v in done) / len(done) * 100, 1) if done else None,
            "avg": r2(sum(done) / len(done)) if done else None,
            "baseHit": r2(sum(v > 0 for v in base) / len(base) * 100, 1) if base else None,
            "baseAvg": r2(sum(base) / len(base)) if base else None,
            "active": cur["d"] if cur else None, "since": since,
            "events": [{k: e[k] for k in ("d", "a5", "b5", "fwd")} for e in events],
        })
        all_events += done
        base_all += base
        by_dir[direction][0].extend(done)
        by_dir[direction][1].extend(base)
    def stat(ev, base):
        return {
            "events": len(ev),
            "hit": r2(sum(v > 0 for v in ev) / len(ev) * 100, 1) if ev else None,
            "avg": r2(sum(ev) / len(ev)) if ev else None,
            "baseHit": r2(sum(v > 0 for v in base) / len(base) * 100, 1) if base else None,
            "baseAvg": r2(sum(base) / len(base)) if base else None,
        }
    summary = {**stat(all_events, base_all), "hotPct": HOT_PCT, "lagPct": LAG_PCT, "fwdDays": FWD_DAYS,
               "byDir": {k: stat(*v) for k, v in by_dir.items()}}
    return {"summary": summary, "paths": paths}


def build_tennis(companies, by_code, dates):
    out = []
    win = dates[-TENNIS_LOOKBACK:]
    for c in companies:
        px = by_code.get(c["code"])
        if not px or dates[-1] not in px:
            continue
        closes = [(d, px[d][0]) for d in win if d in px]
        if len(closes) < TENNIS_LOOKBACK * 0.8:
            continue
        hi_i = max(range(len(closes)), key=lambda k: closes[k][1])
        hi = closes[hi_i][1]
        lo_i = min(range(hi_i, len(closes)), key=lambda k: closes[k][1])
        lo = closes[lo_i][1]
        now = closes[-1][1]
        last5 = [v for _, v in closes[-5:]]
        ma5 = sum(last5) / len(last5)
        pull = (lo / hi - 1) * 100
        if now >= hi:
            state = "新高"
        elif now > ma5:
            state = "站上5日線"
        else:
            state = "5日線下"
        rec = 1.0 if hi == lo else (now - lo) / (hi - lo)
        # 低點之後第一次收盤站上 5 日線花了幾天
        reclaim = None
        for k in range(lo_i + 1, len(closes)):
            seg = [v for _, v in closes[max(0, k - 4):k + 1]]
            if closes[k][1] > sum(seg) / len(seg):
                reclaim = k - lo_i
                break
        out.append({"code": c["code"], "name": c["name"], "group": c["group"], "also": c["also"],
                    "pull": r2(pull), "rec": r2(rec * 100, 1), "daysLow": len(closes) - 1 - lo_i,
                    "reclaim": reclaim, "state": state, "pulled": pull <= -MIN_PULLBACK_PCT,
                    "fromHigh": r2((now / hi - 1) * 100)})
    return out


def main():
    by_code, _names, dates = load_prices()
    companies, members, group_industry, sub_to_group = load_groups()
    rets = daily_returns(by_code, dates)
    n = len(dates)
    mkt_idx = ew_index(list(rets.keys()), rets, n)
    group_idx = {}
    for g, codes in members.items():
        if any(c in rets for c in codes):
            group_idx[g] = ew_index(codes, rets, n)
    edges = load_flows(set(members), sub_to_group)

    groups = []
    for g, idx in group_idx.items():
        groups.append({"group": g, "industry": group_industry.get(g, ""), "members": members[g],
                       "c1": r2(window_return(idx, n - 1, 1)), "c5": r2(window_return(idx, n - 1, 5)),
                       "c20": r2(window_return(idx, n - 1, 20))})
    out = {
        "asOf": dates[-1],
        "days": n,
        "generatedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "market": {"c1": r2(window_return(mkt_idx, n - 1, 1)), "c5": r2(window_return(mkt_idx, n - 1, 5)),
                   "c20": r2(window_return(mkt_idx, n - 1, 20))},
        "groups": groups,
        "heatmap": build_heatmap(companies, by_code, dates),
        "rrg": build_rrg(group_idx, mkt_idx, group_industry, dates),
        "baton": build_baton(edges, group_idx, mkt_idx, dates),
        "tennis": build_tennis(companies, by_code, dates),
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"groups.json：{dates[-1]}，{n} 個交易日，{len(groups)} 個族群，{len(out['heatmap'])} 檔，"
          f"{len(out['baton']['paths'])} 條傳導路徑，{OUT_JSON.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
