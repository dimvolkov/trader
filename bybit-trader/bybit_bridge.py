"""ByBit V5 REST client.

Mirrors the role of trade-executor/mt5_bridge.py — a thin shim that hides the
exchange-specific API from app.py. All public functions return
``{"success": True, ...}`` on success or ``{"success": False, "error": str}``
on failure, matching the convention used by mt5_bridge.

We talk to the unified trading account (UTA) over the linear (USDT-perp)
category. Signed with HMAC-SHA256 per V5 spec.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any, Dict, Optional

import httpx

# Distinguishes orders placed by this bot from orders placed manually or by
# other systems on the same account.
MAGIC_PREFIX = "bbt"   # bybit-trader

_RECV_WINDOW = "5000"
_DEFAULT_TIMEOUT = 10.0


def _host(testnet: bool) -> str:
    return os.getenv(
        "BYBIT_API_HOST",
        "https://api-testnet.bybit.com" if testnet else "https://api.bybit.com",
    )


def _credentials():
    return (
        os.getenv("BYBIT_API_KEY", ""),
        os.getenv("BYBIT_API_SECRET", ""),
    )


def _sign(secret: str, prehash: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        prehash.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


async def _request(
    method: str,
    path: str,
    *,
    testnet: bool,
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    signed: bool = True,
) -> Dict[str, Any]:
    api_key, api_secret = _credentials()
    if signed and (not api_key or not api_secret):
        return {"success": False, "error": "BYBIT_API_KEY/SECRET not configured"}

    url = _host(testnet) + path
    headers: Dict[str, str] = {"Content-Type": "application/json"}

    payload_str = ""
    if body is not None:
        payload_str = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    elif params:
        # Bybit signs the canonical querystring (alphabetical), but httpx will
        # send the same order we give it. Sort to keep both consistent.
        payload_str = "&".join(
            f"{k}={params[k]}" for k in sorted(params)
        )

    if signed:
        ts = str(int(time.time() * 1000))
        sign = _sign(api_secret, ts + api_key + _RECV_WINDOW + payload_str)
        headers.update({
            "X-BAPI-API-KEY": api_key,
            "X-BAPI-TIMESTAMP": ts,
            "X-BAPI-RECV-WINDOW": _RECV_WINDOW,
            "X-BAPI-SIGN": sign,
        })

    try:
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
            if method == "GET":
                # Re-build params dict from the sorted string we signed so the
                # outgoing query exactly matches what we hashed.
                sorted_params = {k: params[k] for k in sorted(params)} if params else None
                r = await client.get(url, headers=headers, params=sorted_params)
            else:
                r = await client.request(
                    method, url, headers=headers, content=payload_str or None,
                )
    except httpx.HTTPError as exc:
        return {"success": False, "error": f"network: {exc}"}

    try:
        data = r.json()
    except ValueError:
        return {"success": False, "error": f"HTTP {r.status_code}: non-JSON body"}

    if data.get("retCode") != 0:
        return {
            "success": False,
            "error": data.get("retMsg") or f"retCode={data.get('retCode')}",
            "retCode": data.get("retCode"),
            "raw": data,
        }
    return {"success": True, **(data.get("result") or {}), "raw": data}


# ─── Public helpers ───────────────────────────────────────────────────────

async def get_wallet_balance(testnet: bool) -> Dict[str, Any]:
    res = await _request(
        "GET", "/v5/account/wallet-balance",
        testnet=testnet,
        params={"accountType": "UNIFIED"},
    )
    if not res.get("success"):
        return res
    # Flatten USDT coin entry to top level for convenience.
    accounts = res.get("list") or []
    usdt = {}
    if accounts:
        for coin in accounts[0].get("coin", []):
            if coin.get("coin") == "USDT":
                usdt = coin
                break
    return {
        "success": True,
        "totalEquity": float(accounts[0].get("totalEquity") or 0) if accounts else 0,
        "totalWalletBalance": float(accounts[0].get("totalWalletBalance") or 0) if accounts else 0,
        "totalAvailableBalance": float(accounts[0].get("totalAvailableBalance") or 0) if accounts else 0,
        "usdtWallet": float(usdt.get("walletBalance") or 0),
        "usdtEquity": float(usdt.get("equity") or 0),
        "usdtAvailable": float(usdt.get("availableToWithdraw") or usdt.get("walletBalance") or 0),
        "raw": res.get("raw"),
    }


async def get_positions(testnet: bool, symbol: Optional[str] = None) -> Dict[str, Any]:
    params = {"category": "linear", "settleCoin": "USDT"}
    if symbol:
        params = {"category": "linear", "symbol": symbol}
    res = await _request("GET", "/v5/position/list", testnet=testnet, params=params)
    if not res.get("success"):
        return res
    out = []
    for p in res.get("list") or []:
        try:
            size = float(p.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        if size <= 0:
            continue
        out.append({
            "symbol": p.get("symbol"),
            "side": p.get("side"),
            "size": size,
            "avgPrice": float(p.get("avgPrice") or 0),
            "markPrice": float(p.get("markPrice") or 0),
            "leverage": float(p.get("leverage") or 0),
            "unrealisedPnl": float(p.get("unrealisedPnl") or 0),
            "positionValue": float(p.get("positionValue") or 0),
            "takeProfit": float(p.get("takeProfit") or 0) or None,
            "stopLoss": float(p.get("stopLoss") or 0) or None,
            "positionIdx": p.get("positionIdx"),
            "createdTime": p.get("createdTime"),
            "updatedTime": p.get("updatedTime"),
        })
    return {"success": True, "positions": out}


_INSTRUMENT_CACHE: Dict[str, Dict[str, Any]] = {}
_INSTRUMENT_CACHE_TTL = 3600.0
_instrument_cache_ts: Dict[str, float] = {}


async def get_instrument_info(testnet: bool, symbol: str) -> Dict[str, Any]:
    """Return tickSize, qtyStep, minOrderQty, maxLeverage for symbol. Cached 1h."""
    key = f"{int(testnet)}:{symbol}"
    now = time.monotonic()
    if (key in _INSTRUMENT_CACHE
            and now - _instrument_cache_ts.get(key, 0) < _INSTRUMENT_CACHE_TTL):
        return {"success": True, **_INSTRUMENT_CACHE[key]}

    res = await _request(
        "GET", "/v5/market/instruments-info",
        testnet=testnet,
        params={"category": "linear", "symbol": symbol},
        signed=False,
    )
    if not res.get("success"):
        return res
    items = res.get("list") or []
    if not items:
        return {"success": False, "error": f"unknown symbol: {symbol}"}
    item = items[0]
    info = {
        "symbol": item.get("symbol"),
        "tickSize": float(item.get("priceFilter", {}).get("tickSize") or 0),
        "qtyStep": float(item.get("lotSizeFilter", {}).get("qtyStep") or 0),
        "minOrderQty": float(item.get("lotSizeFilter", {}).get("minOrderQty") or 0),
        "maxOrderQty": float(item.get("lotSizeFilter", {}).get("maxOrderQty") or 0),
        "maxLeverage": float(item.get("leverageFilter", {}).get("maxLeverage") or 100),
    }
    _INSTRUMENT_CACHE[key] = info
    _instrument_cache_ts[key] = now
    return {"success": True, **info}


async def get_ticker(testnet: bool, symbol: str) -> Dict[str, Any]:
    res = await _request(
        "GET", "/v5/market/tickers",
        testnet=testnet,
        params={"category": "linear", "symbol": symbol},
        signed=False,
    )
    if not res.get("success"):
        return res
    items = res.get("list") or []
    if not items:
        return {"success": False, "error": f"no ticker for {symbol}"}
    t = items[0]
    return {
        "success": True,
        "symbol": t.get("symbol"),
        "lastPrice": float(t.get("lastPrice") or 0),
        "bid1Price": float(t.get("bid1Price") or 0),
        "ask1Price": float(t.get("ask1Price") or 0),
    }


async def set_leverage(testnet: bool, symbol: str, leverage: int) -> Dict[str, Any]:
    res = await _request(
        "POST", "/v5/position/set-leverage",
        testnet=testnet,
        body={
            "category": "linear",
            "symbol": symbol,
            "buyLeverage": str(leverage),
            "sellLeverage": str(leverage),
        },
    )
    # leverage-not-modified (110043) is fine — treat as success.
    if (not res.get("success")) and res.get("retCode") == 110043:
        return {"success": True, "note": "leverage unchanged"}
    return res


def _round_step(value: float, step: float) -> float:
    if step <= 0:
        return value
    n = round(value / step)
    return round(n * step, 10)


def _round_down_step(value: float, step: float) -> float:
    if step <= 0:
        return value
    import math
    n = math.floor(value / step)
    return round(n * step, 10)


def round_price(value: float, tick: float) -> float:
    return _round_step(value, tick)


def round_qty(value: float, step: float) -> float:
    return _round_down_step(value, step)


async def place_order(
    *,
    testnet: bool,
    symbol: str,
    side: str,                # "Buy" | "Sell"
    qty: float,
    order_type: str = "Market",
    price: Optional[float] = None,
    take_profit: Optional[float] = None,
    stop_loss: Optional[float] = None,
    reduce_only: bool = False,
    order_link_id: Optional[str] = None,
    tp_trigger_by: str = "LastPrice",
    sl_trigger_by: str = "LastPrice",
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "category": "linear",
        "symbol": symbol,
        "side": side,
        "orderType": order_type,
        "qty": str(qty),
        "timeInForce": "GTC",
        "reduceOnly": reduce_only,
    }
    if order_type == "Limit":
        if price is None:
            return {"success": False, "error": "limit order needs price"}
        body["price"] = str(price)
    if take_profit:
        body["takeProfit"] = str(take_profit)
        body["tpTriggerBy"] = tp_trigger_by
    if stop_loss:
        body["stopLoss"] = str(stop_loss)
        body["slTriggerBy"] = sl_trigger_by
    if order_link_id:
        body["orderLinkId"] = order_link_id[:36]

    return await _request("POST", "/v5/order/create", testnet=testnet, body=body)


async def set_trading_stop(
    *,
    testnet: bool,
    symbol: str,
    take_profit: Optional[float] = None,
    stop_loss: Optional[float] = None,
    position_idx: int = 0,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "category": "linear",
        "symbol": symbol,
        "positionIdx": position_idx,
    }
    if take_profit is not None:
        body["takeProfit"] = str(take_profit)
    if stop_loss is not None:
        body["stopLoss"] = str(stop_loss)
    return await _request(
        "POST", "/v5/position/trading-stop",
        testnet=testnet, body=body,
    )


async def close_position(
    *,
    testnet: bool,
    symbol: str,
) -> Dict[str, Any]:
    """Close an open position market-reduce-only on the opposite side."""
    pos = await get_positions(testnet, symbol=symbol)
    if not pos.get("success"):
        return pos
    positions = pos.get("positions") or []
    if not positions:
        return {"success": False, "error": f"no open position on {symbol}"}
    p = positions[0]
    opposite = "Sell" if p["side"] == "Buy" else "Buy"
    return await place_order(
        testnet=testnet, symbol=symbol, side=opposite,
        qty=p["size"], order_type="Market", reduce_only=True,
        order_link_id=f"{MAGIC_PREFIX}-close-{int(time.time())}",
    )


async def get_closed_pnl(
    testnet: bool, symbol: Optional[str] = None, limit: int = 100,
) -> Dict[str, Any]:
    params: Dict[str, Any] = {"category": "linear", "limit": limit}
    if symbol:
        params["symbol"] = symbol
    res = await _request(
        "GET", "/v5/position/closed-pnl", testnet=testnet, params=params,
    )
    if not res.get("success"):
        return res
    out = []
    for r in res.get("list") or []:
        out.append({
            "symbol": r.get("symbol"),
            "side": r.get("side"),
            "qty": float(r.get("qty") or 0),
            "avgEntryPrice": float(r.get("avgEntryPrice") or 0),
            "avgExitPrice": float(r.get("avgExitPrice") or 0),
            "closedPnl": float(r.get("closedPnl") or 0),
            "leverage": float(r.get("leverage") or 0),
            "createdTime": r.get("createdTime"),
            "updatedTime": r.get("updatedTime"),
            "orderId": r.get("orderId"),
            "orderLinkId": r.get("orderLinkId"),
        })
    return {"success": True, "trades": out}


async def server_time(testnet: bool) -> Dict[str, Any]:
    return await _request("GET", "/v5/market/time", testnet=testnet, signed=False)


def normalize_side(direction: str) -> str:
    d = direction.lower()
    if d in ("buy", "long", "up"):
        return "Buy"
    if d in ("sell", "short", "down"):
        return "Sell"
    raise ValueError(f"bad direction: {direction}")
