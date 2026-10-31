#!/usr/bin/env python3
"""
平行宇宙：從 9/1 起，假設每天完全照規則機械執行，資金曲線會長怎樣。

規則（2026-10-25 版交易計畫）：
- 訊號：A 盤整突破＝收盤創 20 日新高＋量 ≥ 20 日均量 2 倍＋漲幅 ≥ 5%；
        B 動能延續＝近 3 天收盤都站上 5 日扣抵值＋近 3 日平均漲幅 ≥ 3%（同 daily_signal_scan.py）。
- 訊號隔天開盤進場，一單位＝當下淨值 15%，每檔一單位（簡化：不加碼）。
- 同時持有上限依加權指數水位：跌破月線 30%（2 檔）、站回月線 50%（3 檔）、10 日線 70%（4 檔）、
  5 日線以上 100%（6 檔）；水位下降時收盤先賣報酬最差的。候選排序：A 先於 B，A 依量倍數、B 依 3 日漲幅。
- 出場：盤中跌到成本 −7% 緊急停損；收盤跌破 max(進場日低, 成本 −5%)；漲過 1R 後停損不低於成本；
  收盤跌破前一日低點；連續兩天沒創 5 日新高；單日落後對應指數 5%（上市比加權、上櫃比櫃買）。
- 交易成本來回 0.45%。

輸出 signals/parallel.json（給訊號頁畫圖）與 signals/recent_ohlc.json（最近 7 個交易日高低收，
給盤前作戰卡檢查庫存出場規則）。
"""
import csv
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HISTORY_CSV = ROOT / "data" / "price_history.csv"
OUT = ROOT / "signals" / "parallel.json"
OUT_RECENT = ROOT / "signals" / "recent_ohlc.json"
START = "2026-09-01"
UNIT = 0.15
COST = 0.0045
LEVEL_SLOTS = {"30%": 2, "50%": 3, "70%": 4, "100%": 6, "槓桿": 6}
NAN = float("nan")


def f(v):
    try:
        return float(v) if v not in ("", None) else NAN
    except ValueError:
        return NAN


def load():
    rows = defaultdict(dict)
    names, markets, counts = {}, {}, defaultdict(int)
    with open(HISTORY_CSV, encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh):
            d, c = r["date"], r["code"]
            rows[c][d] = (f(r.get("open")), f(r.get("high")), f(r.get("low")), f(r["close"]), f(r["volume"]))
            names[c], markets[c] = r["name"], r["market"]
            counts[d] += 1
    med = statistics.median(counts.values())
    cal = sorted(d for d, n in counts.items() if n >= med * 0.9)
    data = {}
    for c, byd in rows.items():
        arr = [byd.get(d, (NAN,) * 5) for d in cal]
        data[c] = [list(x) for x in zip(*arr)]  # O, H, L, C, V
    return cal, data, names, markets


def load_index(name):
    p = ROOT / "data" / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def index_level(closes):
    """closes：到當天為止的指數收盤（按日期排序）。"""
    if len(closes) < 20:
        return "100%"
    c = closes[-1]
    ma = lambda k: sum(closes[-k:]) / k
    if c < ma(20):
        return "30%"
    if c < ma(10):
        return "50%"
    if c < ma(5):
        return "70%"
    return "槓桿" if c >= max(closes) else "100%"


def ok(*xs):
    return all(x == x for x in xs)


def signals_on(t, data):
    out = []
    for c, (O, H, L, C, V) in data.items():
        if t < 21 or not ok(C[t], C[t - 1], V[t]):
            continue
        prior_c, prior_v = C[t - 20:t], V[t - 20:t]
        if ok(*prior_c, *prior_v):
            avg_v = sum(prior_v) / 20
            chg = (C[t] / C[t - 1] - 1) * 100
            if C[t] > max(prior_c) and avg_v > 0 and V[t] >= 2 * avg_v and chg >= 5:
                out.append((0, -V[t] / avg_v, c, "A"))
                continue
        w = C[t - 7:t + 1]
        if ok(*w) and all(C[t - k] > C[t - k - 5] for k in range(3)):
            slope = (C[t] / C[t - 3] - 1) * 100 / 3
            if slope >= 3:
                out.append((1, -slope, c, "B"))
    out.sort()
    return out


