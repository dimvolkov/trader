// Server-side Forex Scanner with Telegram notifications
// Runs on schedule without browser, checks currency pairs and sends alerts

// ─── Configuration from environment variables ───
const CONFIG = {
    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId:   process.env.TELEGRAM_CHAT_ID || '',

    // Data source: twelvedata, tradermade, polygon, finnhub, fcsapi, alphavantage, oanda
    dataSource: process.env.DATA_SOURCE || 'twelvedata',

    // API keys (set the one matching your DATA_SOURCE)
    apiKeys: {
        twelvedata:   process.env.API_KEY_TWELVEDATA || '8694f4e28a974a0eba808458ceb33bfb',
        tradermade:   process.env.API_KEY_TRADERMADE || '',
        polygon:      process.env.API_KEY_POLYGON || '',
        finnhub:      process.env.API_KEY_FINNHUB || '',
        fcsapi:       process.env.API_KEY_FCSAPI || '',
        alphavantage: process.env.API_KEY_ALPHAVANTAGE || '',
        oanda:        process.env.API_KEY_OANDA || '',
    },

    // Watchlist (comma-separated, e.g. "EUR/USD,GBP/USD,USD/JPY,USD/CHF")
    watchlist: (process.env.WATCHLIST || 'EUR/USD,GBP/USD,USD/JPY,USD/CHF').split(',').map(s => s.trim()),

    // Schedule: time window (Moscow UTC+3)
    scheduleFrom: parseInt(process.env.SCHEDULE_FROM || '8'),
    scheduleTo:   parseInt(process.env.SCHEDULE_TO || '20'),
    // Scan interval in hours
    intervalHours: parseFloat(process.env.SCAN_INTERVAL_HOURS || '1'),

    // Risk management
    deposit:  parseFloat(process.env.DEPOSIT || '100000'),
    riskPct:  parseFloat(process.env.RISK_PCT || '0.01'),

    // Domain for chart links
    domain: process.env.DOMAIN || 'trader.kachestvobiz-ai.ru',

    // Trade Executor (auto-trading)
    executorUrl: process.env.EXECUTOR_URL || '',           // e.g. http://your-server:8500
    executorSecret: process.env.EXECUTOR_API_SECRET || '', // shared secret
    autoTrade: process.env.AUTO_TRADE === 'true',          // enable auto-trading
};

const MAX_RISK = CONFIG.deposit * CONFIG.riskPct;

const RATE_DELAYS = {
    twelvedata: 12000, tradermade: 3000, polygon: 12000,
    finnhub: 1500, fcsapi: 21000, alphavantage: 15000, oanda: 500,
};

// ─── Helpers ───
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
    const now = new Date().toISOString();
    console.log(`[${now}] ${msg}`);
}

function getMoscowHour() {
    const now = new Date();
    const mskOffset = 3 * 60;
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const mskMinutes = utcMinutes + mskOffset;
    return Math.floor(((mskMinutes % 1440) + 1440) % 1440 / 60);
}

function isInTimeWindow() {
    const hour = getMoscowHour();
    const { scheduleFrom: from, scheduleTo: to } = CONFIG;
    if (from <= to) return hour >= from && hour < to;
    return hour >= from || hour < to;
}

function pairConcat(symbol) {
    return symbol.replace('/', '');
}

function parseDatetime(dt) {
    const parts = dt.split(' ');
    const d = parts[0].split('-');
    if (parts.length === 1) {
        return Date.UTC(+d[0], +d[1] - 1, +d[2]) / 1000;
    }
    const t = parts[1].split(':');
    return Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1], +t[2] || 0) / 1000;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// ─── API Fetch Functions ───
function getApiKey() {
    return CONFIG.apiKeys[CONFIG.dataSource] || '';
}

async function fetchTwelveData(symbol, interval) {
    const size = interval === '1h' ? 200 : 150;
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${size}&apikey=${getApiKey()}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.status === 'ok' && data.values) {
        return data.values.reverse().map(v => ({
            time: parseDatetime(v.datetime),
            open: parseFloat(v.open), high: parseFloat(v.high),
            low: parseFloat(v.low), close: parseFloat(v.close),
        }));
    }
    if (data.code === 429) throw new Error('Rate limit (429)');
    return [];
}

