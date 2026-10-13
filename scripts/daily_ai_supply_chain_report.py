#!/usr/bin/env python3
"""
每日 AI 半導體供應鏈盤前研究報告：呼叫 Anthropic Messages API，帶 server-side
web_search 工具，讓模型依照 ai_supply_chain_report_prompt.md 的規格自己上網研究、
驗證、寫出完整報告，結果存成 data/ai_supply_chain_report.json 給前端讀取顯示。

跟 daily_signal_scan.py 不同，這支腳本做的不是「用公開 API 抓結構化資料」，而是
委託 Claude 做真正的網路研究（搜尋、開文章讀全文、交叉比對多市場資料），所以需要
ANTHROPIC_API_KEY（GitHub repo secret）才能執行，而且每次執行都會產生 API 用量費用。

模型可用 repo variable AI_REPORT_MODEL 覆寫（.github/workflows 裡用
vars.AI_REPORT_MODEL），沒設定時預設用 DEFAULT_MODEL。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

TAIPEI_TZ = timezone(timedelta(hours=8))

REPO_ROOT = Path(__file__).resolve().parent.parent
PROMPT_MD = Path(__file__).resolve().parent / "ai_supply_chain_report_prompt.md"
OUTPUT_JSON = REPO_ROOT / "data" / "ai_supply_chain_report.json"

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-opus-5"
MAX_TOKENS = 16000
WEB_SEARCH_MAX_USES = 30

FETCH_RETRIES = 3
FETCH_BACKOFF_SECONDS = 10  # API 端常見的是暫時性 429/5xx，拉長間隔比盤後資料抓取更保守


def call_anthropic(api_key: str, model: str, user_prompt: str) -> dict:
    body = json.dumps({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "tools": [
            {"type": "web_search_20250305", "name": "web_search", "max_uses": WEB_SEARCH_MAX_USES},
        ],
        "messages": [
            {"role": "user", "content": user_prompt},
        ],
    }).encode("utf-8")

    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }

    last_error = None
    for attempt in range(1, FETCH_RETRIES + 1):
        try:
            req = urllib.request.Request(ANTHROPIC_API_URL, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=600) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            resp_body = e.read().decode("utf-8", errors="replace")
            last_error = f"Anthropic API 回傳 HTTP {e.code}（第 {attempt} 次）：{resp_body[:500]}"
            print(last_error, file=sys.stderr)
            # 4xx（除了 429）通常是請求本身有問題，重試也不會好，直接中止
            if e.code != 429 and e.code < 500:
                raise RuntimeError(last_error)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_error = f"連線失敗（第 {attempt} 次）：{e}"
            print(last_error, file=sys.stderr)

        if attempt < FETCH_RETRIES:
            time.sleep(FETCH_BACKOFF_SECONDS * attempt)

    raise RuntimeError(f"呼叫 Anthropic API 重試 {FETCH_RETRIES} 次後仍失敗：{last_error}")


def extract_report_text(response: dict) -> tuple[str, bool]:
    """從 response['content'] 取出所有 text block 接起來（中間穿插的是 server_tool_use /
    web_search_tool_result，略過不要），回傳 (文字, 是否被 max_tokens 截斷)。"""
    blocks = response.get("content", [])
    texts = [b["text"] for b in blocks if b.get("type") == "text" and b.get("text")]
    report = "\n\n".join(texts).strip()
    truncated = response.get("stop_reason") == "max_tokens"
    return report, truncated


def main() -> int:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print("缺少 ANTHROPIC_API_KEY 環境變數，無法呼叫 Anthropic API。", file=sys.stderr)
        return 1

    model = os.environ.get("AI_REPORT_MODEL", "").strip() or DEFAULT_MODEL

    now_taipei = datetime.now(TAIPEI_TZ)
    base_prompt = PROMPT_MD.read_text(encoding="utf-8")
    time_context = (
        f"目前實際時間（台灣時間，請以此為準，不要用你自己的訓練知識猜測今天日期）：\n"
        f"{now_taipei.strftime('%Y/%m/%d (%A) %H:%M')} Asia/Taipei\n\n"
        "---\n\n"
    )
    user_prompt = time_context + base_prompt

    print(f"呼叫 Anthropic API（model={model}）產生報告...")
    response = call_anthropic(api_key, model, user_prompt)

    if response.get("type") == "error":
        raise RuntimeError(f"Anthropic API 回傳錯誤：{response}")

    report_text, truncated = extract_report_text(response)
    if not report_text:
        raise RuntimeError(f"Anthropic API 回應中沒有任何文字內容，完整回應：{json.dumps(response)[:1000]}")

    if truncated:
        print("警告：回應因為達到 max_tokens 而被截斷，報告可能不完整。", file=sys.stderr)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "report_date_taipei": now_taipei.strftime("%Y/%m/%d"),
        "model": model,
        "truncated": truncated,
        "markdown": report_text,
    }

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已寫入 {OUTPUT_JSON}（{len(report_text)} 字元，truncated={truncated}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
