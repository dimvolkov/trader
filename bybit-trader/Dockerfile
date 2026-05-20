FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/bybit-trader

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py bybit_bridge.py crypto_config.py signal_parser.py \
     signal_store.py telegram_listener.py bootstrap_session.py ./

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8502

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8502"]