async function fetchTraderMade(symbol, interval) {
    const pair = pairConcat(symbol);
    let tmInterval, tmPeriod = '';
    if (interval === '1h') { tmInterval = 'hourly'; }
    else if (interval === '30min') { tmInterval = 'minute'; tmPeriod = '&period=30'; }
    else { tmInterval = 'daily'; }
    const now = new Date();
    const daysBack = tmInterval === 'minute' ? 4 : 30;
    const from = new Date(now.getTime() - daysBack * 86400000);
    const startDate = from.toISOString().slice(0, 10);
    const endDate = now.toISOString().slice(0, 10);
    const url = `https://marketdata.tradermade.com/api/v1/timeseries?currency=${pair}&api_key=${getApiKey()}&start_date=${startDate}&end_date=${endDate}&interval=${tmInterval}${tmPeriod}&format=records`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.quotes && Array.isArray(data.quotes)) {
        return data.quotes.map(q => ({
            time: parseDatetime(q.date),
            open: parseFloat(q.open), high: parseFloat(q.high),
            low: parseFloat(q.low), close: parseFloat(q.close),
        }));
    }
    if (data.error || (data.errors && data.errors.length > 0)) {
        const msg = data.error || data.errors[0]?.message || 'API error';
        if (msg.includes('rate') || msg.includes('limit') || msg.includes('429')) throw new Error('Rate limit (429)');
        throw new Error(msg);
    }
    return [];
}

async function fetchPolygon(symbol, interval) {
    const ticker = 'C:' + pairConcat(symbol);
    let multiplier, timespan;
    if (interval === '1h') { multiplier = 1; timespan = 'hour'; }
    else if (interval === '30min') { multiplier = 30; timespan = 'minute'; }
    else { multiplier = 1; timespan = 'day'; }
    const now = new Date();
    const from = new Date(now.getTime() - 60 * 86400000);
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = now.toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=5000&apiKey=${getApiKey()}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results) {
        return data.results.map(r => ({
            time: Math.floor(r.t / 1000), open: r.o, high: r.h, low: r.l, close: r.c,
        }));
    }
    if (data.status === 'ERROR') {
        const msg = data.error || data.message || 'API error';
        if (msg.includes('rate') || msg.includes('limit')) throw new Error('Rate limit (429)');
        throw new Error(msg);
    }
    return [];
}

async function fetchFinnhub(symbol, interval) {
    const pair = pairConcat(symbol);
    const fhSymbol = 'OANDA:' + pair.slice(0, 3) + '_' + pair.slice(3);
    const resolution = interval === '1h' ? '60' : interval === '30min' ? '30' : '60';
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 86400;
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=${fhSymbol}&resolution=${resolution}&from=${from}&to=${to}&token=${getApiKey()}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.s === 'ok' && data.c && data.c.length > 0) {
        return data.t.map((t, i) => ({
            time: t, open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i],
        }));
    }
    if (data.error) throw new Error(data.error);
    return [];
}

