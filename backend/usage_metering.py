"""AI 成本計量：每次 Claude / Whisper 呼叫後換算美元花費，寫進 ai_usage_log。"""

from __future__ import annotations

import re

PRICING: dict[str, dict[str, float]] = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0},
    "claude-opus-4-8":   {"input": 5.0, "output": 25.0},
    "claude-haiku-4-5":  {"input": 1.0, "output": 5.0},
}
_DEFAULT = {"input": 3.0, "output": 15.0}

WHISPER_USD_PER_MINUTE = 0.006


def _rates(model: str) -> dict[str, float]:
    if model in PRICING:
        return PRICING[model]
    base = re.sub(r"-\d{8}$", "", model)
    return PRICING.get(base, _DEFAULT)


def claude_cost(model: str, usage) -> tuple[float, dict[str, int]]:
    def g(name: str) -> int:
        try:
            return int(getattr(usage, name, 0) or 0)
        except (TypeError, ValueError):
            return 0

    inp = g("input_tokens")
    out = g("output_tokens")
    cache_write = g("cache_creation_input_tokens")
    cache_read = g("cache_read_input_tokens")

    r = _rates(model)
    in_rate = r["input"]
    cost = (
        inp * in_rate
        + out * r["output"]
        + cache_write * in_rate * 1.25
        + cache_read * in_rate * 0.1
    ) / 1_000_000

    breakdown = {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_write_tokens": cache_write,
        "cache_read_tokens": cache_read,
    }
    return round(cost, 6), breakdown


def whisper_cost(seconds: float) -> float:
    try:
        return round(max(0.0, float(seconds)) / 60.0 * WHISPER_USD_PER_MINUTE, 6)
    except (TypeError, ValueError):
        return 0.0
