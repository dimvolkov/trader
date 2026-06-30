"""
Trade Executor — FastAPI service that accepts trading signals and executes them on MT5.
Runs on Windows Server with native MetaTrader 5.

Endpoints:
  GET  /health
  GET  /account
  GET  /positions
  POST /order                — open market order (legacy)
  POST /close/{ticket}       — close position

  POST /pending              — place pending order with signal context
  GET  /pending              — list active pendings
  DELETE /pending/{ticket}   — cancel pending
  POST /pending/cancel-by-pair/{pair} — cancel all our pendings on pair

  GET  /history?days=30      — recorded signal attempts (from local JSONL)
  GET  /history/mt5?days=30  — MT5 deals & orders history
  GET  /stats?days=30        — aggregated stats: winrate, fill-rate, avg R, by pair/type
  GET  /analysis?pair=...    — per-pair deep analysis with recommendations
"""

import os
import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Header, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

import mt5_bridge

# ─── Configuration ───
API_SECRET = os.getenv("EXECUTOR_API_SECRET", "change-me-to-a-real-secret")
MAX_OPEN_POSITIONS = int(os.getenv("MAX_OPEN_POSITIONS", "5"))
MAX_PENDING_ORDERS = int(os.getenv("MAX_PENDING_ORDERS", "10"))
# Idempotency: a pending request whose direction matches and whose entry/SL/TP
# all sit within this many points of an already-live pending on the same symbol
# is rejected instead of placed, so repeated scans cannot stack duplicates.
DEDUP_TOLERANCE_POINTS = float(os.getenv("DEDUP_TOLERANCE_POINTS", "10"))
LOG_FILE = os.getenv("LOG_FILE", "C:/trade-executor/trades.log")

# ─── Logging ───
log_path = Path(LOG_FILE)
log_path.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ],
)
logger = logging.getLogger("executor")

# ─── App ───
app = FastAPI(title="Trade Executor", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Trade log (JSON lines) ───
TRADE_LOG = Path(os.getenv("TRADE_LOG_JSON", "C:/trade-executor/trades.jsonl"))
TRADE_LOG.parent.mkdir(parents=True, exist_ok=True)


def log_trade(data: dict):
    """Append trade record to JSON lines file."""
    data["timestamp"] = datetime.now(timezone.utc).isoformat()
    with open(TRADE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")


def read_trade_log(days: int = 30, pair: Optional[str] = None, action: Optional[str] = None) -> List[dict]:
    """Read trade log filtered by time/pair/action."""
    if not TRADE_LOG.exists():
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    with open(TRADE_LOG, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = rec.get("timestamp")
            if ts:
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    if dt < cutoff:
                        continue
                except ValueError:
                    pass
            if pair and rec.get("pair") != pair:
                continue
            if action and rec.get("action") != action:
                continue
            out.append(rec)
    return out


# ─── Helper ───
def pair_to_mt5_symbol(pair: str) -> str:
    """Convert 'EUR/USD' to the broker-specific MT5 symbol name.

    Strips the slash and then asks mt5_bridge to resolve any broker suffix
    (e.g. Alfa-Forex uses 'rfd' → USDCHFrfd). Result is cached in
    mt5_bridge, so this is cheap on repeat calls.
    """
    return mt5_bridge.resolve_symbol(pair.replace("/", ""))


def calculate_volume(
    pair: str, entry: float, stop: float, deposit: float, risk_pct: float
) -> float:
    """Calculate position size in lots based on risk."""
    risk_amount = deposit * risk_pct
    pip_value_approx = 0.0001 if "JPY" not in pair else 0.01
    stop_pips = abs(entry - stop) / pip_value_approx

    if stop_pips == 0:
        return 0.01

    lot_size = risk_amount / (stop_pips * 10)
    lot_size = max(0.01, round(lot_size, 2))
    return lot_size


def require_auth(secret: Optional[str]):
    if secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─── Models ───
class OrderRequest(BaseModel):
    pair: str = Field(..., description="Currency pair, e.g. EUR/USD")
    direction: str = Field(..., description="'up'/'buy' or 'down'/'sell'")
    entry: float
    stop: float
    take: float
    rr: float
    volume: float = Field(0, description="Lot size (0 = auto-calculate)")
    deposit: float = 100000
    risk_pct: float = 0.01


class PendingRequest(BaseModel):
    pair: str = Field(..., description="e.g. EUR/USD")
    direction: str = Field(..., description="'up'/'buy' or 'down'/'sell'")
    entry: float
    stop: float
    take: float
    rr: float
    volume: float = Field(0, description="0 = auto-calculate from risk")
    deposit: float = 100000
    risk_pct: float = 0.01
    pending_type: str = Field("auto", description="'limit' | 'stop' | 'auto'")
    ttl_hours: float = Field(0, description="0 = GTC; otherwise expire after N hours")
    # Signal context for retrospective analysis
    signal_context: Optional[Dict[str, Any]] = Field(default_factory=dict)
    config_snapshot: Optional[Dict[str, Any]] = Field(default_factory=dict)


class SkipNote(BaseModel):
    """A placement attempt the scanner rejected pre-flight (never sent to MT5).
    Recorded in the journal so the reason stays visible next to real orders
    instead of the setup vanishing without a trace."""
    pair: str
    direction: str
    entry: float
    stop: float
    take: float
    rr: float = 0
    volume: float = 0
    reason: str
    signal_context: Optional[Dict[str, Any]] = Field(default_factory=dict)


def _normalize_direction(direction: str) -> str:
    d = direction.lower()
    if d in ("up", "buy", "long"):
        return "buy"
    if d in ("down", "sell", "short"):
        return "sell"
    raise HTTPException(status_code=400, detail=f"Bad direction: {direction}")


# ─── Endpoints: basic ───
@app.get("/health")
async def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/account")
async def account(x_api_secret: str = Header(None)):
    require_auth(x_api_secret)
    result = mt5_bridge.account_info()
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "MT5 error"))
    return result


@app.get("/terminal")
async def terminal(x_api_secret: str = Header(None)):
    """MT5 terminal status: broker connection + algo-trading permission."""
    require_auth(x_api_secret)
    return mt5_bridge.terminal_info()


@app.get("/positions")
async def positions(x_api_secret: str = Header(None)):
    require_auth(x_api_secret)
    result = mt5_bridge.get_positions()
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "MT5 error"))
    return result


