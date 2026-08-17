import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS } from "../config/errorConfig.js";
import {
  getCircuitBreaker,
  getAllCircuitBreakerStatuses,
  resetCircuitBreaker,
  PROVIDER_FAILURE_ERROR_CODES,
} from "../utils/circuitBreaker.js";
import { getProviderResilienceProfile } from "../config/providerProfiles.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}

// ---------------------------------------------------------------------------
// Provider-level circuit breaker helpers (in-memory, proxy bucket = "direct").
// Only 5xx/timeout failures count; 429 stays per-account (see circuitBreaker.js).
// ---------------------------------------------------------------------------

/**
 * Get the remaining cooldown for a provider's breaker, or null when executable.
 */
export function getProviderCooldownRemainingMs(provider, proxyHash = "direct") {
  if (!provider) return null;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  if (!breaker || breaker.canExecute()) return null;
  const remaining = breaker.getRetryAfterMs();
  return remaining > 0 ? remaining : null;
}

/**
 * Get the circuit breaker state for a provider.
 */
export function getProviderBreakerState(provider, proxyHash = "direct") {
  if (!provider) return null;
  const breaker = getCircuitBreaker(`${provider}:${proxyHash}`);
  return breaker?.getStatus?.() ?? null;
}

/**
 * Record a provider failure against the shared circuit breaker.
 * Deduplicates rapid-fire failures from the same connection within 5s.
 */
const _lastProviderFailure = new Map();
const _dedupMs = 5_000;
const _dedupMaxSize = 10_000; // cap to prevent unbounded growth

/**
 * Clear the provider-failure dedup map. Used by tests and full resets.
 */
export function clearProviderFailureDedup() {
  _lastProviderFailure.clear();
}

export function recordProviderFailure(provider, statusCode, errorText, log, connectionId, proxyHash = "direct") {
  if (!provider) return;

  // Deduplicate
  if (connectionId) {
    const dedupKey = `${provider}:${proxyHash}:${connectionId}`;
    const now = Date.now();
    const last = _lastProviderFailure.get(dedupKey);
    if (last && now - last < _dedupMs) return;
    _lastProviderFailure.set(dedupKey, now);
    // Evict oldest entries when over the cap to prevent unbounded memory growth
    if (_lastProviderFailure.size > _dedupMaxSize) {
      const evictCount = Math.floor(_dedupMaxSize / 10);
      const keysToEvict = Array.from(_lastProviderFailure.keys()).slice(0, evictCount);
      for (const key of keysToEvict) _lastProviderFailure.delete(key);
    }
  }

  // Only count failure-eligible status codes
  if (statusCode && !PROVIDER_FAILURE_ERROR_CODES.has(statusCode)) return;

  const profile = getProviderResilienceProfile(provider);
  const breakerKey = `${provider}:${proxyHash}`;
  const breaker = getCircuitBreaker(breakerKey, {
    failureThreshold: profile.providerFailureThreshold,
    failureWindowMs: profile.providerFailureWindowMs,
    resetTimeout: profile.providerCooldownMs,
  });
  if (!breaker) return;
  if (!breaker.canExecute()) return; // already OPEN, skip

  breaker._onFailure({ statusCode, message: errorText });

  if (!breaker.canExecute()) {
    log?.warn?.(`[ProviderFailure] ${breakerKey}: circuit breaker opened after ${breaker.failureCount} failures`);
  }
}

/**
 * Reset the shared provider breaker for a proxy bucket.
 */
export function clearProviderFailure(provider, proxyHash = "direct") {
  if (!provider) return;
  resetCircuitBreaker(`${provider}:${proxyHash}`);
}

/**
 * Check if a status code should count toward provider failure threshold.
 */
export function isProviderFailureCode(status) {
  return PROVIDER_FAILURE_ERROR_CODES.has(status);
}

/**
 * Get all providers currently blocked by the circuit breaker.
 */
