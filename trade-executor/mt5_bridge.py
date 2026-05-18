"""
MT5 Bridge — connects to MetaTrader 5 terminal via native Python API.
Handles order execution, position management, account info, history.
"""

import logging
import os
from datetime import datetime, timezone

import MetaTrader5 as mt5

logger = logging.getLogger("mt5_bridge")

# Magic numbers — separate so we can distinguish in history/stats
MAGIC_MARKET = 123456
MAGIC_PENDING = 123457

# Some brokers append a suffix to symbol names (e.g. Alfa-Forex uses "rfd":
# USDCHFrfd, EURUSDrfd). If set, it's tried before broker-wide search.
SYMBOL_SUFFIX = os.getenv("MT5_SYMBOL_SUFFIX", "")

_symbol_cache: dict = {}


def _ensure_initialized() -> bool:
    """Initialize MT5 connection if not already connected."""
    if not mt5.terminal_info():
        if not mt5.initialize():
            logger.error(f"MT5 initialize failed: {mt5.last_error()}")
            return False
    return True


def resolve_symbol(base: str) -> str:
    """Return the actual MT5 symbol name for a bare pair like 'USDCHF'.

    Strategy:
      1. Cache hit
      2. Exact name `base`
      3. `base + SYMBOL_SUFFIX` (from MT5_SYMBOL_SUFFIX env)
      4. `mt5.symbols_get("*base*")` and pick the shortest match
    Returns the resolved name if found and selectable, otherwise returns
    `base` unchanged so downstream sees a clear "Cannot select" error.
    """
    if base in _symbol_cache:
        return _symbol_cache[base]
    if not _ensure_initialized():
        return base

    candidates = [base]
    if SYMBOL_SUFFIX and (base + SYMBOL_SUFFIX) not in candidates:
        candidates.append(base + SYMBOL_SUFFIX)

    for c in candidates:
        if mt5.symbol_select(c, True):
            _symbol_cache[base] = c
            return c

    # Pattern search across all broker symbols
    try:
        found = mt5.symbols_get(f"*{base}*") or []
    except Exception:
        found = []
    best = None
    for s in found:
        name = s.name
        if name == base:
            best = name
            break
        if best is None or len(name) < len(best):
            best = name
    if best and mt5.symbol_select(best, True):
        _symbol_cache[base] = best
        logger.info(f"resolve_symbol: {base} → {best} (broker suffix detected)")
        return best

    logger.warning(f"resolve_symbol: no match for {base}")
    return base


def account_info() -> dict:
    """Get MT5 account information."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    info = mt5.account_info()
    if info is None:
        return {"success": False, "error": "No account info"}

    return {
        "success": True,
        "login": info.login,
        "server": info.server,
        "balance": info.balance,
        "equity": info.equity,
        "margin": info.margin,
        "free_margin": info.margin_free,
        "currency": info.currency,
        "leverage": info.leverage,
    }


def get_symbol_info(symbol: str) -> dict:
    """Get symbol information (tick size, lot size, etc.)."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    if not mt5.symbol_select(symbol, True):
        return {"success": False, "error": f"Cannot select {symbol}"}

    info = mt5.symbol_info(symbol)
    if info is None:
        return {"success": False, "error": f"Symbol not found: {symbol}"}

    return {
        "success": True,
        "symbol": info.name,
        "bid": info.bid,
        "ask": info.ask,
        "spread": info.spread,
        "digits": info.digits,
        "point": info.point,
        "lot_min": info.volume_min,
        "lot_max": info.volume_max,
        "lot_step": info.volume_step,
        "trade_mode": info.trade_mode,
        "stops_level": info.trade_stops_level,
    }


