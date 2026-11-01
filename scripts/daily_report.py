#!/usr/bin/env python3
"""
台股盤後報告：讀每日排程算好的資料，整理成一份報告。
- 寫入 signals/daily_report.json，給 App 的「盤後報告」分頁讀
- 加 --email 時用 Gmail SMTP 寄出（需要 GitHub Secrets：GMAIL_USER、GMAIL_APP_PASSWORD，
  收件人 REPORT_EMAIL_TO 沒設就寄給 GMAIL_USER）。同一個資料日期只寄一次。

不呼叫任何 AI、不需要 API key，只整理數字。
用法：python3 scripts/daily_report.py [--email] [--print]
"""
import argparse
import csv
import html
import json
import os
import re
import smtplib
import sys
from collections import defaultdict
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "signals" / "daily_report.json"
LIMIT_UP_PCT = 9.5  # 漲幅 ≥ 9.5% 視為漲停（上限 10%，保留價位跳動誤差）
TOP_GROUPS = 5
MAX_SIGNALS_IN_EMAIL = 15
SIGNAL_NAMES = {"fast": "進場 A（盤整突破）", "streak": "進場 B（動能延續）", "vcp": "VCP 量縮突破"}


def load_json(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def ma(values, n):
    return sum(values[-n:]) / n if len(values) >= n else None


def index_status(series):
    dates = sorted(series)
    closes = [series[d] for d in dates]
    close, prev = closes[-1], closes[-2]
    return {"date": dates[-1], "close": close, "chg": round((close / prev - 1) * 100, 2),
            "ma5": ma(closes, 5), "ma10": ma(closes, 10), "ma20": ma(closes, 20),
            "new_high": close >= max(closes)}  # 資料從 6/1 起，「新高」指資料期間內


def exposure_level(s):
    """依大盤水位規則，從加權指數收盤與均線位置推算水位（看今天的位置，不追蹤回補歷程）。
    跌破月線 30%；站回月線 50%；10 日線 70%；5 日線滿倉；創新高可用槓桿。"""
    c = s["close"]
    if s["ma20"] is None:
        return "?", "均線資料不足"
    if c < s["ma20"]:
        return "30%", "收在月線（20 日線）下"
    if s["new_high"]:
        return "滿倉＋槓桿", "創資料期間新高"
    if c >= s["ma5"] and c >= s["ma10"]:
        return "滿倉", "站上 5 日線"
    if c >= s["ma10"]:
        return "70%", "站上 10 日線、5 日線下"
    return "50%", "站上月線、10 日線下"


def market_breadth(as_of):
    closes = defaultdict(list)
    with (ROOT / "data" / "price_history.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["date"] <= as_of and row["close"]:
                closes[row["code"]].append((row["date"], float(row["close"])))
    b = {"up": 0, "down": 0, "flat": 0, "limit_up": 0, "new_high20": 0}
    for series in closes.values():
        series.sort()
        if len(series) < 2 or series[-1][0] != as_of:
            continue
        last, prev = series[-1][1], series[-2][1]
        chg = (last / prev - 1) * 100 if prev else 0
        b["up" if chg > 0 else "down" if chg < 0 else "flat"] += 1
        if chg >= LIMIT_UP_PCT:
            b["limit_up"] += 1
        window = [c for _, c in series[-21:-1]]
        if len(window) == 20 and last > max(window):
            b["new_high20"] += 1
    return b


def build_report():
    latest = load_json("signals/latest.json")
    groups = load_json("signals/groups.json")
    twi = index_status(load_json("data/twi_index.json"))
    otc = index_status(load_json("data/otc_index.json"))
    as_of = latest["scan_date"]

    warnings = []
    if not latest.get("markets_in_sync", True):
        warnings.append(f"上市（{latest['twse_date']}）與上櫃（{latest['tpex_date']}）資料日期不一致")
    if groups.get("asOf") != as_of:
        warnings.append(f"族群資料日期（{groups.get('asOf')}）與訊號日期（{as_of}）不同")
    if twi["date"] != as_of:
        warnings.append(f"加權指數資料停在 {twi['date']}")

    level, reason = exposure_level(twi)
    grp = groups["groups"]
    by_c1 = sorted(grp, key=lambda g: g["c1"], reverse=True)
    by_c5 = sorted(grp, key=lambda g: g["c5"], reverse=True)
    pick = lambda g: {k: g[k] for k in ("group", "industry", "c1", "c5", "c20")}
    sets = [{"key": s["key"], "name": SIGNAL_NAMES.get(s["key"], s["label"]), "label": s["label"],
             "count": s["signal_count"], "signals": s["signals"]}
            for s in latest["sets"]]
    # 網球：拉回後已站回 5 日線，依收復比例排序（rec＝(現價−低點)÷(高點−低點)）
    balls = sorted((t for t in groups["tennis"] if t["pulled"] and t["state"] == "站上5日線"),
                   key=lambda t: t["rec"], reverse=True)[:8]

    return {
        "as_of": as_of,
        "warnings": warnings,
        "index": {"twi": twi, "otc": otc},
        "exposure": {"level": level, "reason": reason},
        "breadth": market_breadth(as_of),
        "groups_top": [pick(g) for g in by_c1[:TOP_GROUPS]],
        "groups_bottom": [pick(g) for g in by_c1[-TOP_GROUPS:][::-1]],
        "groups_top5d": [pick(g) for g in by_c5[:TOP_GROUPS]],
        "group_rotation": latest.get("group_rotation", {}).get("groups", []),
        "signal_sets": sets,
        "tennis": [{k: t[k] for k in ("code", "name", "group", "pull", "rec", "fromHigh")} for t in balls],
    }


def pct(x):
    return "–" if x is None else f"{x:+.2f}%"


def render_text(r):
    L = [f"台股盤後報告｜{r['as_of']}", ""]
    L += [f"⚠ 資料提醒：{w}" for w in r["warnings"]] + ([""] if r["warnings"] else [])
    L.append("【大盤】")
    for name, s in (("加權", r["index"]["twi"]), ("櫃買", r["index"]["otc"])):
        pos = "、".join(f"{'站上' if s['close'] >= m else '跌破'} {n} 日線"
                        for n, m in ((5, s["ma5"]), (10, s["ma10"]), (20, s["ma20"])) if m)
        L.append(f"・{name} {s['close']:,.2f}（{pct(s['chg'])}）：{pos}")
    L.append(f"・依水位規則（看加權）：{r['exposure']['level']}　← {r['exposure']['reason']}")
    b = r["breadth"]
    L.append(f"・漲 {b['up']} / 跌 {b['down']} / 平 {b['flat']}，漲停 {b['limit_up']} 檔，創 20 日新高 {b['new_high20']} 檔")
    L.append("")
    for title, key, cols in (("今天最強", "groups_top", ("今日", "c1", "5 日", "c5")),
                             ("今天最弱", "groups_bottom", ("今日", "c1", "5 日", "c5")),
                             ("5 日最強", "groups_top5d", ("5 日", "c5", "20 日", "c20"))):
        L.append(f"【族群：{title}】")
        for g in r[key]:
            L.append(f"・{g['group']}（{g['industry']}）{cols[0]} {pct(g[cols[1]])}，{cols[2]} {pct(g[cols[3]])}")
    if r["group_rotation"]:
        L.append("【族群同步噴出】")
        for g in r["group_rotation"]:
            stocks = "、".join(f"{s['name']} {s['daily_change_pct']:+}%" for s in g["stocks"])
            L.append(f"・{g['group']}（{g['triggered_count']}/{g['total_in_group']}）：{stocks}")
    L.append("")
    for s in r["signal_sets"]:
        L.append(f"【{s['name']}】{s['count']} 檔　條件：{s['label']}")
        for sig in s["signals"][:MAX_SIGNALS_IN_EMAIL]:
            grp = " · ".join(x for x in (sig.get("industry"), sig.get("sub_group")) if x)
            vol = f"，量 {sig['volume_multiple']:.1f} 倍" if sig.get("volume_multiple") else ""
            L.append(f"・{sig['code']} {sig['name']}　{sig['close']}（{pct(sig['daily_change_pct'])}{vol}）{('　' + grp) if grp else ''}")
        if s["count"] > MAX_SIGNALS_IN_EMAIL:
            L.append(f"・……另有 {s['count'] - MAX_SIGNALS_IN_EMAIL} 檔，見 App 訊號分頁")
        L.append("")
    if r["tennis"]:
        L.append("【網球：拉回後已站回 5 日線】")
        for t in r["tennis"]:
            L.append(f"・{t['code']} {t['name']}（{t['group']}）拉回 {t['pull']:.1f}%，已收復 {t['rec']:.0f}% 跌幅，距高點 {t['fromHigh']:.1f}%")
        L.append("")
    L.append("資料來源：證交所、櫃買中心收盤資料（trading-journal 每日排程）。只整理數字，不構成投資建議。")
    return "\n".join(L)


def render_html(text):
    def color(m):
        return f"<span style='color:{'#d1242f' if m.group(0).startswith('+') else '#1a7f37'}'>{m.group(0)}</span>"
    out = []
    for line in text.splitlines():
        e = html.escape(line)
        if line.startswith("【") or line.startswith("台股盤後報告"):
            out.append(f"<h3 style='margin:14px 0 4px'>{e}</h3>")
        elif line:
            out.append(f"<div>{re.sub(r'[+-]\d+(?:\.\d+)?%', color, e)}</div>")
    return ("<div style='font-family:-apple-system,\"PingFang TC\",sans-serif;font-size:14px;line-height:1.6'>"
            + "\n".join(out) + "</div>")


def send_email(subject, text, html_body):
    user, pw = os.environ.get("GMAIL_USER"), os.environ.get("GMAIL_APP_PASSWORD")
    if not (user and pw):
        print("沒有設定 GMAIL_USER／GMAIL_APP_PASSWORD，略過寄信")
        return False
    msg = EmailMessage()
    msg["Subject"], msg["From"] = subject, user
    msg["To"] = os.environ.get("REPORT_EMAIL_TO") or user
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
        s.login(user, pw)
        s.send_message(msg)
    print("已寄出盤後報告")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", action="store_true", help="寄出報告（同一資料日期只寄一次）")
    ap.add_argument("--print", action="store_true", help="印出文字版")
    args = ap.parse_args()

    prev = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    r = build_report()
    r["text"] = render_text(r)
    r["subject"] = f"台股盤後報告 {r['as_of']}｜水位 {r['exposure']['level']}"
    r["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    r["emailed_as_of"] = prev.get("emailed_as_of")
    if args.print:
        print(r["text"])

    if args.email and r["emailed_as_of"] != r["as_of"]:
        try:
            if send_email(r["subject"], r["text"], render_html(r["text"])):
                r["emailed_as_of"] = r["as_of"]
        except Exception as e:  # 寄信失敗不影響報告寫入，Actions log 會留下錯誤
            print(f"寄信失敗：{e}", file=sys.stderr)

    OUT.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"寫入 {OUT.relative_to(ROOT)}（資料日期 {r['as_of']}）")


if __name__ == "__main__":
    main()
