// SQLite store for OHLC candles fetched by the scanner.
// Single file at /data/candles.db (persistent volume `scanner-data`).
// One row per (symbol, timeframe, candle-open-time) — re-fetches overwrite.

const DB_FILE = process.env.CANDLE_DB_FILE || '/data/candles.db';

let db = null;
let insertStmt = null;
let initFailed = false;

function init() {
    if (db || initFailed) return db;
    try {
        const Database = require('better-sqlite3');
        db = new Database(DB_FILE);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.exec(`
            CREATE TABLE IF NOT EXISTS candles (
                symbol     TEXT    NOT NULL,
                timeframe  TEXT    NOT NULL,
                time       INTEGER NOT NULL,
                open       REAL    NOT NULL,
                high       REAL    NOT NULL,
                low        REAL    NOT NULL,
                close      REAL    NOT NULL,
                source     TEXT,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY (symbol, timeframe, time)
            );
            CREATE INDEX IF NOT EXISTS idx_candles_lookup
                ON candles(symbol, timeframe, time DESC);
        `);
        insertStmt = db.prepare(`
            INSERT INTO candles (symbol, timeframe, time, open, high, low, close, source, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, timeframe, time) DO UPDATE SET
                open       = excluded.open,
                high       = excluded.high,
                low        = excluded.low,
                close      = excluded.close,
                source     = excluded.source,
                fetched_at = excluded.fetched_at
        `);
        console.log(`[candle-store] opened ${DB_FILE}`);
    } catch (err) {
        initFailed = true;
        console.error(`[candle-store] init failed: ${err.message} — candle logging disabled`);
    }
    return db;
}

function save(symbol, timeframe, candles, source) {
    if (!Array.isArray(candles) || candles.length === 0) return 0;
    if (!init()) return 0;
    const fetchedAt = Math.floor(Date.now() / 1000);
    const tx = db.transaction((rows) => {
        let n = 0;
        for (const c of rows) {
            if (!Number.isFinite(c.time)) continue;
            if (!Number.isFinite(c.open) || !Number.isFinite(c.high)
                || !Number.isFinite(c.low) || !Number.isFinite(c.close)) continue;
            insertStmt.run(
                symbol, timeframe, c.time | 0,
                c.open, c.high, c.low, c.close,
                source || null, fetchedAt,
            );
            n++;
        }
        return n;
    });
    try {
        return tx(candles);
    } catch (err) {
        console.error(`[candle-store] save ${symbol} ${timeframe} failed: ${err.message}`);
        return 0;
    }
}

function query({ symbol, timeframe, fromTime, toTime, limit } = {}) {
    if (!init()) return [];
    const clauses = [];
    const params = [];
    if (symbol)    { clauses.push('symbol = ?');    params.push(symbol); }
    if (timeframe) { clauses.push('timeframe = ?'); params.push(timeframe); }
    if (fromTime)  { clauses.push('time >= ?');     params.push(fromTime | 0); }
    if (toTime)    { clauses.push('time <= ?');     params.push(toTime | 0); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 10000);
    const rows = db.prepare(
        `SELECT symbol, timeframe, time, open, high, low, close, source, fetched_at
         FROM candles ${where}
         ORDER BY time DESC
         LIMIT ?`
    ).all(...params, lim);
    return rows.reverse();
}

function stats() {
    if (!init()) return { available: false };
    const total = db.prepare('SELECT COUNT(*) AS n FROM candles').get().n;
    const bySeries = db.prepare(`
        SELECT symbol, timeframe,
               COUNT(*)  AS candles,
               MIN(time) AS first_time,
               MAX(time) AS last_time
        FROM candles
        GROUP BY symbol, timeframe
        ORDER BY symbol, timeframe
    `).all();
    return { available: true, db_file: DB_FILE, total, series: bySeries };
}

module.exports = { init, save, query, stats };
