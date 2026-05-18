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

function _validate(patch) {
    const errors = [];
    if (patch.use_pending !== undefined && typeof patch.use_pending !== 'boolean') {
        errors.push('use_pending must be boolean');
    }
    if (patch.pending_type !== undefined && !['limit', 'stop', 'auto'].includes(patch.pending_type)) {
        errors.push("pending_type must be 'limit', 'stop' or 'auto'");
    }
    if (patch.ttl_hours !== undefined && (typeof patch.ttl_hours !== 'number' || patch.ttl_hours < 0)) {
        errors.push('ttl_hours must be number >= 0');
    }
    if (patch.max_distance_pct_from_entry !== undefined
        && (typeof patch.max_distance_pct_from_entry !== 'number'
            || patch.max_distance_pct_from_entry < 0
            || patch.max_distance_pct_from_entry > 1)) {
        errors.push('max_distance_pct_from_entry must be number in [0..1]');
    }
    if (patch.min_rr !== undefined && (typeof patch.min_rr !== 'number' || patch.min_rr <= 0)) {
        errors.push('min_rr must be number > 0');
    }
    if (patch.min_winrate_threshold !== undefined
        && (typeof patch.min_winrate_threshold !== 'number'
            || patch.min_winrate_threshold < 0
            || patch.min_winrate_threshold > 1)) {
        errors.push('min_winrate_threshold must be number in [0..1]');
    }
    if (patch.watcher_interval_minutes !== undefined
        && (typeof patch.watcher_interval_minutes !== 'number' || patch.watcher_interval_minutes < 1)) {
        errors.push('watcher_interval_minutes must be number >= 1');
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

module.exports = { get, update, defaults, CONFIG_FILE };
