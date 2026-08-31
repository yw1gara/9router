import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;

function installFetchMock() {
  const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
  globalThis.fetch = fetchMock;
  return fetchMock;
}

describe("proxyAwareFetch smart fail-closed", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("rejects smart proxy requests with no resolved proxy without direct egress", async () => {
    const fetchMock = installFetchMock();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://example.com/api", {}, {
      smartProxy: true,
      proxyRequired: true,
      strictProxy: true,
      provider: "codex",
      model: "gpt-5.5",
      connectionName: "work-account",
      proxyPoolId: "pool-a",
      proxyPoolScope: "codex::gpt-5.5",
    })).rejects.toThrow(/Proxy required but none resolved.*provider=codex.*model=gpt-5.5.*conn=work-account.*pool=pool-a.*target=https:\/\/example.com\/api/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects smart MITM requests with no resolved proxy without direct bypass", async () => {
    const fetchMock = installFetchMock();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://cloudcode-pa.googleapis.com/v1/test", {}, {
      smartProxy: true,
      proxyRequired: true,
      strictProxy: true,
      proxyPoolId: "pool-a",
    })).rejects.toThrow(/Proxy required but none resolved/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps direct fetch for legacy non-required requests", async () => {
    const fetchMock = installFetchMock();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const response = await proxyAwareFetch("https://example.com/api", {}, {
      smartProxy: false,
      proxyRequired: false,
      strictProxy: false,
    });

    expect(response).toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});