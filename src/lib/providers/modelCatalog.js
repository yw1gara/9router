import { PROVIDERS, PROVIDER_MEDIA } from "open-sse/providers/index.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { resolveConnectionProxyConfig, applyProviderProxyOverlay } from "@/lib/network/connectionProxy.js";

const SUPPORTED = new Set(["orcarouter", "opencode-zen", "tokenrouter", "b-ai"]);

function modelType(model) {
  return model?.type || model?.kind || "llm";
}

function normalizeModels(value) {
  const models = Array.isArray(value) ? value : value?.data || value?.models || value?.results || [];
  return models.flatMap((model) => {
    const id = typeof model === "string" ? model : model?.id || model?.model || model?.slug;
    if (!id) return [];
    return [{ id, type: modelType(model) }];
  });
}

function staticModels(provider) {
  return normalizeModels(getModelsByProviderId(provider));
}

function staticCatalogIsComplete(provider) {
  // Zen is a closed free-model allowlist. OrcaRouter and TokenRouter explicitly
  // accept changing live/passthrough catalogs, so a static snapshot is unsafe
  // for the "all models locked" decision.
  return provider === "opencode-zen";
}

function proxyOptions(proxy) {
  return {
    connectionProxyEnabled: proxy?.connectionProxyEnabled === true,
    connectionProxyUrl: proxy?.connectionProxyUrl || "",
    connectionNoProxy: proxy?.connectionNoProxy || "",
    vercelRelayUrl: proxy?.vercelRelayUrl || "",
    strictProxy: proxy?.strictProxy === true,
  };
}

export async function getCanonicalProviderModelCatalog(connection, deps = {}) {
  const provider = connection?.provider;
  if (!SUPPORTED.has(provider)) {
    return { provider, models: [], complete: false, source: "unsupported" };
  }

  const settings = deps.settings || (deps.getSettings ? await deps.getSettings() : {});
  const strategy = settings?.providerStrategies?.[provider] || {};
  const overlay = await applyProviderProxyOverlay(
    connection.providerSpecificData || {},
    strategy,
    deps,
  );
  const resolveProxy = deps.resolveProxy || resolveConnectionProxyConfig;
  const proxy = await resolveProxy(overlay, provider, null, {
    scope: `${provider}::*`,
    connectionId: connection.id || null,
  });

  const fetcher = PROVIDER_MEDIA[provider]?.modelsFetcher;
  const url = fetcher?.url || PROVIDERS[provider]?.validateUrl;
  const token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
  const fetchFn = deps.fetchFn || fetch;

  if (url && token) {
    try {
      const options = {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15_000),
      };
      let response;
      const proxied = proxy?.vercelRelayUrl ||
        (proxy?.connectionProxyEnabled && proxy?.connectionProxyUrl);
      if (proxied) {
        const proxyFetch = deps.proxyAwareFetch ||
          (await import("open-sse/utils/proxyFetch.js")).proxyAwareFetch;
        response = await proxyFetch(url, options, proxyOptions(proxy));
      } else {
        response = await fetchFn(url, options);
      }
      if (response.ok) {
        const models = normalizeModels(await response.json());
        if (models.length > 0) {
          return { provider, models, complete: true, source: "live" };
        }
      }
    } catch {
      // Static fallback below deliberately carries explicit completeness.
    }
  }

  return {
    provider,
    models: staticModels(provider),
    complete: staticCatalogIsComplete(provider),
    source: "static",
  };
}
