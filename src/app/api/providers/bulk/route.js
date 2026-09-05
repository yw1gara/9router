import { NextResponse } from "next/server";
import { createProviderConnectionsBulk, getProxyPoolById } from "@/models";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items || items.length === 0 || items.length > 500) {
      return NextResponse.json({ error: "items array of 1-500 entries is required" }, { status: 400 });
    }

    const prepared = [];
    for (const item of items) {
      const provider = normalizeProviderId(item.provider);
      const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
      const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
      const isValidProvider = APIKEY_PROVIDERS[provider] ||
        FREE_TIER_PROVIDERS[provider] ||
        supportsApiKeyMode ||
        isWebCookieProvider ||
        isOpenAICompatibleProvider(provider) ||
        isAnthropicCompatibleProvider(provider) ||
        isCustomEmbeddingProvider(provider);

      if (!provider || !isValidProvider) {
        return NextResponse.json({ error: `Invalid provider: ${item.provider}` }, { status: 400 });
      }

      const apiKey = item.apiKey || "";
      if (!apiKey && provider !== "ollama-local") {
        return NextResponse.json({ error: `${isWebCookieProvider ? "Cookie value" : "API Key"} is required for each item` }, { status: 400 });
      }

      const connectionName = item.name || item.displayName || AI_PROVIDERS[provider]?.name;
      if (!connectionName) {
        return NextResponse.json({ error: "Name is required for each item" }, { status: 400 });
      }

      let providerSpecificData = normalizeProviderSpecificData(provider, item, item.providerSpecificData);
      if (item.proxyPoolId && item.proxyPoolId !== "__none__") {
        const pool = await getProxyPoolById(item.proxyPoolId);
        if (pool) {
          providerSpecificData = { ...(providerSpecificData || {}), proxyPoolId: item.proxyPoolId };
        }
      }

      prepared.push({
        provider,
        authType: isWebCookieProvider ? "cookie" : "apikey",
        name: connectionName,
        apiKey,
        priority: item.priority || 1,
        testStatus: item.testStatus || "unknown",
        providerSpecificData,
      });
    }

    const results = await createProviderConnectionsBulk(prepared);
    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    console.error("[API] Bulk provider connection creation error:", error);
    return NextResponse.json({ error: error.message || "Bulk creation failed" }, { status: 500 });
  }
}
