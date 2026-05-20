"""Parse free-form crypto signals from Telegram into a structured order spec.

Two stages:
  1. Regex shapes that cover the most common Telegram crypto signal formats.
  2. LLM fallback (Claude) for everything else, returning a strict JSON schema.

A successful parse looks like:
    {
        "pair": "BTCUSDT",
        "direction": "Buy" | "Sell",
        "entry": 65000.0 | None,        # None = enter at market
        "stop": 64000.0,
        "takes": [67000.0, 70000.0],    # at least one TP (may be empty if missing)
        "confidence": "regex" | "llm",
    }

`parse_signal` returns ``None`` when the text is not a trade signal at all.
Validation against pair_whitelist, SL sanity, etc. lives in app.py — this
module only concerns itself with extraction.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

# Counter is module-level so /signals can surface "% routed to LLM" in the UI.
STATS = {"regex_hits": 0, "llm_hits": 0, "llm_failures": 0, "skipped": 0}


# ─── Stage 1: regex ───────────────────────────────────────────────────────

# Accept "BTCUSDT", "BTC/USDT", "$BTC", "BTC-USDT". Normalise to BBBQQQ.
_SYMBOL_RE = re.compile(
    r"(?P<base>[A-Z]{2,10})[/\-]?(?P<quote>USDT|USDC|USD|BTC|ETH)\b",
    re.IGNORECASE,
)
_DOLLAR_SYMBOL_RE = re.compile(r"\$(?P<base>[A-Z]{2,10})\b", re.IGNORECASE)

_DIR_LONG = re.compile(r"\b(long|buy|lon|лонг|купить)\b", re.IGNORECASE)
_DIR_SHORT = re.compile(r"\b(short|sell|шорт|продать)\b", re.IGNORECASE)

# Capture float (with optional thousands separator stripped beforehand).
_FLOAT = r"([0-9]+(?:[.,][0-9]+)?)"

_ENTRY_RES = [
    re.compile(rf"\bentry\s*[:=@]?\s*{_FLOAT}", re.IGNORECASE),
    re.compile(rf"\b(?:buy|long|sell|short)\s*@\s*{_FLOAT}", re.IGNORECASE),
    re.compile(rf"\b(?:цена\s*входа|вход)\s*[:=@]?\s*{_FLOAT}", re.IGNORECASE),
    # "PAIR @ price" — symbol followed by @ and a number.
    re.compile(rf"[A-Z]{{2,10}}[/\-]?(?:USDT|USDC|USD|BTC|ETH)\s*@\s*{_FLOAT}",
               re.IGNORECASE),
]

_STOP_RES = [
    re.compile(rf"\b(?:sl|stop[\s\-]?loss|stop)\s*[:=@]?\s*{_FLOAT}", re.IGNORECASE),
    re.compile(rf"\b(?:стоп(?:[\s\-]?лосс)?)\s*[:=@]?\s*{_FLOAT}", re.IGNORECASE),
]

# Note: TP-index (1..12) is matched only when the digits are NOT immediately
# followed by another digit — otherwise greedy \d* would swallow the price
# itself ("TP 66000" must yield 66000, not just "000").
_TP_RES = [
    re.compile(
        rf"\b(?:tp|take[\s\-]?profit|target)(?:\d{{1,2}}(?!\d))?\s*[:=@]?\s*{_FLOAT}",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\b(?:тейк(?:[\s\-]?профит)?|цель)(?:\s*\d{{1,2}}(?!\d))?\s*[:=@]?\s*{_FLOAT}",
        re.IGNORECASE,
    ),
]


def _to_float(token: str) -> Optional[float]:
    if not token:
        return None
    cleaned = token.replace(",", ".").replace(" ", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def _extract_symbol(text: str) -> Optional[str]:
    m = _SYMBOL_RE.search(text)
    if m:
        return (m.group("base") + m.group("quote")).upper()
    m = _DOLLAR_SYMBOL_RE.search(text)
    if m:
        # If only "$BTC" mentioned, default quote to USDT (USDT perp).
        return (m.group("base") + "USDT").upper()
    return None


def _extract_direction(text: str) -> Optional[str]:
    has_long = bool(_DIR_LONG.search(text))
    has_short = bool(_DIR_SHORT.search(text))
    if has_long and not has_short:
        return "Buy"
    if has_short and not has_long:
        return "Sell"
    return None


def _extract_first_match(text: str, patterns: List[re.Pattern]) -> Optional[float]:
    for pat in patterns:
        m = pat.search(text)
        if m:
            return _to_float(m.group(1))
    return None


def _extract_all_matches(text: str, patterns: List[re.Pattern]) -> List[float]:
    out: List[float] = []
    seen = set()
    for pat in patterns:
        for m in pat.finditer(text):
            v = _to_float(m.group(1))
            if v is not None and v not in seen:
                seen.add(v)
                out.append(v)
    return out


def _regex_parse(text: str) -> Optional[Dict[str, Any]]:
    symbol = _extract_symbol(text)
    direction = _extract_direction(text)
    if not symbol or not direction:
        return None

    entry = _extract_first_match(text, _ENTRY_RES)
    stop = _extract_first_match(text, _STOP_RES)
    takes = _extract_all_matches(text, _TP_RES)

    # At least one of (stop, takes) must be present for us to call this a
    # valid signal — otherwise it's likely just commentary.
    if stop is None and not takes:
        return None

    return {
        "pair": symbol,
        "direction": direction,
        "entry": entry,
        "stop": stop,
        "takes": takes,
        "confidence": "regex",
    }


# ─── Stage 2: LLM fallback ────────────────────────────────────────────────

_LLM_SYSTEM = (
    "You extract crypto trading signals from messages. "
    "Return STRICT JSON only — no prose, no markdown — matching this schema:\n"
    '{\n'
    '  "is_signal": bool,\n'
    '  "pair": "BTCUSDT" | null,           # ByBit linear perp symbol, base+USDT\n'
    '  "direction": "Buy" | "Sell" | null,\n'
    '  "entry": number | null,             # null means enter at market\n'
    '  "stop": number | null,\n'
    '  "takes": [number, ...]              # zero or more TPs, in order\n'
    "}\n"
    "If the message is news, commentary, P&L screenshot, or anything other "
    "than an actionable trade signal — return {\"is_signal\": false}.\n"
    "Resolve abbreviations (TP1/TP2/Take = takes; SL/Stop/Стоп = stop). "
    "Translate Russian. Pair format: base symbol joined with USDT in uppercase."
)


def _make_llm_client():
    """Lazy import so the module is usable in unit tests without anthropic installed."""
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        import anthropic
    except ImportError:
        return None
    return anthropic.Anthropic(api_key=key)


def _llm_parse(text: str) -> Optional[Dict[str, Any]]:
    client = _make_llm_client()
    if client is None:
        return None
    model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")
    try:
        msg = client.messages.create(
            model=model,
            max_tokens=400,
            system=_LLM_SYSTEM,
            messages=[{"role": "user", "content": text[:4000]}],
        )
        raw = "".join(
            block.text for block in msg.content
            if getattr(block, "type", None) == "text"
        ).strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?", "", raw).rstrip("`").strip()
        data = json.loads(raw)
    except Exception as exc:                     # pragma: no cover - network
        STATS["llm_failures"] += 1
        print(f"[signal-parser] LLM error: {exc}")
        return None

    if not data.get("is_signal"):
        return None
    pair = data.get("pair")
    direction = data.get("direction")
    if not pair or direction not in ("Buy", "Sell"):
        return None
    return {
        "pair": str(pair).upper(),
        "direction": direction,
        "entry": data.get("entry"),
        "stop": data.get("stop"),
        "takes": [t for t in (data.get("takes") or []) if isinstance(t, (int, float))],
        "confidence": "llm",
    }


# ─── Public ──────────────────────────────────────────────────────────────

def parse_signal(text: str) -> Optional[Dict[str, Any]]:
    if not text or not text.strip():
        STATS["skipped"] += 1
        return None

    result = _regex_parse(text)
    if result is not None:
        STATS["regex_hits"] += 1
        return result

    result = _llm_parse(text)
    if result is not None:
        STATS["llm_hits"] += 1
        return result

    STATS["skipped"] += 1
    return None


def stats_snapshot() -> Dict[str, Any]:
    total_hits = STATS["regex_hits"] + STATS["llm_hits"]
    return {
        **STATS,
        "llm_share": (STATS["llm_hits"] / total_hits) if total_hits else 0,
    }
