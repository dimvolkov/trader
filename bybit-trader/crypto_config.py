"""Live JSON config for the crypto pipeline.

Mirrors the design of server-scanner/pending_config.js:
  - 5-second cache, re-read from disk on each access
  - update(patch) validates against DEFAULTS keys + RANGES, writes back to disk
  - non-default values are persisted for cleaner diffs
"""

import json
import os
import time
from pathlib import Path

CONFIG_FILE = Path(os.getenv("CRYPTO_CONFIG_FILE", "/data/crypto_config.json"))

DEFAULTS = {
    # Master switch: signals are received and parsed regardless, but ordering
    # only happens when this is true.
    "auto_trade": False,

    # ByBit environment. When true the bridge talks to api-testnet.bybit.com.
    "testnet": True,

    # Risk per trade as a fraction of wallet balance (USDT).
    "risk_pct": 0.01,

    # Default isolated leverage for new positions (1..100, broker-capped).
    "leverage": 5,

    # Hard cap on concurrent open positions across all pairs.
    "max_open_positions": 3,

    # Notional caps in USDT for a single position.
    "min_position_usd": 10,
    "max_position_usd": 200,

    # If the signal carries no take-profit, use this RR multiple of stop.
    # (e.g. 2.0 means TP placed at entry + 2*(entry-stop) in the trade direction)
    "default_tp_rr": 2.0,

    # If the signal carries no stop-loss, behaviour is controlled here:
    #   null → skip the signal entirely (recommended; never guess SL)
    #   number → use this fraction of entry price as a synthetic SL
    "default_sl_pct": None,

    # When a signal lists multiple TPs, this controls how the position is
    # split. Values must sum to 1.0. Trimmed/extended to match TP count.
    "tp_split": [1.0],

    # ─── Filters ───
    # Telegram chat / channel ids the listener will accept. Empty = nothing
    # gets traded automatically (we still log everything we receive).
    "channel_whitelist": [],

    # Symbol filters (ByBit linear symbols, e.g. BTCUSDT, ETHUSDT).
    "pair_whitelist": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    "pair_blacklist": [],

    # Reject signals where current market price has already drifted past
    # entry by more than this fraction of |entry - stop|. 0 disables the
    # check.
    "max_entry_drift_pct": 0.5,
}

RANGES = {
    "risk_pct":            {"min": 0.0001, "max": 0.2},
    "leverage":            {"min": 1,      "max": 100, "integer": True},
    "max_open_positions":  {"min": 1,      "max": 50,  "integer": True},
    "min_position_usd":    {"min": 1,      "max": 100000},
    "max_position_usd":    {"min": 1,      "max": 1000000},
    "default_tp_rr":       {"min": 0.5,    "max": 10},
    "max_entry_drift_pct": {"min": 0.0,    "max": 1.0},
}

_CACHE = {"data": None, "ts": 0.0}
_CACHE_TTL = 5.0


def _load_from_file() -> dict:
    if not CONFIG_FILE.exists():
        return dict(DEFAULTS)
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[crypto-config] failed to read {CONFIG_FILE}: {exc}")
        return dict(DEFAULTS)
    merged = dict(DEFAULTS)
    merged.update({k: v for k, v in raw.items() if k in DEFAULTS})
    return merged


def get(force: bool = False) -> dict:
    now = time.monotonic()
    if force or _CACHE["data"] is None or now - _CACHE["ts"] > _CACHE_TTL:
        _CACHE["data"] = _load_from_file()
        _CACHE["ts"] = now
    return _CACHE["data"]


def defaults() -> dict:
    return dict(DEFAULTS)


def ranges() -> dict:
    return {k: dict(v) for k, v in RANGES.items()}


def _check_numeric(name: str, value, errors: list):
    rng = RANGES.get(name)
    if rng is None:
        return
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        errors.append(f"{name} must be a number")
        return
    if rng.get("integer") and not float(value).is_integer():
        errors.append(f"{name} must be an integer")
        return
    if value < rng["min"] or value > rng["max"]:
        errors.append(f"{name} must be in [{rng['min']}..{rng['max']}]")


def validate(patch: dict) -> list:
    errors = []
    allowed = set(DEFAULTS.keys())
    for k in patch:
        if k not in allowed:
            errors.append(f"unknown key: {k}")

    for k in ("auto_trade", "testnet"):
        if k in patch and not isinstance(patch[k], bool):
            errors.append(f"{k} must be boolean")

    for k in RANGES:
        if k in patch:
            _check_numeric(k, patch[k], errors)

    if "default_sl_pct" in patch and patch["default_sl_pct"] is not None:
        v = patch["default_sl_pct"]
        if not isinstance(v, (int, float)) or v <= 0 or v >= 0.5:
            errors.append("default_sl_pct must be null or 0 < number < 0.5")

    if "tp_split" in patch:
        v = patch["tp_split"]
        if (not isinstance(v, list) or not v
                or any(not isinstance(x, (int, float)) or x <= 0 for x in v)):
            errors.append("tp_split must be non-empty list of positive numbers")
        elif abs(sum(v) - 1.0) > 1e-6:
            errors.append("tp_split values must sum to 1.0")

    for k in ("channel_whitelist", "pair_whitelist", "pair_blacklist"):
        if k in patch:
            v = patch[k]
            if not isinstance(v, list):
                errors.append(f"{k} must be a list")
                continue
            if k == "channel_whitelist":
                # Channel ids are ints (or @username strings).
                for x in v:
                    if not isinstance(x, (int, str)):
                        errors.append(f"{k} entries must be int or string")
                        break
            else:
                for x in v:
                    if not isinstance(x, str):
                        errors.append(f"{k} entries must be strings")
                        break

    return errors


def update(patch: dict) -> dict:
    errors = validate(patch)
    if errors:
        return {"success": False, "errors": errors}
    current = _load_from_file()
    merged = dict(current)
    merged.update(patch)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        json.dumps(merged, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    _CACHE["data"] = merged
    _CACHE["ts"] = time.monotonic()
    return {"success": True, "config": merged}
