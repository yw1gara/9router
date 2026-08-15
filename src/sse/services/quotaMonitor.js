/**
 * Quota Monitor — server-side background daemon that keeps quota state fresh
 * for every connection and auto-toggles availability:
 *
 *   depleted quota  → isActive = false (+ providerSpecificData.autoQuotaDisabled)
 *   quota recovered → isActive = true  (only for connections IT disabled —
 *                     manually disabled connections are never touched)
 *
 * The dashboard's /api/usage/[id] (non-force) reads this monitor's state
 * instead of hitting the provider, so client auto-refresh costs nothing
 * upstream.
 *
 * Optimization:
 *   - staggered scheduling (never bursts), max a few checks per tick
 *   - one check per provider per tick (anti rate-limit)
 *   - reset-aware: a quota with resetAt in the future is not re-checked
 *     before the reset time
 *   - exponential backoff on failures (10m → 20m → 40m … cap 60m)
 *   - in-flight dedup; "usage not implemented" providers poll rarely
 *
 * State file: $DATA_DIR/state/quota-monitor/state.json (no SQLite schema
 * changes; DB writes use the existing updateProviderConnection API).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TICK_MS = 30 * 1000;
const BASE_INTERVAL_MS = 10 * 60 * 1000;
const MIN_NEXT_DELAY_MS = 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const NOT_IMPLEMENTED_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_CHECKS_PER_TICK = 3;
const DEPLETED_THRESHOLD_PCT = 5; // remaining <= 5% ⇒ depleted (same as dashboard)

const stateDir = (() => {
  try {
    const dir = path.join(process.env.DATA_DIR || path.join(os.homedir(), ".9router"), "state", "quota-monitor");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
})();
const statePath = stateDir ? path.join(stateDir, "state.json") : null;

/** @type {Map<string, any>} connectionId → { provider, usage, depleted, checkedAt, nextCheckAt, failures, inFlight } */
const entries = new Map();
let timer = null;
let ticking = false;
let log = {
  info: (tag, msg) => console.log(`[QUOTA-MONITOR] ${msg}`),
  warn: (tag, msg) => console.warn(`[QUOTA-MONITOR] ${msg}`),
};

function persistState() {
  if (!statePath) return;
  try {
    const snapshot = {};
    for (const [id, e] of entries) {
      snapshot[id] = {
        provider: e.provider,
        depleted: e.depleted,
        checkedAt: e.checkedAt,
        nextCheckAt: e.nextCheckAt,
        failures: e.failures,
      };
    }
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, snapshot }, null, 2));
    fs.renameSync(tmp, statePath);
  } catch (e) {
    log.warn("QUOTA-MONITOR", `state persist failed: ${e?.message || e}`);
  }
}

function loadState() {
  if (!statePath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const [id, s] of Object.entries(raw?.snapshot || {})) {
      // usage is NOT persisted (large + stale); force one fresh check on boot,
      // scheduled with a small stagger.
      entries.set(id, {
        provider: s.provider,
        usage: null,
        depleted: Boolean(s.depleted),
        checkedAt: s.checkedAt || null,
        nextCheckAt: Date.now() + Math.floor(Math.random() * 60_000),
        failures: 0,
        inFlight: false,
      });
    }
  } catch {
    /* fresh start */
  }
}

/** Generic quota extraction: {quotas: {name: {used,total,resetAt}}} or array. */
export function extractQuotas(usage) {
  if (!usage || typeof usage !== "object") return [];
  const q = usage.quotas;
  if (Array.isArray(q)) {
    return q.map((x) => ({ used: Number(x?.used) || 0, total: Number(x?.total) || 0, resetAt: x?.resetAt || x?.reset_at || null }));
  }
  if (q && typeof q === "object") {
    return Object.values(q).map((x) => ({
      used: Number(x?.used) || 0,
      total: Number(x?.total) || 0,
      resetAt: x?.resetAt || x?.reset_at || null,
    }));
  }
  return [];
}

/** Depleted when ANY bounded quota has remaining <= threshold. */
export function isUsageDepleted(usage) {
  const quotas = extractQuotas(usage);
  const bounded = quotas.filter((x) => x.total > 0);
  if (bounded.length === 0) return false;
  return bounded.some((x) => ((x.total - x.used) / x.total) * 100 <= DEPLETED_THRESHOLD_PCT);
}

