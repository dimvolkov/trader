@echo off
:: ─── Trade Executor — Windows autostart script ───
:: Place shortcut to this file in: shell:startup
:: Or register as a Windows Service with NSSM

cd /d C:\trade-executor\trader\trade-executor

:: Load environment
set EXECUTOR_API_SECRET=your-random-secret-here
set MAX_OPEN_POSITIONS=5
set LOG_FILE=C:\trade-executor\trades.log
set TRADE_LOG_JSON=C:\trade-executor\trades.jsonl

:: Start executor
python executor.py
