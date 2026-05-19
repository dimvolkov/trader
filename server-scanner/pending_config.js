// Pending order configuration — loaded from JSON file at every scan cycle.
// All criteria can be changed live without restarting the scanner.

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.PENDING_CONFIG_FILE
    || path.join(__dirname, 'pending_config.json');

const DEFAULTS = {
    // Master switch: false → use legacy market orders, true → use pending
    use_pending: false,

    // 'limit' | 'stop' | 'auto' (executor will pick based on entry vs market)
    pending_type: 'limit',

    // Pending lifetime in hours; 0 = GTC (good till cancelled)
    ttl_hours: 0,

    // Drop old pending on same pair before placing new one
    replace_existing_pending: true,

    // Skip placement if current market price drifted from entry by more than
    // (this fraction × distance entry→take). Example: 0.5 means if price is
    // halfway to TP already, R:R is destroyed — skip.
    max_distance_pct_from_entry: 0.5,

    // Background watcher: cancel pending if price already breached the stop
    // before the order could be filled.
    cancel_on_stop_breach: true,

    // Background watcher: cancel pending if it has been alive longer than
    // this many hours (separate from MT5 expiration). 0 = disabled.
    watcher_max_age_hours: 48,

    // How often the background watcher polls /pending and current prices.
    watcher_interval_minutes: 15,

    // Minimum R:R to send an order at all (overrides scanner's default of 3.0).
    min_rr: 3.0,

    // Adaptive filter: skip placement if retrospective winrate on this pair
    // (over `winrate_lookback_days`) is below this threshold AND we have at
    // least `min_samples_for_winrate` historical trades. 0 = disabled.
    min_winrate_threshold: 0.0,
    min_samples_for_winrate: 10,
    winrate_lookback_days: 60,

    // Hard cap on simultaneously active pending orders (defence-in-depth;
    // executor also enforces MAX_PENDING_ORDERS).
    max_pending_total: 10,

    // ─── Strategy thresholds (formerly hardcoded in scanner.js) ───
    // Lookback window for swing-point detection on H1 candles.
    h1_swing_lookback: 5,
    // Lookback window for swing-point detection on M30 candles.
    m30_swing_lookback: 4,
    // Pullback ratio for Signal 2 detection (entry zone = breakLevel + ratio*(impulse)).
    pullback_zone_ratio: 0.5,
    // Tolerance around breakLevel — Signal 2 may touch level within this fraction.
    breakout_tolerance_pct: 0.001,
    // Stop-loss buffer as fraction of |signal2 - signal1| distance.
    stop_buffer_ratio: 0.5,
    // Minimum H1 candles required to start analysis.
    min_h1_candles: 20,
    // Minimum number of swing points to determine trend.
    min_swings_required: 4,

    // ─── Per-pair filters ───
    // List of pairs to skip entirely (e.g. ["GBP/JPY", "AUD/CAD"]).
    pair_blacklist: [],
    // Per-pair risk override: {"EUR/USD": 0.005} overrides RISK_PCT for that pair.
    pair_risk_overrides: {},

    // ─── Time-window filters (applied on top of SCHEDULE_FROM/TO env) ───
    // List of allowed MSK hours [0..23]. Empty = no extra restriction.
    allowed_hours_msk: [],
    // List of allowed weekdays (0=Mon..6=Sun). Empty = all days.
    allowed_weekdays: [],
};

let _cached = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5000;   // re-read at most every 5s

function _loadFromFile() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return { ...DEFAULTS };
    }
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...parsed };
    } catch (err) {
        console.error(`[pending-config] failed to read ${CONFIG_FILE}: ${err.message}`);
        return { ...DEFAULTS };
    }
}

function get(force = false) {
    const now = Date.now();
    if (force || !_cached || now - _cachedAt > CACHE_TTL_MS) {
        _cached = _loadFromFile();
        _cachedAt = now;
    }
    return _cached;
}

// Allowed ranges for numeric fields — surfaced to AI agent so it stays within bounds.
const RANGES = {
    ttl_hours:                   { min: 0,      max: 720 },
    max_distance_pct_from_entry: { min: 0,      max: 1 },
    watcher_max_age_hours:       { min: 0,      max: 720 },
    watcher_interval_minutes:    { min: 1,      max: 1440 },
    min_rr:                      { min: 0.5,    max: 10 },
    min_winrate_threshold:       { min: 0,      max: 1 },
    min_samples_for_winrate:     { min: 1,      max: 10000 },
    winrate_lookback_days:       { min: 1,      max: 365 },
    max_pending_total:           { min: 1,      max: 100 },
    h1_swing_lookback:           { min: 2,      max: 10,   integer: true },
    m30_swing_lookback:          { min: 2,      max: 10,   integer: true },
    pullback_zone_ratio:         { min: 0.2,    max: 0.8 },
    breakout_tolerance_pct:      { min: 0.0001, max: 0.005 },
    stop_buffer_ratio:           { min: 0.1,    max: 1.5 },
    min_h1_candles:              { min: 10,     max: 50,   integer: true },
    min_swings_required:         { min: 3,      max: 8,    integer: true },
};

