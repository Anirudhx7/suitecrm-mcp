/**
 * Persistent audit log - SQLite backend.
 *
 * Safe for concurrent use by multiple gateway processes:
 *   - WAL mode: multiple readers + one writer at a time, no corruption.
 *   - busy_timeout: writers queue instead of throwing SQLITE_BUSY.
 *   - Synchronous=NORMAL: crash-safe without full fsync on every write.
 *
 * Fail-safe: if better-sqlite3 is not installed, audit writes are silently
 * skipped and a one-time warning is printed to stderr. The gateway continues
 * running normally - audit is non-fatal.
 *
 * DB file: /var/log/suitecrm-mcp/audit.db
 */

import { mkdirSync } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

const AUDIT_DIR = '/var/log/suitecrm-mcp';
const AUDIT_DB  = `${AUDIT_DIR}/audit.db`;

try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

// Load better-sqlite3 dynamically so a missing native module never crashes the gateway.
let _Database = null;
let _dbLoadAttempted = false;
function getDatabase() {
  if (_dbLoadAttempted) return _Database;
  _dbLoadAttempted = true;
  try {
    _Database = _require('better-sqlite3');
  } catch (e) {
    process.stderr.write(`[audit-db] WARNING: better-sqlite3 not available - audit logging disabled. Run: npm install better-sqlite3\n  (${e.message})\n`);
  }
  return _Database;
}

let _db = null;

function getDb() {
  if (_db) return _db;
  const Database = getDatabase();
  if (!Database) return null;

  _db = new Database(AUDIT_DB);

  // WAL mode: safe concurrent multi-process writes, fast reads.
  _db.pragma('journal_mode = WAL');
  // Queue writes up to 5 s before throwing SQLITE_BUSY.
  _db.pragma('busy_timeout = 5000');
  // Crash-safe without fsync on every INSERT.
  _db.pragma('synchronous = NORMAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL,
      email        TEXT    NOT NULL,
      entity       TEXT    NOT NULL,
      tool         TEXT    NOT NULL,
      module       TEXT,
      msg          TEXT    NOT NULL,
      status       TEXT,
      duration_ms  INTEGER,
      result_count INTEGER,
      req_id       TEXT,
      err          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_email  ON audit_log(email);
    CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity);
    CREATE INDEX IF NOT EXISTS idx_audit_msg    ON audit_log(msg);
    CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_log(status);
  `);

  // Migration: add result_count to any DB created before this column existed.
  try { _db.exec('ALTER TABLE audit_log ADD COLUMN result_count INTEGER'); } catch { /* already exists */ }

  return _db;
}

const _insert = (() => {
  let stmt = null;
  return (record) => {
    const db = getDb();
    if (!db) return; // better-sqlite3 not available - skip silently
    if (!stmt) {
      stmt = db.prepare(`
        INSERT INTO audit_log (ts, email, entity, tool, module, msg, status, duration_ms, result_count, req_id, err)
        VALUES (@ts, @email, @entity, @tool, @module, @msg, @status, @duration_ms, @result_count, @req_id, @err)
      `);
    }
    try {
      stmt.run(record);
    } catch (e) {
      // Non-fatal - log to stderr but never crash the gateway.
      process.stderr.write(`[audit-db] INSERT failed: ${e.message}\n`);
    }
  };
})();

/**
 * Write one audit event. Synchronous but takes ~0.1 ms - safe to call from
 * inside an async request handler without meaningful event-loop impact.
 * No-ops silently if better-sqlite3 is not installed.
 */
export function writeAuditEvent(record) {
  _insert({
    ts:           record.ts,
    email:        record.email        ?? 'unknown',
    entity:       record.entity       ?? '',
    tool:         record.tool         ?? '',
    module:       record.module       ?? null,
    msg:          record.msg          ?? '',
    status:       record.status       ?? null,
    duration_ms:  record.durationMs   ?? null,
    result_count: record.resultCount  ?? null,
    req_id:       record.reqId        ?? null,
    err:          record.err          ?? null,
  });
}

export { AUDIT_DB, AUDIT_DIR, getDb };
