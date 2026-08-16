import { describe, it, expect } from "vitest";
import {
  applyComboTargetExhaustion,
  isModelAccessDeniedError,
} from "open-sse/services/accountFallback.js";

function freshSets() {
  return {
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
  };
}

describe("isModelAccessDeniedError — model-scoped denial patterns", () => {
  it("matches the custom-provider 403 model_not_allowed body", () => {
    expect(isModelAccessDeniedError(403, "Model is not available for this API key")).toBe(true);
    expect(isModelAccessDeniedError(403, '{"error":{"message":"Model is not available","code":"model_not_allowed"}}')).toBe(true);
  });

  it("does not match genuine auth or rate-limit failures", () => {
    expect(isModelAccessDeniedError(401, "invalid api key")).toBe(false);
    expect(isModelAccessDeniedError(429, "rate limit reached")).toBe(false);
    expect(isModelAccessDeniedError(500, "model is not available")).toBe(false);
  });
});

describe("applyComboTargetExhaustion — model-denied must stay model-scoped", () => {
  it("403 model_not_allowed marks provider:model only — connection stays eligible", () => {
    const sets = freshSets();
    const ret = applyComboTargetExhaustion(
      "routers9", "conn-1", "model-a", 403,
      "Model is not available for this API key",
      sets,
    );
    expect(ret).toBe(false);
    expect(sets.exhaustedProviders.has("routers9:model-a")).toBe(true);
    expect(sets.exhaustedConnections.has("routers9:conn-1")).toBe(false);
    // Sibling model on the same account is untouched
    expect(sets.exhaustedProviders.has("routers9:model-b")).toBe(false);
  });

  it("genuine 401 still marks the connection (account problem)", () => {
    const sets = freshSets();
    applyComboTargetExhaustion("routers9", "conn-1", "model-a", 401, "invalid api key", sets);
    expect(sets.exhaustedConnections.has("routers9:conn-1")).toBe(true);
    expect(sets.exhaustedProviders.has("routers9:model-a")).toBe(false);
  });

  it("quota-exhausted body marks provider:model (request-local)", () => {
    const sets = freshSets();
    applyComboTargetExhaustion("routers9", "conn-1", "model-a", 402, "insufficient credits", sets);
    expect(sets.exhaustedProviders.has("routers9:model-a")).toBe(true);
    expect(sets.exhaustedConnections.has("routers9:conn-1")).toBe(false);
  });
});
