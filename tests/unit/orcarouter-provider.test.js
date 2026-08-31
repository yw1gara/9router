import { describe, it, expect } from "vitest";
import { PROVIDERS, PROVIDER_MODELS } from "open-sse/providers/index.js";
import { FREE_TIER_PROVIDERS } from "@/shared/constants/providers.js";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";
import {
  applyComboTargetExhaustion,
  isModelAccessDeniedError,
} from "open-sse/services/accountFallback.js";
import { DefaultExecutor } from "open-sse/executors/default.js";

function freshSets() {
  return {
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
  };
}

describe("OrcaRouter provider registration", () => {
  it("is registered as a freeTier provider like OpenRouter", () => {
    const ui = FREE_TIER_PROVIDERS.orcarouter;
    expect(ui).toBeTruthy();
    expect(ui.name).toBe("OrcaRouter");
    expect(ui.authType).toBe("apikey");
    expect(ui.hasFree).toBe(true);
    expect(ui.passthroughModels).toBe(true);
    expect(ui.notice.apiKeyUrl).toBe("https://www.orcarouter.ai/console");
    expect(PROVIDERS.orcarouter.baseUrl).toBe("https://api.orcarouter.ai/v1/chat/completions");
    expect(PROVIDERS.orcarouter.validateUrl).toBe("https://api.orcarouter.ai/v1/models");
  });

  it("seeds the documented free models including the orcarouter/free router id", () => {
    const ids = (PROVIDER_MODELS.orca || []).map((m) => m.id);
    expect(ids).toContain("orcarouter/free");
    expect(ids).toContain("deepseek/deepseek-v4-flash-free");
  });
});

describe("orcarouter-free model filter", () => {
  it("keeps -free ids and the router id, drops paid models", () => {
    const out = FILTERS["orcarouter-free"]([
      { id: "orcarouter/free" },
      { id: "deepseek/deepseek-v4-flash-free" },
      { id: "google/gemini-2.5-pro" },
      { id: "qwen/qwen3.8-27b-free" },
    ]);
    expect(out.map((m) => m.id)).toEqual([
      "orcarouter/free",
      "deepseek/deepseek-v4-flash-free",
      "qwen/qwen3.8-27b-free",
    ]);
  });
});

describe("OrcaRouter error semantics", () => {
  it("503 model_not_found (not available for your account) is model-scoped", () => {
    expect(isModelAccessDeniedError(503, '{"error":{"code":"model_not_found","message":"Model is not available for your account"}}')).toBe(true);
    expect(isModelAccessDeniedError(503, "service unavailable")).toBe(false);
    expect(isModelAccessDeniedError(425, "model_not_yet_available")).toBe(true);
  });

  it("transient overloaded 503 with generic model text is NOT a model denial", () => {
    // "Model is not available right now, please retry" on a 503 under load is a
    // transient outage — it must stay in the connection/transient path, not
    // trigger a 5-minute model quarantine.
    expect(isModelAccessDeniedError(503, "Model is not available right now, please retry")).toBe(false);
    expect(isModelAccessDeniedError(503, "The deployment does not exist")).toBe(false);
    expect(isModelAccessDeniedError(425, "upgrade your plan")).toBe(false);
  });

  it("503 model_not_found exhausts only the model, not the connection", () => {
    const sets = freshSets();
    applyComboTargetExhaustion(
      "orcarouter", "conn-1", "google/gemini-2.5-pro", 503,
      '{"error":{"code":"model_not_found"}}',
      sets,
    );
    expect(sets.exhaustedProviders.has("orcarouter:google/gemini-2.5-pro")).toBe(true);
    expect(sets.exhaustedConnections.has("orcarouter:conn-1")).toBe(false);
  });

  it("429 free_rate_limited skips the model for the request, keeps the account", () => {
    const sets = freshSets();
    applyComboTargetExhaustion(
      "orcarouter", "conn-1", "deepseek/deepseek-v4-flash-free", 429,
      '{"error":{"code":"free_rate_limited"}}',
      sets,
    );
    expect(sets.exhaustedProviders.has("orcarouter:deepseek/deepseek-v4-flash-free")).toBe(true);
    expect(sets.exhaustedConnections.has("orcarouter:conn-1")).toBe(false);
  });

  it("plain 429 without free_rate_limited marks nothing extra", () => {
    const sets = freshSets();
    applyComboTargetExhaustion("orcarouter", "conn-1", "m", 429, "rate limit exceeded", sets);
    expect(sets.exhaustedProviders.size).toBe(0);
    expect(sets.exhaustedConnections.size).toBe(0);
  });
});

describe("DefaultExecutor Retry-After parsing", () => {
  const exec = new DefaultExecutor("orcarouter");

  it("converts seconds form to resetsAtMs", () => {
    const before = Date.now();
    const res = { status: 429, headers: new Headers({ "retry-after": "30" }) };
    const parsed = exec.parseError(res, '{"error":{"code":"free_rate_limited"}}');
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("converts HTTP-date form to resetsAtMs", () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    const res = { status: 429, headers: new Headers({ "retry-after": at }) };
    const parsed = exec.parseError(res, "err");
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 55_000);
    expect(parsed.resetsAtMs).toBeLessThan(Date.now() + 65_000);
  });

  it("no header → no resetsAtMs", () => {
    const res = { status: 429, headers: new Headers({}) };
    const parsed = exec.parseError(res, "err");
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});
