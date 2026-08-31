import {
  getModelLockAccKey,
  getModelLockKey,
  isModelLockActive,
} from "open-sse/services/accountFallback.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getCanonicalProviderModelCatalog } from "@/lib/providers/modelCatalog.js";
import {
  applyProviderProxyOverlay,
  resolveConnectionProxyConfig,
} from "@/lib/network/connectionProxy.js";

export const SUPPORTED_PROVIDER_RECOVERY_IDS = new Set([
  "opencode-zen",
  "tokenrouter",
]);

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const runtime = globalThis.__providerRecoveryMonitorRuntime ??= {
  timer: null,
  running: false,
  state: { lastRunAt: null },
};

function llmModels(catalog) {
  return (catalog?.models || []).filter(
    (model) => model?.id && (model.type || model.kind || "llm") === "llm",
  );
}

function mergeProviderData(connection, patch) {
  return {
    ...(connection.providerSpecificData || {}),
    ...patch,
  };
}

function isAutoDisabled(connection) {
  return (
    connection?.isActive === false &&
    Boolean(connection?.providerSpecificData?.autoRecoveryDisabled)
  );
}

function isEveryModelLocked(connection, models, now) {
  if (models.length === 0) return false;
  return models.every((model) => {
    const expiry = connection[getModelLockKey(model.id)];
    return expiry && new Date(expiry).getTime() > now;
  });
}

async function reconcileActiveConnection(connection, catalog, deps, now) {
  if (!catalog?.complete) return false;
  const models = llmModels(catalog);
  if (models.length === 0) return false;

  if (isEveryModelLocked(connection, models, now)) {
    await deps.updateProviderConnection(connection.id, {
      isActive: false,
      testStatus: "unavailable",
      providerSpecificData: mergeProviderData(connection, {
        autoRecoveryDisabled: new Date(now).toISOString(),
      }),
    });
    return true;
  }

  const hasActiveModelLock = models.some((model) =>
    isModelLockActive(connection, model.id),
  );
  if (
    hasActiveModelLock &&
    (connection.testStatus === "unavailable" ||
      connection.lastError ||
      connection.errorCode ||
      connection.lastErrorAt)
  ) {
    await deps.updateProviderConnection(connection.id, {
      isActive: true,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      providerSpecificData: { ...(connection.providerSpecificData || {}) },
    });
  }
  return false;
}

async function recoverConnection(connection, catalog, deps, applyProxy) {
  if (!catalog?.complete) return false;
  const models = llmModels(catalog);
  if (models.length === 0) return false;

  const patch = {};
  let recovered = false;
  for (const model of models) {
    const result = await deps.probeProviderModel({
      connection,
      provider: connection.provider,
      model: model.id,
      applyProxy,
    });
    if (!result?.ok) continue;
    recovered = true;
    patch[getModelLockKey(model.id)] = null;
    patch[getModelLockAccKey(model.id)] = null;
    patch[`modelLockMeta_${model.id}`] = null;
  }

  if (!recovered) return false;
  const providerSpecificData = { ...(connection.providerSpecificData || {}) };
  delete providerSpecificData.autoRecoveryDisabled;
  Object.assign(patch, {
    isActive: true,
    testStatus: "active",
    lastError: null,
    errorCode: null,
    lastErrorAt: null,
    backoffLevel: 0,
    providerSpecificData,
  });
  await deps.updateProviderConnection(connection.id, patch);
  return true;
}

export async function runProviderRecoveryMonitorTick(deps, options = {}) {
  const state = options.state || { lastRunAt: null };
  const now = options.now ?? Date.now();
  const intervalMs = Math.max(0, Number(options.intervalMs) || 0);
  if (state.lastRunAt !== null && now - state.lastRunAt < intervalMs) {
    return { ran: false, reason: "interval-not-due" };
  }
  state.lastRunAt = now;

  const connections = await deps.getProviderConnections();
  let disabled = 0;
  let recovered = 0;

  for (const connection of connections) {
    if (!SUPPORTED_PROVIDER_RECOVERY_IDS.has(connection.provider)) continue;

    if (connection.isActive !== false) {
      if (connection.providerSpecificData?.autoRecoveryDisabled) continue;
      const catalog = await deps.getProviderModelCatalog(connection);
      if (await reconcileActiveConnection(connection, catalog, deps, now)) {
        disabled += 1;
      }
      continue;
    }

    if (!isAutoDisabled(connection)) continue;
    const catalog = await deps.getProviderModelCatalog(connection);
    if (
      await recoverConnection(
        connection,
        catalog,
        deps,
        options.applyProxy === true,
      )
    ) {
      recovered += 1;
    }
  }

  return { ran: true, disabled, recovered };
}

