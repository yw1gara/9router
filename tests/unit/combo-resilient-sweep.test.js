import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { applyComboTargetExhaustion } from "../../open-sse/services/accountFallback.js";

describe("Resilient Combo Sweep & Hard/Soft Exhaustion", () => {
  it("marks quota and prompt-cap failures as hardExhausted, but 5xx/timeout as soft", () => {
    const sets = {
      exhaustedProviders: new Set(),
      hardExhaustedProviders: new Set(),
      exhaustedConnections: new Set(),
      transientRateLimitedProviders: new Set(),
      providerFailureCounts: new Map(),
    };

    // Orca prompt cap (400) -> HARD
    applyComboTargetExhaustion("orcarouter", "c1", "orcarouter/free", 400, "err_free_prompt_cap", sets);
    expect(sets.exhaustedProviders.has("orcarouter:orcarouter/free")).toBe(true);
    expect(sets.hardExhaustedProviders.has("orcarouter:orcarouter/free")).toBe(true);

    // Timeout (524) -> SOFT (only exhaustedConnections / exhaustedProviders, not hard)
    applyComboTargetExhaustion("tokenharbor", "c2", "mimo-v2.5:free", 524, "target timeout", sets);
    expect(sets.hardExhaustedProviders.has("tokenharbor:mimo-v2.5:free")).toBe(false);

    // Quota exhausted (429) -> HARD
    applyComboTargetExhaustion("genspark", "c3", "gpt-4", 429, "credits exhausted", sets);
    expect(sets.hardExhaustedProviders.has("genspark:gpt-4")).toBe(true);
  });

  it("handleComboChat sweeps all eligible targets on 2nd pass if 1st pass fails transiently", async () => {
    const calls = [];
    const mockHandle = vi.fn(async (body, modelStr, targetOptions) => {
      calls.push({ model: modelStr, pass: targetOptions?.retryPass || 1 });
      // Fail on pass 1 for both models, succeed on pass 2 for modelB
      if (targetOptions?.retryPass === 2 && modelStr === "modelB") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "transient error" }), { status: 502 });
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["modelA", "modelB"],
      handleSingleModel: mockHandle,
      comboName: "test-combo",
      comboStrategy: "fallback",
      timeoutMs: 5000,
      log: { info: () => {}, warn: () => {} },
    });

    expect(result.ok).toBe(true);
    // Expect pass 1 for A, pass 1 for B, pass 2 for A, pass 2 for B (succeeds!)
    expect(calls).toEqual([
      { model: "modelA", pass: 1 },
      { model: "modelB", pass: 1 },
      { model: "modelA", pass: 2 },
      { model: "modelB", pass: 2 },
    ]);
  });
});