@app.get("/symbol/{pair}")
async def symbol_info(pair: str, x_api_secret: str = Header(None)):
    require_auth(x_api_secret)
    return mt5_bridge.get_symbol_info(pair_to_mt5_symbol(pair))


# ─── Endpoints: market order (legacy) ───
@app.post("/order")
async def create_order(order: OrderRequest, x_api_secret: str = Header(None)):
    """Open a market order (immediate execution)."""
    require_auth(x_api_secret)

    logger.info(f"Market order: {order.pair} {order.direction} entry={order.entry}")

    pos_result = mt5_bridge.get_positions()
    if pos_result.get("success"):
        open_count = len(pos_result.get("positions", []))
        if open_count >= MAX_OPEN_POSITIONS:
            msg = f"Max positions reached ({MAX_OPEN_POSITIONS}), skipping {order.pair}"
            logger.warning(msg)
            return {"success": False, "error": msg}

        symbol = pair_to_mt5_symbol(order.pair)
        for p in pos_result.get("positions", []):
            if p["symbol"] == symbol:
                msg = f"Already have position on {order.pair}, skipping"
                logger.warning(msg)
                return {"success": False, "error": msg}

    direction = _normalize_direction(order.direction)
    symbol = pair_to_mt5_symbol(order.pair)

    volume = order.volume
    if volume <= 0:
        volume = calculate_volume(order.pair, order.entry, order.stop, order.deposit, order.risk_pct)

    result = mt5_bridge.open_order(
        symbol=symbol,
        direction=direction,
        volume=volume,
        entry_price=order.entry,
        stop_loss=order.stop,
        take_profit=order.take,
        comment=f"M_{order.pair}_{order.rr:.1f}",
    )

    log_trade({
        "action": "market_open",
        "pair": order.pair,
        "direction": direction,
        "volume": volume,
        "entry": order.entry,
        "stop": order.stop,
        "take": order.take,
        "rr": order.rr,
        "result": result,
    })

    if result.get("success"):
        logger.info(f"Market done: {order.pair} {direction} vol={volume} id={result.get('order_id')}")
    else:
        logger.error(f"Market failed: {order.pair} — {result.get('error')}")

    return result


@app.post("/close/{ticket}")
async def close_order(ticket: int, x_api_secret: str = Header(None)):
    require_auth(x_api_secret)
    result = mt5_bridge.close_position(ticket)
    log_trade({"action": "close", "ticket": ticket, "result": result})
    if result.get("success"):
        logger.info(f"Position closed: {ticket}")
    else:
        logger.error(f"Close failed: {ticket} — {result.get('error')}")
    return result


# ─── Endpoints: pending orders ───
def _find_duplicate_pending(symbol: str, direction: str,
                            entry: float, stop: float, take: float):
    """Return an existing live pending on `symbol` placed by us that represents
    the same setup (same direction, entry/SL/TP within DEDUP_TOLERANCE_POINTS),
    or None. Last-line-of-defence against stacked duplicate orders — fires even
    when the scanner-side replace/dedup did not run (retries, races, restarts,
    or two scanner instances)."""
    listing = mt5_bridge.get_pending_orders(symbol=symbol)
    if not listing.get("success"):
        return None

    info = mt5_bridge.get_symbol_info(symbol)
    point = info.get("point") if info.get("success") else None
    tol = (point or 0) * DEDUP_TOLERANCE_POINTS
    if tol <= 0:
        tol = abs(entry) * 1e-5

    want_buy = direction == "buy"
    for o in listing.get("orders", []):
        if o.get("magic") != mt5_bridge.MAGIC_PENDING:
            continue
        if str(o.get("type", "")).lower().startswith("buy") != want_buy:
            continue
        if (abs(o["price_open"] - entry) <= tol
                and abs(o["sl"] - stop) <= tol
                and abs(o["tp"] - take) <= tol):
            return o
    return None


