/**
 * Codex quota guard — automatically disables Codex accounts that hit HTTP 429
 * (usage limit reached) and re-enables them 24h later.
 *
 * State file: $DATA_DIR/state/codex-account-state/disabled.json
 * DB updates go through the app DB driver (getAdapter) so every adapter
 * (better-sqlite3 / node:sqlite / bun / sql.js) sees the same write.
 *
 * Ported from the live patch that was injected into the published npm build
 * (app/.next-cli-build/server/chunks/4664.js) so the behaviour survives in
 * source form.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { getAdapter } from "@/lib/db/driver.js";

const statePath = (() => {
  try {
    const dir = path.join(process.env.DATA_DIR || path.join(os.homedir(), ".9router"), "state", "codex-account-state");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "disabled.json");
  } catch {
    return null;
  }
})();

async function dbGet(sqlText, params = []) {
  const adapter = await getAdapter();
  return adapter.get(sqlText, params);
}

async function dbRun(sqlText, params = []) {
  const adapter = await getAdapter();
  return adapter.run(sqlText, params);
}


function readState() {
  if (!statePath) return { accounts: {} };
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) || { accounts: {} };
  } catch {
    return { accounts: {} };
  }
}

function writeState(state) {
  if (!statePath) return;
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, statePath);
}

// mkdir-based lock — atomic on all platforms, no dependencies.
// Crash-safe: a lock dir left behind by a hard kill (SIGKILL/OOM never runs
// the finally) is detected by age and broken instead of wedging every future
// guard call behind a 10s event-loop stall.
const STALE_LOCK_MS = 15000;
async function withStateLock(fn) {
  if (!statePath) return fn();
  const lock = `${statePath}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let lockAge = 0;
      try {
        lockAge = Date.now() - fs.statSync(lock).mtimeMs;
      } catch { /* vanished between mkdir and stat — retry immediately */ }
      if (lockAge > STALE_LOCK_MS) {
        try {
          fs.rmSync(lock, { recursive: true, force: true });
          console.warn(`[QUOTA-GUARD] broke stale state lock (age ${Math.round(lockAge / 1000)}s)`);
        } catch { /* removal raced with the owner — keep waiting */ }
        continue;
      }
      if (Date.now() - started > 10000) throw new Error("quota state lock timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

async function getConnectionRow(id) {
  return dbGet(
    "SELECT id, provider, email, isActive FROM providerConnections WHERE id = ?",
    [id],
  );
}

async function setConnectionActive(id, isActive) {
  await dbRun(
    "UPDATE providerConnections SET isActive = ?, updatedAt = ? WHERE id = ? AND provider = 'codex'",
    [isActive ? 1 : 0, new Date().toISOString(), id],
  );
}

function isQuotaError(status) {
  return Number(status) === 429;
}

function isCodex(provider) {
  try {
    return resolveProviderId(provider) === "codex";
  } catch {
    return provider === "codex";
  }
}

/**
 * Sync query for other services (e.g. quota monitor): is this connection
 * currently hard-disabled by the Codex quota guard (within its 24h window)?
 */
export function isAccountGuardDisabled(connectionId, provider = "codex") {
  if (!connectionId || !isCodex(provider) || !statePath) return false;
  try {
    const item = readState().accounts?.[connectionId];
    if (item?.disabled !== true || !item.nextCheckAt) return false;
    return Date.parse(item.nextCheckAt) > Date.now();
  } catch {
    return false;
  }
}

/**
 * Called from markAccountUnavailable() on upstream errors. Codex + HTTP 429
 * means the account's usage limit is exhausted — deactivate it in the DB so
 * account selection skips it entirely until the re-enable window.
 */
export async function disableCodexAccountOnQuota(connectionId, provider, status, error) {
  if (!isCodex(provider) || !connectionId || !isQuotaError(status)) return;
  const now = Date.now();
  const iso = new Date(now).toISOString();
  await withStateLock(async () => {
    const row = await getConnectionRow(connectionId);
    if (!row || row.provider !== "codex") return;
    const state = readState();
    const old = state.accounts?.[connectionId];
    if (old?.disabled === true && Number(row.isActive) === 0) {
      console.warn(`[CODEX_QUOTA_GUARD] already disabled ${row.email || connectionId}`);
      return;
    }
    await setConnectionActive(connectionId, false);
    state.accounts = state.accounts || {};
    state.accounts[connectionId] = {
      ...old,
      disabled: true,
      previousIsActive: old?.previousIsActive ?? Number(row.isActive),
      disabledAt: old?.disabledAt || iso,
      nextCheckAt: old?.nextCheckAt || new Date(now + 86400000).toISOString(),
      email: row.email || old?.email || null,
      reason: String(error || old?.reason || "").slice(0, 500),
    };
    writeState(state);
    console.warn(`[CODEX_QUOTA_GUARD] disabled ${row.email || connectionId} until ${state.accounts[connectionId].nextCheckAt}`);
  });
}

// On boot: make sure accounts marked disabled in the state file are also inactive in the DB
async function reconcileDisabledAccounts() {
  if (!statePath) return;
  await withStateLock(async () => {
    const state = readState();
    const now = Date.now();
    for (const [id, item] of Object.entries(state.accounts || {})) {
      if (item?.disabled !== true || (item.nextCheckAt && Date.parse(item.nextCheckAt) <= now)) continue;
      const row = await getConnectionRow(id);
      if (!row || row.provider !== "codex" || Number(row.isActive) === 0) continue;
      await setConnectionActive(id, false);
      console.warn(`[CODEX_QUOTA_GUARD] reconciled inactive ${row.email || id}`);
    }
    writeState(state);
  });
}

// Hourly: re-enable accounts whose 24h window has passed
async function reenableExpiredAccounts() {
  if (!statePath) return;
  await withStateLock(async () => {
    const state = readState();
    const now = Date.now();
    for (const [id, item] of Object.entries(state.accounts || {})) {
      if (item?.disabled !== true || !item.nextCheckAt || Date.parse(item.nextCheckAt) > now) continue;
      const row = await getConnectionRow(id);
      if (!row || row.provider !== "codex") continue;
      await setConnectionActive(id, Number(item.previousIsActive) !== 0);
      item.disabled = false;
      item.reenabledAt = new Date(now).toISOString();
      console.warn(`[CODEX_QUOTA_GUARD] re-enabled ${item.email || id}`);
    }
    writeState(state);
  });
}

let started = false;

/**
 * Start the background schedulers (reconcile 1s after boot, re-enable hourly).
 * Safe to call multiple times.
 */
export function startCodexQuotaGuard() {
  if (started) return;
  started = true;
  const t1 = setTimeout(
    () => reconcileDisabledAccounts().catch(e => console.error("[CODEX_QUOTA_GUARD] reconcile failed", e.message)),
    1000
  );
  t1.unref?.();
  const t2 = setInterval(
    () => reenableExpiredAccounts().catch(e => console.error("[CODEX_QUOTA_GUARD] re-enable failed", e.message)),
    60 * 60 * 1000
  );
  t2.unref?.();
}