function _checkNumRange(name, v, errors) {
    const r = RANGES[name];
    if (!r) return;
    if (typeof v !== 'number' || !isFinite(v)) {
        errors.push(`${name} must be a finite number`);
        return;
    }
    if (r.integer && !Number.isInteger(v)) {
        errors.push(`${name} must be an integer`);
        return;
    }
    if (v < r.min || v > r.max) {
        errors.push(`${name} must be in [${r.min}..${r.max}]`);
    }
}

function _validate(patch) {
    const errors = [];
    const allowedKeys = new Set(Object.keys(DEFAULTS));
    for (const k of Object.keys(patch)) {
        if (!allowedKeys.has(k)) errors.push(`unknown key: ${k}`);
    }
    if (patch.use_pending !== undefined && typeof patch.use_pending !== 'boolean') {
        errors.push('use_pending must be boolean');
    }
    if (patch.pending_type !== undefined && !['limit', 'stop', 'auto'].includes(patch.pending_type)) {
        errors.push("pending_type must be 'limit', 'stop' or 'auto'");
    }
    if (patch.replace_existing_pending !== undefined && typeof patch.replace_existing_pending !== 'boolean') {
        errors.push('replace_existing_pending must be boolean');
    }
    if (patch.cancel_on_stop_breach !== undefined && typeof patch.cancel_on_stop_breach !== 'boolean') {
        errors.push('cancel_on_stop_breach must be boolean');
    }
    // Numeric ranges
    const numeric = [
        'ttl_hours', 'max_distance_pct_from_entry', 'watcher_max_age_hours',
        'watcher_interval_minutes', 'min_rr', 'min_winrate_threshold',
        'min_samples_for_winrate', 'winrate_lookback_days', 'max_pending_total',
        'h1_swing_lookback', 'm30_swing_lookback', 'pullback_zone_ratio',
        'breakout_tolerance_pct', 'stop_buffer_ratio', 'min_h1_candles',
        'min_swings_required',
    ];
    for (const k of numeric) {
        if (patch[k] !== undefined) _checkNumRange(k, patch[k], errors);
    }
    // Arrays / objects
    if (patch.pair_blacklist !== undefined) {
        if (!Array.isArray(patch.pair_blacklist)
            || patch.pair_blacklist.some(s => typeof s !== 'string')) {
            errors.push('pair_blacklist must be array of strings');
        } else if (patch.pair_blacklist.length > 50) {
            errors.push('pair_blacklist too large (max 50)');
        }
    }
    if (patch.pair_risk_overrides !== undefined) {
        if (patch.pair_risk_overrides === null
            || typeof patch.pair_risk_overrides !== 'object'
            || Array.isArray(patch.pair_risk_overrides)) {
            errors.push('pair_risk_overrides must be object {pair: riskPct}');
        } else {
            for (const [k, v] of Object.entries(patch.pair_risk_overrides)) {
                if (typeof k !== 'string' || typeof v !== 'number' || v <= 0 || v > 0.5) {
                    errors.push(`pair_risk_overrides[${k}] must be 0 < number <= 0.5`);
                }
            }
        }
    }
    if (patch.allowed_hours_msk !== undefined) {
        if (!Array.isArray(patch.allowed_hours_msk)
            || patch.allowed_hours_msk.some(h => !Number.isInteger(h) || h < 0 || h > 23)) {
            errors.push('allowed_hours_msk must be array of ints 0..23');
        }
    }
    if (patch.allowed_weekdays !== undefined) {
        if (!Array.isArray(patch.allowed_weekdays)
            || patch.allowed_weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
            errors.push('allowed_weekdays must be array of ints 0..6 (Mon=0)');
        }
    }
    return errors;
}

function update(patch) {
    const errors = _validate(patch);
    if (errors.length > 0) {
        return { success: false, errors };
    }
    const current = _loadFromFile();
    const merged = { ...current, ...patch };
    // Only persist non-default values for cleaner config files
    const toWrite = {};
    for (const [k, v] of Object.entries(merged)) {
        toWrite[k] = v;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(toWrite, null, 2), 'utf-8');
    _cached = merged;
    _cachedAt = Date.now();
    return { success: true, config: merged };
}

function defaults() {
    return { ...DEFAULTS };
}

function ranges() {
    return { ...RANGES };
}

module.exports = { get, update, defaults, ranges, validate: _validate, CONFIG_FILE };
