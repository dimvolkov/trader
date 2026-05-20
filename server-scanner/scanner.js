// Server-side Forex Scanner with Telegram notifications
// Runs on schedule without browser, checks currency pairs and sends alerts

const pendingConfig = require('./pending_config');
const auth = require('./auth');
const aiAgent = require('./ai-agent');
auth.init();

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

    // Admin secret for /api/pending-config write endpoint (settings UI)
    adminSecret: process.env.SCANNER_ADMIN_SECRET || '',

    // Anthropic Claude (strategy chat assistant)
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
};

const MAX_RISK = CONFIG.deposit * CONFIG.riskPct;

const RATE_DELAYS = {
    twelvedata: 12000, tradermade: 3000, polygon: 12000,
    finnhub: 1500, fcsapi: 21000, alphavantage: 15000, oanda: 500,
};

// ─── Live scan state (for UI sync) ───
const SCAN_HISTORY_MAX = 20;
const lastResults = Object.create(null);          // pair → result with scanTime
const scanHistoryByPair = Object.create(null);    // pair → [{time, trend, rr, entry, valid, reason}, ...]
const scanState = {
    isScanning: false,
    currentPair: null,
    currentIndex: 0,
    totalPairs: 0,
    startedAt: null,
    finishedAt: null,
    nextScanAt: null,
    skipReason: null,
    lastError: null,
};

let interruptDelayFn = null;
function interruptibleDelay(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(() => { interruptDelayFn = null; resolve(); }, ms);
        interruptDelayFn = () => {
            clearTimeout(timer);
            interruptDelayFn = null;
            resolve();
        };
    });
}

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

