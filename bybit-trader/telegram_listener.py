"""Background Telethon listener.

Runs inside the same process as the FastAPI app, on a dedicated asyncio task.
For every message arriving in a whitelisted channel:

  1. Append a raw "received" record to signals.jsonl.
  2. Parse with signal_parser.
  3. If parsed → call the pipeline callback (which validates + executes).

The pipeline callback is passed in from app.py so this module stays free of
ByBit-specific concerns.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Awaitable, Callable, Optional

from telethon import TelegramClient, events

import crypto_config
import signal_parser
import signal_store

log = logging.getLogger("crypto.telegram")

_client: Optional[TelegramClient] = None
_task: Optional[asyncio.Task] = None


PipelineCb = Callable[[dict, dict], Awaitable[None]]


def _channel_allowed(chat_id: int, username: Optional[str]) -> bool:
    cfg = crypto_config.get()
    allow = cfg.get("channel_whitelist") or []
    if not allow:
        return False
    for item in allow:
        if isinstance(item, int) and item == chat_id:
            return True
        if isinstance(item, str):
            normalized = item.lstrip("@").lower()
            if username and normalized == username.lower():
                return True
            # Allow numeric ids passed as string (e.g. "-100123456789")
            if normalized.lstrip("-").isdigit() and int(normalized) == chat_id:
                return True
    return False


async def _on_message(event, pipeline: PipelineCb):
    text = (event.message.message or "").strip()
    chat = await event.get_chat()
    chat_id = event.chat_id
    username = getattr(chat, "username", None)
    message_key = f"{chat_id}:{event.message.id}"

    base_record = {
        "message_key": message_key,
        "chat_id": chat_id,
        "chat_username": username,
        "message_id": event.message.id,
        "text": text,
    }

    if signal_store.signal_already_processed(message_key):
        return

    if not _channel_allowed(chat_id, username):
        signal_store.append_signal({**base_record, "status": "ignored_channel"})
        return

    parsed = signal_parser.parse_signal(text)
    if parsed is None:
        signal_store.append_signal({**base_record, "status": "unparsed"})
        return

    record = {**base_record, "status": "parsed", "parsed": parsed}
    signal_store.append_signal(record)

    try:
        await pipeline(parsed, record)
    except Exception as exc:                   # pragma: no cover - safety net
        log.exception("pipeline failed for %s: %s", message_key, exc)
        signal_store.append_signal({
            **base_record,
            "status": "pipeline_error",
            "error": str(exc),
        })


async def start(pipeline: PipelineCb) -> Optional[TelegramClient]:
    """Spin up the Telethon client + event handler. Returns None if not configured."""
    global _client, _task

    api_id = os.getenv("TELETHON_API_ID")
    api_hash = os.getenv("TELETHON_API_HASH")
    session = os.getenv("TELETHON_SESSION", "/data/telethon.session")

    if not api_id or not api_hash:
        log.warning("TELETHON_API_ID/HASH not set — Telegram listener disabled")
        return None

    _client = TelegramClient(session, int(api_id), api_hash)
    try:
        await _client.connect()
    except Exception as exc:
        log.error("Telethon connect failed: %s", exc)
        _client = None
        return None

    if not await _client.is_user_authorized():
        log.error(
            "Telethon session %s is NOT authorised. Run bootstrap_session.py "
            "locally and copy the .session file into /data.",
            session,
        )
        await _client.disconnect()
        _client = None
        return None

    @_client.on(events.NewMessage())
    async def handler(event):                  # pragma: no cover - runtime
        await _on_message(event, pipeline)

    log.info("Telethon listener started (session=%s)", session)
    return _client


async def stop() -> None:
    global _client
    if _client is not None:
        await _client.disconnect()
        _client = None
