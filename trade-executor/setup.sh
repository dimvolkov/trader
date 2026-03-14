#!/bin/bash
# ─── Trade Executor Setup Script ───
# Run on a fresh Ubuntu 22.04+ server
# Usage: chmod +x setup.sh && sudo ./setup.sh

set -e

echo "=== Trade Executor Setup ==="
echo "This will install: Wine, MetaTrader 5, Python 3, FastAPI"
echo ""

# ─── 1. System update ───
echo "[1/6] Updating system..."
apt update && apt upgrade -y

# ─── 2. Install Wine ───
echo "[2/6] Installing Wine..."
dpkg --add-architecture i386
mkdir -pm755 /etc/apt/keyrings
wget -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key
CODENAME=$(lsb_release -cs)
wget -NP /etc/apt/sources.list.d/ "https://dl.winehq.org/wine-builds/ubuntu/dists/${CODENAME}/winehq-${CODENAME}.sources"
apt update
apt install -y --install-recommends winehq-stable || apt install -y wine64 wine32

# ─── 3. Install Xvfb (virtual display for MT5) ───
echo "[3/6] Installing Xvfb (virtual display)..."
apt install -y xvfb wget cabextract

# ─── 4. Install winetricks ───
echo "[4/6] Installing winetricks..."
wget -O /usr/local/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks
chmod +x /usr/local/bin/winetricks

# ─── 5. Install Python and dependencies ───
echo "[5/6] Installing Python..."
apt install -y python3 python3-pip python3-venv

# Create venv and install packages
python3 -m venv /opt/trade-executor/venv
/opt/trade-executor/venv/bin/pip install fastapi uvicorn requests

# ─── 6. Setup Wine prefix and MT5 ───
echo "[6/6] Setting up Wine prefix..."
export WINEPREFIX=/opt/trade-executor/wine
export WINEARCH=win64
export DISPLAY=:99

# Start virtual display
Xvfb :99 -screen 0 1024x768x16 &
XVFB_PID=$!
sleep 2

# Initialize wine prefix
wineboot --init
sleep 5

# Install required Windows components
winetricks -q vcrun2019 dotnet48 corefonts

# Download MT5 installer
echo "Downloading MetaTrader 5..."
MT5_INSTALLER="/tmp/mt5setup.exe"
wget -O "$MT5_INSTALLER" "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"

echo ""
echo "=== IMPORTANT: Manual step required ==="
echo "Run the following command to install MT5:"
echo ""
echo "  export WINEPREFIX=/opt/trade-executor/wine DISPLAY=:99"
echo "  wine $MT5_INSTALLER /auto"
echo ""
echo "After MT5 is installed, login to your Alfa-Forex demo account in MT5."
echo "Then copy the executor files:"
echo ""
echo "  cp executor.py /opt/trade-executor/"
echo "  cp mt5_bridge.py /opt/trade-executor/"
echo "  cp .env /opt/trade-executor/"
echo "  cp trade-executor.service /etc/systemd/system/"
echo "  systemctl daemon-reload"
echo "  systemctl enable --now trade-executor"
echo ""

# Stop Xvfb
kill $XVFB_PID 2>/dev/null || true

echo "=== Setup base complete ==="
