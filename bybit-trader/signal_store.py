"""JSONL persistence for incoming signals and executed trades.

Two append-only files in the /data volume:
  signals.jsonl — one record per Telegram message we saw (raw + parsed + result)
  trades.jsonl  — one record per opened/closed position event

Both mirror the executor's log_trade() convention so the UI / journaling code
can reason about them uniformly.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

SIGNAL_LOG = Path(os.getenv("SIGNAL_LOG", "/data/signals.jsonl"))
TRADE_LOG = Path(os.getenv("TRADE_LOG", "/data/trades.jsonl"))

# Lock prevents interleaved writes between the listener thread and FastAPI
# request handlers in the same process.
_lock = threading.Lock()


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def append(path: Path, record: Dict[str, Any]) -> None:
    record.setdefault("timestamp", _now_iso())
    _ensure_parent(path)
    line = json.dumps(record, ensure_ascii=False)
    with _lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def append_signal(record: Dict[str, Any]) -> None:
    append(SIGNAL_LOG, record)


def append_trade(record: Dict[str, Any]) -> None:
    append(TRADE_LOG, record)


def _read_filtered(
    path: Path,
    days: Optional[int],
    extra_filter=None,
) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=days)
        if days is not None else None
    )
    out: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if cutoff is not None:
                ts = rec.get("timestamp")
                if ts:
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        if dt < cutoff:
                            continue
                    except ValueError:
                        pass
            if extra_filter and not extra_filter(rec):
                continue
            out.append(rec)
    return out


def read_signals(days: int = 14, limit: int = 200) -> List[Dict[str, Any]]:
    records = _read_filtered(SIGNAL_LOG, days)
    return records[-limit:]


def read_trades(days: int = 30, limit: int = 500,
                pair: Optional[str] = None,
                action: Optional[str] = None) -> List[Dict[str, Any]]:
    def matches(rec):
        if pair and rec.get("pair") != pair:
            return False
        if action and rec.get("action") != action:
            return False
        return True
    records = _read_filtered(TRADE_LOG, days, extra_filter=matches)
    return records[-limit:]


def signal_already_processed(message_key: str) -> bool:
    """Idempotency check: True if a signal with this message_key was
    already recorded.

    message_key is the unique "(chat_id, message_id)" tuple that we attach to
    every signal record we write.
    """
    if not SIGNAL_LOG.exists():
        return False
    target = f'"message_key": "{message_key}"'
    with open(SIGNAL_LOG, "r", encoding="utf-8") as f:
        for line in f:
            if target in line:
                return True
    return False
