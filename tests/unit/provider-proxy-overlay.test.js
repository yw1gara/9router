import { describe, expect, it, vi } from "vitest";
import { applyProviderProxyOverlay } from "../../src/lib/network/connectionProxy.js";

describe("provider proxy overlay", () => {
  it("overlays a fixed provider proxy without discarding connection data", async () => {
    const result = await applyProviderProxyOverlay(
      { tenant: "a", proxyPoolId: "old" },
      { proxyApply: { strategy: "fixed", poolId: "fixed" } },
    );

    expect(result).toEqual({ tenant: "a", proxyPoolId: "fixed", strictProxy: true, proxyRequired: true });
  });

  it("uses all live proxy pools for provider rotation", async () => {
    const getProxyPools = vi.fn().mockResolvedValue([
      { id: "live", isActive: true, proxyUrl: "http://proxy" },
      { id: "inactive", isActive: false, proxyUrl: "http://proxy-2" },
      { id: "empty", isActive: true, proxyUrl: "" },
    ]);

    const result = await applyProviderProxyOverlay(
      { tenant: "a" },
      { proxyApply: { strategy: "smart" } },
      { getProxyPools },
    );

    expect(result).toEqual({
      tenant: "a",
      strictProxy: true,
      proxyRequired: true,
      proxyPoolIds: ["live"],
      proxyRotationStrategy: "smart",
    });
  });
});