def open_order(
    symbol: str,
    direction: str,
    volume: float,
    entry_price: float,
    stop_loss: float,
    take_profit: float,
    comment: str = "scanner",
) -> dict:
    """Open a market order on MT5."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    if not mt5.symbol_select(symbol, True):
        return {"success": False, "error": f"Cannot select {symbol}"}

    order_type = mt5.ORDER_TYPE_BUY if direction == "buy" else mt5.ORDER_TYPE_SELL
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"success": False, "error": "Cannot get price"}

    price = tick.ask if direction == "buy" else tick.bid
    if price == 0:
        return {"success": False, "error": "Cannot get price"}

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "sl": stop_loss,
        "tp": take_profit,
        "deviation": 20,
        "magic": MAGIC_MARKET,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": "order_send returned None"}

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "success": False,
            "error": f"Order failed: {result.retcode} — {result.comment}",
            "retcode": result.retcode,
        }

    return {
        "success": True,
        "order_id": result.order,
        "volume": result.volume,
        "price": result.price,
        "comment": result.comment,
    }


# ─── Pending orders ───

PENDING_TYPE_MAP = {
    "buy_limit":  mt5.ORDER_TYPE_BUY_LIMIT,
    "sell_limit": mt5.ORDER_TYPE_SELL_LIMIT,
    "buy_stop":   mt5.ORDER_TYPE_BUY_STOP,
    "sell_stop":  mt5.ORDER_TYPE_SELL_STOP,
}

PENDING_TYPE_NAMES = {v: k for k, v in PENDING_TYPE_MAP.items()}


def _resolve_pending_type(direction: str, entry: float, current_price: float, pending_type: str = "auto") -> str:
    """
    Decide which pending order type to use.
    - direction: 'buy' or 'sell'
    - pending_type: 'limit', 'stop', or 'auto' (decide by entry vs current)
    """
    if pending_type == "limit":
        return "buy_limit" if direction == "buy" else "sell_limit"
    if pending_type == "stop":
        return "buy_stop" if direction == "buy" else "sell_stop"
    # auto
    if direction == "buy":
        return "buy_limit" if entry < current_price else "buy_stop"
    return "sell_limit" if entry > current_price else "sell_stop"


def place_pending_order(
    symbol: str,
    direction: str,
    volume: float,
    entry_price: float,
    stop_loss: float,
    take_profit: float,
    pending_type: str = "auto",       # 'limit' | 'stop' | 'auto'
    expiration_ts: int = 0,           # unix seconds, 0 = GTC
    comment: str = "pending",
) -> dict:
    """
    Place a pending order (limit/stop) on MT5.
    Returns ticket on success.
    """
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    if not mt5.symbol_select(symbol, True):
        return {"success": False, "error": f"Cannot select {symbol}"}

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"success": False, "error": "Cannot get current price"}

    current_price = tick.ask if direction == "buy" else tick.bid
    resolved = _resolve_pending_type(direction, entry_price, current_price, pending_type)
    mt5_type = PENDING_TYPE_MAP[resolved]

    # Validate distance from stops_level
    info = mt5.symbol_info(symbol)
    if info is not None and info.trade_stops_level > 0:
        min_dist = info.trade_stops_level * info.point
        dist = abs(entry_price - current_price)
        if dist < min_dist:
            return {
                "success": False,
                "error": f"Entry {entry_price} too close to market {current_price} "
                         f"(stops_level={min_dist:.{info.digits}f})",
            }

    # Time policy
    if expiration_ts and expiration_ts > 0:
        type_time = mt5.ORDER_TIME_SPECIFIED
        expiration = int(expiration_ts)
    else:
        type_time = mt5.ORDER_TIME_GTC
        expiration = 0

    request = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": symbol,
        "volume": volume,
        "type": mt5_type,
        "price": entry_price,
        "sl": stop_loss,
        "tp": take_profit,
        "deviation": 20,
        "magic": MAGIC_PENDING,
        "comment": comment[:31],   # MT5 comment max 31 chars
        "type_time": type_time,
        "expiration": expiration,
        "type_filling": mt5.ORDER_FILLING_RETURN,
    }

    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": f"order_send returned None: {mt5.last_error()}"}

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "success": False,
            "error": f"Pending failed: {result.retcode} — {result.comment}",
            "retcode": result.retcode,
        }

    return {
        "success": True,
        "ticket": result.order,
        "order_type": resolved,
        "entry": entry_price,
        "sl": stop_loss,
        "tp": take_profit,
        "volume": result.volume,
        "current_price_at_place": current_price,
        "comment": result.comment,
    }


def get_pending_orders(symbol: str = None) -> dict:
    """Get active pending orders, optionally filtered by symbol."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    orders = mt5.orders_get(symbol=symbol) if symbol else mt5.orders_get()
    if orders is None:
        orders = []

    result = []
    for o in orders:
        result.append({
            "ticket": o.ticket,
            "symbol": o.symbol,
            "type": PENDING_TYPE_NAMES.get(o.type, str(o.type)),
            "type_code": o.type,
            "volume": o.volume_initial,
            "price_open": o.price_open,
            "sl": o.sl,
            "tp": o.tp,
            "magic": o.magic,
            "comment": o.comment,
            "time_setup": o.time_setup,
            "time_expiration": o.time_expiration,
        })

    return {"success": True, "orders": result}


def cancel_pending_order(ticket: int) -> dict:
    """Cancel a pending order by ticket."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    request = {
        "action": mt5.TRADE_ACTION_REMOVE,
        "order": ticket,
    }
    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": f"order_send returned None: {mt5.last_error()}"}

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "success": False,
            "error": f"Cancel failed: {result.retcode} — {result.comment}",
            "retcode": result.retcode,
        }

    return {"success": True, "ticket": ticket}


def modify_pending_order(ticket: int, entry: float = None, sl: float = None, tp: float = None) -> dict:
    """Modify price/sl/tp on an existing pending order."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    orders = mt5.orders_get(ticket=ticket)
    if not orders:
        return {"success": False, "error": "Pending not found"}
    o = orders[0]

    request = {
        "action": mt5.TRADE_ACTION_MODIFY,
        "order": ticket,
        "price": entry if entry is not None else o.price_open,
        "sl": sl if sl is not None else o.sl,
        "tp": tp if tp is not None else o.tp,
        "type_time": o.type_time,
        "expiration": o.time_expiration,
    }
    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": f"order_send returned None: {mt5.last_error()}"}

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "success": False,
            "error": f"Modify failed: {result.retcode} — {result.comment}",
            "retcode": result.retcode,
        }

    return {"success": True, "ticket": ticket}