export function getProvidersInCooldown() {
  return getAllCircuitBreakerStatuses()
    .filter((s) => {
      const breaker = getCircuitBreaker(s.name);
      return Boolean(breaker && !breaker.canExecute());
    })
    .map((s) => ({
      provider: s.name,
      failureCount: s.failureCount,
      cooldownRemainingMs: s.retryAfterMs || null,
      lastFailureAt: s.lastFailureTime,
    }));
}

/**
 * Pipeline gate: returns true if the circuit breaker is OPEN for ALL known
 * buckets of a provider. When true, the request should short-circuit BEFORE
 * any credential lookup — no point querying the DB when every bucket is blocked.
 */
export function isProviderFullyBlocked(provider) {
  if (!provider) return false;
  const all = getAllCircuitBreakerStatuses();
  const providerBreakers = all.filter((s) => {
    const name = s.name || "";
    return name === provider || name.startsWith(`${provider}:`);
  });
  if (providerBreakers.length === 0) return false; // no breakers registered → not blocked
  return providerBreakers.every((s) => {
    const breaker = getCircuitBreaker(s.name);
    return Boolean(breaker && !breaker.canExecute());
  });
}

/**
 * Get the shortest remaining cooldown across all buckets for a provider.
 * Used to populate Retry-After when the pipeline gate blocks.
 */
export function getProviderShortestCooldownMs(provider) {
  if (!provider) return 0;
  const all = getAllCircuitBreakerStatuses();
  let shortest = Infinity;
  for (const s of all) {
    const name = s.name || "";
    if (name !== provider && !name.startsWith(`${provider}:`)) continue;
    const breaker = getCircuitBreaker(s.name);
    if (breaker && !breaker.canExecute()) {
      const remaining = breaker.getRetryAfterMs();
      if (remaining < shortest) shortest = remaining;
    }
  }
  return shortest === Infinity ? 0 : shortest;
}

/**
 * Returns true when an error signals that the account/key does not have
 * access to or a subscription for the requested model. This is NOT a
 * transient failure — retrying immediately would just hit the same wall —
 * so the caller should lock the model for this account only, leaving
 * sibling models on the same account usable.
 */
export function isModelAccessDeniedError(status, errorText) {
  const text = typeof errorText === "string" ? errorText.toLowerCase() : "";
  if (!text && !status) return false;

  // Only HTTP statuses that providers use for model-access/subscription denials
  // are accepted. 401 (auth) and 429 (rate-limit) are NEVER model-access.
  // 503/425 are included because OrcaRouter returns model_not_found as 503
  // ("not available for your account") and model_not_yet_available as 425 —
  // for these the TEXT patterns below must still match (no status auto-true).
  if (![400, 402, 403, 404, 405, 415, 425, 451, 503].includes(Number(status))) return false;

  // Status-based: 404 model-not-found / deployment-not-found
  if (Number(status) === 404) return true;

  // For 503/425 ONLY match OrcaRouter's precise codes — generic phrases like
  // "model is not available right now, please retry" on an overloaded 503 are
  // transient outages, not account-level model denials, and must not trigger
  // a 5-minute model quarantine.
  if (Number(status) === 503 || Number(status) === 425) {
    return /model_not_found|model_not_yet_available|not available for your account/i.test(text);
  }

  // Text-based patterns for 400/402/403/405/415/451 bodies
  const MODEL_ACCESS_DENIED_PATTERNS = [
    "model not found",
    "model_not_found",
    "model does not exist",
    "does not exist",
    "model is not available",
    "model_not_allowed",
    "model not allowed",
    "model is not yet available",
    "model_not_yet_available",
    "model is not available for your account",
    "deployment not found",
    "deployment_not_found",
    "model not supported",
    "model_not_supported",
    "do not have access",
    "does not have access",
    "no access",
    "access denied",
    "permission denied",
    "not authorized",
    "not allowed to use",
    "has not been authorized",
    "not authorized to use",
    "insufficient scope",
    "model is not accessible",
    "model is blocked",
    "model access is blocked",
    "restricted model",
    "model is restricted",
    "no subscription",
    "subscription needed",
    "subscription required",
    "not subscribed",
    "billing limit reached",
    "upgrade your plan",
    "pricingurl",
    "pricing url",
    "plan does not include",
    "not available for your plan",
    "not included in your plan",
    "model is not available on your plan",
  ];

  return MODEL_ACCESS_DENIED_PATTERNS.some((p) => text.includes(p));
}