/** Earliest future reset timestamp (epoch ms) across quotas, or null. */
export function earliestResetAt(usage) {
  const times = extractQuotas(usage)
    .map((x) => (x.resetAt ? new Date(x.resetAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t) && t > Date.now());
  return times.length ? Math.min(...times) : null;
}

function scheduleNext(entry, usage) {
  const reset = earliestResetAt(usage);
  if (reset) {
    // Check shortly after the earliest reset window, but not less than a
    // minute out and not further than the base interval.
    const afterReset = reset + 30_000;
    entry.nextCheckAt = Math.min(
      Math.max(afterReset, Date.now() + MIN_NEXT_DELAY_MS),
      Date.now() + BASE_INTERVAL_MS,
    );
  } else {
    entry.nextCheckAt = Date.now() + BASE_INTERVAL_MS;
  }
}

function isUsageNotImplemented(usage) {
  return typeof usage?.message === "string" && usage.message.startsWith("Usage API not implemented");
}

function isAuthExpiredUsage(usage) {
  const msg = typeof usage?.message === "string" ? usage.message.toLowerCase() : "";
  return ["expired", "authentication", "unauthorized", "401", "re-authorize"].some((p) => msg.includes(p));
}

async function runCheck(deps, connection) {
  const entry = entries.get(connection.id);
  if (!entry || entry.inFlight) return;
  entry.inFlight = true;
  try {
    let credentials = connection;
    if (connection.authType === "oauth" && deps.checkAndRefreshToken) {
      credentials = await deps.checkAndRefreshToken(connection.provider, connection);
    }

    const proxyConfig = await deps.resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    const usage = await deps.getUsageForProvider(credentials, proxyOptions, { force: false });
    entry.usage = usage;
    entry.checkedAt = new Date().toISOString();
    entry.failures = 0;

    if (isUsageNotImplemented(usage)) {
      entry.depleted = false;
      entry.nextCheckAt = Date.now() + NOT_IMPLEMENTED_INTERVAL_MS;
      return;
    }

    if (isAuthExpiredUsage(usage)) {
      // Auth problem ≠ quota problem: no toggling, moderate backoff.
      entry.nextCheckAt = Date.now() + BASE_INTERVAL_MS * 2;
      return;
    }

    const depleted = isUsageDepleted(usage);
    entry.depleted = depleted;
    scheduleNext(entry, usage);

    const isActive = connection.isActive ?? true;
    const marked = Boolean(connection.providerSpecificData?.autoQuotaDisabled);
    const guardDisabled = deps.isCodexGuardDisabled ? deps.isCodexGuardDisabled(connection.id, connection.provider) : false;

    if (depleted && isActive && !guardDisabled) {
      await deps.updateProviderConnection(connection.id, {
        isActive: false,
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          autoQuotaDisabled: new Date().toISOString(),
        },
      });
      log.info("QUOTA-MONITOR", `${connection.provider}/${connection.displayName || String(connection.id).slice(0, 8)} depleted → auto OFF`);
    } else if (!depleted && !isActive && marked && !guardDisabled) {
      // Only re-enable connections this monitor disabled — manual offs stay off.
      const psd = { ...(connection.providerSpecificData || {}) };
      delete psd.autoQuotaDisabled;
      await deps.updateProviderConnection(connection.id, {
        isActive: true,
        providerSpecificData: psd,
      });
      log.info("QUOTA-MONITOR", `${connection.provider}/${connection.displayName || String(connection.id).slice(0, 8)} recovered → auto ON`);
    }
  } catch (e) {
    entry.failures = (entry.failures || 0) + 1;
    const backoff = Math.min(BASE_INTERVAL_MS * Math.pow(2, entry.failures), BACKOFF_CAP_MS);
    entry.nextCheckAt = Date.now() + backoff;
    log.warn("QUOTA-MONITOR", `check failed for ${connection.provider}/${String(connection.id).slice(0, 8)}: ${e?.message || e} (next in ${Math.round(backoff / 60000)}m)`);
  } finally {
    entry.inFlight = false;
    persistState();
  }
}

