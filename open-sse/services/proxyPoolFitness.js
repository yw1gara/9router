// Durable proxy-pool fitness registry — scoped cooldowns per (pool, scope).
//
// Scope format: `provider::model` (e.g. "codex::gpt-5.5") or `provider::*`
// (provider-wide). A pool marked unfit for a scope is skipped by the "smart"
// rotation strategy until the cooldown expires. SQLite is the source of truth
// (proxyPoolFitness table); a globalThis Map acts as a read-through cache so
// Next dev bundles share one registry. All persistence is fail-open: fitness
// is advisory and must never block a request.

const FITNESS_STATE_KEY = "__9routerPoolFitness__";
const fitness = (globalThis[FITNESS_STATE_KEY] ??= new Map()); // poolId -> Map<scope, {until, reason, failureCount}>

export const POOL_UNFIT_MS = 10 * 60 * 1000;
// Every failed smart-proxy pool stays unavailable for exactly 10 minutes.
// failureCount remains diagnostic only; it does not extend cooldown duration.

function repo() {
  // Dynamic + relative so the engine stays independent of the app alias and
  // a DB outage never breaks module loading.
  return import("../../src/lib/db/repos/proxyPoolFitnessRepo.js");
}

function setPoolFitness(poolId, entries) {
  if (!entries.length) fitness.delete(poolId);
  else fitness.set(poolId, new Map(entries.map((e) => [e.scope, { until: e.until, reason: e.reason || "", failureCount: e.failureCount || 1 }])));
}

function providerWildcardScope(scope) {
  const sep = String(scope || "").indexOf("::");
  if (sep < 0) return null;
  return `${scope.slice(0, sep)}::*`;
}

/** Load (and cache) durable fitness rows for one pool.
 *  NOTE: expired rows are deliberately KEPT (cached with their past `until`)
 *  — failureCount must persist across cooldown expiries so a pool that keeps
 *  failing after every retry accumulates (5m → 10m → … → 24h). The count is
 *  only reset by clearPoolUnfit() on a SUCCESS through the pool. */
export async function loadPoolFitness(poolId) {
  if (!poolId) return;
  try {
    const { listProxyPoolFitness } = await repo();
    const entries = await listProxyPoolFitness(poolId);
    setPoolFitness(poolId, entries);
  } catch {
    // Fail-open: fitness unavailable ⇒ every pool treated as fit.
  }
}

/** Mark a pool unfit for a scope. Cooldown escalates exponentially with the
 *  pool's LIFETIME failure count for the scope (5m, 10m, 20m, … capped 24h).
 *  The count persists across cooldown expiries — a pool that fails again
 *  after its cooldown elapsed keeps accumulating. Only a SUCCESS through the
 *  pool (clearPoolUnfit) resets it. */
export async function markPoolUnfit(poolId, scope, until = null, reason = "", failureCount = 1) {
  if (!poolId || !scope) return false;
  try {
    // Read the persisted count from the DB regardless of expiry — the source
    // of truth for accumulation (the in-memory cache may have evicted it).
    const { upsertProxyPoolFitness, listProxyPoolFitness } = await repo();
    let priorCount = 0;
    try {
      const rows = await listProxyPoolFitness(poolId);
      const row = (rows || []).find((r) => r.scope === scope);
      if (row && Number.isFinite(row.failureCount) && row.failureCount > 0) {
        priorCount = row.failureCount;
      }
    } catch { /* history unreadable — treat as fresh */ }
    const count = Math.max(Math.max(1, Number(failureCount) || 1), priorCount + 1);
    const now = Date.now();
    // An explicit `until` is honored as-is (callers may pass a past timestamp
    // for tests/stale markers); only compute a cooldown when absent.
    const baseUntil = Number.isFinite(until)
      ? until
      : now + POOL_UNFIT_MS;
    await upsertProxyPoolFitness(poolId, scope, baseUntil, reason, count);
    const scoped = fitness.get(poolId) || new Map();
    scoped.set(scope, { until: baseUntil, reason: reason || "", failureCount: count });
    fitness.set(poolId, scoped);
    return true;
  } catch {
    return false;
  }
}

export async function clearPoolUnfit(poolId, scope) {
  if (!poolId || !scope) return false;
  try {
    const { deleteProxyPoolFitness } = await repo();
    await deleteProxyPoolFitness(poolId, scope);
    const byScope = fitness.get(poolId);
    if (byScope) {
      byScope.delete(scope);
      if (byScope.size === 0) fitness.delete(poolId);
    }
    return true;
  } catch {
    return false;
  }
}

/** Sync check against the cached registry. Unknown pool/scope ⇒ fit. */
export function isPoolFit(poolId, scope, now = Date.now()) {
  if (!poolId) return true;
  const byScope = fitness.get(poolId);
  if (!byScope) return true;
  for (const key of [scope, providerWildcardScope(scope)]) {
    if (!key) continue;
    const entry = byScope.get(key);
    if (!entry) continue;
    if (entry.until <= now) {
      byScope.delete(key);
      if (byScope.size === 0) fitness.delete(poolId);
      continue;
    }
    return false;
  }
  return true;
}

export function fitPoolIds(poolIds, scope, now = Date.now()) {
  return (poolIds || []).filter((id) => isPoolFit(id, scope, now));
}

export async function clearAllPoolUnfit(provider = null) {
  try {
    const { clearProxyPoolFitness } = await repo();
    await clearProxyPoolFitness(provider);
    if (!provider) fitness.clear();
    else {
      const prefix = `${provider}::`;
      for (const [poolId, byScope] of fitness) {
        for (const scope of [...byScope.keys()]) if (scope.startsWith(prefix)) byScope.delete(scope);
        if (!byScope.size) fitness.delete(poolId);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function pruneExpired(now = Date.now()) {
  try {
    const { pruneExpiredProxyPoolFitness } = await repo();
    return await pruneExpiredProxyPoolFitness(now);
  } catch {
    return 0;
  }
}

/** Live (non-expired) snapshot, primarily for the dashboard. */
export async function poolFitnessSnapshot(now = Date.now()) {
  try {
    const { listProxyPoolFitness } = await repo();
    const entries = await listProxyPoolFitness();
    const out = {};
    for (const e of entries) {
      if (e.until <= now) continue;
      const byScope = out[e.poolId] || (out[e.poolId] = {});
      byScope[e.scope] = { until: e.until, reason: e.reason || "", failureCount: e.failureCount || 1 };
    }
    return out;
  } catch {
    return {};
  }
}

/** Test-only: drop all cached marks. */
export function resetPoolFitness() {
  fitness.clear();
}