function getMoscowWeekday() {
    // Returns 0=Mon..6=Sun in MSK timezone.
    const now = new Date();
    const mskMs = now.getTime() + (3 * 60 * 60 * 1000);
    const mskDate = new Date(mskMs);
    // getUTCDay returns 0=Sun..6=Sat; remap to 0=Mon..6=Sun
    return (mskDate.getUTCDay() + 6) % 7;
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

function detectSlom(m30Candles, trendDir, h1Levels, pc) {
    if (!h1Levels.impulseEnd) return null;
    const lookback = pc.m30_swing_lookback;
    const pullbackRatio = pc.pullback_zone_ratio;
    const tol = pc.breakout_tolerance_pct;
    const m30Swings = findSwingPoints(m30Candles, lookback);
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
            const pullbackZone = breakLevel + (microTop.price - breakLevel) * pullbackRatio;
            for (let i = microTop.index + 1; i < m30Candles.length; i++) {
                if (m30Candles[i].low <= pullbackZone && m30Candles[i].low >= breakLevel * (1 - tol)) {
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
            const pullbackZone = breakLevel - (breakLevel - microBottom.price) * pullbackRatio;
            for (let i = microBottom.index + 1; i < m30Candles.length; i++) {
                if (m30Candles[i].high >= pullbackZone && m30Candles[i].high <= breakLevel * (1 + tol)) {
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

function computeEntry(slom, levels, trend, pc) {
    if (!slom || !slom.signal2 || !levels.target) return null;
    const entry = slom.signal2.price;
    const bufferRatio = pc.stop_buffer_ratio;
    const minRr = pc.min_rr;
    let stop, take;
    const buffer = Math.abs(slom.signal2.price - slom.signal1.price) * bufferRatio;
    if (trend === 'up') {
        stop = entry - buffer;
        take = levels.target;
    } else {
        stop = entry + buffer;
        take = levels.target;
    }
    const riskPerUnit = Math.abs(entry - stop);
    const profitPerUnit = Math.abs(take - entry);
    const rr = profitPerUnit / riskPerUnit;
    const positionSize = MAX_RISK / riskPerUnit;
    const potentialProfit = positionSize * profitPerUnit;
    const potentialLoss = MAX_RISK;

    const base = { entry, stop, take, rr, direction: trend, positionSize, potentialProfit, potentialLoss };
    if (rr < minRr) return { ...base, valid: false, reason: `R:R ${rr.toFixed(2)} < ${minRr.toFixed(2)}` };
    return { ...base, valid: true, reason: `R:R = ${rr.toFixed(2)}` };
}

function analyzePair(h1Candles, m30Candles, pc) {
    pc = pc || pendingConfig.get();
    const result = {
        trend: 'range', phase: '—',
        reversal: false, reversalReason: '',
        s1: false, s2: false, s3: false,
        entry: null, rr: null,
        h1Count: h1Candles.length, m30Count: m30Candles.length,
        swingHighs: [], swingLows: [],
        swingCount: 0,
        lastImp: null, lastCorr: null,
        lastImpSize: null, lastCorrSize: null,
        levels: {},
        slom: null,
    };

    if (h1Candles.length < pc.min_h1_candles) return result;

    const swings = findSwingPoints(h1Candles, pc.h1_swing_lookback);
    result.swingCount = swings.length;
    result.swingHighs = swings.filter(s => s.type === 'high').slice(-3).map(s => s.price);
    result.swingLows = swings.filter(s => s.type === 'low').slice(-3).map(s => s.price);
    if (swings.length < pc.min_swings_required) return result;

    result.trend = determineTrend(swings);
    const impulses = segmentSwings(swings, result.trend);

    if (impulses.length > 0) {
        const lastSeg = impulses[impulses.length - 1];
        result.phase = lastSeg.type === 'impulse' ? 'Импульс' : 'Коррекция';
        const lastImpSeg = [...impulses].reverse().find(s => s.type === 'impulse');
        const lastCorrSeg = [...impulses].reverse().find(s => s.type === 'correction');
        if (lastImpSeg) {
            result.lastImp = { startPrice: lastImpSeg.startPrice, endPrice: lastImpSeg.endPrice };
            result.lastImpSize = lastImpSeg.size;
        }
        if (lastCorrSeg) {
            result.lastCorr = { startPrice: lastCorrSeg.startPrice, endPrice: lastCorrSeg.endPrice };
            result.lastCorrSize = lastCorrSeg.size;
        }
        const rev = checkReversal(impulses);
        result.reversal = rev.reversal;
        result.reversalReason = rev.reason;
    }

    if (result.trend !== 'range') {
        const levels = constructLevels(impulses, result.trend, swings);
        result.levels = levels;

        if (m30Candles.length > pc.min_h1_candles) {
            const slom = detectSlom(m30Candles, result.trend, levels, pc);
            if (slom) {
                result.slom = {
                    signal1: slom.signal1 ? { price: slom.signal1.price } : null,
                    signal2: slom.signal2 ? { price: slom.signal2.price } : null,
                    signal3: slom.signal3 ? { price: slom.signal3.price } : null,
                };
                result.s1 = !!slom.signal1;
                result.s2 = !!slom.signal2;
                result.s3 = !!slom.signal3;
                if (slom.signal2) {
                    const entry = computeEntry(slom, levels, result.trend, pc);
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

async function execFetch(method, path, body = null) {
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-API-Secret': CONFIG.executorSecret,
        },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetchWithTimeout(`${CONFIG.executorUrl}${path}`, opts);
    const data = await res.json().catch(() => null);
    if (data === null) {
        return { success: false, error: `HTTP ${res.status} (non-JSON body)` };
    }
    // Normalize FastAPI error shape ({detail: ...}) into our {success, error}
    if (!res.ok && data && data.error === undefined) {
        let detail = data.detail;
        if (Array.isArray(detail)) {
            detail = detail.map(d => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ');
        }
        return { success: false, error: detail || `HTTP ${res.status}`, http_status: res.status, raw: data };
    }
    return data;
}

async function getPairWinrate(pair, days) {
    try {
        const data = await execFetch('GET', `/stats?days=${days}&pair=${encodeURIComponent(pair)}`);
        if (!data.success) return null;
        return {
            trades: data.overall.trades,
            winrate: data.overall.winrate,
        };
    } catch (err) {
        log(`  ${pair}: stats fetch error — ${err.message}`);
        return null;
    }
}

async function getCurrentMarketPrice(pair) {
    try {
        const data = await execFetch('GET', `/symbol/${encodeURIComponent(pair.replace('/', ''))}`);
        if (!data.success) return null;
        return { bid: data.bid, ask: data.ask };
    } catch {
        return null;
    }
}

async function sendOrderToExecutor(pair, result) {
    if (!CONFIG.executorUrl || !CONFIG.executorSecret || !CONFIG.autoTrade) {
        return;
    }

    const pc = pendingConfig.get();
    const e = result.entry;

    // Common R:R override
    if (typeof pc.min_rr === 'number' && e.rr < pc.min_rr) {
        log(`  ${pair}: SKIPPED — R:R ${e.rr.toFixed(2)} < min_rr ${pc.min_rr}`);
        return;
    }

    // Adaptive: skip if historical winrate on this pair is too low
    if (pc.min_winrate_threshold > 0) {
        const wr = await getPairWinrate(pair, pc.winrate_lookback_days);
        if (wr && wr.trades >= pc.min_samples_for_winrate && wr.winrate < pc.min_winrate_threshold) {
            log(`  ${pair}: SKIPPED — historic winrate ${(wr.winrate*100).toFixed(0)}% (${wr.trades} trades) < threshold ${(pc.min_winrate_threshold*100).toFixed(0)}%`);
            return;
        }
    }

    if (pc.use_pending) {
        await placePendingOrder(pair, result, pc);
    } else {
        await placeMarketOrder(pair, result);
    }
}

async function placeMarketOrder(pair, result) {
    const e = result.entry;
    const pc = pendingConfig.get();
    const riskPct = (pc.pair_risk_overrides && pc.pair_risk_overrides[pair]) || CONFIG.riskPct;
    const payload = {
        pair,
        direction: e.direction,
        entry: e.entry,
        stop: e.stop,
        take: e.take,
        rr: e.rr,
        volume: 0,
        deposit: CONFIG.deposit,
        risk_pct: riskPct,
    };
    try {
        const data = await execFetch('POST', '/order', payload);
        if (data.success) {
            log(`  ${pair}: MARKET EXECUTED — id=${data.order_id} vol=${data.volume} price=${data.price}`);
        } else {
            log(`  ${pair}: MARKET FAILED — ${data.error}`);
        }
    } catch (err) {
        log(`  ${pair}: EXECUTOR ERROR — ${err.message}`);
    }
}

async function placePendingOrder(pair, result, pc) {
    const e = result.entry;

    // Drift filter: if market already moved >X% from entry towards take, R:R is gone
    const market = await getCurrentMarketPrice(pair);
    if (market) {
        const refPrice = e.direction === 'up' ? market.ask : market.bid;
        const totalDist = Math.abs(e.take - e.entry);
        const moved = e.direction === 'up'
            ? Math.max(0, refPrice - e.entry)
            : Math.max(0, e.entry - refPrice);
        if (totalDist > 0 && moved / totalDist > pc.max_distance_pct_from_entry) {
            log(`  ${pair}: SKIPPED pending — price drifted ${((moved/totalDist)*100).toFixed(0)}% towards take (> ${(pc.max_distance_pct_from_entry*100).toFixed(0)}%)`);
            return;
        }
    }

    // Replace policy: cancel existing pending on this pair before placing new
    if (pc.replace_existing_pending) {
        try {
            const cdata = await execFetch('POST', `/pending/cancel-by-pair/${encodeURIComponent(pair.replace('/', ''))}?reason=replace`);
            if (cdata.success && cdata.cancelled && cdata.cancelled.length > 0) {
                log(`  ${pair}: cancelled ${cdata.cancelled.length} old pending(s)`);
            }
        } catch (err) {
            log(`  ${pair}: cancel-by-pair error — ${err.message}`);
        }
    }

    // Hard cap on simultaneous pendings
    try {
        const list = await execFetch('GET', '/pending');
        if (list.success && list.orders && list.orders.length >= pc.max_pending_total) {
            log(`  ${pair}: SKIPPED pending — already ${list.orders.length} active (max ${pc.max_pending_total})`);
            return;
        }
    } catch {}

    const riskPct = (pc.pair_risk_overrides && pc.pair_risk_overrides[pair]) || CONFIG.riskPct;
    const payload = {
        pair,
        direction: e.direction,
        entry: e.entry,
        stop: e.stop,
        take: e.take,
        rr: e.rr,
        volume: 0,
        deposit: CONFIG.deposit,
        risk_pct: riskPct,
        pending_type: pc.pending_type,
        ttl_hours: pc.ttl_hours,
        signal_context: {
            trend: result.trend,
            phase: result.phase,
            s1: result.s1, s2: result.s2, s3: result.s3,
            reversal: result.reversal,
            reversalReason: result.reversalReason,
            potentialProfit: e.potentialProfit,
            potentialLoss: e.potentialLoss,
            market_bid: market?.bid,
            market_ask: market?.ask,
        },
        config_snapshot: { ...pc },
    };

    try {
        const data = await execFetch('POST', '/pending', payload);
        if (data.success) {
            log(`  ${pair}: PENDING PLACED — ticket=${data.ticket} type=${data.order_type} entry=${data.entry}`);
        } else {
            log(`  ${pair}: PENDING FAILED — ${data.error}`);
        }
    } catch (err) {
        log(`  ${pair}: EXECUTOR ERROR — ${err.message}`);
    }
}

// ─── Main Scan Cycle ───
async function runScanCycle() {
    const pcInitial = pendingConfig.get(true);
    const rateDelay = RATE_DELAYS[CONFIG.dataSource] || 12000;

    // Apply per-pair filter (blacklist) and time-window filter from live config.
    const blacklist = new Set(pcInitial.pair_blacklist || []);
    const pairs = CONFIG.watchlist.filter(p => !blacklist.has(p));
    const skipped = CONFIG.watchlist.filter(p => blacklist.has(p));

    // Day-of-week filter (MSK).
    if (Array.isArray(pcInitial.allowed_weekdays) && pcInitial.allowed_weekdays.length > 0) {
        const dow = getMoscowWeekday();
        if (!pcInitial.allowed_weekdays.includes(dow)) {
            const msg = `MSK weekday ${dow} not in allowed_weekdays ${JSON.stringify(pcInitial.allowed_weekdays)}`;
            log(`Skipping scan: ${msg}`);
            scanState.skipReason = msg;
            return;
        }
    }
    // Hour-of-day filter (MSK), in addition to scheduleFrom/scheduleTo.
    if (Array.isArray(pcInitial.allowed_hours_msk) && pcInitial.allowed_hours_msk.length > 0) {
        const h = getMoscowHour();
        if (!pcInitial.allowed_hours_msk.includes(h)) {
            const msg = `MSK hour ${h} not in allowed_hours_msk ${JSON.stringify(pcInitial.allowed_hours_msk)}`;
            log(`Skipping scan: ${msg}`);
            scanState.skipReason = msg;
            return;
        }
    }

    log(`=== Scan started: ${pairs.length} pairs [${CONFIG.dataSource}]${skipped.length ? ` (blacklisted: ${skipped.join(',')})` : ''} ===`);

    scanState.isScanning = true;
    scanState.startedAt = new Date().toISOString();
    scanState.finishedAt = null;
    scanState.totalPairs = pairs.length;
    scanState.currentIndex = 0;
    scanState.currentPair = null;
    scanState.skipReason = null;
    scanState.lastError = null;

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
        scanState.currentPair = pair;
        scanState.currentIndex = i + 1;
        log(`  Scanning ${pair} (${i + 1}/${pairs.length})...`);

        const scanTime = new Date().toISOString();
        let result = null;
        let errMsg = null;

        try {
            const h1 = await fetchTimeSeries(pair, '1h');
            await delay(rateDelay);
            const m30 = await fetchTimeSeries(pair, '30min');

            const pc = pendingConfig.get();
            result = analyzePair(h1, m30, pc);
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
            errMsg = err.message;
            log(`  ${pair}: ERROR — ${err.message}`);
        }

        // Publish state for UI even on error.
        lastResults[pair] = result
            ? { ...result, scanTime, error: null }
            : { trend: 'range', phase: '—', s1: false, s2: false, s3: false,
                entry: null, rr: null, h1Count: 0, m30Count: 0,
                scanTime, error: errMsg };

        if (!scanHistoryByPair[pair]) scanHistoryByPair[pair] = [];
        const valid = !!(result && result.entry && result.entry.valid);
        let verdict;
        if (errMsg) verdict = `Ошибка: ${errMsg}`;
        else if (valid) verdict = 'Вход возможен';
        else if (result && result.entry) verdict = result.entry.reason;
        else if (result && result.trend === 'range') verdict = 'Нет тренда';
        else verdict = 'Нет сигнала';
        scanHistoryByPair[pair].push({
            time: scanTime,
            trend: result ? result.trend : 'range',
            rr: result && result.rr ? result.rr : null,
            entry: result && result.entry ? result.entry.entry : null,
            valid,
            verdict,
        });
        if (scanHistoryByPair[pair].length > SCAN_HISTORY_MAX) {
            scanHistoryByPair[pair] = scanHistoryByPair[pair].slice(-SCAN_HISTORY_MAX);
        }

        if (i < pairs.length - 1) await delay(rateDelay);
    }

    scanState.currentPair = null;
    scanState.isScanning = false;
    scanState.finishedAt = new Date().toISOString();

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

    const pc = pendingConfig.get(true);
    log(`  Pending: ${pc.use_pending ? `ON (type=${pc.pending_type}, ttl=${pc.ttl_hours}h)` : 'OFF (market orders)'}`);

    // Initial balance check on startup
    if (CONFIG.executorUrl && CONFIG.executorSecret) {
        const acc = await fetchAccountBalance();
        if (acc) {
            log(`  💰 ${formatBalance(acc)}`);
        } else {
            log(`  ⚠ Executor configured but could not fetch account balance`);
        }
    }

    // Start pending-orders watcher (cancels stale / stop-breached pendings)
    if (CONFIG.executorUrl && CONFIG.executorSecret) {
        startPendingWatcher();
    }

    // Start AI agent daily scheduler (analysis + recommendations)
    if (process.env.AI_AGENT_ENABLED === 'true' && CONFIG.anthropicApiKey
        && CONFIG.executorUrl && CONFIG.executorSecret) {
        aiAgent.startDailyScheduler({
            CONFIG, execFetch, sendTelegram, fetchWithTimeout,
            strategyDoc: STRATEGY_DOC,
        });
    }

    while (true) {
        const moscowHour = getMoscowHour();

        if (isInTimeWindow()) {
            log(`Moscow time ~${moscowHour}:00 — in window, running scan...`);
            try {
                await runScanCycle();
            } catch (err) {
                scanState.lastError = err.message;
                scanState.isScanning = false;
                log(`Scan cycle error: ${err.message}`);
            }
        } else {
            const msg = `outside window (${CONFIG.scheduleFrom}-${CONFIG.scheduleTo})`;
            scanState.skipReason = msg;
            log(`Moscow time ~${moscowHour}:00 — ${msg}, skipping`);
        }

        const delayMs = getNextScanDelayMs();
        scanState.nextScanAt = new Date(Date.now() + delayMs).toISOString();
        log(`Next scan in ${formatMs(delayMs)}`);
        await interruptibleDelay(delayMs);
    }
}

// ─── Pending watcher ───
// Periodically polls active pendings on executor and cancels them when
// (a) market already breached the stop without filling, or (b) too old.

let watcherTimer = null;

async function pendingWatcherTick() {
    if (!CONFIG.executorUrl || !CONFIG.executorSecret) return;
    const pc = pendingConfig.get();
    if (!pc.use_pending) return;
    if (!pc.cancel_on_stop_breach && (!pc.watcher_max_age_hours || pc.watcher_max_age_hours <= 0)) return;

    let list;
    try {
        list = await execFetch('GET', '/pending');
    } catch (err) {
        log(`[watcher] list error: ${err.message}`);
        return;
    }
    if (!list?.success || !list.orders?.length) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const maxAgeSec = (pc.watcher_max_age_hours || 0) * 3600;

    for (const o of list.orders) {
        const reasonsToCancel = [];

        // Age check
        if (maxAgeSec > 0 && o.time_setup && (nowSec - o.time_setup) > maxAgeSec) {
            const ageH = ((nowSec - o.time_setup) / 3600).toFixed(1);
            reasonsToCancel.push(`age ${ageH}h > ${pc.watcher_max_age_hours}h`);
        }

        // Stop breach check
        if (pc.cancel_on_stop_breach && o.sl) {
            const sym = await execFetch('GET', `/symbol/${o.symbol}`);
            if (sym?.success) {
                const isBuy = o.type === 'buy_limit' || o.type === 'buy_stop';
                const price = isBuy ? sym.bid : sym.ask;
                if (isBuy && price <= o.sl) reasonsToCancel.push(`bid ${price} <= SL ${o.sl}`);
                else if (!isBuy && price >= o.sl) reasonsToCancel.push(`ask ${price} >= SL ${o.sl}`);
            }
        }

        if (reasonsToCancel.length > 0) {
            const reason = reasonsToCancel.join(', ');
            try {
                await execFetch('DELETE', `/pending/${o.ticket}?reason=${encodeURIComponent('watcher: ' + reason)}`);
                log(`[watcher] cancelled ${o.symbol} ticket=${o.ticket} — ${reason}`);
            } catch (err) {
                log(`[watcher] cancel ${o.ticket} error: ${err.message}`);
            }
        }
    }
}

function startPendingWatcher() {
    const pc = pendingConfig.get();
    const intervalMs = Math.max(1, pc.watcher_interval_minutes) * 60 * 1000;
    if (watcherTimer) clearInterval(watcherTimer);
    watcherTimer = setInterval(() => {
        pendingWatcherTick().catch(err => log(`[watcher] tick error: ${err.message}`));
    }, intervalMs);
    log(`Pending watcher started, every ${pc.watcher_interval_minutes}m`);
}

// ─── HTTP API for frontend ───
const http = require('http');
const url = require('url');
const API_PORT = process.env.SCANNER_API_PORT || 3001;

function jsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); }
            catch (err) { reject(err); }
        });
        req.on('error', reject);
    });
}

function reply(res, status, body) {
    res.statusCode = status;
    res.end(JSON.stringify(body));
}

function requireAdmin(req) {
    if (!CONFIG.adminSecret) return false;
    return req.headers['x-admin-secret'] === CONFIG.adminSecret;
}

// ─── Strategy chat (Anthropic Claude) ───
const fs = require('fs');
const path = require('path');

const STRATEGY_DOC = (() => {
    try {
        return fs.readFileSync(path.join(__dirname, 'trading_algorithm.md'), 'utf-8');
    } catch (err) {
        log(`[chat] trading_algorithm.md not loaded: ${err.message}`);
        return '';
    }
})();

function buildStrategySystemPrompt() {
    const pc = pendingConfig.get();
    return [
        'Ты — ассистент по торговой стратегии «Слом» (breakout по импульсам и коррекциям).',
        'Отвечай по-русски, кратко и конкретно. Опирайся ТОЛЬКО на материалы ниже.',
        'Если вопрос вне темы стратегии — мягко перенаправь к ней.',
        'Если пользователь предлагает изменения параметров — обсуждай как идеи, не как готовые решения;',
        'не выдавай рекомендации как финансовые советы.',
        '',
        '=== Полный мануал стратегии ===',
        STRATEGY_DOC || '(документ не загружен)',
        '',
        '=== Текущие настраиваемые параметры (pending_config) ===',
        `- Минимальный R:R для сигнала: ${pc.min_rr}`,
        `- Lookback свингов на H1: ${pc.h1_swing_lookback} свечей`,
        `- Lookback свингов на M30: ${pc.m30_swing_lookback} свечей`,
        `- Pullback ratio (зона Сигнала 2): ${pc.pullback_zone_ratio}`,
        `- Допуск к breakLevel: ±${(pc.breakout_tolerance_pct * 100).toFixed(2)}%`,
        `- Буфер стоп-лосса: ${pc.stop_buffer_ratio} × |S2-S1|`,
        `- Минимум свечей H1 для анализа: ${pc.min_h1_candles}`,
        `- Минимум свингов: ${pc.min_swings_required}`,
        '- Глубина анализа: 200 свечей (twelvedata) / 150 свечей (остальные источники)',
        '- Условия тренда H1: 2+ повышающихся максимумов и 2+ повышающихся минимумов (для up; зеркально для down)',
    ].join('\n');
}

const CHAT_RATE_WINDOW_MS = 60_000;
const CHAT_RATE_LIMIT = 15;
const chatRateBuckets = new Map();

// Manual /api/agent/trigger: 1 per 10 minutes per IP
const AGENT_TRIGGER_WINDOW_MS = 10 * 60 * 1000;
const AGENT_TRIGGER_LIMIT = 1;
const agentTriggerBuckets = new Map();

function agentTriggerAllow(ip) {
    const now = Date.now();
    const bucket = (agentTriggerBuckets.get(ip) || []).filter(t => now - t < AGENT_TRIGGER_WINDOW_MS);
    if (bucket.length >= AGENT_TRIGGER_LIMIT) {
        agentTriggerBuckets.set(ip, bucket);
        return false;
    }
    bucket.push(now);
    agentTriggerBuckets.set(ip, bucket);
    return true;
}

function chatRateAllow(ip) {
    const now = Date.now();
    const bucket = (chatRateBuckets.get(ip) || []).filter(t => now - t < CHAT_RATE_WINDOW_MS);
    if (bucket.length >= CHAT_RATE_LIMIT) {
        chatRateBuckets.set(ip, bucket);
        return false;
    }
    bucket.push(now);
    chatRateBuckets.set(ip, bucket);
    return true;
}

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

async function handleChat(req, res) {
    if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
    if (!CONFIG.anthropicApiKey) {
        return reply(res, 503, { success: false, error: 'Anthropic API key not configured on server' });
    }
    if (!chatRateAllow(clientIp(req))) {
        return reply(res, 429, { success: false, error: 'too many requests, slow down' });
    }

    let body;
    try { body = await jsonBody(req); }
    catch { return reply(res, 400, { success: false, error: 'bad JSON' }); }

    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
        return reply(res, 400, { success: false, error: 'messages must be a non-empty array' });
    }
    if (messages.length > 30) {
        return reply(res, 400, { success: false, error: 'too many messages (max 30)' });
    }
    let userChars = 0;
    for (const m of messages) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
            return reply(res, 400, { success: false, error: 'invalid message shape' });
        }
        if (m.role === 'user') userChars += m.content.length;
    }
    if (userChars > 8000) {
        return reply(res, 400, { success: false, error: 'user content too long (max 8000 chars)' });
    }
    if (messages[messages.length - 1].role !== 'user') {
        return reply(res, 400, { success: false, error: 'last message must be from user' });
    }

    const payload = {
        model: CONFIG.anthropicModel,
        max_tokens: 1024,
        temperature: 0.3,
        system: [{
            type: 'text',
            text: buildStrategySystemPrompt(),
            cache_control: { type: 'ephemeral' },
        }],
        messages: messages.map(m => ({ role: m.role, content: m.content })),
    };

    try {
        const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.anthropicApiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
        }, 60_000);

        if (!r.ok) {
            const errText = await r.text().catch(() => '');
            console.error(`[chat] Anthropic ${r.status}: ${errText.slice(0, 500)}`);
            const msg = r.status === 401 ? 'invalid Anthropic API key'
                      : r.status === 429 ? 'Anthropic rate limit hit, try later'
                      : `LLM error (HTTP ${r.status})`;
            return reply(res, 502, { success: false, error: msg });
        }

        const data = await r.json();
        const reply_text = (data.content || [])
            .filter(b => b && b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();
        const usage = data.usage || {};
        log(`[chat] reply ${data.stop_reason} in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens || 0} cache_create=${usage.cache_creation_input_tokens || 0}`);
        return reply(res, 200, {
            success: true,
            reply: reply_text,
            stop_reason: data.stop_reason,
            usage,
        });
    } catch (err) {
        console.error(`[chat] fetch error: ${err.message}`);
        return reply(res, 502, { success: false, error: 'failed to reach LLM' });
    }
}

