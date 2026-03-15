"""
MT5 Bridge — connects to MetaTrader 5 terminal via native Python API.
Handles order execution, position management, account info.
"""

import logging

import MetaTrader5 as mt5

logger = logging.getLogger("mt5_bridge")


def _ensure_initialized() -> bool:
    """Initialize MT5 connection if not already connected."""
    if not mt5.terminal_info():
        if not mt5.initialize():
            logger.error(f"MT5 initialize failed: {mt5.last_error()}")
            return False
    return True


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
        "lot_min": info.volume_min,
        "lot_max": info.volume_max,
        "lot_step": info.volume_step,
        "trade_mode": info.trade_mode,
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
        "magic": 123456,
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
        "magic": 123456,
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
