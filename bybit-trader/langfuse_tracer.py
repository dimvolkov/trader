"""Minimal, dependency-light Langfuse tracer.

Sends LLM generations to a (self-hosted) Langfuse instance via the public
ingestion API using httpx (already a dependency) — no `langfuse` SDK, in keeping
with this service's lightweight style.

It is a NO-OP unless all three of LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY /
LANGFUSE_SECRET_KEY are set. Every call is best-effort: nothing here raises into
the caller, so tracing can never break signal parsing.

Docs: https://langfuse.com/docs/api  (POST /api/public/ingestion)
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

try:
    import httpx
except ImportError:  # pragma: no cover - httpx is a hard dep in prod
    httpx = None  # type: ignore

_HOST = (os.getenv("LANGFUSE_HOST") or "").rstrip("/")
_PUBLIC = os.getenv("LANGFUSE_PUBLIC_KEY") or ""
_SECRET = os.getenv("LANGFUSE_SECRET_KEY") or ""
_ENVIRONMENT = os.getenv("LANGFUSE_TRACING_ENVIRONMENT") or "production"
_RELEASE = os.getenv("LANGFUSE_RELEASE") or None


def enabled() -> bool:
    return bool(_HOST and _PUBLIC and _SECRET and httpx is not None)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid() -> str:
    return str(uuid.uuid4())


def usage_from_anthropic(u: Any) -> Optional[dict]:
    """Build Langfuse usage from an anthropic `usage` object (or None)."""
    if u is None:
        return None
    inp = getattr(u, "input_tokens", 0) or 0
    out = getattr(u, "output_tokens", 0) or 0
    return {
        "input": inp,
        "output": out,
        "total": inp + out,
        "unit": "TOKENS",
        "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
    }


def _send(batch: list) -> None:
    if not enabled() or not batch:
        return
    try:
        auth = base64.b64encode(f"{_PUBLIC}:{_SECRET}".encode()).decode()
        httpx.post(
            f"{_HOST}/api/public/ingestion",
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/json",
            },
            content=json.dumps({"batch": batch}),
            timeout=5.0,
        )
    except Exception as exc:  # pragma: no cover - network
        print(f"[langfuse] send failed: {exc}")


def trace_generation(
    *,
    name: str,
    model: str,
    model_parameters: Optional[dict] = None,
    input: Any = None,
    output: Any = None,
    usage: Optional[dict] = None,
    metadata: Optional[dict] = None,
    tags: Optional[list] = None,
    level: Optional[str] = None,
    status_message: Optional[str] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
) -> None:
    """Record a single LLM generation as its own trace. Best-effort, never raises."""
    if not enabled():
        return
    trace_id = _uuid()
    gen_id = _uuid()
    start = start_time or now_iso()
    end = end_time or now_iso()
    batch = [
        {
            "id": _uuid(),
            "type": "trace-create",
            "timestamp": start,
            "body": {
                "id": trace_id,
                "timestamp": start,
                "name": name,
                "input": input,
                "output": output,
                "metadata": metadata,
                "tags": tags,
                "level": level,
                "statusMessage": status_message,
                "release": _RELEASE,
                "environment": _ENVIRONMENT,
            },
        },
        {
            "id": _uuid(),
            "type": "generation-create",
            "timestamp": start,
            "body": {
                "id": gen_id,
                "traceId": trace_id,
                "name": name,
                "model": model,
                "modelParameters": model_parameters,
                "input": input,
                "startTime": start,
                "environment": _ENVIRONMENT,
            },
        },
        {
            "id": _uuid(),
            "type": "generation-update",
            "timestamp": end,
            "body": {
                "id": gen_id,
                "traceId": trace_id,
                "endTime": end,
                "output": output,
                "usage": usage,
                "level": level,
                "statusMessage": status_message,
            },
        },
    ]
    _send(batch)
