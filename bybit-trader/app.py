"""bybit-trader — FastAPI service.

Receives Telegram crypto signals (via Telethon), executes them on ByBit
USDT-perp, and exposes a REST API to the scanner / web UI.

Auth: X-API-Secret header on every protected endpoint, mirroring
trade-executor/executor.py (so the same scanner-side helper can talk to both
executors).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import bybit_bridge
import crypto_config
import signal_parser
import signal_store
import telegram_listener

API_SECRET = os.getenv("BYBIT_EXECUTOR_SECRET", "change-me-to-a-real-secret")
TG_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("crypto.app")


# ─── App lifecycle: spin up Telethon as a background task ─────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    client = await telegram_listener.start(pipeline=run_pipeline)
    bg_task = None
    if client is not None:
        bg_task = asyncio.create_task(client.run_until_disconnected())
    try:
        yield
    finally:
        await telegram_listener.stop()
        if bg_task is not None:
            bg_task.cancel()


app = FastAPI(title="bybit-trader", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_auth(secret: Optional[str]):
    if secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


def _testnet() -> bool:
    return bool(crypto_config.get().get("testnet", True))


# ─── Telegram admin notifications ────────────────────────────────────────

async def notify_admin(text: str) -> None:
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(url, json={
                "chat_id": TG_CHAT_ID,
                "text": text,
                "parse_mode": "Markdown",
                "disable_web_page_preview": True,
            })
    except httpx.HTTPError as exc:
        log.warning("admin notify failed: %s", exc)


# ─── Execution pipeline (called by telegram_listener) ────────────────────

async def run_pipeline(parsed: Dict[str, Any], signal_record: Dict[str, Any]) -> None:
    cfg = crypto_config.get()
    pair = parsed["pair"]
    direction = parsed["direction"]
    entry = parsed.get("entry")
    stop = parsed.get("stop")
    takes = parsed.get("takes") or []

    # ─── Sanity checks (do not auto-trade obviously broken signals) ───
    if pair in (cfg.get("pair_blacklist") or []):
        return _skip(signal_record, parsed, f"pair {pair} blacklisted")

    whitelist = cfg.get("pair_whitelist") or []
    if whitelist and pair not in whitelist:
        return _skip(signal_record, parsed, f"pair {pair} not in whitelist")

    if not cfg.get("auto_trade"):
        return _skip(signal_record, parsed, "auto_trade disabled")

    if stop is None:
        default_sl_pct = cfg.get("default_sl_pct")
        if default_sl_pct is None or entry is None:
            return _skip(signal_record, parsed, "no stop loss and no default")
        # Synthetic SL relative to entry.
        stop = (entry * (1 - default_sl_pct)) if direction == "Buy" else (entry * (1 + default_sl_pct))

    # SL must be on the correct side of entry (or market).
    ticker = await bybit_bridge.get_ticker(_testnet(), pair)
    if not ticker.get("success"):
        return _fail(signal_record, parsed, f"ticker unavailable: {ticker.get('error')}")
    market_price = ticker["lastPrice"]
    ref_price = entry if entry is not None else market_price

    if direction == "Buy" and stop >= ref_price:
        return _skip(signal_record, parsed, "SL above entry for long")
    if direction == "Sell" and stop <= ref_price:
        return _skip(signal_record, parsed, "SL below entry for short")

    # Drift check: market already moved past entry beyond the configured cap.
    drift_pct_max = cfg.get("max_entry_drift_pct", 0)
    if entry is not None and drift_pct_max > 0:
        risk_dist = abs(entry - stop)
        if risk_dist > 0:
            drift = abs(market_price - entry) / risk_dist
            if drift > drift_pct_max:
                return _skip(signal_record, parsed,
                             f"price drifted {drift:.2f}x past entry (cap {drift_pct_max})")

    # ─── Position cap ───
    positions = await bybit_bridge.get_positions(_testnet())
    if positions.get("success"):
        cnt = len(positions.get("positions") or [])
        if cnt >= cfg.get("max_open_positions", 3):
            return _skip(signal_record, parsed,
                         f"max_open_positions={cnt} reached")
        for p in positions.get("positions") or []:
            if p["symbol"] == pair:
                return _skip(signal_record, parsed, f"already in {pair}")

    # ─── Sizing ───
    balance = await bybit_bridge.get_wallet_balance(_testnet())
    if not balance.get("success"):
        return _fail(signal_record, parsed,
                     f"balance unavailable: {balance.get('error')}")
    equity = balance.get("usdtEquity") or balance.get("usdtWallet") or 0
    if equity <= 0:
        return _skip(signal_record, parsed, "wallet balance zero")

    risk_usd = equity * cfg.get("risk_pct", 0.01)
    risk_dist = abs((entry or market_price) - stop)
    if risk_dist <= 0:
        return _skip(signal_record, parsed, "zero stop distance")
    raw_qty = risk_usd / risk_dist

    inst = await bybit_bridge.get_instrument_info(_testnet(), pair)
    if not inst.get("success"):
        return _fail(signal_record, parsed,
                     f"instrument info unavailable: {inst.get('error')}")
    qty = bybit_bridge.round_qty(raw_qty, inst["qtyStep"])
    if qty < inst["minOrderQty"]:
        return _skip(signal_record, parsed,
                     f"qty {qty} below minOrderQty {inst['minOrderQty']}")

    notional = qty * (entry or market_price)
    if notional < cfg.get("min_position_usd", 0):
        return _skip(signal_record, parsed,
                     f"notional ${notional:.2f} below min_position_usd")
    max_notional = cfg.get("max_position_usd", 0)
    if max_notional and notional > max_notional:
        # Trim qty to fit cap.
        capped = max_notional / (entry or market_price)
        qty = bybit_bridge.round_qty(capped, inst["qtyStep"])
        if qty < inst["minOrderQty"]:
            return _skip(signal_record, parsed,
                         f"capped qty below min after max_position_usd cap")
        log.info("trimmed qty to %s to fit max_position_usd=%s", qty, max_notional)

    # ─── TP plan ───
    if not takes:
        # Synthesize a single TP at default_tp_rr * risk_dist.
        rr = cfg.get("default_tp_rr", 2.0)
        if direction == "Buy":
            takes = [(entry or market_price) + rr * risk_dist]
        else:
            takes = [(entry or market_price) - rr * risk_dist]

    tp_split = cfg.get("tp_split") or [1.0]
    # Pad / trim split to match the count of TPs.
    if len(tp_split) < len(takes):
        # Extend by distributing remaining weight evenly.
        leftover = max(0.0, 1.0 - sum(tp_split))
        extra = len(takes) - len(tp_split)
        if leftover > 0 and extra > 0:
            tp_split = list(tp_split) + [leftover / extra] * extra
        else:
            tp_split = list(tp_split) + [0.0] * extra
    elif len(tp_split) > len(takes):
        tp_split = tp_split[: len(takes)]

    # Re-normalize to sum=1 in case of rounding.
    s = sum(tp_split)
    if s > 0:
        tp_split = [x / s for x in tp_split]

    # ─── Set leverage ───
    leverage = int(cfg.get("leverage", 5))
    leverage = min(leverage, int(inst.get("maxLeverage") or leverage))
    lev_res = await bybit_bridge.set_leverage(_testnet(), pair, leverage)
    if not lev_res.get("success"):
        # Non-fatal: log and continue (account may not allow this lev for symbol).
        log.warning("set_leverage failed: %s", lev_res.get("error"))

    # ─── Place entry ───
    link_id = f"{bybit_bridge.MAGIC_PREFIX}-{signal_record['message_key'][:24]}"
    order_type = "Market" if entry is None else "Limit"
    price = (bybit_bridge.round_price(entry, inst["tickSize"])
             if entry is not None else None)
    rounded_stop = bybit_bridge.round_price(stop, inst["tickSize"])

    # For multi-TP we place the first TP on the entry itself, then add the
    # rest via reduce-only conditional orders sized by tp_split.
    first_tp = bybit_bridge.round_price(takes[0], inst["tickSize"]) if takes else None

    entry_res = await bybit_bridge.place_order(
        testnet=_testnet(),
        symbol=pair,
        side=direction,
        qty=qty,
        order_type=order_type,
        price=price,
        take_profit=first_tp if len(takes) == 1 else None,
        stop_loss=rounded_stop,
        order_link_id=link_id,
    )

    record = {
        "action": "open_attempt" if entry_res.get("success") else "open_failed",
        "message_key": signal_record["message_key"],
        "pair": pair,
        "direction": direction,
        "entry": entry,
        "market_price": market_price,
        "stop": rounded_stop,
        "takes": takes,
        "qty": qty,
        "leverage": leverage,
        "order_type": order_type,
        "order_link_id": link_id,
        "tp_split": tp_split,
        "parsed_confidence": parsed.get("confidence"),
        "result": entry_res,
    }
    signal_store.append_trade(record)
    signal_store.append_signal({
        **signal_record,
        "status": "executed" if entry_res.get("success") else "execution_failed",
        "execution": entry_res,
    })

    if not entry_res.get("success"):
        await notify_admin(
            f"❌ *ByBit ORDER FAIL* {pair} {direction}\n"
            f"`{entry_res.get('error')}`"
        )
        return

    # Additional TPs (only if multiple takes provided).
    if len(takes) > 1:
        await _place_split_tps(pair, direction, qty, takes, tp_split, inst, link_id)

    await notify_admin(
        f"✅ *ByBit OPEN* `{pair}` {direction}\n"
        f"qty `{qty}`  entry `{price or 'market'}`\n"
        f"SL `{rounded_stop}`  TPs `{takes}`\n"
        f"lev `{leverage}x`  testnet=`{_testnet()}`"
    )


async def _place_split_tps(pair, direction, qty, takes, tp_split, inst, link_id):
    """Place reduce-only conditional TPs after the entry filled."""
    opposite = "Sell" if direction == "Buy" else "Buy"
    placed = 0
    for i, tp in enumerate(takes):
        portion = bybit_bridge.round_qty(qty * tp_split[i], inst["qtyStep"])
        if portion <= 0:
            continue
        tp_price = bybit_bridge.round_price(tp, inst["tickSize"])
        res = await bybit_bridge.place_order(
            testnet=_testnet(),
            symbol=pair,
            side=opposite,
            qty=portion,
            order_type="Limit",
            price=tp_price,
            reduce_only=True,
            order_link_id=f"{link_id}-tp{i}",
        )
        if res.get("success"):
            placed += 1
        else:
            log.warning("TP%d place failed: %s", i, res.get("error"))
    log.info("placed %d/%d TPs", placed, len(takes))


def _skip(signal_record, parsed, reason: str):
    log.info("skip %s: %s", signal_record.get("message_key"), reason)
    signal_store.append_signal({
        **signal_record,
        "status": "skipped",
        "skip_reason": reason,
    })


def _fail(signal_record, parsed, reason: str):
    log.warning("fail %s: %s", signal_record.get("message_key"), reason)
    signal_store.append_signal({
        **signal_record,
        "status": "failed",
        "failure_reason": reason,
    })


# ─── Models ──────────────────────────────────────────────────────────────

class ManualOrder(BaseModel):
    pair: str
    direction: str
    entry: Optional[float] = None
    stop: float
    takes: List[float] = Field(default_factory=list)


class ConfigUpdate(BaseModel):
    patch: Dict[str, Any]


class ChannelAdd(BaseModel):
    channel: Any   # int or "@username"


# ─── Routes ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat(),
            "testnet": _testnet()}


@app.get("/account")
async def account(x_api_secret: Optional[str] = Header(None)):
    require_auth(x_api_secret)
    return await bybit_bridge.get_wallet_balance(_testnet())


@app.get("/positions")
async def positions(x_api_secret: Optional[str] = Header(None)):
    require_auth(x_api_secret)
    return await bybit_bridge.get_positions(_testnet())


@app.get("/signals")
async def list_signals(
    days: int = Query(14, ge=1, le=90),
    limit: int = Query(200, ge=1, le=1000),
    x_api_secret: Optional[str] = Header(None),
):
    require_auth(x_api_secret)
    return {
        "success": True,
        "signals": signal_store.read_signals(days=days, limit=limit),
        "parser_stats": signal_parser.stats_snapshot(),
    }


@app.get("/history")
async def history(
    days: int = Query(30, ge=1, le=180),
    limit: int = Query(500, ge=1, le=5000),
    pair: Optional[str] = None,
    x_api_secret: Optional[str] = Header(None),
):
    require_auth(x_api_secret)
    return {
        "success": True,
        "trades": signal_store.read_trades(days=days, limit=limit, pair=pair),
    }


@app.get("/closed-pnl")
async def closed_pnl(
    limit: int = Query(100, ge=1, le=500),
    pair: Optional[str] = None,
    x_api_secret: Optional[str] = Header(None),
):
    require_auth(x_api_secret)
    return await bybit_bridge.get_closed_pnl(_testnet(), symbol=pair, limit=limit)


@app.post("/order")
async def manual_order(
    body: ManualOrder, x_api_secret: Optional[str] = Header(None),
):
    """Open a position manually (bypasses Telegram listener). Useful for UI."""
    require_auth(x_api_secret)
    fake_record = {
        "message_key": f"manual:{uuid.uuid4().hex[:12]}",
        "chat_id": None,
        "message_id": None,
        "text": "(manual UI order)",
    }
    parsed = {
        "pair": body.pair,
        "direction": body.direction,
        "entry": body.entry,
        "stop": body.stop,
        "takes": body.takes,
        "confidence": "manual",
    }
    await run_pipeline(parsed, fake_record)
    return {"success": True, "queued": True}


@app.post("/close/{pair}")
async def close(pair: str, x_api_secret: Optional[str] = Header(None)):
    require_auth(x_api_secret)
    res = await bybit_bridge.close_position(testnet=_testnet(), symbol=pair)
    signal_store.append_trade({
        "action": "close_manual",
        "pair": pair,
        "result": res,
    })
    return res


@app.get("/config")
async def get_config(x_api_secret: Optional[str] = Header(None)):
    require_auth(x_api_secret)
    return {
        "success": True,
        "config": crypto_config.get(force=True),
        "defaults": crypto_config.defaults(),
        "ranges": crypto_config.ranges(),
    }


@app.post("/config")
async def post_config(body: ConfigUpdate, x_api_secret: Optional[str] = Header(None)):
    require_auth(x_api_secret)
    res = crypto_config.update(body.patch)
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res)
    return res


@app.get("/channels")
async def list_channels(x_api_secret: Optional[str] = Header(None)):
    require_auth(x_api_secret)
    cfg = crypto_config.get(force=True)
    return {"success": True, "channels": cfg.get("channel_whitelist", [])}


@app.post("/channels")
async def add_channel(body: ChannelAdd, x_api_secret: Optional[str] = Header(None)):
    require_auth(x_api_secret)
    cfg = crypto_config.get(force=True)
    current = list(cfg.get("channel_whitelist") or [])
    entry = body.channel
    if entry in current:
        return {"success": True, "channels": current, "note": "already present"}
    current.append(entry)
    res = crypto_config.update({"channel_whitelist": current})
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res)
    return {"success": True, "channels": current}


@app.delete("/channels/{channel}")
async def remove_channel(
    channel: str, x_api_secret: Optional[str] = Header(None),
):
    require_auth(x_api_secret)
    cfg = crypto_config.get(force=True)
    current = list(cfg.get("channel_whitelist") or [])
    # Accept either int or string id.
    try:
        as_int = int(channel)
    except ValueError:
        as_int = None
    new = [c for c in current if c != channel and c != as_int]
    if len(new) == len(current):
        raise HTTPException(status_code=404, detail="channel not found")
    res = crypto_config.update({"channel_whitelist": new})
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res)
    return {"success": True, "channels": new}