async function fetchFcsApi(symbol, interval) {
    const period = interval === '1h' ? '1h' : interval === '30min' ? '30m' : '1h';
    const url = `https://fcsapi.com/api-v3/forex/history?symbol=${symbol}&period=${period}&access_key=${getApiKey()}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    const isError = data.code === 101 || data.code === 102 ||
        String(data.status).toLowerCase() === 'false' || data.status === 0;
    if (isError) throw new Error(data.msg || data.message || 'FCS API error');
    let candles = data.response || data.data || data.results || data.candles;
    if (!candles) {
        const candidateKeys = Object.keys(data).filter(k => !['status', 'msg', 'message', 'code', 'info', 's'].includes(k));
        for (const k of candidateKeys) {
            const val = data[k];
            if (val && (Array.isArray(val) || (typeof val === 'object' && Object.keys(val).length > 0))) {
                candles = val; break;
            }
        }
    }
    if (!candles) throw new Error('FCS API: no data');
    if (!Array.isArray(candles)) candles = Object.values(candles);
    if (!candles || candles.length === 0) throw new Error('FCS API: empty');
    const first = candles[0];
    const oField = first.o !== undefined ? 'o' : first.open !== undefined ? 'open' : null;
    const hField = first.h !== undefined ? 'h' : first.high !== undefined ? 'high' : null;
    const lField = first.l !== undefined ? 'l' : first.low !== undefined ? 'low' : null;
    const cField = first.c !== undefined ? 'c' : first.close !== undefined ? 'close' : null;
    if (!oField) throw new Error('FCS API: unknown format');
    return candles.map(q => ({
        time: parseInt(q.t) || parseDatetime(q.tm) || Math.floor(new Date(q.tm || q.time || q.date).getTime() / 1000),
        open: parseFloat(q[oField]), high: parseFloat(q[hField]),
        low: parseFloat(q[lField]), close: parseFloat(q[cField]),
    }));
}

async function fetchAlphaVantage(symbol, interval) {
    const parts = symbol.split('/');
    const ivParam = interval === '30min' ? '30min' : '60min';
    const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${parts[0]}&to_symbol=${parts[1]}&interval=${ivParam}&outputsize=full&apikey=${getApiKey()}`;
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    const tsKey = Object.keys(data).find(k => k.startsWith('Time Series'));
    if (tsKey && data[tsKey]) {
        return Object.entries(data[tsKey]).reverse().map(([dt, v]) => ({
            time: parseDatetime(dt),
            open: parseFloat(v['1. open']), high: parseFloat(v['2. high']),
            low: parseFloat(v['3. low']), close: parseFloat(v['4. close']),
        }));
    }
    if (data['Error Message']) throw new Error(data['Error Message']);
    if (data['Note']) throw new Error('Rate limit');
    return [];
}

async function fetchOanda(symbol, interval) {
    const parts = symbol.split('/');
    const instrument = parts[0] + '_' + parts[1];
    const granularity = interval === '1h' ? 'H1' : interval === '30min' ? 'M30' : 'H1';
    const url = `https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?granularity=${granularity}&count=500&price=M`;
    const res = await fetchWithTimeout(url, {
        headers: { 'Authorization': 'Bearer ' + getApiKey() },
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.errorMessage || `OANDA error ${res.status}`);
    }
    const data = await res.json();
    if (!data.candles || data.candles.length === 0) throw new Error('OANDA: no data');
    return data.candles.filter(c => c.complete !== false).map(c => ({
        time: Math.floor(new Date(c.time).getTime() / 1000),
        open: parseFloat(c.mid.o), high: parseFloat(c.mid.h),
        low: parseFloat(c.mid.l), close: parseFloat(c.mid.c),
    }));
}

const FETCH_FNS = {
    twelvedata: fetchTwelveData, tradermade: fetchTraderMade,
    polygon: fetchPolygon, finnhub: fetchFinnhub,
    fcsapi: fetchFcsApi, alphavantage: fetchAlphaVantage,
    oanda: fetchOanda,
};

async function fetchTimeSeries(symbol, interval, retries = 3) {
    const fetchFn = FETCH_FNS[CONFIG.dataSource] || fetchTwelveData;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetchFn(symbol, interval);
        } catch (err) {
            if (attempt < retries) {
                const isTimeout = err.name === 'AbortError';
                const isRateLimit = err.message.includes('429');
                const isNetwork = err.message.includes('fetch') || err.message.includes('network');
                if (isTimeout || isRateLimit || isNetwork) {
                    const waitSec = isRateLimit ? 15 : 5;
                    log(`  ${symbol} ${interval}: ${err.message} — retry in ${waitSec}s (${attempt + 2}/${retries + 1})`);
                    await delay(waitSec * 1000);
                    continue;
                }
            }
            throw err;
        }
    }
    return [];
}

// ─── Analysis Functions ───
function findSwingPoints(candles, lookback) {
    const swings = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
        let isHigh = true, isLow = true;
        for (let j = 1; j <= lookback; j++) {
            if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isHigh = false;
            if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isLow = false;
        }
        if (isHigh) swings.push({ index: i, time: candles[i].time, price: candles[i].high, type: 'high' });
        if (isLow) swings.push({ index: i, time: candles[i].time, price: candles[i].low, type: 'low' });
    }
    swings.sort((a, b) => a.time - b.time);
    return swings;
}

