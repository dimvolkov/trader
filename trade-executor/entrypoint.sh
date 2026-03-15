#!/bin/bash

export WINEPREFIX=/data/wine
export DISPLAY=:99
export WINEDEBUG=-all

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ─── 1. Start Xvfb ───
log "Starting Xvfb..."
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x800x24 -ac &
sleep 3

if ! xdpyinfo -display :99 >/dev/null 2>&1; then
    log "ERROR: Xvfb failed to start"
    exit 1
fi
log "Xvfb started OK"

# ─── 2. Start x11vnc ───
log "Starting VNC server..."
if [ -n "$VNC_PASSWORD" ]; then
    x11vnc -display :99 -forever -shared -rfbport 5900 -passwd "$VNC_PASSWORD" -bg -noxdamage -q
else
    x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -bg -noxdamage -q
fi
sleep 1

# ─── 3. Start noVNC ───
log "Starting noVNC on port 6080..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &
sleep 1

# ─── 4. First run: initialize Wine + install MT5 + Python ───
if [ ! -f "/data/wine/.initialized" ]; then
    log "============================================"
    log "  FIRST RUN — Setting up Wine + MT5..."
    log "  This will take 10-20 minutes."
    log "============================================"

    # ── 4.1 Init Wine prefix ──
    log "[1/6] Initializing Wine prefix..."
    rm -rf /data/wine/*
    WINEARCH=win64 wine wineboot --init 2>&1 | tail -5
    RC=$?
    log "wineboot exit code: $RC"
    sleep 15
    wineserver --wait 2>/dev/null || true

    # Verify Wine prefix created
    if [ ! -d "/data/wine/drive_c" ]; then
        log "ERROR: Wine prefix not created — /data/wine/drive_c missing!"
        log "Contents of /data/wine:"
        ls -la /data/wine/ 2>/dev/null || log "(empty)"
        exit 1
    fi
    log "Wine prefix created OK: $(ls /data/wine/drive_c/ | tr '\n' ' ')"

    # ── 4.2 Install Windows components ──
    log "[2/6] Installing vcrun2019 + corefonts..."
    winetricks -q vcrun2019 2>&1 | tail -3
    log "vcrun2019 done (exit: $?)"
    winetricks -q corefonts 2>&1 | tail -3
    log "corefonts done (exit: $?)"
    wineserver --wait 2>/dev/null || true

    # ── 4.3 Download MT5 installer ──
    log "[3/6] Downloading MetaTrader 5 installer..."
    MT5_URL="https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"
    wget -q -O /tmp/mt5setup.exe "$MT5_URL"
    if [ ! -f /tmp/mt5setup.exe ] || [ ! -s /tmp/mt5setup.exe ]; then
        log "ERROR: MT5 installer download failed!"
        log "Trying alternative URL..."
        wget -q -O /tmp/mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe?utm_source=www.mql5.com"
    fi
    MT5_SIZE=$(stat -c%s /tmp/mt5setup.exe 2>/dev/null || echo 0)
    log "MT5 installer size: $MT5_SIZE bytes"
    if [ "$MT5_SIZE" -lt 1000000 ]; then
        log "ERROR: MT5 installer too small ($MT5_SIZE bytes), download likely failed"
        log "File contents (first 200 chars):"
        head -c 200 /tmp/mt5setup.exe 2>/dev/null
        echo ""
    fi

    # ── 4.4 Install MT5 ──
    log "[4/6] Installing MetaTrader 5 (this takes a few minutes)..."
    # Run installer with /auto flag for silent install
    wine /tmp/mt5setup.exe /auto 2>&1 | tail -10 &
    MT5_INSTALL_PID=$!

    # Wait for installer to finish (max 5 minutes)
    WAIT_COUNT=0
    MAX_WAIT=60  # 60 * 5s = 300s = 5 min
    while kill -0 $MT5_INSTALL_PID 2>/dev/null; do
        WAIT_COUNT=$((WAIT_COUNT + 1))
        if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
            log "WARNING: MT5 installer still running after 5 minutes, killing..."
            kill $MT5_INSTALL_PID 2>/dev/null || true
            wineserver -k 2>/dev/null || true
            break
        fi
        if [ $((WAIT_COUNT % 12)) -eq 0 ]; then
            ELAPSED=$((WAIT_COUNT * 5))
            log "  ...still installing MT5 (${ELAPSED}s elapsed)"
        fi
        sleep 5
    done

    wineserver --wait 2>/dev/null || true
    rm -f /tmp/mt5setup.exe

    # ── 4.5 Verify MT5 installation ──
    log "[5/6] Verifying MT5 installation..."
    MT5_EXE=$(find /data/wine -name "terminal64.exe" -type f 2>/dev/null | head -1)
    if [ -z "$MT5_EXE" ]; then
        log "WARNING: terminal64.exe not found!"
        log "Searching for any MT5 files..."
        find /data/wine -iname "*metatrader*" -o -iname "*terminal*" 2>/dev/null | head -20
        log ""
        log "Listing Program Files:"
        ls -la "/data/wine/drive_c/Program Files/" 2>/dev/null || log "(no Program Files)"
        log ""
        log "MT5 may need manual installation via noVNC (port 6080)."
        log "The container will continue running so you can install manually."
    else
        MT5_DIR=$(dirname "$MT5_EXE")
        log "MT5 found: $MT5_EXE"
        log "MT5 directory contents:"
        ls "$MT5_DIR"/*.exe 2>/dev/null | head -5
    fi

    # ── 4.6 Install Python in Wine ──
    log "[6/6] Installing Python 3.10 in Wine..."
    PYTHON_URL="https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
    wget -q -O /tmp/python-installer.exe "$PYTHON_URL"
    PY_SIZE=$(stat -c%s /tmp/python-installer.exe 2>/dev/null || echo 0)
    log "Python installer size: $PY_SIZE bytes"

    if [ "$PY_SIZE" -gt 1000000 ]; then
        wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=1 Include_pip=1 2>&1 | tail -5 &
        PY_INSTALL_PID=$!

        # Wait max 3 minutes
        WAIT_COUNT=0
        while kill -0 $PY_INSTALL_PID 2>/dev/null; do
            WAIT_COUNT=$((WAIT_COUNT + 1))
            if [ $WAIT_COUNT -ge 36 ]; then
                log "WARNING: Python installer still running after 3 min, killing..."
                kill $PY_INSTALL_PID 2>/dev/null || true
                wineserver -k 2>/dev/null || true
                break
            fi
            sleep 5
        done
        wineserver --wait 2>/dev/null || true

        # Find Python executable
        WINE_PYTHON=$(find /data/wine -name "python.exe" -path "*/Python*" 2>/dev/null | head -1)
        if [ -n "$WINE_PYTHON" ]; then
            log "Wine Python found: $WINE_PYTHON"
            # Install MetaTrader5 package
            WINE_PIP=$(find /data/wine -name "pip.exe" -path "*/Scripts/*" 2>/dev/null | head -1)
            if [ -n "$WINE_PIP" ]; then
                log "Installing MetaTrader5 Python package..."
                wine "$WINE_PIP" install MetaTrader5 2>&1 | tail -5
                log "MetaTrader5 pip install exit: $?"
            else
                log "WARNING: pip.exe not found in Wine Python"
                log "Trying: wine python -m pip install MetaTrader5"
                wine "$WINE_PYTHON" -m pip install MetaTrader5 2>&1 | tail -5
            fi
        else
            log "WARNING: Python not found in Wine after install"
            log "Searching:"
            find /data/wine -name "python.exe" 2>/dev/null || log "(none found)"
        fi
    else
        log "ERROR: Python installer download failed (size: $PY_SIZE)"
    fi
    rm -f /tmp/python-installer.exe

    # Mark as initialized (even partial — user can fix via noVNC)
    touch /data/wine/.initialized

    log "============================================"
    log "  Setup complete! Summary:"
    MT5_EXE=$(find /data/wine -name "terminal64.exe" -type f 2>/dev/null | head -1)
    WINE_PYTHON=$(find /data/wine -name "python.exe" -path "*/Python*" 2>/dev/null | head -1)
    [ -n "$MT5_EXE" ] && log "  MT5: OK ($MT5_EXE)" || log "  MT5: NOT FOUND — install manually via noVNC"
    [ -n "$WINE_PYTHON" ] && log "  Python: OK ($WINE_PYTHON)" || log "  Python: NOT FOUND"
    log "  noVNC: port 6080"
    log "  API:   port 8500"
    log "============================================"
fi

# ─── 5. Start MT5 terminal ───
MT5_EXE=$(find /data/wine -name "terminal64.exe" -type f 2>/dev/null | head -1)
if [ -n "$MT5_EXE" ]; then
    log "Starting MetaTrader 5: $MT5_EXE"
    wine "$MT5_EXE" &
    sleep 5
    # Verify MT5 process is running
    if pgrep -f terminal64 >/dev/null 2>&1; then
        log "MT5 is running"
    else
        log "WARNING: MT5 process not detected after launch"
    fi
else
    log "WARNING: MT5 terminal not found — API will return errors"
    log "Install MT5 manually via noVNC (port 6080):"
    log "  1. Open browser -> http://<host>:6080"
    log "  2. Download mt5setup.exe from mql5.com"
    log "  3. Run the installer"
    log "  4. Restart the container"
fi

# ─── 6. Start FastAPI executor ───
log "============================================"
log "  Trade Executor ready!"
log "  API:   port 8500"
log "  noVNC: port 6080"
log "============================================"
exec python3 -m uvicorn executor:app --host 0.0.0.0 --port 8500
