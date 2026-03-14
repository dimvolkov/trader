#!/bin/bash
# ─── Install Python inside Wine for MetaTrader5 library ───
# Run after MT5 is installed
set -e

export WINEPREFIX=/opt/trade-executor/wine
export DISPLAY=:99

echo "=== Installing Python 3.10 inside Wine ==="

# Download Python 3.10 for Windows (required for MetaTrader5 lib)
PYTHON_URL="https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
wget -O /tmp/python-installer.exe "$PYTHON_URL"

echo "Installing Python in Wine (silent mode)..."
wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=1 Include_pip=1

echo "Waiting for install to complete..."
sleep 15

echo "Installing MetaTrader5 Python package..."
wine pip install MetaTrader5

echo ""
echo "=== Verifying installation ==="
wine python -c "import MetaTrader5; print('MetaTrader5 module OK')"

echo ""
echo "=== Done! ==="
echo "WINE_PYTHON is: python"
echo "Set WINE_PYTHON=python in your .env"
