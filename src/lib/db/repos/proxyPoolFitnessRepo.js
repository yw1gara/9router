import { getAdapter } from "../driver.js";

function rowToFitness(row) {
  if (!row) return null;
  return {
    poolId: row.poolId,
    scope: row.scope,
    until: Number(row.until),
    reason: row.reason || "",
    failureCount: Number(row.failureCount) || 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listProxyPoolFitness(poolId = null) {
  const db = await getAdapter();
  const rows = poolId
    ? db.all(`SELECT * FROM proxyPoolFitness WHERE poolId = ?`, [poolId])
    : db.all(`SELECT * FROM proxyPoolFitness`);
  return rows.map(rowToFitness);
}

export async function upsertProxyPoolFitness(poolId, scope, until, reason = "", failureCount = 1) {
  if (!poolId || !scope || !Number.isFinite(until)) return;
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO proxyPoolFitness(poolId, scope, until, reason, failureCount, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(poolId, scope) DO UPDATE SET
       until=excluded.until, reason=excluded.reason,
       failureCount=excluded.failureCount, updatedAt=excluded.updatedAt`,
    [poolId, scope, Math.floor(until), reason || "", Math.max(1, Number(failureCount) || 1), now, now]
  );
}

export async function deleteProxyPoolFitness(poolId, scope) {
  if (!poolId || !scope) return;
  const db = await getAdapter();
  db.run(`DELETE FROM proxyPoolFitness WHERE poolId = ? AND scope = ?`, [poolId, scope]);
}

export async function deleteProxyPoolFitnessByPool(poolId) {
  if (!poolId) return;
  const db = await getAdapter();
  db.run(`DELETE FROM proxyPoolFitness WHERE poolId = ?`, [poolId]);
}

export async function clearProxyPoolFitness(provider = null) {
  const db = await getAdapter();
  if (provider) {
    // Escape LIKE wildcards so a provider containing _ or % cannot match
    // unrelated scopes.
    const escaped = provider.replace(/([%_\\])/g, "\\$1");
    db.run(
      `DELETE FROM proxyPoolFitness WHERE scope = ? OR scope LIKE ? ESCAPE '\\'`,
      [`${provider}::*`, `${escaped}::%`]
    );
    return;
  }
  db.run(`DELETE FROM proxyPoolFitness`);
}

export async function pruneExpiredProxyPoolFitness(nowMs = Date.now()) {
  const db = await getAdapter();
  const info = db.run(`DELETE FROM proxyPoolFitness WHERE until <= ?`, [Math.floor(nowMs)]);
  return Number(info?.changes) || 0;
}
