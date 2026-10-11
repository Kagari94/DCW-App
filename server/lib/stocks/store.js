const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
function createStockStore(filename = path.join(__dirname, '../../data/stocks.db')) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS watchlist(symbol TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stock_state(symbol TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stock_meta(key TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stock_articles(key TEXT PRIMARY KEY, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS stock_alerts(id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const decode = row => row ? JSON.parse(row.data) : null;
    function list() { return db.prepare('SELECT data FROM watchlist ORDER BY symbol').all().map(decode); }
    function put(table, key, value, idColumn = 'symbol') {
        db.prepare(`INSERT INTO ${table}(${idColumn},data) VALUES (?,?) ON CONFLICT(${idColumn}) DO UPDATE SET data=excluded.data`)
            .run(key, JSON.stringify(value));
    }
    function alerts({ unread = false, pending = false, includeHidden = false, limit = 100 } = {}) {
        return db.prepare('SELECT data FROM stock_alerts ORDER BY created DESC LIMIT 500').all().map(decode)
            .filter(a => (!unread || !a.read) && (!pending || a.status === 'pending') && (includeHidden || a.visible))
            .slice(0, Math.min(500, limit));
    }
    function saveAlert(alert) {
        db.prepare('INSERT INTO stock_alerts(id,created,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
            .run(alert.id, alert.created, JSON.stringify(alert));
        return alert;
    }
    function remove(symbol) {
        db.prepare('DELETE FROM watchlist WHERE symbol=?').run(symbol);
        db.prepare('DELETE FROM stock_state WHERE symbol=?').run(symbol);
        for (const alert of alerts({ pending: true, includeHidden: true, limit: 500 })) {
            if (alert.symbol === symbol) saveAlert({ ...alert, status: 'cancelled' });
        }
    }
    function prune(now) {
        const before = now - 30 * 86400000;
        db.prepare('DELETE FROM stock_alerts WHERE created<?').run(before);
        db.prepare('DELETE FROM stock_articles WHERE at<?').run(before);
    }
    // A restart must not leave an interrupted explanation permanently running.
    for (const row of db.prepare('SELECT data FROM stock_alerts').all()) {
        const alert = decode(row);
        if (alert.status === 'running') saveAlert({ ...alert, status: 'pending' });
    }
    return { list, get: symbol => decode(db.prepare('SELECT data FROM watchlist WHERE symbol=?').get(symbol)),
        save: item => put('watchlist', item.symbol, item), remove,
        state: symbol => decode(db.prepare('SELECT data FROM stock_state WHERE symbol=?').get(symbol)) || {},
        saveState: (symbol, value) => put('stock_state', symbol, value),
        meta: key => decode(db.prepare('SELECT data FROM stock_meta WHERE key=?').get(key)),
        setMeta: (key, value) => put('stock_meta', key, value, 'key'), alerts, saveAlert,
        alert: id => decode(db.prepare('SELECT data FROM stock_alerts WHERE id=?').get(id)),
        seen: key => Boolean(db.prepare('SELECT 1 FROM stock_articles WHERE key=?').get(key)),
        markSeen: (key, at) => db.prepare('INSERT OR IGNORE INTO stock_articles VALUES (?,?)').run(key, at),
        transaction: run => {
            db.exec('BEGIN IMMEDIATE');
            try { const result = run(); db.exec('COMMIT'); return result; }
            catch (error) { db.exec('ROLLBACK'); throw error; }
        },
        prune, close: () => db.close() };
}
module.exports = { createStockStore };