async function callExecutor(path, { auth = true, timeoutMs = 8000 } = {}) {
    const t0 = Date.now();
    try {
        const headers = auth ? { 'X-API-Secret': CONFIG.executorSecret } : {};
        const r = await fetchWithTimeout(`${CONFIG.executorUrl}${path}`, { headers }, timeoutMs);
        const ms = Date.now() - t0;
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* leave raw */ }
        return { ok: r.ok, status: r.status, data, raw: text, ms };
    } catch (err) {
        return { ok: false, status: 0, data: null, error: err.message, ms: Date.now() - t0 };
    }
}

async function runHealthCheck() {
    const checks = [];
    const add = (name, status, message, detail) => checks.push({ name, status, message, detail });

    if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
        add('Конфигурация executor', 'fail',
            'EXECUTOR_URL или EXECUTOR_API_SECRET не заданы в окружении сканера.');
        return { success: false, configured: false, checks };
    }
    add('Конфигурация executor', 'ok', `URL: ${CONFIG.executorUrl}`);

    // 1. Reachability — /health (no auth)
    const h = await callExecutor('/health', { auth: false, timeoutMs: 5000 });
    if (h.ok && h.data && h.data.status === 'ok') {
        add('Executor отвечает (/health)', 'ok', `HTTP 200 за ${h.ms} мс`);
    } else {
        const msg = h.error
            ? `Сеть: ${h.error}`
            : `HTTP ${h.status}${h.raw ? ` — ${h.raw.slice(0, 200)}` : ''}`;
        add('Executor отвечает (/health)', 'fail', msg);
        return { success: false, configured: true, checks };
    }

    // 2. MT5 terminal status — /terminal (auth)
    const t = await callExecutor('/terminal');
    if (t.status === 404) {
        add('Терминал MT5 (/terminal)', 'skip',
            'Старая версия executor.py — обнови (git pull + перезапуск scheduled task).');
    } else if (t.ok && t.data && t.data.success) {
        const td = t.data;
        add('Терминал MT5 запущен', 'ok',
            `${td.name || 'MetaTrader 5'} build ${td.build || '?'} (${td.company || '—'})`);
        if (td.connected) {
            add('Соединение с брокером', 'ok', 'connected = true');
        } else {
            add('Соединение с брокером', 'fail',
                'MT5 не подключён к торговому серверу. Залогинься в торговый счёт.');
        }
        // Active probe: terminal_info.connected can be true even when the
        // trade account session has dropped — only a real orders_get() probe
        // catches that (see mt5_bridge.terminal_info).
        if (td.authorized === undefined) {
            add('Авторизация в торговом счёте', 'skip',
                'Старая версия executor.py без active-probe. Обнови executor (git pull + Stop-Process + Start-ScheduledTask) и проверь ещё раз.');
        } else if (td.authorized) {
            add('Авторизация в торговом счёте', 'ok', 'orders_get() отвечает без auth-ошибок');
        } else {
            add('Авторизация в торговом счёте', 'fail',
                `Сессия в торговом счёте отвалилась: ${td.auth_error || 'неизвестная ошибка'}. Открой MT5 на VPS, File → Login to Trade Account, введи пароль заново.`);
        }
        if (td.trade_allowed && !td.tradeapi_disabled) {
            add('Алготрейдинг разрешён', 'ok', 'AutoTrading включён в терминале');
        } else {
            const reason = td.tradeapi_disabled
                ? 'API торговли запрещён (Tools → Options → Expert Advisors).'
                : 'Кнопка AutoTrading выключена в MT5.';
            add('Алготрейдинг разрешён', 'fail', reason);
        }
    } else {
        const err = (t.data && t.data.detail) || t.error || `HTTP ${t.status}`;
        add('Терминал MT5 (/terminal)', 'fail', `MT5 недоступен: ${err}`);
    }

    // 3. Account info — /account (auth)
    const a = await callExecutor('/account');
    if (a.ok && a.data && a.data.success) {
        const ad = a.data;
        const fmt = (v) => Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        add('Счёт MT5 подключён', 'ok',
            `Login ${ad.login} @ ${ad.server} · ${fmt(ad.balance)} ${ad.currency} · плечо 1:${ad.leverage}`,
            { balance: ad.balance, equity: ad.equity, free_margin: ad.free_margin, currency: ad.currency });
    } else {
        const err = (a.data && a.data.detail) || a.error || `HTTP ${a.status}`;
        add('Счёт MT5 подключён', 'fail', `Не получили account_info: ${err}`);
    }

    // 4. Live quote — /symbol/EURUSD (auth) — проверяет, что котировки идут от брокера
    const s = await callExecutor('/symbol/EURUSD');
    if (s.ok && s.data && s.data.success && s.data.bid > 0 && s.data.ask > 0) {
        const sd = s.data;
        add('Котировки от брокера', 'ok',
            `${sd.symbol}: bid ${sd.bid} / ask ${sd.ask} · spread ${sd.spread}`);
    } else {
        const err = (s.data && (s.data.error || s.data.detail)) || s.error || `HTTP ${s.status}`;
        add('Котировки от брокера', 'fail', `EURUSD недоступен: ${err}`);
    }

    const success = checks.every(c => c.status !== 'fail');
    return { success, configured: true, checks };
}

