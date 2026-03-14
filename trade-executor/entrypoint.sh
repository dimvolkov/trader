#!/bin/bash
set -e

export WINEPREFIX=/data/wine
export DISPLAY=:99

# ─── 1. Start Xvfb ───
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x800x24 -ac &
sleep 2

# ─── 2. Start x11vnc ───
echo "Starting VNC server..."
if [ -n "$VNC_PASSWORD" ]; then
    x11vnc -display :99 -forever -shared -rfbport 5900 -passwd "$VNC_PASSWORD" -bg -noxdamage
else
    x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -bg -noxdamage
fi
sleep 1

# ─── 3. Start noVNC ───
echo "Starting noVNC on port 6080..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &
sleep 1

# ─── 4. First run: initialize Wine + install MT5 + Python ───
if [ ! -f "/data/wine/.initialized" ]; then
    echo "============================================"
    echo "  FIRST RUN — Setting up Wine + MT5..."
    echo "  This will take 10-20 minutes."
    echo "============================================"

    # Init Wine prefix
    echo "[1/5] Initializing Wine prefix..."
    wineboot --init
    sleep 10
    wineserver --wait

    # Install Windows components
    echo "[2/5] Installing vcrun2019 + corefonts..."
    winetricks -q vcrun2019 corefonts
    wineserver --wait

    # Download and install MT5
    echo "[3/5] Installing MetaTrader 5..."
    wget -O /tmp/mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"
    wine /tmp/mt5setup.exe /auto
    sleep 30
    wineserver --wait
    rm -f /tmp/mt5setup.exe

    # Install Python in Wine
    echo "[4/5] Installing Python 3.10 in Wine..."
    wget -O /tmp/python-installer.exe "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
    wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=1 Include_pip=1
    sleep 20
    wineserver --wait
    rm -f /tmp/python-installer.exe

    # Install MetaTrader5 Python package
    echo "[5/5] Installing MetaTrader5 Python package..."
    wine pip install MetaTrader5
    wineserver --wait

    # Mark as initialized
    touch /data/wine/.initialized

    echo "============================================"
    echo "  Setup complete!"
    echo "  Open noVNC (port 6080) to login to MT5."
    echo "============================================"
fi

# ─── 5. Start MT5 terminal ───
MT5_EXE=$(find /data/wine -name "terminal64.exe" 2>/dev/null | head -1)
if [ -n "$MT5_EXE" ]; then
    echo "Starting MetaTrader 5..."
    wine "$MT5_EXE" &
    sleep 5
fi

# ─── 6. Start FastAPI executor ───
echo "============================================"
echo "  Trade Executor ready!"
echo "  API:   port 8500"
echo "  noVNC: port 6080"
echo "============================================"
exec python3 -m uvicorn executor:app --host 0.0.0.0 --port 8500