function determineTrend(swings) {
    const highs = swings.filter(s => s.type === 'high');
    const lows = swings.filter(s => s.type === 'low');
    if (highs.length < 2 || lows.length < 2) return 'range';
    const lastHighs = highs.slice(-3);
    const lastLows = lows.slice(-3);
    if (lastHighs.length >= 2 && lastLows.length >= 2) {
        const hLen = lastHighs.length;
        const lLen = lastLows.length;
        const lastHH = lastHighs[hLen - 1].price > lastHighs[hLen - 2].price;
        const lastHL = lastLows[lLen - 1].price > lastLows[lLen - 2].price;
        const lastLH = lastHighs[hLen - 1].price < lastHighs[hLen - 2].price;
        const lastLL = lastLows[lLen - 1].price < lastLows[lLen - 2].price;
        if (hLen >= 3 && lLen >= 3) {
            const hhCount = (lastHighs[1].price > lastHighs[0].price ? 1 : 0) + (lastHighs[2].price > lastHighs[1].price ? 1 : 0);
            const hlCount = (lastLows[1].price > lastLows[0].price ? 1 : 0) + (lastLows[2].price > lastLows[1].price ? 1 : 0);
            const lhCount = (lastHighs[1].price < lastHighs[0].price ? 1 : 0) + (lastHighs[2].price < lastHighs[1].price ? 1 : 0);
            const llCount = (lastLows[1].price < lastLows[0].price ? 1 : 0) + (lastLows[2].price < lastLows[1].price ? 1 : 0);
            if (hhCount >= 1 && hlCount >= 1) return 'up';
            if (lhCount >= 1 && llCount >= 1) return 'down';
        } else {
            if (lastHH && lastHL) return 'up';
            if (lastLH && lastLL) return 'down';
        }
    }
    return 'range';
}

function segmentSwings(swings, trend) {
    if (swings.length < 2) return [];
    const alternating = [swings[0]];
    for (let i = 1; i < swings.length; i++) {
        const last = alternating[alternating.length - 1];
        if (swings[i].type === last.type) {
            if (swings[i].type === 'high' && swings[i].price > last.price) alternating[alternating.length - 1] = swings[i];
            else if (swings[i].type === 'low' && swings[i].price < last.price) alternating[alternating.length - 1] = swings[i];
        } else {
            alternating.push(swings[i]);
        }
    }
    const segments = [];
    for (let i = 0; i < alternating.length - 1; i++) {
        const from = alternating[i];
        const to = alternating[i + 1];
        let segType;
        if (trend === 'up') segType = (from.type === 'low' && to.type === 'high') ? 'impulse' : 'correction';
        else if (trend === 'down') segType = (from.type === 'high' && to.type === 'low') ? 'impulse' : 'correction';
        else segType = (i % 2 === 0) ? 'impulse' : 'correction';
        segments.push({
            startTime: from.time, startPrice: from.price,
            endTime: to.time, endPrice: to.price,
            type: segType, size: Math.abs(to.price - from.price),
        });
    }
    return segments;
}

function checkReversal(impulses) {
    const corrections = impulses.filter(s => s.type === 'correction');
    const imps = impulses.filter(s => s.type === 'impulse');
    if (corrections.length === 0 || imps.length === 0) return { reversal: false, reason: 'Insufficient data' };
    const lastCorr = corrections[corrections.length - 1];
    const lastImp = imps[imps.length - 1];
    if (lastCorr.size > lastImp.size) return { reversal: true, reason: 'Corr > Imp' };
    return { reversal: false, reason: 'Trend continues' };
}

function constructLevels(impulses, trend, swings) {
    const imps = impulses.filter(s => s.type === 'impulse');
    if (imps.length === 0) return {};
    const lastImp = imps[imps.length - 1];
    const impulseEnd = lastImp.endPrice;
    const impulseStart = lastImp.startPrice;
    let target = null;
    const relevantSwings = trend === 'up'
        ? swings.filter(s => s.type === 'high' && s.price > impulseEnd)
        : swings.filter(s => s.type === 'low' && s.price < impulseEnd);
    if (relevantSwings.length > 0) {
        relevantSwings.sort((a, b) => trend === 'up' ? a.price - b.price : b.price - a.price);
        target = relevantSwings[0].price;
    } else {
        const size = Math.abs(impulseEnd - impulseStart);
        target = trend === 'up' ? impulseEnd + size : impulseEnd - size;
    }
    return { impulseEnd, impulseStart, target };
}

