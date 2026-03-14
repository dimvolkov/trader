FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

# ─── 1. System packages ───
RUN apt-get update && apt-get install -y \
    wget cabextract xvfb x11vnc python3 python3-pip \
    software-properties-common gnupg2 git net-tools \
    && rm -rf /var/lib/apt/lists/*

# ─── 2. Wine (9.0 — proven to work in Docker, unlike Wine 11) ───
RUN dpkg --add-architecture i386 \
    && mkdir -pm755 /etc/apt/keyrings \
    && wget -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
    && wget -NP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources \
    && apt-get update \
    && apt-get install -y --install-recommends \
        wine-stable-amd64=9.0.0.0~jammy-1 \
        wine-stable-i386:i386=9.0.0.0~jammy-1 \
        wine-stable=9.0.0.0~jammy-1 \
        winehq-stable=9.0.0.0~jammy-1 \
    && rm -rf /var/lib/apt/lists/*

# ─── 3. Winetricks ───
RUN wget -O /usr/local/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks \
    && chmod +x /usr/local/bin/winetricks

# ─── 4. noVNC + websockify ───
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/novnc \
    && git clone --depth 1 https://github.com/novnc/websockify.git /opt/novnc/utils/websockify \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# ─── 5. Python (Linux) dependencies for FastAPI ───
WORKDIR /opt/trade-executor
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# ─── 6. Copy application ───
COPY executor.py mt5_bridge.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create data directory
RUN mkdir -p /opt/trade-executor/data /data/wine

EXPOSE 8500 6080

ENTRYPOINT ["/opt/trade-executor/entrypoint.sh"]