@app.post("/pending")
async def create_pending(req: PendingRequest, x_api_secret: str = Header(None)):
    """
    Place a pending order. Stores full signal context for later retrospective analysis.
    """
    require_auth(x_api_secret)

    direction = _normalize_direction(req.direction)
    symbol = pair_to_mt5_symbol(req.pair)

    logger.info(f"Pending request: {req.pair} {direction} entry={req.entry} type={req.pending_type}")

    # Max pending guard
    p_existing = mt5_bridge.get_pending_orders()
    if p_existing.get("success") and len(p_existing.get("orders", [])) >= MAX_PENDING_ORDERS:
        msg = f"Max pending reached ({MAX_PENDING_ORDERS})"
        logger.warning(msg)
        log_trade({
            "action": "pending_rejected",
            "pair": req.pair, "reason": msg,
            "signal_context": req.signal_context,
        })
        return {"success": False, "error": msg}

    # Duplicate guard (idempotency): refuse to stack an order matching one that
    # is already live on this symbol. Logged so repeated-scan attempts are visible.
    dup = _find_duplicate_pending(symbol, direction, req.entry, req.stop, req.take)
    if dup is not None:
        logger.warning(
            f"Pending duplicate skipped: {req.pair} {direction} "
            f"entry={req.entry} — matches live ticket {dup['ticket']}"
        )
        log_trade({
            "action": "pending_duplicate_skipped",
            "pair": req.pair,
            "direction": direction,
            "entry": req.entry, "stop": req.stop, "take": req.take,
            "rr": req.rr,
            "duplicate_ticket": dup["ticket"],
            "duplicate": {"price_open": dup["price_open"], "sl": dup["sl"], "tp": dup["tp"]},
            "tolerance_points": DEDUP_TOLERANCE_POINTS,
            "signal_context": req.signal_context,
        })
        return {"success": False, "error": "duplicate", "duplicate_ticket": dup["ticket"]}

    # Volume
    volume = req.volume
    if volume <= 0:
        volume = calculate_volume(req.pair, req.entry, req.stop, req.deposit, req.risk_pct)

    # Expiration
    expiration_ts = 0
    if req.ttl_hours and req.ttl_hours > 0:
        expiration_ts = int((datetime.now(timezone.utc) + timedelta(hours=req.ttl_hours)).timestamp())

    # Current market price (for context)
    sym_info = mt5_bridge.get_symbol_info(symbol)
    market_price = None
    if sym_info.get("success"):
        market_price = sym_info["ask"] if direction == "buy" else sym_info["bid"]

    attempt_id = str(uuid.uuid4())
    comment = f"P_{req.pair.replace('/', '')}_{attempt_id[:6]}"

    result = mt5_bridge.place_pending_order(
        symbol=symbol,
        direction=direction,
        volume=volume,
        entry_price=req.entry,
        stop_loss=req.stop,
        take_profit=req.take,
        pending_type=req.pending_type,
        expiration_ts=expiration_ts,
        comment=comment,
    )

    log_trade({
        "action": "pending_placed" if result.get("success") else "pending_failed",
        "attempt_id": attempt_id,
        "pair": req.pair,
        "direction": direction,
        "volume": volume,
        "entry": req.entry,
        "stop": req.stop,
        "take": req.take,
        "rr": req.rr,
        "pending_type_requested": req.pending_type,
        "ttl_hours": req.ttl_hours,
        "expiration_ts": expiration_ts,
        "market_price_at_place": market_price,
        "ticket": result.get("ticket"),
        "comment": comment,
        "signal_context": req.signal_context,
        "config_snapshot": req.config_snapshot,
        "result": result,
    })

    if result.get("success"):
        logger.info(f"Pending placed: {req.pair} {direction} ticket={result.get('ticket')} type={result.get('order_type')}")
    else:
        logger.error(f"Pending failed: {req.pair} — {result.get('error')}")

    result["attempt_id"] = attempt_id
    return result


@app.get("/pending")
async def list_pending(pair: Optional[str] = None, x_api_secret: str = Header(None)):
    require_auth(x_api_secret)
    symbol = pair_to_mt5_symbol(pair) if pair else None
    return mt5_bridge.get_pending_orders(symbol=symbol)


@app.delete("/pending/{ticket}")
async def cancel_pending(ticket: int, reason: Optional[str] = None, x_api_secret: str = Header(None)):
    require_auth(x_api_secret)
    result = mt5_bridge.cancel_pending_order(ticket)
    log_trade({
        "action": "pending_cancelled",
        "ticket": ticket,
        "reason": reason or "manual",
        "result": result,
    })
    if result.get("success"):
        logger.info(f"Pending cancelled: {ticket} ({reason or 'manual'})")
    else:
        logger.error(f"Cancel failed: {ticket} — {result.get('error')}")
    return result


@app.post("/pending/cancel-by-pair/{pair}")
async def cancel_by_pair(pair: str, reason: Optional[str] = "replace", x_api_secret: str = Header(None)):
    require_auth(x_api_secret)
    symbol = pair_to_mt5_symbol(pair)
    result = mt5_bridge.cancel_pending_by_symbol(symbol, only_pending_magic=True)
    log_trade({
        "action": "pending_cancel_by_pair",
        "pair": pair,
        "reason": reason,
        "result": result,
    })
    return result


