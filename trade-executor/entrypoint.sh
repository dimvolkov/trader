#!/bin/bash

export WINEPREFIX=/data/wine
export DISPLAY=:99
export WINEDEBUG=-all

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ─── 1. Start Xvfb ───
log "Starting Xvfb..."
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1920x1080x24 -ac &
sleep 3

if ! xdpyinfo -display :99 >/dev/null 2>&1; then
    log "ERROR: Xvfb failed to start"
    exit 1
fi
log "Xvfb started OK"

# ─── 2. Start x11vnc (no auth) ───
log "Starting VNC server..."
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -bg -noxdamage -q
sleep 1

# ─── 3. Start noVNC ───
log "Starting noVNC on port 6080..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &
sleep 1

# ─── 3.1 Clipboard sync ───
log "Starting clipboard sync..."
autocutsel -fork -selection CLIPBOARD 2>/dev/null || true
autocutsel -fork -selection PRIMARY 2>/dev/null || true

# ─── 4. First run: initialize Wine + Python ───
if [ ! -f "/data/wine/.initialized" ]; then
    log "============================================"
    log "  FIRST RUN — Setting up Wine environment"
    log "============================================"

    # ── 4.1 Init Wine prefix ──
    log "[1/4] Initializing Wine prefix..."
    rm -rf /data/wine/*
    WINEARCH=win64 wine wineboot --init 2>&1 | tail -5
    log "wineboot exit code: $?"
    sleep 15
    wineserver --wait 2>/dev/null || true

    if [ ! -d "/data/wine/drive_c" ]; then
        log "ERROR: Wine prefix not created — /data/wine/drive_c missing!"
        exit 1
    fi
    log "Wine prefix created OK"

    # ── 4.2 Install Windows components ──
    log "[2/4] Installing vcrun2019 + corefonts..."
    winetricks -q vcrun2019 2>&1 | tail -3
    log "vcrun2019 done (exit: $?)"
    winetricks -q corefonts 2>&1 | tail -3
    log "corefonts done (exit: $?)"
    wineserver --wait 2>/dev/null || true

    # ── 4.3 Install Python in Wine ──
    log "[3/4] Installing Python 3.10 in Wine..."
    PYTHON_URL="https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
    wget -q -O /tmp/python-installer.exe "$PYTHON_URL"
    PY_SIZE=$(stat -c%s /tmp/python-installer.exe 2>/dev/null || echo 0)
    log "Python installer size: $PY_SIZE bytes"

    if [ "$PY_SIZE" -gt 1000000 ]; then
        wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=1 Include_pip=1 2>&1 | tail -5 &
        PY_INSTALL_PID=$!
        WAIT_COUNT=0
        while kill -0 $PY_INSTALL_PID 2>/dev/null; do
            WAIT_COUNT=$((WAIT_COUNT + 1))
            if [ $WAIT_COUNT -ge 36 ]; then
                log "WARNING: Python installer timeout, killing..."
                kill $PY_INSTALL_PID 2>/dev/null || true
                wineserver -k 2>/dev/null || true
                break
            fi
            sleep 5
        done
        wineserver --wait 2>/dev/null || true

        WINE_PYTHON=$(find /data/wine -name "python.exe" -path "*/Python*" 2>/dev/null | head -1)
        if [ -n "$WINE_PYTHON" ]; then
            log "Wine Python found: $WINE_PYTHON"
            log "Installing MetaTrader5 Python package..."
            wine "$WINE_PYTHON" -m pip install MetaTrader5 2>&1 | tail -5
            log "MetaTrader5 pip install exit: $?"
        else
            log "WARNING: Python not found in Wine after install"
        fi
    else
        log "ERROR: Python installer download failed"
    fi
    rm -f /tmp/python-installer.exe

    # ── 4.4 Download MT5 installer to Desktop ──
    log "[4/4] Downloading MT5 installer..."
    MT5_URL="https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"
    DESKTOP_DIR="/data/wine/drive_c/users/root/Desktop"
    mkdir -p "$DESKTOP_DIR"
    wget -q -O "$DESKTOP_DIR/mt5setup.exe" "$MT5_URL"
    MT5_SIZE=$(stat -c%s "$DESKTOP_DIR/mt5setup.exe" 2>/dev/null || echo 0)
    log "MT5 installer saved to Desktop: $MT5_SIZE bytes"

    touch /data/wine/.initialized

    log "============================================"
    log "  Wine environment ready!"
    log ""
    log "  MT5 REQUIRES MANUAL INSTALLATION:"
    log "  1. Open noVNC: http://<host>:6080"
    log "  2. Double-click mt5setup.exe on Desktop"
    log "  3. Follow the installer"
    log "  4. Restart the container after install"
    log ""
    WINE_PYTHON=$(find /data/wine -name "python.exe" -path "*/Python*" 2>/dev/null | head -1)
    [ -n "$WINE_PYTHON" ] && log "  Python: OK" || log "  Python: NOT FOUND"
    log "============================================"
fi

# ─── 5. Check if MT5 needs installation ───
MT5_EXE=$(find /data/wine -name "terminal64.exe" -type f 2>/dev/null | head -1)
if [ -z "$MT5_EXE" ]; then
    # MT5 not installed yet — check if installer is on Desktop
    DESKTOP_DIR="/data/wine/drive_c/users/root/Desktop"
    if [ -f "$DESKTOP_DIR/mt5setup.exe" ]; then
        log "============================================"
        log "  MT5 NOT INSTALLED YET"
        log ""
        log "  Open noVNC to install:"
        log "    http://<host>:6080"
        log ""
        log "  mt5setup.exe is on the Desktop."
        log "  Double-click it to start installation."
        log "  After install — restart the container."
        log "============================================"
    else
        log "WARNING: MT5 not installed and no installer found"
        log "Download mt5setup.exe from mql5.com via noVNC"
    fi
else
    # ─── 6. Start MT5 terminal ───
    log "Starting MetaTrader 5: $MT5_EXE"
    wine "$MT5_EXE" &
    sleep 5
    if pgrep -f terminal64 >/dev/null 2>&1; then
        log "MT5 is running"
    else
        log "WARNING: MT5 process not detected after launch"
    fi
fi

# ─── 7. Start FastAPI executor ───
log "============================================"
log "  Trade Executor ready!"
log "  API:   port 8500"
log "  noVNC: port 6080"
log "============================================"
exec python3 -m uvicorn executor:app --host 0.0.0.0 --port 8500
