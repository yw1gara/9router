import { describe, expect, it, vi } from "vitest";
import { getCanonicalProviderModelCatalog } from "../../src/lib/providers/modelCatalog.js";

function connection(provider, overrides = {}) {
  return {
    id: "connection-1",
    provider,
    apiKey: "secret",
    providerSpecificData: {},
    ...overrides,
  };
}

describe("canonical provider model catalog", () => {
  it("fetches an authenticated live catalog through the resolved proxy", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "live-a" }, { id: "live-b", kind: "image" }] }),
    });
    const resolveProxy = vi.fn().mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy:8080",
      connectionNoProxy: "localhost",
    });
    const proxyAwareFetch = vi.fn(fetchFn);

    const result = await getCanonicalProviderModelCatalog(connection("orcarouter"), {
      fetchFn,
      proxyAwareFetch,
      resolveProxy,
      settings: { providerStrategies: {} },
    });

    expect(resolveProxy).toHaveBeenCalledWith(
      expect.objectContaining({}),
      "orcarouter",
      null,
      { scope: "orcarouter::*", connectionId: "connection-1" },
    );
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.orcarouter.ai/v1/models",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
      expect.objectContaining({ connectionProxyUrl: "http://proxy:8080" }),
    );
    expect(result).toEqual(expect.objectContaining({
      complete: true,
      source: "live",
      models: [{ id: "live-a", type: "llm" }, { id: "live-b", type: "image" }],
    }));
  });

  it("marks dynamic-provider static fallbacks incomplete", async () => {
    const result = await getCanonicalProviderModelCatalog(connection("tokenrouter"), {
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
      resolveProxy: vi.fn().mockResolvedValue({ source: "none" }),
    });

    expect(result.source).toBe("static");
    expect(result.complete).toBe(false);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("treats the closed OpenCode Zen static allowlist as complete", async () => {
    const result = await getCanonicalProviderModelCatalog(connection("opencode-zen"), {
      fetchFn: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
      resolveProxy: vi.fn().mockResolvedValue({ source: "none" }),
    });

    expect(result).toEqual(expect.objectContaining({ source: "static", complete: true }));
    expect(result.models).toHaveLength(7);
  });
});