@app.post("/journal/skip")
async def journal_skip(note: SkipNote, x_api_secret: str = Header(None)):
    """Record a scanner-side pre-flight skip (e.g. entry too close to market) in
    the journal, so a setup dropped before it ever reaches MT5 still leaves a
    trace with its reason instead of silently disappearing."""
    require_auth(x_api_secret)
    log_trade({
        "action": "pending_skipped",
        "pair": note.pair,
        "direction": _normalize_direction(note.direction),
        "entry": note.entry,
        "stop": note.stop,
        "take": note.take,
        "rr": note.rr,
        "volume": note.volume,
        "reason": note.reason,
        "signal_context": note.signal_context,
    })
    logger.info(f"Pending skipped (scanner): {note.pair} — {note.reason}")
    return {"success": True}


# ─── Endpoints: retrospective analysis ───

ORDER_STATE_NAMES = {
    0: "started", 1: "placed", 2: "cancelled", 3: "partial",
    4: "filled", 5: "rejected", 6: "expired",
}


@app.get("/history")
async def history(
    days: int = Query(30, ge=1, le=365),
    pair: Optional[str] = None,
    action: Optional[str] = None,
    x_api_secret: str = Header(None),
):
    """Local trade attempts log (includes pending_placed, pending_cancelled, market_open, etc)."""
    require_auth(x_api_secret)
    records = read_trade_log(days=days, pair=pair, action=action)
    return {"success": True, "count": len(records), "records": records}


@app.get("/history/mt5")
async def history_mt5(
    days: int = Query(30, ge=1, le=365),
    pair: Optional[str] = None,
    x_api_secret: str = Header(None),
):
    """MT5 deals + orders history."""
    require_auth(x_api_secret)
    from_ts = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    symbol = pair_to_mt5_symbol(pair) if pair else None
    deals = mt5_bridge.get_history_deals(from_ts, symbol=symbol)
    orders = mt5_bridge.get_history_orders(from_ts, symbol=symbol)
    return {
        "success": True,
        "deals": deals.get("deals", []),
        "orders": orders.get("orders", []),
    }


