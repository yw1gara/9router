import { getProxyPoolById, getProxyPools } from "@/models";
import { loadPoolFitness, fitPoolIds } from "open-sse/services/proxyPoolFitness.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }
// Smart-sticky bindings: `${providerId}::${connectionId}` → assigned poolId.
// Each account keeps its own proxy; the binding only rotates when the
// assigned pool fails (excluded/unfit), mirroring per-account egress IPs.
const stickyBindings = new Map();
const STICKY_BINDINGS_MAX = 5000;

/**
 * Pick one proxy pool ID from a list based on strategy.
 *
 * Strategies:
 *   fixed        first eligible entry
 *   round-robin  cycle sequentially (in-memory, resets on restart)
 *   random       uniform random pick
 *   smart        STICKY PER CONNECTION: each connectionId keeps its assigned
 *                pool (random initial pick + in-memory binding) and only
 *                rotates to the next fit pool when the assigned one is
 *                excluded (just failed) or under a scoped cooldown.
 *                Without a connectionId it degrades to fitness-aware
 *                round-robin.
 *
 * @param {string[]} poolIds candidate pool ids
 * @param {string} strategy
 * @param {string} providerId per-provider rotation cursor key
 * @param {{ scope?: string|null, excludeIds?: string[], connectionId?: string|null }} [opts]
 *   scope        fitness scope `provider::model` for smart filtering
 *   excludeIds   pool ids to skip (e.g. pool that just failed)
 *   connectionId sticky binding key for the "smart" strategy
 */
export function pickProxyPoolId(poolIds, strategy, providerId, opts = {}) {
  if (!poolIds || poolIds.length === 0) return null;

  const { scope = null, excludeIds = [], connectionId = null } = opts || {};
  let eligible = poolIds.filter((id) => !(excludeIds || []).includes(id));

  const isSmart = strategy === "smart" && !!scope;
  if (isSmart) eligible = fitPoolIds(eligible, scope);

  if (eligible.length === 0) {
    // Smart with every candidate unfit must NOT silently fall back to an
    // unfit pool — return null so the resolver can apply its fail policy.
    if (isSmart) return null;
    // Non-smart strategies keep the legacy fail-open behavior.
    eligible = poolIds.filter((id) => !(excludeIds || []).includes(id));
    if (eligible.length === 0) return null;
  }
  if (eligible.length === 1) {
    if (isSmart && connectionId) setStickyBinding(providerId, connectionId, eligible[0]);
    return eligible[0];
  }

  // Smart-sticky: return the connection's bound pool while it stays eligible,
  // otherwise advance to the next eligible pool after the bound position
  // (or a random eligible start for first assignment — accounts spread
  // unpredictably across the inventory instead of clustering).
  if (isSmart && connectionId) {
    const key = `${providerId}::${connectionId}`;
    const bound = stickyBindings.get(key);
    if (bound && eligible.includes(bound)) return bound;

    // Deterministic cursor spreads new connections evenly across eligible pools.
    // When a bound pool is excluded/unfit, advance from its previous position.
    const state = rotateState.get(providerId) || { index: -1 };
    const boundIdx = bound ? poolIds.indexOf(bound) : -1;
    if (boundIdx >= 0) {
      const nextCandidate = poolIds
        .slice(boundIdx + 1)
        .concat(poolIds.slice(0, boundIdx))
        .find((id) => eligible.includes(id));
      state.index = eligible.indexOf(nextCandidate);
    } else {
      state.index = (state.index + 1) % eligible.length;
    }
    rotateState.set(providerId, state);
    const next = eligible[state.index];
    setStickyBinding(providerId, connectionId, next);
    return next;
  }

  if (strategy === "round-robin" || strategy === "smart") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % eligible.length;
    rotateState.set(providerId, state);
    return eligible[state.index];
  }

  if (strategy === "random") {
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  return eligible[0]; // "fixed"/"none"/unknown
}

function setStickyBinding(providerId, connectionId, poolId) {
  const key = `${providerId}::${connectionId}`;
  if (stickyBindings.size >= STICKY_BINDINGS_MAX && !stickyBindings.has(key)) {
    // Bound the map: drop the oldest entry (insertion order) before growing.
    stickyBindings.delete(stickyBindings.keys().next().value);
  }
  stickyBindings.set(key, poolId);
}

/**
 * Normalize legacy proxy configuration.
 */
export async function applyProviderProxyOverlay(
  providerSpecificData = {},
  providerStrategy = {},
  deps = {},
) {
  const proxyApply = providerStrategy?.proxyApply;
  if (!proxyApply?.strategy || proxyApply.strategy === "none") {
    return { ...(providerSpecificData || {}) };
  }

  const input = { ...(providerSpecificData || {}), strictProxy: true, proxyRequired: true };
  if (proxyApply.strategy === "fixed" && proxyApply.poolId) {
    input.proxyPoolId = proxyApply.poolId;
    delete input.proxyPoolIds;
    delete input.proxyRotationStrategy;
    return input;
  }

  const loadProxyPools = deps.getProxyPools || getProxyPools;
  const pools = await loadProxyPools({ isActive: true });
  input.proxyPoolIds = (pools || [])
    .filter((pool) => pool?.isActive !== false && normalizeString(pool?.proxyUrl))
    .map((pool) => pool.id)
    .filter(Boolean);
  input.proxyRotationStrategy = proxyApply.strategy;
  return input;
}

