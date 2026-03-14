#!/bin/bash
set -e

export WINEPREFIX=/opt/mt5/wine
export DISPLAY=:99

# ─── 1. Restore Wine prefix from build if volume is empty ───
if [ ! -d "/data/wine/drive_c" ]; then
    echo "First run — copying Wine+MT5 from image to volume..."
    cp -a /opt/mt5/wine/* /data/wine/ 2>/dev/null || true
fi
export WINEPREFIX=/data/wine

# ─── 2. Start Xvfb ───
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x800x24 -ac &
sleep 2

# ─── 3. Start x11vnc ───
echo "Starting VNC server..."
if [ -n "$VNC_PASSWORD" ]; then
    x11vnc -display :99 -forever -shared -rfbport 5900 -passwd "$VNC_PASSWORD" -bg -noxdamage
else
    x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -bg -noxdamage
fi
sleep 1

# ─── 4. Start noVNC ───
echo "Starting noVNC on port 6080..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &
sleep 1

# ─── 5. Start MT5 terminal ───
echo "Starting MetaTrader 5..."
wine "$WINEPREFIX/drive_c/Program Files/MetaTrader 5/terminal64.exe" &
sleep 5

# ─── 6. Start FastAPI executor ───
echo "============================================"
echo "  Trade Executor ready!"
echo "  API:   port 8500"
echo "  noVNC: port 6080"
echo "============================================"
exec python3 -m uvicorn executor:app --host 0.0.0.0 --port 8500