async function tick(deps) {
  if (ticking) return;
  ticking = true;
  try {
    const connections = await deps.getConnections();
    const byId = new Map(connections.map((c) => [c.id, c]));
    // Drop entries for deleted connections.
    for (const id of [...entries.keys()]) {
      if (!byId.has(id)) entries.delete(id);
    }

    const now = Date.now();
    const due = [];
    for (const c of connections) {
      let entry = entries.get(c.id);
      if (!entry) {
        // Eligibility mirrors /api/usage: oauth, or apikey providers with usage handlers.
        const isOAuth = c.authType === "oauth";
        const isApikeyEligible =
          (c.authType === "apikey" || c.authType === "api_key") &&
          (deps.USAGE_APIKEY_PROVIDERS || []).includes(c.provider);
        if (!isOAuth && !isApikeyEligible) continue;
        entry = {
          provider: c.provider,
          usage: null,
          depleted: false,
          checkedAt: null,
          nextCheckAt: now + Math.floor(Math.random() * 60_000), // boot stagger
          failures: 0,
          inFlight: false,
        };
        entries.set(c.id, entry);
      }
      if (entry.nextCheckAt <= now && !entry.inFlight) due.push(c);
    }

    // One check per provider per tick + global cap.
    const seenProviders = new Set();
    let launched = 0;
    for (const connection of due) {
      if (launched >= MAX_CHECKS_PER_TICK) break;
      if (seenProviders.has(connection.provider)) continue;
      seenProviders.add(connection.provider);
      launched++;
      runCheck(deps, connection).catch(() => {});
    }
    persistState();
  } catch (e) {
    log.warn("QUOTA-MONITOR", `tick failed: ${e?.message || e}`);
  } finally {
    ticking = false;
  }
}

/**
 * Start the daemon (idempotent — safe under Next HMR/re-imports).
 * Every dependency is injectable for tests; production defaults are
 * resolved lazily on the first tick to keep module import cheap.
 */
export function startQuotaMonitor(deps = {}, injectedLog) {
  if (injectedLog) log = injectedLog;
  if (timer) return;
  loadState();

  let defaults = null;
  const resolveDefaults = async () => {
    if (!defaults) {
      const db = await import("@/lib/localDb.js");
      const usage = await import("open-sse/services/usage.js");
      const tokenRefresh = await import("@/sse/services/tokenRefresh.js");
      const proxy = await import("@/lib/network/connectionProxy.js");
      const providers = await import("@/shared/constants/providers.js");
      const guard = await import("@/sse/services/codexQuotaGuard.js");
      defaults = {
        getConnections: () => db.getProviderConnections({}),
        getUsageForProvider: usage.getUsageForProvider,
        updateProviderConnection: db.updateProviderConnection,
        checkAndRefreshToken: tokenRefresh.checkAndRefreshToken,
        resolveConnectionProxyConfig: proxy.resolveConnectionProxyConfig,
        isCodexGuardDisabled: guard.isAccountGuardDisabled || null,
        USAGE_APIKEY_PROVIDERS: providers.USAGE_APIKEY_PROVIDERS || [],
      };
    }
    return defaults;
  };

  const d = {};
  for (const key of ["getConnections", "getUsageForProvider", "updateProviderConnection", "checkAndRefreshToken", "resolveConnectionProxyConfig", "isCodexGuardDisabled"]) {
    d[key] = deps[key] || ((...args) => resolveDefaults().then((def) => def[key](...args)));
  }
  d.USAGE_APIKEY_PROVIDERS = deps.USAGE_APIKEY_PROVIDERS;

  timer = setInterval(() => { tick(d).catch(() => {}); }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  log.info("QUOTA-MONITOR", "started");
  tick(d).catch(() => {});
}

export function stopQuotaMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Last monitored usage for a connection (null when not yet checked). */
export function getMonitorUsage(connectionId) {
  return entries.get(connectionId)?.usage ?? null;
}

/** Record an externally performed check (e.g. dashboard force refresh). */
export function recordMonitorResult(connectionId, provider, usage) {
  let entry = entries.get(connectionId);
  if (!entry) {
    entry = { provider, usage: null, depleted: false, checkedAt: null, nextCheckAt: 0, failures: 0, inFlight: false };
    entries.set(connectionId, entry);
  }
  entry.provider = provider;
  entry.usage = usage;
  entry.checkedAt = new Date().toISOString();
  if (isUsageNotImplemented(usage)) {
    entry.depleted = false;
    entry.nextCheckAt = Date.now() + NOT_IMPLEMENTED_INTERVAL_MS;
  } else if (!isAuthExpiredUsage(usage)) {
    entry.depleted = isUsageDepleted(usage);
    entry.failures = 0;
    scheduleNext(entry, usage);
  }
  persistState();
}

/** Snapshot for dashboards/debugging. */
export function getQuotaMonitorSnapshot() {
  const out = [];
  for (const [id, e] of entries) {
    out.push({
      connectionId: id,
      provider: e.provider,
      depleted: e.depleted,
      checkedAt: e.checkedAt,
      nextCheckAt: e.nextCheckAt ? new Date(e.nextCheckAt).toISOString() : null,
      failures: e.failures || 0,
    });
  }
  return out;
}

// Test hooks: expose internals for unit tests only.
export const __internals = { entries, tick, runCheck, scheduleNext, persistState, loadState };
