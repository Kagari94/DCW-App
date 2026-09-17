// ============================================
// server/lib/memory/db.js — SQLite store for facts, summaries, vector chunks
// ============================================
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const sqliteVec = require('sqlite-vec');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'memory.db');

const EMBEDDING_DIM = 384; // output size of Xenova/all-MiniLM-L6-v2

let db = null;

function getDb() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // node:sqlite — built into Node itself (stable since 22.13, you're on
    // 24.10.0) — instead of better-sqlite3. better-sqlite3's node-gyp build
    // was failing on this machine's VS Build Tools config, and it isn't
    // needed: node:sqlite's synchronous API is close enough for our needs,
    // with zero native compilation. allowExtension:true is required at
    // construction time — sqlite-vec's load() needs to enable extension
    // loading internally, and it can't if this wasn't set up front.
    db = new DatabaseSync(DB_PATH, { allowExtension: true });
    sqliteVec.load(db); // registers vec0 virtual-table support on this connection

    db.exec(`
        CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            source_conversation_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(category, key)
        );

        CREATE TABLE IF NOT EXISTS conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            rolling_summary TEXT,
            final_summary TEXT,
            message_count_at_last_summary INTEGER NOT NULL DEFAULT 0,
            finalized INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            chunk_text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
    `);

    // vec0 virtual table — rowid is set explicitly to match memory_chunks.id
    // on insert, so a vector hit maps straight back to its source row with
    // no join table needed. Kept as a SEPARATE table (not columns bolted
    // onto memory_chunks) because vec0 is pre-v1 and its join behavior with
    // regular tables isn't reliable yet — safer to query it standalone and
    // resolve rowids against memory_chunks in a second step.
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
            embedding float[${EMBEDDING_DIM}]
        );
    `);

    return db;
}

// Vector params need to go in as raw bytes, not a bare Float32Array —
// node:sqlite's binding layer expects a Buffer for BLOB params (unlike
// better-sqlite3, which accepts a TypedArray directly). Shared here so
// summaries.js and retrieval.js stay consistent.
function toVecBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
}

module.exports = { getDb, EMBEDDING_DIM, toVecBuffer };