@app.get("/journal")
async def journal(
    days: int = Query(30, ge=1, le=365),
    pair: Optional[str] = None,
    status_filter: Optional[str] = Query(None, alias="status", description="filter: placed|filled|cancelled|expired|failed|closed"),
    x_api_secret: str = Header(None),
):
    """
    Unified order journal: stitches local attempts with MT5 order/deal outcomes.
    Each row = one placement attempt with its final outcome (filled/cancelled/expired/etc),
    profit (if closed), close price, and the originating signal context.
    Also includes pending_failed and pending_rejected attempts that never reached MT5.
    """
    require_auth(x_api_secret)

    from_ts = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    symbol = pair_to_mt5_symbol(pair) if pair else None
    mt5_orders = mt5_bridge.get_history_orders(from_ts, symbol=symbol).get("orders", [])
    mt5_deals = mt5_bridge.get_history_deals(from_ts, symbol=symbol).get("deals", [])
    active_orders = mt5_bridge.get_pending_orders(symbol=symbol).get("orders", [])
    log_recs = read_trade_log(days=days, pair=pair)

    # Index MT5 data by ticket / position_id. History only contains finished orders,
    # so active pendings (still waiting for price) must be merged in explicitly,
    # otherwise _outcome_from_order returns "unknown" and they get hidden by the
    # journal status filter.
    orders_by_ticket = {o["ticket"]: o for o in mt5_orders}
    for o in active_orders:
        if o["ticket"] in orders_by_ticket:
            continue
        orders_by_ticket[o["ticket"]] = {
            **o,
            "state": 1,                       # ORDER_STATE_PLACED
            "type_name": o.get("type"),       # get_pending_orders puts the name string under "type"
            "position_id": None,
        }
    deals_by_position = {}
    for d in mt5_deals:
        deals_by_position.setdefault(d.get("position_id"), []).append(d)

    # Index cancellations from local log (reason, watcher cause)
    cancellations_by_ticket = {}
    for r in log_recs:
        if r.get("action") == "pending_cancelled" and r.get("ticket"):
            cancellations_by_ticket[r["ticket"]] = r

    rows = []
    seen_tickets = set()

    def _outcome_from_order(ticket: int):
        """Return (status, position_id) from MT5 order state."""
        o = orders_by_ticket.get(ticket)
        if not o:
            return ("unknown", None)
        st = o.get("state")
        return (ORDER_STATE_NAMES.get(st, str(st)), o.get("position_id"))

    def _profit_from_position(position_id):
        """Return (profit, close_price, close_time, in_deal) for a position.

        Sums profit+swap+commission across ALL deals of the position so the result
        matches MT5's "Profit" line. Alfa-Forex (and similar) charges commission on
        the entry deal; ignoring it underreported losses. Partial closes also produce
        multiple out-deals — the final close price/time comes from the last one.
        """
        if not position_id:
            return (None, None, None, None)
        deals = deals_by_position.get(position_id, [])
        in_deal = next((d for d in deals if d.get("entry") == 0), None)
        out_deals = [d for d in deals if d.get("entry") == 1]
        if not out_deals:
            return (None, None, None, in_deal)
        total = sum(
            d.get("profit", 0) + d.get("swap", 0) + d.get("commission", 0)
            for d in deals
        )
        last_out = max(out_deals, key=lambda d: d.get("time") or 0)
        return (round(total, 2), last_out["price"], last_out["time"], in_deal)

    # Walk local attempts (pending and market)
    for r in log_recs:
        action = r.get("action")
        if action not in ("pending_placed", "market_open", "pending_failed",
                          "pending_rejected", "pending_skipped"):
            continue
        ticket = r.get("ticket") or (r.get("result") or {}).get("order_id")
        if action in ("pending_failed", "pending_rejected", "pending_skipped") or not ticket:
            rows.append({
                "timestamp": r.get("timestamp"),
                "pair": r.get("pair"),
                "kind": "pending" if action.startswith("pending") else "market",
                "direction": r.get("direction"),
                "entry": r.get("entry"),
                "stop": r.get("stop"),
                "take": r.get("take"),
                "rr": r.get("rr"),
                "volume": r.get("volume"),
                "ticket": ticket,
                "status": {"pending_rejected": "rejected",
                           "pending_skipped": "skipped"}.get(action, "failed"),
                "reason": r.get("reason") or (r.get("result") or {}).get("error"),
                "profit": None,
                "close_price": None,
                "close_time": None,
                "signal_context": r.get("signal_context"),
                "attempt_id": r.get("attempt_id"),
            })
            continue

        seen_tickets.add(ticket)
        status, position_id = _outcome_from_order(ticket)
        if action == "market_open":
            # Market orders are filled immediately; if position_id missing, fall back
            if not position_id:
                position_id = ticket
            if status == "unknown":
                status = "filled"
        profit, close_price, close_time, in_deal = _profit_from_position(position_id)

        # Refine status if position is fully closed
        if profit is not None:
            status = "closed"

        cancel_rec = cancellations_by_ticket.get(ticket)

        rows.append({
            "timestamp": r.get("timestamp"),
            "pair": r.get("pair"),
            "kind": "pending" if action == "pending_placed" else "market",
            "direction": r.get("direction"),
            "entry": r.get("entry"),
            "stop": r.get("stop"),
            "take": r.get("take"),
            "rr": r.get("rr"),
            "volume": r.get("volume"),
            "ticket": ticket,
            "status": status,
            "reason": (cancel_rec or {}).get("reason") if status == "cancelled" else None,
            "fill_price": in_deal.get("price") if in_deal else None,
            "fill_time": in_deal.get("time") if in_deal else None,
            "profit": profit,
            "close_price": close_price,
            "close_time": close_time,
            "signal_context": r.get("signal_context"),
            "attempt_id": r.get("attempt_id"),
        })

    # Also include MT5 orders that exist but were never logged locally
    # (e.g. manual orders placed in MT5 terminal directly).
    # Skip position-closing orders: when SL/TP/manual-close fires, MT5
    # creates a fresh order whose position_id points back to the opener.
    # Counting it again would double-book the same trade's profit.
    for o in mt5_orders:
        if o["ticket"] in seen_tickets:
            continue
        pos_id = o.get("position_id") or 0
        if pos_id and pos_id != o["ticket"]:
            continue
        status, position_id = _outcome_from_order(o["ticket"])
        profit, close_price, close_time, in_deal = _profit_from_position(position_id)
        if profit is not None:
            status = "closed"

        # Determine direction & kind from MT5 type
        type_name = o.get("type_name", "")
        is_pending = "limit" in type_name or "stop" in type_name
        direction = "buy" if "buy" in type_name else ("sell" if "sell" in type_name else None)

        # Timestamp from MT5 time_setup
        ts = None
        if o.get("time_setup"):
            ts = datetime.fromtimestamp(o["time_setup"], tz=timezone.utc).isoformat()

        rows.append({
            "timestamp": ts,
            "pair": o["symbol"],
            "kind": "pending" if is_pending else "market",
            "direction": direction,
            "entry": o.get("price_open"),
            "stop": o.get("sl"),
            "take": o.get("tp"),
            "rr": None,
            "volume": o.get("volume_initial"),
            "ticket": o["ticket"],
            "status": status,
            "reason": "external/manual" if o.get("magic") not in (mt5_bridge.MAGIC_MARKET, mt5_bridge.MAGIC_PENDING) else None,
            "fill_price": in_deal.get("price") if in_deal else None,
            "fill_time": in_deal.get("time") if in_deal else None,
            "profit": profit,
            "close_price": close_price,
            "close_time": close_time,
            "signal_context": None,
            "attempt_id": None,
            "source": "mt5_only",
        })

    # Sort: newest first
    rows.sort(key=lambda r: r.get("timestamp") or "", reverse=True)

    if status_filter:
        rows = [r for r in rows if r["status"] == status_filter]

    # Summary
    total = len(rows)
    closed = [r for r in rows if r["status"] == "closed"]
    wins = [r for r in closed if (r["profit"] or 0) > 0]
    summary = {
        "total_attempts": total,
        "placed": sum(1 for r in rows if r["status"] == "placed"),
        "filled": sum(1 for r in rows if r["status"] == "filled"),
        "closed": len(closed),
        "wins": len(wins),
        "losses": len(closed) - len(wins),
        "winrate": round(len(wins) / len(closed), 3) if closed else 0.0,
        "total_profit": round(sum(r["profit"] or 0 for r in closed), 2),
        "cancelled": sum(1 for r in rows if r["status"] == "cancelled"),
        "expired": sum(1 for r in rows if r["status"] == "expired"),
        "failed": sum(1 for r in rows if r["status"] in ("failed", "rejected")),
        "unknown": sum(1 for r in rows if r["status"] in ("unknown", "started", "partial")),
    }

    return {"success": True, "summary": summary, "rows": rows}


