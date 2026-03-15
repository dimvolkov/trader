"""
Trade Executor — FastAPI service that accepts trading signals and executes them on MT5.
Runs on Windows Server with native MetaTrader 5.
"""

import os
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

import mt5_bridge

# ─── Configuration ───
API_SECRET = os.getenv("EXECUTOR_API_SECRET", "change-me-to-a-real-secret")
MAX_OPEN_POSITIONS = int(os.getenv("MAX_OPEN_POSITIONS", "5"))
LOG_FILE = os.getenv("LOG_FILE", "C:/trade-executor/trades.log")

# ─── Logging ───
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
app = FastAPI(title="Trade Executor", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Trade log (JSON lines) ───
TRADE_LOG = Path(os.getenv("TRADE_LOG_JSON", "C:/trade-executor/trades.jsonl"))


def log_trade(data: dict):
    """Append trade record to JSON lines file."""
    data["timestamp"] = datetime.now(timezone.utc).isoformat()
    with open(TRADE_LOG, "a") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")


# ─── Models ───
class OrderRequest(BaseModel):
    pair: str = Field(..., description="Currency pair, e.g. EUR/USD")
    direction: str = Field(..., description="'up' or 'down'")
    entry: float = Field(..., description="Entry price")
    stop: float = Field(..., description="Stop loss price")
    take: float = Field(..., description="Take profit price")
    rr: float = Field(..., description="Risk/Reward ratio")
    volume: float = Field(0, description="Lot size (0 = auto-calculate)")
    deposit: float = Field(100000, description="Account deposit for position sizing")
    risk_pct: float = Field(0.01, description="Risk percentage (0.01 = 1%)")


# ─── Helper: pair conversion ───
def pair_to_mt5_symbol(pair: str) -> str:
    """Convert 'EUR/USD' to 'EURUSD' format for MT5."""
    return pair.replace("/", "")


def calculate_volume(
    pair: str, entry: float, stop: float, deposit: float, risk_pct: float
) -> float:
    """Calculate position size in lots based on risk."""
    risk_amount = deposit * risk_pct
    pip_value_approx = 0.0001 if "JPY" not in pair else 0.01
    stop_pips = abs(entry - stop) / pip_value_approx

    if stop_pips == 0:
        return 0.01

    # Standard lot = 100,000 units, 1 pip = ~$10 for major pairs
    lot_size = risk_amount / (stop_pips * 10)
    # Round to 2 decimal places, min 0.01
    lot_size = max(0.01, round(lot_size, 2))
    return lot_size


# ─── Endpoints ───
@app.get("/health")
async def health():
    """Health check."""
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/account")
async def account(x_api_secret: str = Header(None)):
    """Get MT5 account info."""
    if x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    result = mt5_bridge.account_info()
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "MT5 error"))
    return result


@app.get("/positions")
async def positions(x_api_secret: str = Header(None)):
    """Get open positions."""
    if x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    result = mt5_bridge.get_positions()
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "MT5 error"))
    return result


@app.post("/order")
async def create_order(order: OrderRequest, request: Request, x_api_secret: str = Header(None)):
    """
    Open a new trade order.
    Called by the scanner when a valid signal is found.
    """
    # Auth
    if x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    logger.info(f"Order request: {order.pair} {order.direction} entry={order.entry} stop={order.stop} take={order.take}")

    # Check max positions
    pos_result = mt5_bridge.get_positions()
    if pos_result.get("success"):
        open_count = len(pos_result.get("positions", []))
        if open_count >= MAX_OPEN_POSITIONS:
            msg = f"Max positions reached ({MAX_OPEN_POSITIONS}), skipping {order.pair}"
            logger.warning(msg)
            return {"success": False, "error": msg}

        # Check if already have position on this pair
        symbol = pair_to_mt5_symbol(order.pair)
        for p in pos_result.get("positions", []):
            if p["symbol"] == symbol:
                msg = f"Already have open position on {order.pair}, skipping"
                logger.warning(msg)
                return {"success": False, "error": msg}

    # Calculate volume if not provided
    volume = order.volume
    if volume <= 0:
        volume = calculate_volume(
            order.pair, order.entry, order.stop, order.deposit, order.risk_pct
        )

    # Convert direction
    mt5_direction = "buy" if order.direction == "up" else "sell"
    symbol = pair_to_mt5_symbol(order.pair)

    # Execute order
    result = mt5_bridge.open_order(
        symbol=symbol,
        direction=mt5_direction,
        volume=volume,
        entry_price=order.entry,
        stop_loss=order.stop,
        take_profit=order.take,
        comment=f"scan_{order.pair}_{order.rr:.1f}",
    )

    # Log trade
    log_trade({
        "action": "open",
        "pair": order.pair,
        "direction": mt5_direction,
        "volume": volume,
        "entry": order.entry,
        "stop": order.stop,
        "take": order.take,
        "rr": order.rr,
        "result": result,
    })

    if result.get("success"):
        logger.info(f"Order executed: {order.pair} {mt5_direction} vol={volume} id={result.get('order_id')}")
    else:
        logger.error(f"Order failed: {order.pair} — {result.get('error')}")

    return result


@app.post("/close/{ticket}")
async def close_order(ticket: int, x_api_secret: str = Header(None)):
    """Close a position by ticket number."""
    if x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    result = mt5_bridge.close_position(ticket)

    log_trade({
        "action": "close",
        "ticket": ticket,
        "result": result,
    })

    if result.get("success"):
        logger.info(f"Position closed: ticket={ticket}")
    else:
        logger.error(f"Close failed: ticket={ticket} — {result.get('error')}")

    return result


if __name__ == "__main__":
    logger.info("Trade Executor starting...")
    uvicorn.run(app, host="0.0.0.0", port=8500)
