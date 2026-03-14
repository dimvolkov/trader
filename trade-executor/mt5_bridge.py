"""
MT5 Bridge — connects to MetaTrader 5 terminal via Wine
Handles order execution, position management, account info
"""

import subprocess
import json
import os
import tempfile
import time
import logging

logger = logging.getLogger("mt5_bridge")

WINEPREFIX = os.getenv("WINEPREFIX", "/opt/trade-executor/wine")
WINE_PYTHON = os.getenv("WINE_PYTHON", "python.exe")
MT5_TIMEOUT = int(os.getenv("MT5_TIMEOUT", "30"))


def _run_mt5_script(script: str) -> dict:
    """Run a Python script inside Wine that uses MetaTrader5 library."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, dir="/tmp") as f:
        f.write(script)
        script_path = f.name

    try:
        # Convert Linux path to Wine path
        wine_path = subprocess.run(
            ["winepath", "-w", script_path],
            capture_output=True, text=True,
            env={**os.environ, "WINEPREFIX": WINEPREFIX},
        ).stdout.strip()

        result = subprocess.run(
            ["wine", WINE_PYTHON, wine_path],
            capture_output=True, text=True, timeout=MT5_TIMEOUT,
            env={
                **os.environ,
                "WINEPREFIX": WINEPREFIX,
                "DISPLAY": os.getenv("DISPLAY", ":99"),
            },
        )

        if result.returncode != 0:
            logger.error(f"MT5 script error: {result.stderr}")
            return {"success": False, "error": result.stderr.strip()}

        # Parse JSON output from script
        output = result.stdout.strip()
        for line in output.split("\n"):
            line = line.strip()
            if line.startswith("{"):
                return json.loads(line)

        return {"success": False, "error": f"No JSON output: {output}"}

    except subprocess.TimeoutExpired:
        return {"success": False, "error": "MT5 script timeout"}
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        os.unlink(script_path)


def account_info() -> dict:
    """Get MT5 account information."""
    script = """
import MetaTrader5 as mt5
import json

if not mt5.initialize():
    print(json.dumps({"success": False, "error": mt5.last_error()}))
    quit()

info = mt5.account_info()
if info is None:
    print(json.dumps({"success": False, "error": "No account info"}))
    mt5.shutdown()
    quit()

print(json.dumps({
    "success": True,
    "login": info.login,
    "server": info.server,
    "balance": info.balance,
    "equity": info.equity,
    "margin": info.margin,
    "free_margin": info.margin_free,
    "currency": info.currency,
    "leverage": info.leverage,
}))
mt5.shutdown()
"""
    return _run_mt5_script(script)


def get_symbol_info(symbol: str) -> dict:
    """Get symbol information (tick size, lot size, etc.)."""
    script = f"""
import MetaTrader5 as mt5
import json

if not mt5.initialize():
    print(json.dumps({{"success": False, "error": mt5.last_error()}}))
    quit()

info = mt5.symbol_info("{symbol}")
if info is None:
    print(json.dumps({{"success": False, "error": "Symbol not found: {symbol}"}}))
    mt5.shutdown()
    quit()

print(json.dumps({{
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
}}))
mt5.shutdown()
"""
    return _run_mt5_script(script)


def open_order(
    symbol: str,
    direction: str,
    volume: float,
    entry_price: float,
    stop_loss: float,
    take_profit: float,
    comment: str = "scanner",
) -> dict:
    """
    Open a market order on MT5.

    Args:
        symbol: e.g. "EURUSD"
        direction: "buy" or "sell"
        volume: lot size
        entry_price: desired entry (used for deviation calc)
        stop_loss: stop loss price
        take_profit: take profit price
        comment: order comment
    """
    order_type = "mt5.ORDER_TYPE_BUY" if direction == "buy" else "mt5.ORDER_TYPE_SELL"
    price_field = "mt5.symbol_info_tick(symbol).ask" if direction == "buy" else "mt5.symbol_info_tick(symbol).bid"

    script = f"""
import MetaTrader5 as mt5
import json

symbol = "{symbol}"
if not mt5.initialize():
    print(json.dumps({{"success": False, "error": str(mt5.last_error())}}))
    quit()

# Ensure symbol is available
if not mt5.symbol_select(symbol, True):
    print(json.dumps({{"success": False, "error": f"Cannot select {{symbol}}"}}))
    mt5.shutdown()
    quit()

price = {price_field}
if price is None or price == 0:
    print(json.dumps({{"success": False, "error": "Cannot get price"}}))
    mt5.shutdown()
    quit()

request = {{
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": symbol,
    "volume": {volume},
    "type": {order_type},
    "price": price,
    "sl": {stop_loss},
    "tp": {take_profit},
    "deviation": 20,
    "magic": 123456,
    "comment": "{comment}",
    "type_time": mt5.ORDER_TIME_GTC,
    "type_filling": mt5.ORDER_FILLING_IOC,
}}

result = mt5.order_send(request)
if result is None:
    print(json.dumps({{"success": False, "error": "order_send returned None"}}))
    mt5.shutdown()
    quit()

if result.retcode != mt5.TRADE_RETCODE_DONE:
    print(json.dumps({{
        "success": False,
        "error": f"Order failed: {{result.retcode}} — {{result.comment}}",
        "retcode": result.retcode,
    }}))
else:
    print(json.dumps({{
        "success": True,
        "order_id": result.order,
        "volume": result.volume,
        "price": result.price,
        "comment": result.comment,
    }}))

mt5.shutdown()
"""
    return _run_mt5_script(script)


def get_positions() -> dict:
    """Get all open positions."""
    script = """
import MetaTrader5 as mt5
import json

if not mt5.initialize():
    print(json.dumps({"success": False, "error": str(mt5.last_error())}))
    quit()

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

print(json.dumps({"success": True, "positions": result}))
mt5.shutdown()
"""
    return _run_mt5_script(script)


def close_position(ticket: int) -> dict:
    """Close a specific position by ticket."""
    script = f"""
import MetaTrader5 as mt5
import json

if not mt5.initialize():
    print(json.dumps({{"success": False, "error": str(mt5.last_error())}}))
    quit()

position = mt5.positions_get(ticket={ticket})
if not position:
    print(json.dumps({{"success": False, "error": "Position not found"}}))
    mt5.shutdown()
    quit()

pos = position[0]
close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
price = mt5.symbol_info_tick(pos.symbol).bid if pos.type == 0 else mt5.symbol_info_tick(pos.symbol).ask

request = {{
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": pos.symbol,
    "volume": pos.volume,
    "type": close_type,
    "position": {ticket},
    "price": price,
    "deviation": 20,
    "magic": 123456,
    "comment": "close",
    "type_time": mt5.ORDER_TIME_GTC,
    "type_filling": mt5.ORDER_FILLING_IOC,
}}

result = mt5.order_send(request)
if result is None:
    print(json.dumps({{"success": False, "error": "order_send returned None"}}))
elif result.retcode != mt5.TRADE_RETCODE_DONE:
    print(json.dumps({{"success": False, "error": f"{{result.retcode}} — {{result.comment}}"}}))
else:
    print(json.dumps({{"success": True, "ticket": {ticket}, "closed_price": result.price}}))

mt5.shutdown()
"""
    return _run_mt5_script(script)