def _empty_stats() -> Dict[str, Any]:
    return {
        "trades": 0, "wins": 0, "losses": 0, "winrate": 0.0,
        "total_profit": 0.0, "avg_profit": 0.0, "best": 0.0, "worst": 0.0,
        "profit_factor": 0.0, "max_drawdown": 0.0,
        "consecutive_wins": 0, "consecutive_losses": 0,
        "avg_win": 0.0, "avg_loss": 0.0, "expectancy": 0.0,
    }


def _stats_for_deals(
    deals: List[dict],
    include_curve: bool = False,
    position_deals_map: Optional[Dict[int, List[dict]]] = None,
) -> Dict[str, Any]:
    """Compute winrate + risk metrics from a list of deals (only 'out' deals carry profit).

    If `position_deals_map` is provided, total_profit sums profit+swap+commission across
    every deal of each closed position (matches MT5's "Profit" line, including entry-side
    commission). Without the map it falls back to summing only the out deals.
    """
    outs = [d for d in deals if d.get("entry") == 1]   # entry=1 → out (closing)
    if not outs:
        return _empty_stats()
    # Time-sort outs for streak and drawdown calculations
    outs_sorted = sorted(outs, key=lambda d: d.get("time") or 0)
    wins = [d for d in outs if d["profit"] > 0]
    losses = [d for d in outs if d["profit"] <= 0]
    if position_deals_map:
        total = 0.0
        for d in outs:
            pid = d.get("position_id")
            for dd in position_deals_map.get(pid, [d]):
                total += dd.get("profit", 0) + dd.get("swap", 0) + dd.get("commission", 0)
    else:
        total = sum(d["profit"] + d.get("swap", 0) + d.get("commission", 0) for d in outs)
    profits = [d["profit"] for d in outs]

    # Profit factor
    gross_win = sum(p for p in profits if p > 0)
    gross_loss = abs(sum(p for p in profits if p < 0))
    profit_factor = round(gross_win / gross_loss, 3) if gross_loss > 0 else (gross_win if gross_win > 0 else 0.0)

    # Max drawdown (running equity curve)
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    curve = []
    for d in outs_sorted:
        cum += d["profit"]
        if cum > peak:
            peak = cum
        dd = peak - cum
        if dd > max_dd:
            max_dd = dd
        if include_curve:
            curve.append({"time": d.get("time"), "cum_profit": round(cum, 2)})

    # Consecutive wins/losses
    cur_w, cur_l, max_w, max_l = 0, 0, 0, 0
    for d in outs_sorted:
        if d["profit"] > 0:
            cur_w += 1; cur_l = 0
            if cur_w > max_w: max_w = cur_w
        else:
            cur_l += 1; cur_w = 0
            if cur_l > max_l: max_l = cur_l

    avg_win = round(gross_win / len(wins), 2) if wins else 0.0
    avg_loss = round(gross_loss / len(losses), 2) if losses else 0.0
    winrate = len(wins) / len(outs)
    expectancy = round(winrate * avg_win - (1 - winrate) * avg_loss, 2)

    result = {
        "trades": len(outs),
        "wins": len(wins),
        "losses": len(losses),
        "winrate": round(winrate, 3),
        "total_profit": round(total, 2),
        "avg_profit": round(sum(profits) / len(profits), 2),
        "best": round(max(profits), 2),
        "worst": round(min(profits), 2),
        "profit_factor": profit_factor,
        "max_drawdown": round(max_dd, 2),
        "consecutive_wins": max_w,
        "consecutive_losses": max_l,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "expectancy": expectancy,
    }
    if include_curve:
        result["equity_curve"] = curve
    return result


def _stats_by_hour(
    deals: List[dict],
    position_deals_map: Optional[Dict[int, List[dict]]] = None,
) -> Dict[int, Dict[str, Any]]:
    """Bucket out-deals by MSK hour (UTC+3)."""
    buckets: Dict[int, List[dict]] = {}
    for d in deals:
        if d.get("entry") != 1:
            continue
        ts = d.get("time")
        if not ts:
            continue
        hour_msk = ((datetime.fromtimestamp(ts, tz=timezone.utc).hour + 3) % 24)
        buckets.setdefault(hour_msk, []).append(d)
    return {
        h: _stats_for_deals(ds, position_deals_map=position_deals_map)
        for h, ds in sorted(buckets.items())
    }


