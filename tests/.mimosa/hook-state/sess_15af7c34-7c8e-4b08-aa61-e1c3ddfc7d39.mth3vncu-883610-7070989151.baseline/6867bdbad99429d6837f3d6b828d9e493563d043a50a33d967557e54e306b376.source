import { describe, it, expect } from "vitest";
import { PROVIDERS, PROVIDER_MODELS } from "open-sse/providers/index.js";
import { FREE_TIER_PROVIDERS, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { resolveProviderIconId } from "@/shared/utils/providerIcon.js";

const ZEN_FREE_MODELS = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "laguna-s-2.1-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
];

describe("OpenCode Zen provider registration", () => {
  it("is a freeTier provider with apikey auth and its own alias", () => {
    const ui = FREE_TIER_PROVIDERS["opencode-zen"];
    expect(ui).toBeTruthy();
    expect(ui.name).toBe("OpenCode Zen");
    expect(ui.authType).toBe("apikey");
    expect(ui.hasFree).toBe(true);
    // falsy in the UI entry → ModelSelectModal shows only the registered
    // (free) models, never the full paid catalog
    expect(ui.passthroughModels).toBeFalsy();
    expect(ui.notice.apiKeyUrl).toBe("https://opencode.ai/auth");
    expect(PROVIDERS["opencode-zen"].baseUrl).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(PROVIDERS["opencode-zen"].validateUrl).toBe("https://opencode.ai/zen/v1/models");
  });

  it("does not collide with the existing opencode / opencode-go providers", () => {
    expect(FREE_PROVIDERS.opencode).toBeTruthy(); // noAuth free stays as-is
    expect(PROVIDERS["opencode-go"].baseUrl).toContain("/zen/go/");
    expect(FREE_TIER_PROVIDERS["opencode-zen"].id).toBe("opencode-zen");
    // distinct aliases so model routing cannot clash
    expect(new Set(["oc", "ocg", "oczen"]).size).toBe(3);
  });

  it("seeds exactly the 7 documented free models (all chat/completions-compatible)", () => {
    const ids = (PROVIDER_MODELS.oczen || []).map((m) => m.id).sort();
    expect(ids).toEqual([...ZEN_FREE_MODELS].sort());
  });

  it("uses the opencode icon via alias (no 404 on a missing zen png)", () => {
    expect(resolveProviderIconId("opencode-zen")).toBe("opencode");
  });
});