function detectSlom(m30Candles, trendDir, h1Levels) {
    if (!h1Levels.impulseEnd) return null;
    const m30Swings = findSwingPoints(m30Candles, 4);
    if (m30Swings.length < 4) return null;
    const recentSwings = m30Swings.slice(-10);
    const microHighs = recentSwings.filter(s => s.type === 'high');
    const microLows = recentSwings.filter(s => s.type === 'low');
    if (microHighs.length < 2 || microLows.length < 2) return null;
    const lastMicroHighs = microHighs.slice(-2);
    const lastMicroLows = microLows.slice(-2);
    let signal1 = null, signal2 = null, signal3 = null;

    if (trendDir === 'up') {
        const microTop = lastMicroHighs[lastMicroHighs.length - 1];
        const breakLevel = lastMicroHighs[lastMicroHighs.length - 2].price;
        if (microTop.price > breakLevel) {
            signal1 = { price: breakLevel, time: microTop.time };
            const pullbackZone = breakLevel + (microTop.price - breakLevel) * 0.5;
            for (let i = microTop.index + 1; i < m30Candles.length; i++) {
                if (m30Candles[i].low <= pullbackZone && m30Candles[i].low >= breakLevel * 0.999) {
                    signal2 = { price: m30Candles[i].low, time: m30Candles[i].time };
                    break;
                }
            }
            if (signal2) {
                for (let i = m30Candles.findIndex(c => c.time >= signal2.time) + 1; i < m30Candles.length; i++) {
                    if (m30Candles[i].high > microTop.price) {
                        signal3 = { price: m30Candles[i].high, time: m30Candles[i].time };
                        break;
                    }
                }
            }
        }
    } else if (trendDir === 'down') {
        const microBottom = lastMicroLows[lastMicroLows.length - 1];
        const breakLevel = lastMicroLows[lastMicroLows.length - 2].price;
        if (microBottom.price < breakLevel) {
            signal1 = { price: breakLevel, time: microBottom.time };
            const pullbackZone = breakLevel - (breakLevel - microBottom.price) * 0.5;
            for (let i = microBottom.index + 1; i < m30Candles.length; i++) {
                if (m30Candles[i].high >= pullbackZone && m30Candles[i].high <= breakLevel * 1.001) {
                    signal2 = { price: m30Candles[i].high, time: m30Candles[i].time };
                    break;
                }
            }
            if (signal2) {
                for (let i = m30Candles.findIndex(c => c.time >= signal2.time) + 1; i < m30Candles.length; i++) {
                    if (m30Candles[i].low < microBottom.price) {
                        signal3 = { price: m30Candles[i].low, time: m30Candles[i].time };
                        break;
                    }
                }
            }
        }
    }
    if (!signal1) return null;
    return { signal1, signal2: signal2 || null, signal3: signal3 || null, complete: !!(signal1 && signal2 && signal3) };
}

function computeEntry(slom, levels, trend) {
    if (!slom || !slom.signal2 || !levels.target) return null;
    const entry = slom.signal2.price;
    let stop, take;
    if (trend === 'up') {
        stop = slom.signal1.price - Math.abs(slom.signal2.price - slom.signal1.price) * 0.5;
        take = levels.target;
    } else {
        stop = slom.signal1.price + Math.abs(slom.signal2.price - slom.signal1.price) * 0.5;
        take = levels.target;
    }
    const riskPerUnit = Math.abs(entry - stop);
    const profitPerUnit = Math.abs(take - entry);
    const rr = profitPerUnit / riskPerUnit;
    const positionSize = MAX_RISK / riskPerUnit;
    const potentialProfit = positionSize * profitPerUnit;
    const potentialLoss = MAX_RISK;

    const base = { entry, stop, take, rr, direction: trend, positionSize, potentialProfit, potentialLoss };
    if (rr < 3.0) return { ...base, valid: false, reason: `R:R ${rr.toFixed(2)} < 3.0` };
    return { ...base, valid: true, reason: `R:R = ${rr.toFixed(2)}` };
}