async function proxyExecutor(req, res, path) {
    if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
        return reply(res, 503, { success: false, error: 'Executor not configured' });
    }
    try {
        const method = req.method;
        const opts = {
            method,
            headers: { 'X-API-Secret': CONFIG.executorSecret },
        };
        if (method !== 'GET' && method !== 'DELETE') {
            opts.headers['Content-Type'] = 'application/json';
            const body = await jsonBody(req);
            opts.body = JSON.stringify(body);
        }
        const r = await fetchWithTimeout(`${CONFIG.executorUrl}${path}`, opts);
        const data = await r.json().catch(() => ({}));
        return reply(res, r.status, data);
    } catch (err) {
        return reply(res, 502, { success: false, error: err.message });
    }
}

const apiServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    const parsed = url.parse(req.url, true);
    const p = parsed.pathname;

    try {
        // ─── Auth ───
        // Gate used by nginx auth_request: 204 if session valid, 401 otherwise.
        if (p === '/api/auth/check' && req.method === 'GET') {
            const session = auth.getSessionFromRequest(req);
            if (session) { res.statusCode = 204; res.end(); return; }
            return reply(res, 401, { ok: false });
        }
        if (p === '/api/auth/me' && req.method === 'GET') {
            const session = auth.getSessionFromRequest(req);
            if (!session) return reply(res, 401, { ok: false });
            return reply(res, 200, { ok: true, user: { id: session.uid, email: session.email } });
        }
        if (p === '/api/auth/register' && req.method === 'POST') {
            let body;
            try { body = await jsonBody(req); }
            catch { return reply(res, 400, { ok: false, error: 'bad JSON' }); }
            const r = await auth.registerUser({ email: body.email, password: body.password, name: body.name });
            return reply(res, r.ok ? 200 : 400, r);
        }
        if (p === '/api/auth/verify' && req.method === 'GET') {
            const r = auth.verifyEmail({ token: parsed.query.token, email: parsed.query.email });
            return reply(res, r.ok ? 200 : 400, r);
        }
        if (p === '/api/auth/login' && req.method === 'POST') {
            let body;
            try { body = await jsonBody(req); }
            catch { return reply(res, 400, { ok: false, error: 'bad JSON' }); }
            const r = auth.loginUser({ email: body.email, password: body.password });
            if (!r.ok) return reply(res, 401, r);
            auth.setSessionCookie(req, res, r.user);
            return reply(res, 200, { ok: true, user: { id: r.user.id, email: r.user.email } });
        }
        if (p === '/api/auth/logout' && req.method === 'POST') {
            auth.clearSessionCookie(req, res);
            return reply(res, 200, { ok: true });
        }
        if (p === '/api/auth/reset/request' && req.method === 'POST') {
            let body;
            try { body = await jsonBody(req); }
            catch { return reply(res, 400, { ok: false, error: 'bad JSON' }); }
            const r = await auth.requestPasswordReset({ email: body.email });
            return reply(res, 200, r);
        }
        if (p === '/api/auth/reset/apply' && req.method === 'POST') {
            let body;
            try { body = await jsonBody(req); }
            catch { return reply(res, 400, { ok: false, error: 'bad JSON' }); }
            const r = auth.applyPasswordReset({ token: body.token, password: body.password });
            return reply(res, r.ok ? 200 : 400, r);
        }

        if (p === '/api/balance') {
            if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
                return reply(res, 503, { success: false, error: 'Executor not configured' });
            }
            const acc = lastAccountInfo || await fetchAccountBalance();
            if (acc) {
                return reply(res, 200, { success: true, balance: acc.balance, equity: acc.equity, free_margin: acc.free_margin, currency: acc.currency, leverage: acc.leverage });
            }
            return reply(res, 503, { success: false, error: 'MT5 unavailable' });
        }

        if (p === '/api/health-check' && req.method === 'GET') {
            return reply(res, 200, await runHealthCheck());
        }

        if (p === '/api/send-balance-telegram') {
            if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
                return reply(res, 503, { success: false, error: 'Telegram not configured' });
            }
            const acc = lastAccountInfo || await fetchAccountBalance();
            if (!acc) return reply(res, 503, { success: false, error: 'MT5 unavailable' });
            const fmt = (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            await sendTelegram([
                `💰 *Баланс счёта*`, ``,
                `Баланс: \`${fmt(acc.balance)} ${acc.currency}\``,
                `Эквити: \`${fmt(acc.equity)} ${acc.currency}\``,
                `Свободная маржа: \`${fmt(acc.free_margin)} ${acc.currency}\``,
                `Плечо: 1:${acc.leverage}`,
            ].join('\n'));
            return reply(res, 200, { success: true });
        }

        // ─── Pending config (live-editable settings) ───
        if (p === '/api/pending-config' && req.method === 'GET') {
            return reply(res, 200, {
                success: true,
                config: pendingConfig.get(true),
                defaults: pendingConfig.defaults(),
            });
        }
        if (p === '/api/pending-config' && req.method === 'POST') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            let patch;
            try { patch = await jsonBody(req); }
            catch (e) { return reply(res, 400, { success: false, error: 'bad JSON' }); }
            const r = pendingConfig.update(patch);
            if (!r.success) return reply(res, 400, r);
            startPendingWatcher();   // re-init in case interval changed
            return reply(res, 200, r);
        }

        // ─── Executor proxies (admin-gated) ───
        if (p === '/api/pending-list' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            return proxyExecutor(req, res, '/pending');
        }
        if (p.startsWith('/api/pending-cancel/') && req.method === 'DELETE') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const ticket = p.split('/').pop();
            return proxyExecutor(req, res, `/pending/${ticket}?reason=manual_ui`);
        }
        if (p === '/api/stats' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const qs = parsed.search || '';
            return proxyExecutor(req, res, `/stats${qs}`);
        }
        if (p === '/api/analysis' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const qs = parsed.search || '';
            return proxyExecutor(req, res, `/analysis${qs}`);
        }
        if (p === '/api/history' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const qs = parsed.search || '';
            return proxyExecutor(req, res, `/history${qs}`);
        }
        if (p === '/api/journal' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const qs = parsed.search || '';
            return proxyExecutor(req, res, `/journal${qs}`);
        }

        // ─── Scan state (UI sync with server scanner) ───
        if (p === '/api/scan-state' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const pc = pendingConfig.get();
            const blacklist = new Set(pc.pair_blacklist || []);
            const results = {};
            const history = {};
            for (const pair of CONFIG.watchlist) {
                if (lastResults[pair]) results[pair] = lastResults[pair];
                if (scanHistoryByPair[pair]) history[pair] = scanHistoryByPair[pair];
            }
            return reply(res, 200, {
                success: true,
                scanState,
                watchlist: CONFIG.watchlist,
                blacklist: Array.from(blacklist),
                dataSource: CONFIG.dataSource,
                intervalHours: CONFIG.intervalHours,
                scheduleFrom: CONFIG.scheduleFrom,
                scheduleTo: CONFIG.scheduleTo,
                deposit: CONFIG.deposit,
                riskPct: CONFIG.riskPct,
                minRr: pc.min_rr,
                results,
                history,
            });
        }
        if (p === '/api/scan-history' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const pair = parsed.query.pair;
            if (!pair) return reply(res, 400, { success: false, error: 'pair query param required' });
            return reply(res, 200, { success: true, pair, history: scanHistoryByPair[pair] || [] });
        }
        if (p === '/api/scan-trigger' && req.method === 'POST') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            if (scanState.isScanning) {
                return reply(res, 409, { success: false, error: 'scan already in progress' });
            }
            if (!interruptDelayFn) {
                return reply(res, 409, { success: false, error: 'scheduler not waiting' });
            }
            interruptDelayFn();
            return reply(res, 200, { success: true, message: 'scan triggered' });
        }

        // ─── AI Agent endpoints ───
        if (p === '/api/agent/recommendations' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const status = parsed.query.status || null;
            const limit = parseInt(parsed.query.limit || '50', 10);
            try {
                const recs = aiAgent.getRecommendations({ status, limit });
                return reply(res, 200, { success: true, recommendations: recs });
            } catch (err) {
                return reply(res, 500, { success: false, error: err.message });
            }
        }
        if (p.startsWith('/api/agent/recommendation/') && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            const id = decodeURIComponent(p.replace('/api/agent/recommendation/', ''));
            const rec = aiAgent.getRecommendation(id);
            if (!rec) return reply(res, 404, { success: false, error: 'not found' });
            return reply(res, 200, { success: true, recommendation: rec });
        }
        if (p === '/api/agent/apply' && req.method === 'POST') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            let body;
            try { body = await jsonBody(req); }
            catch { return reply(res, 400, { success: false, error: 'bad JSON' }); }
            const session = auth.getSessionFromRequest(req);
            const r = aiAgent.applyRecommendation(
                body.recommendation_id, body.proposal_id,
                session && session.email
            );
            if (!r.ok) return reply(res, 400, { success: false, error: r.error });
            startPendingWatcher();   // re-init in case watcher_interval changed
            return reply(res, 200, { success: true, before: r.before, after: r.after, diff: r.diff });
        }
        if (p === '/api/agent/dismiss' && req.method === 'POST') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            let body;
            try { body = await jsonBody(req); }
            catch { return reply(res, 400, { success: false, error: 'bad JSON' }); }
            const session = auth.getSessionFromRequest(req);
            const r = aiAgent.dismissRecommendation(
                body.recommendation_id, body.proposal_id, body.reason,
                session && session.email
            );
            if (!r.ok) return reply(res, 400, { success: false, error: r.error });
            return reply(res, 200, { success: true });
        }
        if (p === '/api/agent/history' && req.method === 'GET') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            try {
                const h = await aiAgent.getHistory({ execFetch });
                return reply(res, 200, { success: true, ...h });
            } catch (err) {
                return reply(res, 500, { success: false, error: err.message });
            }
        }
        if (p === '/api/agent/trigger' && req.method === 'POST') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            if (!agentTriggerAllow(clientIp(req))) {
                return reply(res, 429, { success: false, error: 'too many triggers, max 1 per 10 min' });
            }
            if (aiAgent.isRunning()) {
                return reply(res, 409, { success: false, error: 'agent already running' });
            }
            try {
                const r = await aiAgent.manualRun({
                    CONFIG, execFetch, sendTelegram, fetchWithTimeout,
                    strategyDoc: STRATEGY_DOC,
                });
                if (!r.ok) return reply(res, 502, { success: false, error: r.error });
                return reply(res, 200, { success: true, report_id: r.report_id, proposals: r.proposals });
            } catch (err) {
                return reply(res, 500, { success: false, error: err.message });
            }
        }

        // ─── Manual pending order: place an order from a pattern detected in UI ───
        if (p === '/api/manual-pending' && req.method === 'POST') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
                return reply(res, 503, { success: false, error: 'Executor not configured' });
            }
            let body;
            try { body = await jsonBody(req); }
            catch { return reply(res, 400, { success: false, error: 'bad JSON' }); }
            const required = ['pair', 'direction', 'entry', 'stop', 'take', 'rr'];
            for (const f of required) {
                if (body[f] === undefined || body[f] === null) {
                    return reply(res, 400, { success: false, error: `missing ${f}` });
                }
            }
            const dirIn = String(body.direction).toLowerCase();
            const direction = (dirIn === 'up' || dirIn === 'buy' || dirIn === 'long') ? 'up' : 'down';
            const volume = (typeof body.volume === 'number' && body.volume > 0) ? body.volume : 0;
            const pc = pendingConfig.get();
            const payload = {
                pair: body.pair,
                direction,
                entry: +body.entry, stop: +body.stop, take: +body.take, rr: +body.rr,
                volume,
                deposit: CONFIG.deposit,
                risk_pct: CONFIG.riskPct,
                pending_type: pc.pending_type,
                ttl_hours: pc.ttl_hours,
                signal_context: {
                    manual: true,
                    source: 'scanner.html',
                    trend: body.trend, phase: body.phase,
                    note: 'manual placement from UI — detected pattern',
                },
                config_snapshot: { ...pc, manual_mode: true },
            };
            try {
                const data = await execFetch('POST', '/pending', payload);
                log(`  MANUAL PENDING ${payload.pair} ${direction}: entry=${payload.entry} stop=${payload.stop} take=${payload.take} → ${data.success ? `OK ticket=${data.ticket}` : `FAIL ${data.error}`}`);
                return reply(res, 200, { request: payload, response: data });
            } catch (err) {
                return reply(res, 502, { success: false, error: err.message });
            }
        }

        // ─── Test pending order: synthetic signal near current market ───
        if (p === '/api/test-pending' && req.method === 'POST') {
            if (!requireAdmin(req)) return reply(res, 401, { success: false, error: 'admin secret required' });
            if (!CONFIG.executorUrl || !CONFIG.executorSecret) {
                return reply(res, 503, { success: false, error: 'Executor not configured' });
            }
            let body = {};
            try { body = await jsonBody(req); } catch {}
            const pair = body.pair || 'EUR/USD';
            const dirIn = String(body.direction || 'down').toLowerCase();
            const direction = (dirIn === 'up' || dirIn === 'buy' || dirIn === 'long') ? 'up' : 'down';
            const volume = (typeof body.volume === 'number' && body.volume > 0) ? body.volume : 0.01;
            const distPips = typeof body.distance_pips === 'number' ? body.distance_pips : 10;
            const slPips = typeof body.sl_pips === 'number' ? body.sl_pips : 20;
            const tpPips = typeof body.tp_pips === 'number' ? body.tp_pips : 60;

            const market = await getCurrentMarketPrice(pair);
            if (!market) return reply(res, 502, { success: false, error: 'no market price (executor or symbol unavailable)' });

            const pip = pair.includes('JPY') ? 0.01 : 0.0001;
            const decimals = pair.includes('JPY') ? 3 : 5;
            const round = (v) => +v.toFixed(decimals);
            let entry, stop, take;
            if (direction === 'up') {
                entry = round(market.bid - distPips * pip);
                stop = round(entry - slPips * pip);
                take = round(entry + tpPips * pip);
            } else {
                entry = round(market.ask + distPips * pip);
                stop = round(entry + slPips * pip);
                take = round(entry - tpPips * pip);
            }
            const rr = +(Math.abs(take - entry) / Math.abs(stop - entry)).toFixed(2);
            const pc = pendingConfig.get();
            const payload = {
                pair, direction, entry, stop, take, rr,
                volume,
                deposit: CONFIG.deposit,
                risk_pct: CONFIG.riskPct,
                pending_type: pc.pending_type,
                ttl_hours: pc.ttl_hours,
                signal_context: {
                    test: true,
                    market_bid: market.bid,
                    market_ask: market.ask,
                    note: 'synthetic test pending — not a real signal',
                },
                config_snapshot: { ...pc, test_mode: true },
            };
            try {
                const data = await execFetch('POST', '/pending', payload);
                log(`  TEST PENDING ${pair} ${direction}: entry=${entry} stop=${stop} take=${take} vol=${volume} → ${data.success ? `OK ticket=${data.ticket}` : `FAIL ${data.error}`}`);
                return reply(res, 200, { request: payload, response: data });
            } catch (err) {
                return reply(res, 502, { success: false, error: err.message });
            }
        }

        // ─── Strategy chat (Anthropic Claude) ───
        if (p === '/api/chat' && req.method === 'POST') {
            return handleChat(req, res);
        }

        return reply(res, 404, { error: 'not found' });
    } catch (err) {
        return reply(res, 500, { success: false, error: err.message });
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
} else if (process.argv.includes('--test-agent-digest')) {
    (async () => {
        log('Running AI agent (manual one-shot, sends digest)...');
        const r = await aiAgent.manualRun({
            CONFIG, execFetch, sendTelegram, fetchWithTimeout,
            strategyDoc: STRATEGY_DOC,
        });
        log(`Agent result: ${JSON.stringify(r)}`);
    })().catch(err => {
        log(`Agent test error: ${err.message}`);
        process.exit(1);
    });
} else {
    schedulerLoop().catch(err => {
        log(`Fatal error: ${err.message}`);
        process.exit(1);
    });
}
