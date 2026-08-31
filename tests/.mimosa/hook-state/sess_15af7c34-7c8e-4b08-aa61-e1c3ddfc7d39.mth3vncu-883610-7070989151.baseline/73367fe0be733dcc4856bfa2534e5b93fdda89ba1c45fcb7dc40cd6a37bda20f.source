/**
 * Combo fast-switch: recently-failed targets are demoted to the back so the
 * combo starts from a healthy model instead of re-burning a degraded one.
 * Verifies noteTargetFailure / clearTargetFailure / resetTargetFailureTracking
 * via handleComboChat ordering.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  handleComboChat,
  resetTargetFailureTracking,
  resetComboRotation,
  noteTargetFailure,
} from "../../open-sse/services/combo.js";

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function okResponse(model) {
  return new Response(JSON.stringify({ ok: true, model }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// 503 → checkFallbackError falls through to default → shouldFallback = true.
function failResponse(model) {
  return new Response(JSON.stringify({ error: { message: `${model} down` } }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

describe("combo fast-switch target demotion", () => {
  beforeEach(() => {
    resetTargetFailureTracking();
    resetComboRotation();
  });

  it("demotes a previously-failed target to the back on the next request", async () => {
    const combo = "fast-switch-demo";
    const models = ["modelA", "modelB", "modelC"];

    // Request 1: modelA fails, modelB succeeds → combo returns modelB.
    let tried = [];
    const r1 = await handleComboChat({
      body: { messages: [] },
      models,
      comboName: combo,
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0, // disable header-timeout race; use direct result
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return m === "modelA" ? failResponse(m) : okResponse(m);
      },
    });
    expect(r1.status).toBe(200);
    expect(tried[0]).toBe("modelA"); // original order first
    expect(tried).toContain("modelB");

    // Request 2: modelA was marked failed → demoted to back. Force the combo to
    // walk past the healthy-looking targets by failing them, so modelA is tried
    // LAST (proves it moved to the back).
    tried = [];
    const r2 = await handleComboChat({
      body: { messages: [] },
      models,
      comboName: combo,
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return m === "modelA" ? okResponse(m) : failResponse(m);
      },
    });
    expect(r2.status).toBe(200);
    expect(tried[0]).not.toBe("modelA"); // demoted, not first
    expect(tried[tried.length - 1]).toBe("modelA"); // reached last
    expect(tried).toEqual(["modelB", "modelC", "modelA"]);
  });

  it("keeps original order when all targets are degraded (no healthy option)", async () => {
    const combo = "all-degraded";
    const models = ["modelA", "modelB"];

    let tried = [];
    await handleComboChat({
      body: { messages: [] },
      models,
      comboName: combo,
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return failResponse(m); // all fail
      },
    });
    // Both failed → both recorded. Next request: no healthy target exists,
    // so ordering must be preserved (no demotion possible).
    expect(tried).toEqual(["modelA", "modelB"]);

    tried = [];
    await handleComboChat({
      body: { messages: [] },
      models,
      comboName: combo,
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return failResponse(m);
      },
    });
    expect(tried).toEqual(["modelA", "modelB"]);
  });

  it("demotes a target across ALL combos when marked globally (degenerate guard path)", async () => {
    const models = ["prov/model-a", "prov/model-b"];

    // Global mark, as the degenerate-output guard records it (no comboName).
    noteTargetFailure(null, "prov/model-a");

    // A DIFFERENT combo that also lists model-a must demote it to the back.
    let tried = [];
    await handleComboChat({
      body: { messages: [] },
      models,
      comboName: "some-other-combo",
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return m === "prov/model-a" ? okResponse(m) : failResponse(m);
      },
    });
    expect(tried).toEqual(["prov/model-b", "prov/model-a"]);
  });

  it("clears a target's failed mark once it succeeds", async () => {
    const combo = "recover";
    const models = ["modelA", "modelB"];

    // Fail modelA once → it gets marked.
    await handleComboChat({
      body: { messages: [] },
      models,
      comboName: combo,
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => (m === "modelA" ? failResponse(m) : okResponse(m)),
    });

    // Force modelA to actually run and succeed (fail modelB so the combo walks
    // to the demoted modelA). This clears modelA's failed mark.
    await handleComboChat({
      body: { messages: [] },
      models,
      comboName: combo,
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => (m === "modelB" ? failResponse(m) : okResponse(m)),
    });

    // Now modelA is cleared → next request keeps the original order (modelA first).
    let tried = [];
    await handleComboChat({
      body: { messages: [] },
      models,
      comboName: combo,
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return okResponse(m);
      },
    });
    expect(tried[0]).toBe("modelA"); // recovered, back to front
  });
});
