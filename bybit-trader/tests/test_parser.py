"""Unit tests for signal_parser regex stage.

Run with:
    cd bybit-trader && python -m pytest tests/
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from signal_parser import _regex_parse, parse_signal   # noqa: E402


def test_basic_long():
    text = "LONG BTCUSDT\nEntry: 65000\nSL: 64000\nTP1: 67000\nTP2: 70000"
    r = _regex_parse(text)
    assert r is not None
    assert r["pair"] == "BTCUSDT"
    assert r["direction"] == "Buy"
    assert r["entry"] == 65000
    assert r["stop"] == 64000
    assert r["takes"] == [67000, 70000]


def test_basic_short_slash_pair():
    text = "SHORT ETH/USDT @ 3500\nStop loss: 3650\nTake profit: 3300"
    r = _regex_parse(text)
    assert r is not None
    assert r["pair"] == "ETHUSDT"
    assert r["direction"] == "Sell"
    assert r["entry"] == 3500
    assert r["stop"] == 3650
    assert r["takes"] == [3300]


def test_russian():
    text = "Лонг $SOL\nЦена входа: 145.5\nСтоп: 140\nЦель 1: 155, Цель 2: 165"
    r = _regex_parse(text)
    assert r is not None
    assert r["pair"] == "SOLUSDT"
    assert r["direction"] == "Buy"
    assert r["entry"] == 145.5
    assert r["stop"] == 140
    assert r["takes"] == [155, 165]


def test_market_entry_no_explicit_price():
    text = "BUY BTC-USDT now\nSL 63500\nTP 66000"
    r = _regex_parse(text)
    assert r is not None
    assert r["pair"] == "BTCUSDT"
    assert r["direction"] == "Buy"
    assert r["entry"] is None
    assert r["stop"] == 63500
    assert r["takes"] == [66000]


def test_not_a_signal_commentary():
    text = "BTC сегодня прыгнул на 5%, рынок волатилен"
    assert _regex_parse(text) is None


def test_not_a_signal_no_stop_no_tp():
    text = "Думаю LONG BTCUSDT по 65000 интересен"
    assert _regex_parse(text) is None


def test_dedupe_repeated_tp():
    text = "LONG BTCUSDT @ 65000 SL 64000 TP1 67000 TP1 67000 TP2 68000"
    r = _regex_parse(text)
    assert r["takes"] == [67000, 68000]


def test_empty_returns_none():
    assert parse_signal("") is None
    assert parse_signal("   \n  ") is None


def test_comma_decimal():
    text = "LONG BTCUSDT entry 65000,5 sl 64000,1 tp 66000,9"
    r = _regex_parse(text)
    assert r["entry"] == 65000.5
    assert r["stop"] == 64000.1
    assert r["takes"] == [66000.9]
