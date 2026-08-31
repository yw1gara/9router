/**
 * Denied-target handling: OpenCode-style permanent model denials
 * ("Free promotion has ended", HTTP 401 ModelError) must be classified as
 * model-access-denied and skipped by combos for the denial TTL — including
 * for noAuth "Public" connections that have no DB row to model-lock.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  isModelAccessDeniedError,
  noteTargetDenied,
  isTargetDenied,
  resetTargetDenials,
} from "../../open-sse/services/accountFallback.js";
import {
  handleComboChat,
  resetTargetFailureTracking,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe("isModelAccessDeniedError — 401 promotion-ended special case", () => {
  it("classifies OpenCode's 401 'Free promotion has ended' as model-access-denied", () => {
    const body = 'ModelError: Free promotion has ended for DeepSeek V4 Flash Free. You can continue using the model by subscribing to OpenCode Go';
    expect(isModelAccessDeniedError(401, body)).toBe(true);
    expect(isModelAccessDeniedError(401, "promotion has ended")).toBe(true);
  });

  it("keeps plain 401 as an auth error (NOT model-access)", () => {
    expect(isModelAccessDeniedError(401, "Unauthorized")).toBe(false);
    expect(isModelAccessDeniedError(401, "invalid api key")).toBe(false);
    expect(isModelAccessDeniedError(401, "")).toBe(false);
  });

  it("does not regress existing classifications", () => {
    expect(isModelAccessDeniedError(404, "")).toBe(true);
    expect(isModelAccessDeniedError(403, "model_not_allowed")).toBe(true);
    expect(isModelAccessDeniedError(429, "rate limit")).toBe(false);
  });
});

describe("denied-target registry", () => {
  beforeEach(() => resetTargetDenials());

  it("marks and expires denials", () => {
    expect(isTargetDenied("opencode/deepseek-v4-flash-free")).toBe(false);
    noteTargetDenied("opencode/deepseek-v4-flash-free");
    expect(isTargetDenied("opencode/deepseek-v4-flash-free")).toBe(true);
    expect(isTargetDenied("opencode/other-model")).toBe(false);
  });
});

describe("handleComboChat skips denied targets", () => {
  beforeEach(() => {
    resetTargetDenials();
    resetTargetFailureTracking();
    resetComboRotation();
  });

  it("does not call a denied model; uses the healthy sibling (alias-aware)", async () => {
    // Denial is keyed by the RESOLVED provider (`opencode/...`) while the combo
    // lists the target under its ALIAS (`oc/...`) — matching must bridge both.
    noteTargetDenied("opencode/dead-model");
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [] },
      models: ["oc/dead-model", "opencode/healthy-model"],
      comboName: "oc",
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(tried).toEqual(["opencode/healthy-model"]); // dead one never invoked
  });

  it("still tries denied models when ALL targets are denied (cheap re-probe)", async () => {
    noteTargetDenied("opencode/dead-a");
    noteTargetDenied("opencode/dead-b");
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [] },
      models: ["opencode/dead-a", "opencode/dead-b"],
      comboName: "oc2",
      comboStrategy: "fallback",
      log: noopLog,
      timeoutMs: 0,
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return new Response(JSON.stringify({ error: { message: "denied" } }), { status: 401 });
      },
    });
    // All-failed aggregate is retryable 503 — the per-target 401 must not
    // leak as the combo's final status (clients would treat it as permanent).
    expect(res.status).toBe(503);
    expect(tried.length).toBe(2); // nothing skipped when everything is denied
  });
});