async function createProductionDeps(overrides = {}) {
  const db = overrides.db || await import("@/lib/localDb.js");
  const getSettings = overrides.getSettings || db.getSettings;
  const getProxyPools = overrides.getProxyPools || db.getProxyPools;

  const deps = {
    getSettings,
    getProxyPools,
    getProviderConnections: overrides.getProviderConnections || db.getProviderConnections,
    getProviderConnectionById: overrides.getProviderConnectionById || db.getProviderConnectionById,
    updateProviderConnection: overrides.updateProviderConnection || db.updateProviderConnection,
  };

  deps.getProviderModelCatalog = overrides.getProviderModelCatalog || ((connection) =>
    getCanonicalProviderModelCatalog(connection, { getSettings, getProxyPools }));
  deps.probeProviderModel = overrides.probeProviderModel || (async ({ connection, provider, model, applyProxy }) => {
    let proxy = null;
    if (applyProxy) {
      const settings = await getSettings();
      const strategy = settings?.providerStrategies?.[provider] || {};
      const input = await applyProviderProxyOverlay(
        connection.providerSpecificData || {},
        strategy,
        { getProxyPools },
      );
      proxy = await resolveConnectionProxyConfig(input, provider, null, {
        scope: `${provider}::${model}`,
        connectionId: connection.id || null,
      });
      if (proxy.proxyRequired && !proxy.connectionProxyEnabled && !proxy.vercelRelayUrl) {
        return { ok: false, status: 503, error: "Required proxy unavailable" };
      }
    }

    const url = PROVIDERS[provider]?.baseUrl;
    const token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
    if (!url || !token) return { ok: false, status: 400, error: "Missing provider endpoint or token" };
    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    };
    try {
      const response = proxy?.vercelRelayUrl ||
        (proxy?.connectionProxyEnabled && proxy?.connectionProxyUrl)
        ? await proxyAwareFetch(url, options, proxy)
        : await fetch(url, options);
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, status: 0, error: error.message };
    }
  });
  return deps;
}

function recoveryConfig(settings) {
  const config = settings?.providerRecovery || {};
  if (typeof config.enabled === "boolean") {
    return {
      enabled: config.enabled,
      intervalMs: Math.max(1_000, Number(config.intervalMs) || DEFAULT_INTERVAL_MS),
      applyProxy: config.applyProxy === true,
    };
  }
  const providerConfigs = Object.values(config)
    .filter((entry) => entry?.enabled === true);
  if (providerConfigs.length === 0) {
    return { enabled: false, intervalMs: DEFAULT_INTERVAL_MS, applyProxy: false };
  }
  const intervalMs = Math.min(
    ...providerConfigs.map((entry) =>
      Math.max(60_000, Number(entry.intervalMinutes || 15) * 60_000),
    ),
  );
  return { enabled: true, intervalMs, applyProxy: true };
}

function providerRunConfig(settings, provider) {
  const config = settings?.providerRecovery?.[provider] || {};
  return {
    enabled: config.enabled === true,
    intervalMs: Math.max(60_000, Number(config.intervalMinutes || 15) * 60_000),
    applyProxy: config.applyProxy === true,
  };
}

/**
 * Reconcile one connection immediately after a model lock is persisted.
 * Accepts a connection id or a fresh connection object.
 */
export async function reconcileProviderRecoveryAccount(connectionOrId, options = {}) {
  const deps = options.deps || await createProductionDeps(options);
  const connection = typeof connectionOrId === "object"
    ? connectionOrId
    : await deps.getProviderConnectionById(connectionOrId);
  if (!connection || !SUPPORTED_PROVIDER_RECOVERY_IDS.has(connection.provider)) {
    return { reconciled: false, disabled: false, recovered: false };
  }

  const catalog = await deps.getProviderModelCatalog(connection);
  const now = options.now ?? Date.now();
  if (connection.isActive !== false) {
    const disabled = await reconcileActiveConnection(connection, catalog, deps, now);
    return { reconciled: true, disabled, recovered: false };
  }
  if (!isAutoDisabled(connection)) {
    return { reconciled: true, disabled: false, recovered: false };
  }
  const settings = options.settings || (deps.getSettings ? await deps.getSettings() : {});
  const config = recoveryConfig(settings);
  const recovered = await recoverConnection(connection, catalog, deps, config.applyProxy);
  return { reconciled: true, disabled: false, recovered };
}

export async function startProviderRecoveryMonitor(options = {}) {
  if (runtime.timer) return { started: false, reason: "already-started" };
  const deps = options.deps || await createProductionDeps(options);
  const settings = options.settings || await deps.getSettings();
  const config = recoveryConfig(settings);
  if (!config.enabled) return { started: false, reason: "disabled" };

  const run = async () => {
    if (runtime.running) return;
    runtime.running = true;
    try {
      const currentSettings = await deps.getSettings();
      const currentConfig = recoveryConfig(currentSettings);
      if (!currentConfig.enabled) {
        stopProviderRecoveryMonitor();
        return;
      }
      const legacyConfig = currentSettings?.providerRecovery;
      if (typeof legacyConfig?.enabled === "boolean") {
        await runProviderRecoveryMonitorTick(deps, {
          state: runtime.state,
          intervalMs: currentConfig.intervalMs,
          applyProxy: currentConfig.applyProxy,
        });
      } else {
        for (const provider of SUPPORTED_PROVIDER_RECOVERY_IDS) {
          const pConfig = providerRunConfig(currentSettings, provider);
          if (!pConfig.enabled) continue;
          runtime.state[provider] ??= { lastRunAt: null };
          await runProviderRecoveryMonitorTick(deps, {
            state: runtime.state[provider],
            intervalMs: pConfig.intervalMs,
            applyProxy: pConfig.applyProxy,
          });
        }
      }
    } catch (error) {
      console.error("[ProviderRecovery] monitor tick failed:", error.message);
    } finally {
      runtime.running = false;
    }
  };

  await run();
  const setIntervalFn = options.setIntervalFn || setInterval;
  runtime.timer = setIntervalFn(run, config.intervalMs);
  runtime.timer?.unref?.();
  return { started: true, intervalMs: config.intervalMs };
}

export function configureProviderRecoveryMonitor(settings) {
  const config = recoveryConfig(settings);
  if (config.enabled) startProviderRecoveryMonitor();
  else stopProviderRecoveryMonitor();
}

export function stopProviderRecoveryMonitor() {
  if (!runtime.timer) return false;
  clearInterval(runtime.timer);
  runtime.timer = null;
  runtime.running = false;
  runtime.state.lastRunAt = null;
  return true;
}