function analyzePair(h1Candles, m30Candles) {
    const result = {
        trend: 'range', phase: '—',
        reversal: false, reversalReason: '',
        s1: false, s2: false, s3: false,
        entry: null, rr: null,
        h1Count: h1Candles.length, m30Count: m30Candles.length,
    };

    if (h1Candles.length < 20) return result;

    const swings = findSwingPoints(h1Candles, 5);
    if (swings.length < 4) return result;

    result.trend = determineTrend(swings);
    const impulses = segmentSwings(swings, result.trend);

    if (impulses.length > 0) {
        const lastSeg = impulses[impulses.length - 1];
        result.phase = lastSeg.type === 'impulse' ? 'Impulse' : 'Correction';
        const rev = checkReversal(impulses);
        result.reversal = rev.reversal;
        result.reversalReason = rev.reason;
    }

    if (result.trend !== 'range') {
        const levels = constructLevels(impulses, result.trend, swings);
        result.levels = levels;

        if (m30Candles.length > 20) {
            const slom = detectSlom(m30Candles, result.trend, levels);
            if (slom) {
                result.s1 = !!slom.signal1;
                result.s2 = !!slom.signal2;
                result.s3 = !!slom.signal3;
                if (slom.signal2) {
                    const entry = computeEntry(slom, levels, result.trend);
                    if (entry) {
                        result.entry = entry;
                        result.rr = entry.rr;
                    }
                }
            }
        }
    }

    return result;
}

// ─── Telegram ───
async function sendTelegramNotification(pair, result) {
    if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
        log(`  ${pair}: Telegram not configured — skipping`);
        return;
    }

    const e = result.entry;
    const dir = e.direction === 'up' ? 'LONG ↑' : 'SHORT ↓';
    const fp = (v) => v >= 10 ? v.toFixed(2) : v.toFixed(5);

    const chartUrl = `https://${CONFIG.domain}/index.html?pair=${encodeURIComponent(pair)}&tf=30&analyze=1&dir=${e.direction}&entry=${e.entry}&stop=${e.stop}&take=${e.take}&rr=${e.rr.toFixed(2)}`;

    const text = [
        `📊 *${pair} — ${dir}*`,
        ``,
        `Тренд: ${result.trend === 'up' ? 'Восходящий' : 'Нисходящий'}`,
        `Вход: \`${fp(e.entry)}\``,
        `Стоп: \`${fp(e.stop)}\``,
        `Тейк: \`${fp(e.take)}\``,
        `R:R: *1:${e.rr.toFixed(1)}*`,
        `Размер: ${e.positionSize.toFixed(2)}`,
        `Риск: ${e.potentialLoss.toFixed(0)}₽ → Прибыль: ${e.potentialProfit.toFixed(0)}₽`,
        lastAccountInfo ? `Баланс: ${lastAccountInfo.balance.toLocaleString('ru-RU', {minimumFractionDigits: 2})} ${lastAccountInfo.currency}` : '',
        ``,
        `[📈 Открыть график](${chartUrl})`,
    ].join('\n');

    try {
        const res = await fetchWithTimeout(`https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CONFIG.telegramChatId,
                text,
                parse_mode: 'Markdown',
            }),
        });
        if (res.ok) {
            log(`  ${pair}: Telegram sent (${dir})`);
        } else {
            const data = await res.json().catch(() => ({}));
            log(`  ${pair}: Telegram error ${res.status}: ${data.description || 'Unknown'}`);
        }
    } catch (err) {
        log(`  ${pair}: Telegram network error: ${err.message}`);
    }
}

// ─── Telegram (generic) ───
async function sendTelegram(text) {
    if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
    try {
        const res = await fetchWithTimeout(`https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CONFIG.telegramChatId,
                text,
                parse_mode: 'Markdown',
            }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            log(`  Telegram error ${res.status}: ${data.description || 'Unknown'}`);
        }
    } catch (err) {
        log(`  Telegram network error: ${err.message}`);
    }
}

// ─── Account Balance ───
let lastAccountInfo = null;

async function fetchAccountBalance() {
    if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
        return null;
    }

    try {
        const res = await fetchWithTimeout(`${CONFIG.executorUrl}/account`, {
            headers: { 'X-API-Secret': CONFIG.executorSecret },
        });

        const data = await res.json().catch(() => ({}));

        if (data.success) {
            lastAccountInfo = data;
            return data;
        } else {
            log(`  Account balance error: ${data.error || res.status}`);
            return null;
        }
    } catch (err) {
        log(`  Account balance fetch error: ${err.message}`);
        return null;
    }
}

