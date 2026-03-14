FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV WINEPREFIX=/opt/mt5/wine
ENV WINEARCH=win64
ENV DISPLAY=:99

# ─── 1. System packages ───
RUN apt-get update && apt-get install -y \
    wget cabextract xvfb x11vnc python3 python3-pip \
    software-properties-common gnupg2 git net-tools \
    && rm -rf /var/lib/apt/lists/*

# ─── 2. Wine ───
RUN dpkg --add-architecture i386 \
    && mkdir -pm755 /etc/apt/keyrings \
    && wget -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
    && wget -NP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources \
    && apt-get update \
    && (apt-get install -y --install-recommends winehq-stable || apt-get install -y wine64 wine32) \
    && rm -rf /var/lib/apt/lists/*

# ─── 3. Winetricks ───
RUN wget -O /usr/local/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks \
    && chmod +x /usr/local/bin/winetricks

# ─── 4. noVNC + websockify ───
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/novnc \
    && git clone --depth 1 https://github.com/novnc/websockify.git /opt/novnc/utils/websockify \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# ─── 5. Initialize Wine prefix + Windows components ───
RUN Xvfb :99 -screen 0 1280x800x24 -ac & \
    sleep 2 \
    && wineboot --init \
    && sleep 5 \
    && winetricks -q vcrun2019 corefonts \
    && wineserver --wait

# ─── 6. Install MetaTrader 5 ───
RUN Xvfb :99 -screen 0 1280x800x24 -ac & \
    sleep 2 \
    && wget -O /tmp/mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" \
    && wine /tmp/mt5setup.exe /auto \
    && sleep 30 \
    && wineserver --wait \
    && rm -f /tmp/mt5setup.exe

# ─── 7. Install Python 3.10 inside Wine ───
RUN Xvfb :99 -screen 0 1280x800x24 -ac & \
    sleep 2 \
    && wget -O /tmp/python-installer.exe "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe" \
    && wine /tmp/python-installer.exe /quiet InstallAllUsers=1 PrependPath=1 Include_pip=1 \
    && sleep 20 \
    && wineserver --wait \
    && rm -f /tmp/python-installer.exe

# ─── 8. Install MetaTrader5 Python package in Wine ───
RUN Xvfb :99 -screen 0 1280x800x24 -ac & \
    sleep 2 \
    && wine pip install MetaTrader5 \
    && wineserver --wait

# ─── 9. Python (Linux) dependencies for FastAPI ───
WORKDIR /opt/trade-executor
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# ─── 10. Copy application ───
COPY executor.py mt5_bridge.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create data directory
RUN mkdir -p /opt/trade-executor/data

EXPOSE 8500 6080

ENTRYPOINT ["/opt/trade-executor/entrypoint.sh"]