def _stats_by_weekday(
    deals: List[dict],
    position_deals_map: Optional[Dict[int, List[dict]]] = None,
) -> Dict[int, Dict[str, Any]]:
    """Bucket out-deals by MSK weekday (0=Mon..6=Sun)."""
    buckets: Dict[int, List[dict]] = {}
    for d in deals:
        if d.get("entry") != 1:
            continue
        ts = d.get("time")
        if not ts:
            continue
        msk_dt = datetime.fromtimestamp(ts, tz=timezone.utc) + timedelta(hours=3)
        dow = msk_dt.weekday()  # 0=Mon..6=Sun
        buckets.setdefault(dow, []).append(d)
    return {
        d: _stats_for_deals(ds, position_deals_map=position_deals_map)
        for d, ds in sorted(buckets.items())
    }


def _stats_by_signal_context(local_records: List[dict], orders: List[dict], deals: List[dict]) -> Dict[str, Dict[str, Any]]:
    """Group pending attempts by signal_context.trend / .reversal and compute outcome stats."""
    # Build ticket → position_id → out-deal map
    tkt_to_pos = {o["ticket"]: o.get("position_id") for o in orders if o.get("ticket")}
    pos_to_out = {}
    position_deals_map: Dict[int, List[dict]] = {}
    for d in deals:
        if d.get("entry") == 1 and d.get("position_id"):
            pos_to_out[d["position_id"]] = d
        pid = d.get("position_id")
        if pid:
            position_deals_map.setdefault(pid, []).append(d)

    groups: Dict[str, List[dict]] = {}
    for att in local_records:
        if att.get("action") != "pending_placed":
            continue
        ctx = att.get("signal_context") or {}
        trend = ctx.get("trend") or "unknown"
        reversal = bool(ctx.get("reversal"))
        key = f"{trend}/{'reversal' if reversal else 'normal'}"
        tkt = att.get("ticket")
        pos = tkt_to_pos.get(tkt) if tkt else None
        out = pos_to_out.get(pos) if pos else None
        if out is not None:
            groups.setdefault(key, []).append(out)
        else:
            # No outcome yet — count as placed but not tradeable for stats
            groups.setdefault(key, [])
    return {
        k: _stats_for_deals(ds, position_deals_map=position_deals_map)
        for k, ds in sorted(groups.items())
    }


@app.get("/stats")
async def stats(
    days: int = Query(30, ge=1, le=365),
    pair: Optional[str] = None,
    include_curve: bool = Query(False),
    from_ts: Optional[int] = Query(None),
    x_api_secret: str = Header(None),
):
    """
    Aggregated stats for retrospective analysis:
      - by pair: winrate, profit_factor, drawdown, expectancy
      - by hour/weekday (MSK): temporal slices
      - by order type: market vs pending fill-rate, winrate
      - pending stats: placed / filled / cancelled / expired counts
    """
    require_auth(x_api_secret)
    if from_ts is None:
        from_ts = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    symbol = pair_to_mt5_symbol(pair) if pair else None

    deals_r = mt5_bridge.get_history_deals(from_ts, symbol=symbol)
    orders_r = mt5_bridge.get_history_orders(from_ts, symbol=symbol)
    deals = deals_r.get("deals", [])
    orders = orders_r.get("orders", [])

    position_deals_map: Dict[int, List[dict]] = {}
    for d in deals:
        pid = d.get("position_id")
        if pid:
            position_deals_map.setdefault(pid, []).append(d)

    # Overall
    overall = _stats_for_deals(deals, include_curve=include_curve, position_deals_map=position_deals_map)
    by_hour = _stats_by_hour(deals, position_deals_map=position_deals_map)
    by_weekday = _stats_by_weekday(deals, position_deals_map=position_deals_map)

    # By pair
    by_pair = {}
    for sym in sorted({d["symbol"] for d in deals}):
        by_pair[sym] = _stats_for_deals(
            [d for d in deals if d["symbol"] == sym],
            position_deals_map=position_deals_map,
        )

    # Pending vs market
    market_deals = [d for d in deals if d.get("magic") == mt5_bridge.MAGIC_MARKET]
    pending_deals = [d for d in deals if d.get("magic") == mt5_bridge.MAGIC_PENDING]
    by_kind = {
        "market": _stats_for_deals(market_deals, position_deals_map=position_deals_map),
        "pending": _stats_for_deals(pending_deals, position_deals_map=position_deals_map),
    }

    # Pending lifecycle stats (from MT5 orders)
    pending_orders = [o for o in orders if o.get("magic") == mt5_bridge.MAGIC_PENDING]
    states_count = {}
    for o in pending_orders:
        name = ORDER_STATE_NAMES.get(o["state"], str(o["state"]))
        states_count[name] = states_count.get(name, 0) + 1
    filled = states_count.get("filled", 0) + states_count.get("partial", 0)
    cancelled = states_count.get("cancelled", 0)
    expired = states_count.get("expired", 0)
    total_pending = len(pending_orders)
    fill_rate = round(filled / total_pending, 3) if total_pending else 0.0

    # Local log: pending attempts (placed and rejected)
    local = read_trade_log(days=days, pair=pair)
    placed_local = [r for r in local if r["action"] == "pending_placed"]
    rejected_local = [r for r in local if r["action"] in ("pending_failed", "pending_rejected")]

    return {
        "success": True,
        "period_days": days,
        "from_ts": from_ts,
        "pair": pair,
        "overall": overall,
        "by_pair": by_pair,
        "by_kind": by_kind,
        "by_hour": by_hour,
        "by_weekday": by_weekday,
        "pending_lifecycle": {
            "total": total_pending,
            "filled": filled,
            "cancelled": cancelled,
            "expired": expired,
            "fill_rate": fill_rate,
            "states": states_count,
        },
        "local_attempts": {
            "placed": len(placed_local),
            "rejected": len(rejected_local),
        },
    }


