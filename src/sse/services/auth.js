import { getProviderConnections, getProviderNodeById, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, isModelAccessDeniedError, accumulateModelLockCooldown, getModelLockAccKey, getModelLockMetaKey, getModelLockKey, MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, BACKOFF_CONFIG } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { disableCodexAccountOnQuota } from "./codexQuotaGuard.js";
import * as log from "../utils/logger.js";

function friendlyConnectionName(connection, fallback = "connection") {
  return connection?.displayName?.trim()
    || connection?.name?.trim()
    || connection?.email?.trim()
    || connection?.providerSpecificData?.nodeName?.trim()
    || fallback;
}

export function filterConnectionsForModel(providerId, connections, model, settings = {}) {
  const override = (settings.providerStrategies || {})[providerId] || {};
  if (providerId !== "freebuff" || override.strictModelAssignment !== true || !model) return connections;
  return connections.filter((connection) => {
    const data = connection.providerSpecificData || {};
    const assignedModel = Object.prototype.hasOwnProperty.call(data, "assignedModel")
      ? data.assignedModel
      : data.freebuffModel;
    return assignedModel === model;
  });
}

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";
const MODEL_RECOVERY_PROVIDERS = new Set([
  "opencode-zen",
  "tokenrouter",
]);
const RATE_LIMIT_ERROR_RE = /rate[ _-]?limit|too many requests|quota exceeded|free usage limit|freeusagelimiterror|free_rate_limited/i;

function isModelRateLimit(status, errorText) {
  return Number(status) === 429 || RATE_LIMIT_ERROR_RE.test(String(errorText || ""));
}

function openCodeZenFreeLimitResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "opencode-zen" || Number(status) !== 429) return null;
  if (!/freeusagelimiterror|rate limit exceeded/i.test(String(errorText || ""))) return null;
  // FreeUsageLimitError is key-scoped. Park this key/model for one hour;
  // rotating immediately only causes the same limited key to be retried.
  return Date.now() + 60 * 60 * 1000;
}

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function orcaPromptCapResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "orcarouter") return null;
  const text = String(errorText || "");
  // OrcaRouter rejects oversized free-tier prompts with a non-retryable 400.
  // The key remains valid for smaller requests, but parking this model/key for
  // one hour prevents account fallback from cycling through the same cap.
  if (Number(status) !== 400 || !/free_rate_limited|err_free_prompt_cap|prompt is longer than the free tier allows/i.test(text)) return null;
  return Date.now() + 60 * 60 * 1000;
}

function orcaDailyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "orcarouter") return null;
  const text = String(errorText || "");
  // Prompt-cap errors have their own short model/key cooldown; do not park a
  // valid key until midnight for a request-size rejection.
  if (/err_free_prompt_cap|prompt is longer than the free tier allows/i.test(text)) return null;
  const isQuotaLimit = isModelRateLimit(status, text)
    || Number(status) === 403
    || /free.?model.?capacity|freeusagelimiterror|quota/i.test(text);
  if (!isQuotaLimit) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);
    const providerNode = (providerId.startsWith("openai-compatible-") || providerId.startsWith("anthropic-compatible-"))
      ? await getProviderNodeById(providerId).catch(() => null)
      : null;
    const providerDisplayName = providerNode?.name || provider;

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      // Respect the caller's exclusion: once the Public virtual connection is
      // exhausted for this request, returning it again would send the fallback
      // loop in chat.js into an infinite continue-spin (event-loop starvation).
      if (excludeSet.has("noauth")) {
        log.info("AUTH", `${providerId} | Public (noauth) connection excluded this request — no credentials`);
        return null;
      }
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      let rotationPoolIds = [];
      // Per-model scope (VansRouter parity): a pool exhausted for one model
      // stays usable for other models of the same provider.
      const noAuthScope = `${providerId}::${model || "*"}`;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        if (strategy === "smart") {
          // Populate the fitness read-through cache so smart filtering sees
          // current scoped cooldowns (same as the multi-pool resolver path).
          const { loadPoolFitness } = await import("open-sse/services/proxyPoolFitness.js");
          await Promise.allSettled(poolIds.map((id) => loadPoolFitness(id)));
        }
        pickedId = pickProxyPoolId(poolIds, strategy, providerId, { scope: noAuthScope, connectionId: "public" });
        rotationPoolIds = poolIds;
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" }, providerId);
      return {
        id: "noauth",
        // Consumers key exhaustion marks and model-lock guards on
        // connectionId === "noauth"; without the field those guards are dead
        // and per-connection exhaustion keys degenerate to `${provider}:undefined`.
        connectionId: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          // Rotation active ⇒ fail closed on a dead proxy (throws into
          // chatCore's pool rotation) instead of silently egressing direct.
          strictProxy: resolvedProxy.strictProxy === true || strategy !== "none",
          proxyRequired: resolvedProxy.proxyRequired === true || strategy === "smart",
          smartProxy: strategy === "smart",
          proxyRotationStrategy: strategy,
          proxyPoolScope: noAuthScope,
          // Full candidate list lets chatCore's pool-scoped retry rotate the
          // Public connection off a failed proxy just like real accounts.
          proxyPoolIds: rotationPoolIds,
        },
      };
    }

    let connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    const settings = await getSettings();
    connections = filterConnectionsForModel(providerId, connections, model, settings);

    // Filter out model-locked, tagged-unavailable, and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      const modelLocked = isModelLockActive(c, model);
      if (modelLocked) return false;
      // testStatus is a sticky diagnostic marker. Once requested model lock
      // expires, do not let stale unavailable status block account reuse.
      // Account-level unavailable remains blocked by MODEL_LOCK_ALL.
      if (c.testStatus === "unavailable" && isModelLockActive(c, null)) return false;
      return true;
    });

    const providerLabel = connections[0]?.providerDisplayName || provider;
    log.debug("AUTH", `${providerLabel} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${friendlyConnectionName(c, "unnamed")} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      // Report the REQUESTED model's lock expiry — the earliest lock across all
      // models would under-report when a connection holds mixed-model locks.
      const expiries = lockedConns
        .map(c => c[getModelLockKey(model)] || c[MODEL_LOCK_ALL])
        .filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        const providerLabel = earliestConn?.providerDisplayName || friendlyConnectionName(earliestConn, provider);
        const accountLabel = friendlyConnectionName(earliestConn, "unnamed");
        log.warn("AUTH", `${providerLabel} | account=${accountLabel} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      const providerLabel = connections[0]?.providerDisplayName || friendlyConnectionName(connections[0], provider);
      const accountLabel = friendlyConnectionName(connections[0], "unnamed");
      log.warn("AUTH", `${providerLabel} | account=${accountLabel} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    // Fitness scope is provider::model so smart rotation can apply scoped
    // cooldowns at request granularity.
    const proxyScope = model ? `${providerId}::${model}` : `${providerId}::*`;

    // Provider-level proxy default ("Apply Proxy" → Smart / fixed pool on the
    // provider dashboard): applies to EVERY account of this provider —
    // including accounts added later — and resolves from the LIVE pool
    // inventory, so pools added later join automatically. Takes precedence
    // over per-connection assignments.
    const proxyApply = providerOverride.proxyApply || null;
    let proxyInput = connection.providerSpecificData || {};
    if (proxyApply && proxyApply.strategy && proxyApply.strategy !== "none") {
      // Explicit provider-level proxy ⇒ fail closed on a dead proxy so
      // chatCore rotates to another pool instead of egressing direct.
      proxyInput = { ...proxyInput, strictProxy: true, proxyRequired: true };
      if (proxyApply.strategy === "fixed" && proxyApply.poolId) {
        proxyInput = { ...proxyInput, proxyPoolId: proxyApply.poolId };
      } else {
        const allPools = await getProxyPools({ isActive: true });
        const liveIds = allPools.filter((p) => p.proxyUrl).map((p) => p.id);
        proxyInput = { ...proxyInput, proxyPoolIds: liveIds, proxyRotationStrategy: proxyApply.strategy };
      }
    }
    const resolvedProxy = await resolveConnectionProxyConfig(
      proxyInput,
      providerId,
      null,
      { scope: proxyScope, connectionId: connection.id || null }
    );

    let nodeName = null;
    if (providerId.startsWith("openai-compatible-") || providerId.startsWith("anthropic-compatible-")) {
      const node = await getProviderNodeById(providerId).catch(() => null);
      if (node?.name) nodeName = node.name;
    }

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      providerDisplayName: providerDisplayName || null,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
        proxyRequired: resolvedProxy.proxyRequired === true,
        smartProxy: resolvedProxy.smartProxy === true,
        proxyPoolScope: resolvedProxy.proxyPoolScope || proxyScope,
        proxyPoolIds: Array.isArray(resolvedProxy.proxyPoolIds) ? resolvedProxy.proxyPoolIds : [],
        proxyRotationStrategy: proxyInput.proxyRotationStrategy || connection.providerSpecificData?.proxyRotationStrategy || null,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);
  const openCodeZenFreeLimitAtMs = openCodeZenFreeLimitResetMs(status, errorText, provider);

  // OrcaRouter free-tier quota resets at 00:00 UTC — lock until then.
  const orcaResetAtMs = orcaDailyResetMs(status, errorText, provider);
  const orcaPromptCapResetAtMs = orcaPromptCapResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel, accumulate = false;
  let accumulationBaseMs = null;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (openCodeZenFreeLimitAtMs) {
    shouldFallback = true;
    cooldownMs = openCodeZenFreeLimitAtMs - Date.now();
    newBackoffLevel = 0;
    accumulate = false;
  } else if (orcaPromptCapResetAtMs) {
    shouldFallback = true;
    cooldownMs = orcaPromptCapResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (orcaResetAtMs) {
    shouldFallback = true;
    cooldownMs = Math.max(1000, orcaResetAtMs - Date.now());
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else if (isModelAccessDeniedError(status, errorText)) {
    // Model-access/subscription mismatch: lock THIS model for THIS account for
    // 30 minutes so the combo skips it without spamming the model. Sibling
    // models on the same account stay usable — only the denied model is
    // quarantined. Do NOT touch backoffLevel here: a genuine model denial must
    // not reset the account's rate-limit escalation state.
    shouldFallback = true;
    cooldownMs = 30 * 60 * 1000;
    newBackoffLevel = backoffLevel;
    accumulate = true;
  } else {
    const ruleResult = checkFallbackError(status, errorText, backoffLevel);
    ({ shouldFallback, cooldownMs, newBackoffLevel } = ruleResult);
    // `fixed` rules (free-tier key limits) park the key for an exact fixed
    // duration — model-lock accumulation must not double it.
    accumulate = ruleResult.fixed !== true;
    // Accumulate from the level-0 base: backoffLevel already escalates the
    // account-level penalty, and doubling the escalated value on top of it
    // would compound to ~4^n per consecutive failure instead of 2^n.
    if (accumulate) accumulationBaseMs = checkFallbackError(status, errorText, 0).cooldownMs;
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  // Accumulate repeated model-lock cooldowns: each consecutive failure within
  // the grace window doubles the lock (base × 2^(n-1)), capped at 24h; the
  // accumulation resets once the lock has been expired for its own duration.
  let accUpdate = null;
  if (accumulate) {
    ({ cooldownMs, accUpdate } = accumulateModelLockCooldown(conn, model, accumulationBaseMs ?? cooldownMs));
  }

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockModel = githubResetAtMs ? null : model;
  const lockUpdate = buildModelLockUpdate(lockModel, cooldownMs);
  const providerId = resolveProviderId(provider);
  const recoveryRateLimit =
    MODEL_RECOVERY_PROVIDERS.has(providerId) &&
    Boolean(model) &&
    isModelRateLimit(status, errorText);
  const lockMetaUpdate = recoveryRateLimit
    ? {
        [getModelLockMetaKey(model)]: {
          type: "rate_limit",
          status: Number(status) || null,
          resetAt: Object.values(lockUpdate)[0],
        },
      }
    : {};

  // Codex usage-limit guard: hard-disable the account in the DB until the 24h re-check window.
  // Fail-open: a guard error (e.g. stale lock, missing sqlite3 CLI) must not
  // abort this function — the cooldown bookkeeping below still needs to run.
  if (Number(status) === 429 && resolveProviderId(provider) === "codex") {
    try {
      await disableCodexAccountOnQuota(connectionId, provider, status, reason);
    } catch (guardError) {
      console.error(`[AUTH] codex quota guard failed for ${connectionId?.slice(0, 8)}: ${guardError?.message || guardError}`);
    }
  }

  const modelScopedLock = Boolean(lockModel);
  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    ...(accUpdate || {}),
    ...lockMetaUpdate,
    ...(recoveryRateLimit ? { isActive: true } : {}),
    // Model cooldown must not make whole account unavailable. This keeps
    // sibling models eligible and lets account re-enter rotation after expiry.
    testStatus: modelScopedLock || recoveryRateLimit ? "active" : "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
  });

  if (recoveryRateLimit) {
    try {
      const { reconcileProviderRecoveryAccount } = await import(
        "./providerRecoveryMonitor.js"
      );
      await reconcileProviderRecoveryAccount(connectionId);
    } catch (recoveryError) {
      log.warn(
        "AUTH",
        `${providerId} recovery reconciliation failed: ${recoveryError?.message || recoveryError}`,
      );
    }
  }

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  // The accumulated (up to 24h) lock is MODEL-scoped; callers that gate the
  // whole ACCOUNT (e.g. the per-account semaphore) must use the capped value so
  // a hot model cannot block sibling models on the same account for a day.
  return { shouldFallback: true, cooldownMs, semaphoreCooldownMs: Math.min(cooldownMs, BACKOFF_CONFIG.max) };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));
  // Also reset the accumulation state for every lock we cleared — a cleared
  // lock (success or manual clear) means the model served traffic again, so
  // the next failure must start from a fresh accumulation count.
  for (const k of keysToClear) {
    const model = k === "modelLock___all" ? null : k.slice("modelLock_".length);
    clearObj[getModelLockAccKey(model)] = null;
    clearObj[getModelLockMetaKey(model)] = null;
  }

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