def cancel_pending_by_symbol(symbol: str, only_pending_magic: bool = True) -> dict:
    """Cancel all pending orders on a given symbol (optionally only those placed by us)."""
    result = get_pending_orders(symbol=symbol)
    if not result.get("success"):
        return result

    cancelled = []
    failed = []
    for o in result["orders"]:
        if only_pending_magic and o["magic"] != MAGIC_PENDING:
            continue
        r = cancel_pending_order(o["ticket"])
        if r.get("success"):
            cancelled.append(o["ticket"])
        else:
            failed.append({"ticket": o["ticket"], "error": r.get("error")})

    return {"success": True, "cancelled": cancelled, "failed": failed}


# ─── Positions ───

def get_positions() -> dict:
    """Get all open positions."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    positions = mt5.positions_get()
    if positions is None:
        positions = []

    result = []
    for p in positions:
        result.append({
            "ticket": p.ticket,
            "symbol": p.symbol,
            "type": "buy" if p.type == 0 else "sell",
            "volume": p.volume,
            "price_open": p.price_open,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
            "magic": p.magic,
            "comment": p.comment,
        })

    return {"success": True, "positions": result}


def close_position(ticket: int) -> dict:
    """Close a specific position by ticket."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    position = mt5.positions_get(ticket=ticket)
    if not position:
        return {"success": False, "error": "Position not found"}

    pos = position[0]
    close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
    tick = mt5.symbol_info_tick(pos.symbol)
    if tick is None:
        return {"success": False, "error": f"Cannot get tick for {pos.symbol}"}

    price = tick.bid if pos.type == 0 else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": pos.volume,
        "type": close_type,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": pos.magic or MAGIC_MARKET,
        "comment": "close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": "order_send returned None"}

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": f"{result.retcode} — {result.comment}"}

    return {"success": True, "ticket": ticket, "closed_price": result.price}


# ─── History (for retrospective analysis) ───

def get_history_deals(from_ts: int, to_ts: int = None, symbol: str = None) -> dict:
    """Get historical deals (executed trades) between two unix timestamps."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    if to_ts is None:
        to_ts = int(datetime.now(timezone.utc).timestamp())

    from_dt = datetime.fromtimestamp(from_ts, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(to_ts, tz=timezone.utc)

    if symbol:
        deals = mt5.history_deals_get(from_dt, to_dt, group=symbol)
    else:
        deals = mt5.history_deals_get(from_dt, to_dt)

    if deals is None:
        deals = []

    result = []
    for d in deals:
        result.append({
            "ticket": d.ticket,
            "order": d.order,
            "position_id": d.position_id,
            "symbol": d.symbol,
            "type": d.type,   # 0=buy, 1=sell
            "entry": d.entry, # 0=in, 1=out, 2=inout
            "volume": d.volume,
            "price": d.price,
            "profit": d.profit,
            "swap": d.swap,
            "commission": d.commission,
            "magic": d.magic,
            "comment": d.comment,
            "time": d.time,
        })

    return {"success": True, "deals": result}


def get_history_orders(from_ts: int, to_ts: int = None, symbol: str = None) -> dict:
    """Get historical orders (including filled, cancelled, expired) between two unix timestamps."""
    if not _ensure_initialized():
        return {"success": False, "error": str(mt5.last_error())}

    if to_ts is None:
        to_ts = int(datetime.now(timezone.utc).timestamp())

    from_dt = datetime.fromtimestamp(from_ts, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(to_ts, tz=timezone.utc)

    if symbol:
        orders = mt5.history_orders_get(from_dt, to_dt, group=symbol)
    else:
        orders = mt5.history_orders_get(from_dt, to_dt)

    if orders is None:
        orders = []

    result = []
    for o in orders:
        result.append({
            "ticket": o.ticket,
            "symbol": o.symbol,
            "type": o.type,
            "type_name": PENDING_TYPE_NAMES.get(o.type, str(o.type)),
            "state": o.state,   # 0=started, 1=placed, 2=cancelled, 3=partial, 4=filled, 5=rejected, 6=expired
            "price_open": o.price_open,
            "sl": o.sl,
            "tp": o.tp,
            "volume_initial": o.volume_initial,
            "volume_current": o.volume_current,
            "magic": o.magic,
            "comment": o.comment,
            "time_setup": o.time_setup,
            "time_done": o.time_done,
            "position_id": o.position_id,
        })

    return {"success": True, "orders": result}