@app.get("/analysis")
async def analysis(
    pair: str,
    days: int = Query(60, ge=1, le=365),
    x_api_secret: str = Header(None),
):
    """
    Deep per-pair retrospective analysis with concrete recommendations.
    """
    require_auth(x_api_secret)

    from_ts = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    symbol = pair_to_mt5_symbol(pair)

    deals = mt5_bridge.get_history_deals(from_ts, symbol=symbol).get("deals", [])
    orders = mt5_bridge.get_history_orders(from_ts, symbol=symbol).get("orders", [])
    local = read_trade_log(days=days, pair=pair)

    position_deals_map: Dict[int, List[dict]] = {}
    for d in deals:
        pid = d.get("position_id")
        if pid:
            position_deals_map.setdefault(pid, []).append(d)

    out_deals = [d for d in deals if d.get("entry") == 1]
    stats_all = _stats_for_deals(deals, include_curve=True, position_deals_map=position_deals_map)
    by_hour = _stats_by_hour(deals, position_deals_map=position_deals_map)
    by_weekday = _stats_by_weekday(deals, position_deals_map=position_deals_map)
    by_signal_context = _stats_by_signal_context(local, orders, deals)

    pending_orders = [o for o in orders if o.get("magic") == mt5_bridge.MAGIC_PENDING]
    filled_pending = [o for o in pending_orders if o["state"] in (3, 4)]
    cancelled_pending = [o for o in pending_orders if o["state"] == 2]
    expired_pending = [o for o in pending_orders if o["state"] == 6]

    pending_attempts = [r for r in local if r.get("action") == "pending_placed"]

    # Correlate attempts with outcomes via ticket
    correlated = []
    for att in pending_attempts:
        tkt = att.get("ticket")
        if not tkt:
            continue
        matching = [o for o in orders if o["ticket"] == tkt]
        state = matching[0]["state"] if matching else None
        position_id = matching[0].get("position_id") if matching else None
        pos_deals = [d for d in deals if d.get("position_id") == position_id] if position_id else []
        out = next((d for d in pos_deals if d.get("entry") == 1), None)
        correlated.append({
            "attempt_id": att.get("attempt_id"),
            "timestamp": att.get("timestamp"),
            "ticket": tkt,
            "entry": att.get("entry"),
            "rr": att.get("rr"),
            "signal_context": att.get("signal_context"),
            "state": ORDER_STATE_NAMES.get(state, str(state) if state is not None else "unknown"),
            "profit": out.get("profit") if out else None,
            "close_price": out.get("price") if out else None,
        })

    # Build recommendations
    recommendations = []
    total_pending = len(pending_orders)
    if total_pending >= 5:
        fill_rate = len(filled_pending) / total_pending
        if fill_rate < 0.3:
            recommendations.append({
                "level": "warning",
                "text": f"Низкий fill-rate {fill_rate:.0%} ({len(filled_pending)}/{total_pending}). "
                        "Цена редко возвращается к уровню — рассмотри STOP вместо LIMIT или увеличь max_distance.",
            })
        elif fill_rate > 0.85:
            recommendations.append({
                "level": "info",
                "text": f"Очень высокий fill-rate {fill_rate:.0%} — стратегия хорошо ловит откаты на этой паре.",
            })

    if stats_all["trades"] >= 5:
        if stats_all["winrate"] < 0.3:
            recommendations.append({
                "level": "warning",
                "text": f"Низкий winrate {stats_all['winrate']:.0%} за {stats_all['trades']} сделок. "
                        "Рассмотри отключение пары или подъём min_rr.",
            })
        elif stats_all["winrate"] >= 0.6:
            recommendations.append({
                "level": "ok",
                "text": f"Хороший winrate {stats_all['winrate']:.0%} — пара работает стабильно.",
            })

    if len(expired_pending) > len(filled_pending) and len(expired_pending) >= 3:
        recommendations.append({
            "level": "warning",
            "text": f"Pending часто истекают ({len(expired_pending)} expired vs {len(filled_pending)} filled). "
                    "Увеличь ttl_hours или ставь pending ближе к рынку.",
        })

    return {
        "success": True,
        "pair": pair,
        "period_days": days,
        "deals_stats": stats_all,
        "by_hour": by_hour,
        "by_weekday": by_weekday,
        "by_signal_context": by_signal_context,
        "pending_breakdown": {
            "total": total_pending,
            "filled": len(filled_pending),
            "cancelled": len(cancelled_pending),
            "expired": len(expired_pending),
        },
        "attempts_correlated": correlated[-50:],   # last 50
        "recommendations": recommendations,
    }


if __name__ == "__main__":
    logger.info("Trade Executor v2 starting...")
    uvicorn.run(app, host="0.0.0.0", port=8500)