/**
 * Returns true when an error signals that the entire provider quota
 * is exhausted (not just one account) — waiting for a cooldown won't
 * help, so callers should fail over immediately instead of retrying.
 */
export function isProviderExhaustedReason(result) {
  if (!result) return false;
  const reason = typeof result === "string" ? result : (result.reason || result.error || "");
  const text = typeof reason === "string" ? reason : JSON.stringify(reason);
  // Specific patterns only — avoid false positives on transient errors that
  // happen to contain the word "exhausted" (e.g. "exhausted all retries").
  // Covers both word orders: "quota exhausted" and "exhausted your quota".
  return /credits?.{0,20}exhausted|exhausted.{0,20}credits?|quota.{0,20}exhausted|exhausted.{0,20}quota|no remaining credits|insufficient.{0,20}credits|payment.{0,10}required|quota.{0,20}exceeded|rate.?limit.{0,20}reached/i.test(text);
}

/**
 * Update per-request combo exhaustion without globally disabling sibling accounts.
 * Returns true only when the provider itself is considered exhausted.
 */
export function applyComboTargetExhaustion(provider, connectionId, model, status, errorText, sets, log) {
  if (!provider || !sets) return false;

  // Model-access denials (e.g. 403 "model_not_allowed") are MODEL-scoped:
  // mark only provider:model so sibling models on the SAME connection remain
  // eligible for the rest of the request. Must be checked BEFORE the generic
  // 401/403 auth branch, which would wrongly exhaust the whole account.
  if (model && isModelAccessDeniedError(status, errorText)) {
    sets.exhaustedProviders.add(`${provider}:${model}`);
    log?.info?.("COMBO", `Provider ${provider} model ${model} access denied (${status}) — excluding only this model, connection stays eligible`);
    return false;
  }

  // OrcaRouter free-tier 429 (code free_rate_limited): either a rate window
  // (Retry-After header) or a per-request prompt cap. Retrying the SAME
  // model+prompt inside this request is pointless in both cases — skip the
  // model for the rest of the request without punishing the account (paid
  // models on the same key still work; account cooldown is handled
  // separately by markAccountUnavailable).
  if (Number(status) === 429 && /free_rate_limited/i.test(errorText)) {
    if (model) sets.exhaustedProviders.add(`${provider}:${model}`);
    log?.info?.("COMBO", `Provider ${provider} model ${model || "*"} free-tier 429 (free_rate_limited) — excluding model for this request`);
    return false;
  }

  const isAuthError = status === 401 || status === 403;
  const isConnectionError = [408, 500, 502, 503, 504, 524].includes(status);

  if (isAuthError || isConnectionError) {
    if (connectionId) {
      sets.exhaustedConnections.add(`${provider}:${connectionId}`);
      log?.info?.("COMBO", `Provider ${provider} connection ${String(connectionId).slice(0, 8)} error (${status}) — excluding remaining targets`);
    } else {
      sets.exhaustedProviders.add(`${provider}:${model || "*"}`);
      log?.info?.("COMBO", `Provider ${provider} error (${status}) — excluding remaining targets`);
    }
    return false;
  }

  if (isProviderExhaustedReason(errorText)) {
    // Quota scopes differ by upstream. Keep this request-local skip model-scoped
    // so a sibling model can still use a healthy account/provider.
    sets.exhaustedProviders.add(`${provider}:${model || "*"}`);
    log?.info?.("COMBO", `Provider ${provider} model ${model || "*"} quota exhausted — excluding remaining targets`);
    return true;
  }

  return false;
}