function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Multi-pool rotation (proxyPoolIds + proxyRotationStrategy)
 * 2. Single proxy pool (legacy proxyPoolId)
 * 3. Legacy per-connection proxy
 * 4. No proxy
 *
 * `proxyRequired` (connection-level) forces fail-closed semantics: when no
 * usable pool/proxy can be resolved, the caller receives source:"required"
 * with strictProxy=true so downstream never egresses direct by accident.
 *
 * @param {object} providerSpecificData
 * @param {string|null} [providerId] provider id for rotation cursor + fitness scope default
 * @param {string[]} [excludePoolIds] pools to skip (pool-scoped retry)
 * @param {{ scope?: string|null, connectionId?: string|null }} [opts] fitness scope override `provider::model`, sticky binding key for smart
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {},
  providerId = null,
  excludePoolIds = null,
  opts = {}
) {
  const excludeIds = Array.isArray(excludePoolIds) ? excludePoolIds : [];
  const proxyRequired = providerSpecificData?.proxyRequired === true;

  try {
    const multiPoolIds = [...new Set(Array.isArray(providerSpecificData?.proxyPoolIds)
      ? providerSpecificData.proxyPoolIds.map(normalizeString).filter(Boolean)
      : [])];
    const rotationStrategy = normalizeString(providerSpecificData?.proxyRotationStrategy) || "fixed";
    const smartProxy = multiPoolIds.length > 0 && rotationStrategy === "smart";
    const scope = normalizeString(opts?.scope) ||
      (providerId ? `${providerId}::*` : null);

    // Load scoped cooldowns once per resolution (cheap read-through cache).
    if (multiPoolIds.length && rotationStrategy === "smart") {
      await Promise.allSettled(multiPoolIds.map((id) => loadPoolFitness(id)));
    }

    let selectedPoolId = null;

    if (multiPoolIds.length > 0) {
      selectedPoolId = pickProxyPoolId(multiPoolIds, rotationStrategy, providerId || "default", {
        scope,
        excludeIds,
        connectionId: normalizeString(opts?.connectionId) || null,
      });
    }

    const smartPoolResolution = smartProxy;
    if (!selectedPoolId && !smartPoolResolution) {
      // Legacy single-pool path only applies when smart routing was not chosen.
      // Smart pool exhaustion must not fall back to an old single pool or direct egress.
      const proxyPoolIdRaw = normalizeString(providerSpecificData?.proxyPoolId);
      const proxyPoolId = proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;
      if (proxyPoolId && !excludeIds.includes(proxyPoolId)) {
        selectedPoolId = proxyPoolId;
      }
    }

    if (selectedPoolId) {
      const proxyPool = await getProxyPoolById(selectedPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      if (isValidPool) {
        const strictProxy = smartProxy || proxyPool.strictProxy === true;

        /**
         * Vercel/Cloudflare relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
          return {
            source: proxyPool.type,
            proxyPoolId: selectedPoolId,
            proxyPoolIds: multiPoolIds,
            proxyRotationStrategy: rotationStrategy,
            proxyPoolScope: scope,
            proxyPool,
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,
            strictProxy,
            proxyRequired: smartProxy || proxyRequired,
            smartProxy,
            noFitPool: false,
            vercelRelayUrl: proxyUrl,
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",
          proxyPoolId: selectedPoolId,
          proxyPoolIds: multiPoolIds,
          proxyRotationStrategy: rotationStrategy,
          proxyPoolScope: scope,
          proxyPool,
          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,
          strictProxy,
          proxyRequired: smartProxy || proxyRequired,
          smartProxy,
          noFitPool: false,
        };
      }
    }

    // Multi-pool smart had candidates but none fit (scoped cooldowns) or all
    // were excluded: report it so callers can decide (fail-closed when
    // proxyRequired). Derived from the actual pick outcome.
    const smartBlocked =
      multiPoolIds.length > 0 && rotationStrategy === "smart" && !selectedPoolId;

    if (smartProxy || proxyRequired) {
      // Fail-closed: smart or required proxy egress must never fall through
      // to a legacy proxy or direct connection.
      return {
        source: "required",
        proxyPoolId: null,
        proxyPoolIds: multiPoolIds,
        proxyRotationStrategy: rotationStrategy,
        proxyPoolScope: scope,
        proxyPool: null,
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
        strictProxy: true,
        proxyRequired: true,
        smartProxy,
        noFitPool: smartBlocked,
      };
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    const legacy = normalizeLegacyProxy(providerSpecificData);
    if (
      !smartPoolResolution &&
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",
        proxyPoolId: normalizeString(providerSpecificData?.proxyPoolId) === "__none__"
          ? null
          : (normalizeString(providerSpecificData?.proxyPoolId) || null),
        proxyPoolIds: multiPoolIds,
        proxyRotationStrategy: rotationStrategy,
        proxyPoolScope: scope,
        proxyPool: null,
        ...legacy,
        strictProxy: false,
        proxyRequired,
        noFitPool: smartBlocked,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: smartBlocked ? "smart-unavailable" : "none",
      proxyPoolId: smartBlocked ? null : (normalizeString(providerSpecificData?.proxyPoolId) === "__none__"
        ? null
        : (normalizeString(providerSpecificData?.proxyPoolId) || null)),
      proxyPoolIds: multiPoolIds,
      proxyRotationStrategy: rotationStrategy,
      proxyPoolScope: scope,
      proxyPool: null,
      ...legacy,
      strictProxy: false,
      proxyRequired,
      noFitPool: smartBlocked,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    if (proxyRequired) {
      return {
        source: "required",
        proxyPoolId: null,
        proxyPoolIds: [],
        proxyRotationStrategy: "fixed",
        proxyPoolScope: null,
        proxyPool: null,
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
        strictProxy: true,
        proxyRequired: true,
        noFitPool: false,
      };
    }

    return {
      source: "error",
      proxyPoolId: null,
      proxyPoolIds: [],
      proxyRotationStrategy: "fixed",
      proxyPoolScope: null,
      proxyPool: null,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      strictProxy: false,
      proxyRequired: false,
      noFitPool: false,
    };
  }
}