function formatBalance(acc) {
    const fmt = (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `Balance: ${fmt(acc.balance)} ${acc.currency} | Equity: ${fmt(acc.equity)} ${acc.currency} | Free margin: ${fmt(acc.free_margin)} ${acc.currency}`;
}

// ─── Trade Executor ───
async function sendOrderToExecutor(pair, result) {
    if (!CONFIG.executorUrl || !CONFIG.executorSecret || !CONFIG.autoTrade) {
        return;
    }

    const e = result.entry;
    const payload = {
        pair,
        direction: e.direction,
        entry: e.entry,
        stop: e.stop,
        take: e.take,
        rr: e.rr,
        volume: 0, // auto-calculate on executor side
        deposit: CONFIG.deposit,
        risk_pct: CONFIG.riskPct,
    };

    try {
        const res = await fetchWithTimeout(`${CONFIG.executorUrl}/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Secret': CONFIG.executorSecret,
            },
            body: JSON.stringify(payload),
        });

        const data = await res.json().catch(() => ({}));

        if (data.success) {
            log(`  ${pair}: ORDER EXECUTED — id=${data.order_id} vol=${data.volume} price=${data.price}`);
        } else {
            log(`  ${pair}: ORDER FAILED — ${data.error || res.status}`);
        }
    } catch (err) {
        log(`  ${pair}: EXECUTOR ERROR — ${err.message}`);
    }
}

// ─── Main Scan Cycle ───
async function runScanCycle() {
    const pairs = CONFIG.watchlist;
    const rateDelay = RATE_DELAYS[CONFIG.dataSource] || 12000;

    log(`=== Scan started: ${pairs.length} pairs [${CONFIG.dataSource}] ===`);

    // Fetch actual account balance from MT5
    const acc = await fetchAccountBalance();
    if (acc) {
        log(`  💰 ${formatBalance(acc)}`);
        CONFIG.deposit = acc.balance;

        const fmt = (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        await sendTelegram([
            `💰 *Баланс счёта*`,
            ``,
            `Баланс: \`${fmt(acc.balance)} ${acc.currency}\``,
            `Эквити: \`${fmt(acc.equity)} ${acc.currency}\``,
            `Свободная маржа: \`${fmt(acc.free_margin)} ${acc.currency}\``,
            `Плечо: 1:${acc.leverage}`,
            ``,
            `🔍 Сканирую ${pairs.length} пар...`,
        ].join('\n'));
    } else if (CONFIG.executorUrl) {
        log(`  ⚠ Could not fetch balance, using configured deposit: ${CONFIG.deposit}`);
    }

    if (!getApiKey()) {
        log(`ERROR: No API key for ${CONFIG.dataSource}`);
        return;
    }

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        log(`  Scanning ${pair} (${i + 1}/${pairs.length})...`);

        try {
            const h1 = await fetchTimeSeries(pair, '1h');
            await delay(rateDelay);
            const m30 = await fetchTimeSeries(pair, '30min');

            const result = analyzePair(h1, m30);
            log(`  ${pair}: trend=${result.trend} phase=${result.phase} H1=${result.h1Count} M30=${result.m30Count} S1=${result.s1} S2=${result.s2} S3=${result.s3}`);

            if (result.entry && result.entry.valid) {
                log(`  ${pair}: SIGNAL FOUND! ${result.entry.direction === 'up' ? 'LONG' : 'SHORT'} R:R=${result.rr.toFixed(2)}`);
                await sendTelegramNotification(pair, result);
                await sendOrderToExecutor(pair, result);
            } else if (result.entry && !result.entry.valid) {
                log(`  ${pair}: signal present but ${result.entry.reason}`);
            } else if (result.trend === 'range') {
                log(`  ${pair}: no trend (range)`);
            } else {
                log(`  ${pair}: trend ${result.trend} but no entry signal`);
            }
        } catch (err) {
            log(`  ${pair}: ERROR — ${err.message}`);
        }

        if (i < pairs.length - 1) await delay(rateDelay);
    }

    log(`=== Scan complete ===`);
}

// ─── Scheduler ───
function getNextScanDelayMs() {
    return CONFIG.intervalHours * 60 * 60 * 1000;
}

function formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function schedulerLoop() {
    log('Scanner started');
    log(`  Data source: ${CONFIG.dataSource}`);
    log(`  Watchlist: ${CONFIG.watchlist.join(', ')}`);
    log(`  Schedule: ${CONFIG.scheduleFrom}:00 - ${CONFIG.scheduleTo}:00 MSK, every ${CONFIG.intervalHours}h`);
    log(`  Telegram: ${CONFIG.telegramBotToken ? 'configured' : 'NOT configured'}`);
    log(`  Auto-trade: ${CONFIG.autoTrade ? `ON → ${CONFIG.executorUrl}` : 'OFF'}`);

    // Initial balance check on startup
    if (CONFIG.executorUrl && CONFIG.executorSecret) {
        const acc = await fetchAccountBalance();
        if (acc) {
            log(`  💰 ${formatBalance(acc)}`);
        } else {
            log(`  ⚠ Executor configured but could not fetch account balance`);
        }
    }

    while (true) {
        const moscowHour = getMoscowHour();

        if (isInTimeWindow()) {
            log(`Moscow time ~${moscowHour}:00 — in window, running scan...`);
            try {
                await runScanCycle();
            } catch (err) {
                log(`Scan cycle error: ${err.message}`);
            }
        } else {
            log(`Moscow time ~${moscowHour}:00 — outside window (${CONFIG.scheduleFrom}-${CONFIG.scheduleTo}), skipping`);
        }

        const delayMs = getNextScanDelayMs();
        log(`Next scan in ${formatMs(delayMs)}`);
        await delay(delayMs);
    }
}

// ─── HTTP API for frontend ───
const http = require('http');
const API_PORT = process.env.SCANNER_API_PORT || 3001;

const apiServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/api/balance') {
        if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
            res.statusCode = 503;
            res.end(JSON.stringify({ success: false, error: 'Executor not configured' }));
            return;
        }
        const acc = lastAccountInfo || await fetchAccountBalance();
        if (acc) {
            res.end(JSON.stringify({ success: true, balance: acc.balance, equity: acc.equity, free_margin: acc.free_margin, currency: acc.currency, leverage: acc.leverage }));
        } else {
            res.statusCode = 503;
            res.end(JSON.stringify({ success: false, error: 'MT5 unavailable' }));
        }
    } else if (req.url === '/api/send-balance-telegram') {
        if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
            res.statusCode = 503;
            res.end(JSON.stringify({ success: false, error: 'Telegram not configured' }));
            return;
        }
        const acc = lastAccountInfo || await fetchAccountBalance();
        if (acc) {
            const fmt = (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            await sendTelegram([
                `💰 *Баланс счёта*`,
                ``,
                `Баланс: \`${fmt(acc.balance)} ${acc.currency}\``,
                `Эквити: \`${fmt(acc.equity)} ${acc.currency}\``,
                `Свободная маржа: \`${fmt(acc.free_margin)} ${acc.currency}\``,
                `Плечо: 1:${acc.leverage}`,
            ].join('\n'));
            res.end(JSON.stringify({ success: true }));
        } else {
            res.statusCode = 503;
            res.end(JSON.stringify({ success: false, error: 'MT5 unavailable' }));
        }
    } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
    }
});

apiServer.listen(API_PORT, () => log(`API server on port ${API_PORT}`));

// ─── Start ───
if (process.argv.includes('--test-telegram')) {
    (async () => {
        log('Testing Telegram...');
        // Test balance
        const acc = await fetchAccountBalance();
        if (acc) {
            const fmt = (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            await sendTelegram([
                `💰 *Баланс счёта*`,
                ``,
                `Баланс: \`${fmt(acc.balance)} ${acc.currency}\``,
                `Эквити: \`${fmt(acc.equity)} ${acc.currency}\``,
                `Свободная маржа: \`${fmt(acc.free_margin)} ${acc.currency}\``,
                `Плечо: 1:${acc.leverage}`,
            ].join('\n'));
            log('Balance sent to Telegram');
        } else {
            await sendTelegram('⚠ Не удалось получить баланс MT5');
            log('Executor not available or error');
        }
        // Test signal message
        await sendTelegram('✅ Тест Telegram — сканер работает!');
        log('Test message sent');
    })().catch(err => {
        log(`Test error: ${err.message}`);
        process.exit(1);
    });
} else {
    schedulerLoop().catch(err => {
        log(`Fatal error: ${err.message}`);
        process.exit(1);
    });
}
