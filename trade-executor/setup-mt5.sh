#!/bin/bash
# ─── Install MT5 inside running container ───
# Run: docker exec -it <container_id> bash /opt/trade-executor/setup-mt5.sh
set -e

export WINEPREFIX=/opt/trade-executor/wine
export DISPLAY=:99

echo "=== Step 1/4: Installing Windows components ==="
winetricks -q vcrun2019 corefonts
echo "Done."

echo ""
echo "=== Step 2/4: Downloading MetaTrader 5 ==="
wget -O /tmp/mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"
echo "Done."

echo ""
echo "=== Step 3/4: Installing MetaTrader 5 ==="
echo "MT5 installer will open. Watch progress in noVNC (port 6080)."
wine /tmp/mt5setup.exe /auto
echo "Waiting for installation to complete..."
sleep 20

echo ""
echo "=== Step 4/4: Installing Python in Wine + MetaTrader5 library ==="
bash /opt/trade-executor/install_mt5_python.sh

echo ""
echo "========================================="
echo "  MT5 Installation Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Open noVNC in browser (port 6080)"
echo "2. Launch MT5:  wine ~/.wine/drive_c/Program\\ Files/MetaTrader\\ 5/terminal64.exe"
echo "3. Login to your broker account in MT5"
echo "4. Restart the container to apply changes"
