import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export function createBetterSqliteAdapter(filePath) {
  const db = new Database(filePath);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  const stmtCache = new Map();

  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Truncate WAL periodically so file stays small for backup/copy
  const checkpointTimer = setInterval(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown.
  // CRITICAL: close the DB only AFTER the drain grace period, not before it.
  // Closing immediately on SIGTERM/SIGINT pulled the connection out from under
  // live requests still completing in that window, surfacing as cascading
  // "The database connection is not open" errors (and "All models failed" combos).
  // Order: drain in-flight work → checkpoint+close → exit. The timer is unref'd —
  // if the event loop empties first the process exits naturally via beforeExit.
  const SHUTDOWN_GRACE_MS = 1000;
  const onShutdown = () => gracefulClose();
  const exitAfterGrace = () => {
    const t = setTimeout(() => {
      onShutdown();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    t.unref?.();
  };
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", exitAfterGrace);
  process.once("SIGTERM", exitAfterGrace);

  return {
    driver: "better-sqlite3",
    run(sql, params = []) { return prepare(sql).run(...params); },
    get(sql, params = []) { return prepare(sql).get(...params); },
    all(sql, params = []) { return prepare(sql).all(...params); },
    exec(sql) { return db.exec(sql); },
    transaction(fn) { return db.transaction(fn)(); },
    checkpoint() { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