def main():
    cal, data, names, markets = load()
    twi, otc = load_index("twi_index.json"), load_index("otc_index.json")
    twi_dates = sorted(twi)

    def idx_chg(market, i):
        src = twi if market == "TWSE" else otc
        a, b = src.get(cal[i - 1]), src.get(cal[i])
        return (b / a - 1) * 100 if a and b else None

    def level_at(i):
        closes = [twi[d] for d in twi_dates if d <= cal[i]]
        return index_level(closes)

    s0 = next(i for i, d in enumerate(cal) if d >= START)
    cash, positions, trades, curve = 1.0, [], [], []
    pending = []  # 前一天收盤產生、今天開盤要進場的候選

    for i in range(s0, len(cal)):
        # ---- 開盤進場 ----
        equity_prev = cash + sum(p["shares"] * p["last"] for p in positions)
        slots = LEVEL_SLOTS[level_at(i - 1)] - len(positions)
        held = {p["code"] for p in positions}
        for _, _, code, setup in pending:
            if slots <= 0:
                break
            O, H, L, C, V = data[code]
            if code in held or not ok(O[i], L[i], C[i]) or O[i] <= 0:
                continue
            amt = min(UNIT * equity_prev, cash)
            if amt <= 0:
                break
            cash -= amt
            positions.append({"code": code, "setup": setup, "entry": O[i], "i0": i, "d0": cal[i], "shares": amt / O[i],
                              "stop0": None, "R": None, "be": False, "nnh": 0, "last": O[i]})
            held.add(code)
            slots -= 1

        # ---- 收盤出場 ----
        still = []
        for p in positions:
            O, H, L, C, V = data[p["code"]]
            e = p["entry"]
            if not ok(C[i]):
                still.append(p)
                continue
            if p["i0"] == i:
                p["stop0"] = max(L[i], e * 0.95)
                p["R"] = max(e - p["stop0"], e * 0.01)
            reason, px = None, C[i]
            if ok(L[i]) and L[i] <= e * 0.93:
                reason, px = "緊急停損", (min(O[i], e * 0.93) if i > p["i0"] else e * 0.93)
            else:
                if C[i] >= e + p["R"]:
                    p["be"] = True
                stop = max(p["stop0"], e) if p["be"] else p["stop0"]
                if C[i] < stop:
                    reason = "保本" if p["be"] else "停損"
                elif i > p["i0"]:
                    if ok(L[i - 1]) and C[i] < L[i - 1]:
                        reason = "破前日低"
                    else:
                        prev_h = [h for h in H[max(0, i - 5):i] if h == h]
                        p["nnh"] = p["nnh"] + 1 if prev_h and ok(H[i]) and H[i] <= max(prev_h) else 0
                        ic = idx_chg(markets[p["code"]], i)
                        sc = (C[i] / C[i - 1] - 1) * 100 if ok(C[i - 1]) else None
                        if p["nnh"] >= 2:
                            reason = "連兩天沒創5日新高"
                        elif ic is not None and sc is not None and sc - ic <= -5:
                            reason = "落後指數5%"
            p["last"] = C[i]
            if reason:
                cash += p["shares"] * px * (1 - COST)
                trades.append(trade_row(p, cal[i], px, reason, names))
            else:
                still.append(p)
        positions = still

        # ---- 水位下降：賣掉報酬最差的 ----
        lvl = level_at(i)
        over = len(positions) - LEVEL_SLOTS[lvl]
        if over > 0:
            positions.sort(key=lambda p: p["last"] / p["entry"])
            for p in positions[:over]:
                cash += p["shares"] * p["last"] * (1 - COST)
                trades.append(trade_row(p, cal[i], p["last"], "水位下降", names))
            positions = positions[over:]

        eq = cash + sum(p["shares"] * p["last"] for p in positions)
        curve.append({"d": cal[i], "v": round((eq - 1) * 100, 3), "n": len(positions), "lvl": lvl})
        pending = signals_on(i, data)

    pnl = [t["pnl"] for t in trades]
    wins = [x for x in pnl if x > 0]
    losses = [x for x in pnl if x <= 0]
    peak, mdd = 1.0, 0.0
    for pt in curve:
        e = 1 + pt["v"] / 100
        peak = max(peak, e)
        mdd = max(mdd, (1 - e / peak) * 100)
    stats = {
        "ret": curve[-1]["v"] if curve else 0,
        "trades": len(pnl),
        "winRate": round(len(wins) / len(pnl) * 100, 1) if pnl else None,
        "avgWin": round(sum(wins) / len(wins), 2) if wins else None,
        "avgLoss": round(sum(losses) / len(losses), 2) if losses else None,
        "pf": round(sum(wins) / -sum(losses), 2) if losses and sum(losses) < 0 else None,
        "maxDd": round(mdd, 2),
    }
    reasons = defaultdict(int)
    for t in trades:
        reasons[t["reason"]] += 1
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "start": START, "last_date": cal[-1], "stats": stats, "exit_reasons": dict(reasons),
        "curve": curve,
        "trades": sorted(trades, key=lambda t: t["exit_d"], reverse=True),
        "open": [{"code": p["code"], "name": names[p["code"]], "setup": p["setup"], "entry_d": cal[p["i0"]],
                  "entry_p": round(p["entry"], 2), "pnl": round((p["last"] / p["entry"] - 1) * 100, 2)}
                 for p in positions],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"平行宇宙：{START} → {cal[-1]} 報酬 {stats['ret']:.2f}%，{stats['trades']} 筆，勝率 {stats['winRate']}%，"
          f"PF {stats['pf']}，最大回撤 {stats['maxDd']}%")

    # ---- 最近 7 個交易日高低收 ----
    n = 7
    r2 = lambda x: None if x != x else round(x, 2)
    stocks = {}
    for c, (O, H, L, C, V) in data.items():
        if not ok(C[-1]):
            continue
        stocks[c] = {"n": names[c], "m": "T" if markets[c] == "TWSE" else "O",
                     "h": [r2(x) for x in H[-n:]],
                     "l": [r2(x) for x in L[-n:]], "c": [r2(x) for x in C[-n:]]}
    OUT_RECENT.write_text(json.dumps({"dates": cal[-n:], "stocks": stocks}, ensure_ascii=False, separators=(",", ":")),
                          encoding="utf-8")
    print(f"recent_ohlc：{len(stocks)} 檔，{cal[-n]} ~ {cal[-1]}")


def trade_row(p, exit_d, px, reason, names):
    return {"code": p["code"], "name": names[p["code"]], "setup": p["setup"],
            "entry_d": p["d0"], "entry_p": round(p["entry"], 2),
            "exit_d": exit_d, "exit_p": round(px, 2), "reason": reason,
            "pnl": round((px / p["entry"] * (1 - COST) - 1) * 100, 2)}


if __name__ == "__main__":
    main()
