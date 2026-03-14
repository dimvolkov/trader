FROM scottyhardy/docker-wine:stable

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

USER root

# ─── 1. Extra packages ───
RUN apt-get update && apt-get install -y \
    xvfb x11vnc python3 python3-pip git net-tools \
    && rm -rf /var/lib/apt/lists/*

# ─── 2. Winetricks ───
RUN wget -O /usr/local/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks \
    && chmod +x /usr/local/bin/winetricks

# ─── 3. noVNC + websockify ───
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/novnc \
    && git clone --depth 1 https://github.com/novnc/websockify.git /opt/novnc/utils/websockify \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# ─── 4. Python (Linux) dependencies for FastAPI ───
WORKDIR /opt/trade-executor
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# ─── 5. Copy application ───
COPY executor.py mt5_bridge.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create data directory
RUN mkdir -p /opt/trade-executor/data /data/wine

EXPOSE 8500 6080

ENTRYPOINT ["/opt/trade-executor/entrypoint.sh"]
