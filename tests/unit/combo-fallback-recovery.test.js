import { describe, it, expect } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

const response = (status, message) => new Response(
  JSON.stringify(status === 200 ? { ok: true } : { error: { message } }),
  { status, headers: { "Content-Type": "application/json" } },
);

describe("combo fallback recovery", () => {
  it("falls through after an upstream 400", async () => {
    const tried = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["bad-model", "healthy-model"],
      comboName: "400-fallback",
      comboStrategy: "fallback",
      timeoutMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        return model === "bad-model" ? response(400, "model schema rejected") : response(200);
      },
    });

    expect(result.status).toBe(200);
    expect(tried).toEqual(["bad-model", "healthy-model"]);
  });

  it("returns structured error after every target fails", async () => {
    const result = await handleComboChat({
      body: { messages: [] },
      models: ["model-a", "model-b"],
      comboName: "all-fail",
      comboStrategy: "fallback",
      timeoutMs: 0,
      log,
      handleSingleModel: async () => response(400, "rejected by target"),
    });

    // All-failed combos always normalize to retryable 503 — never the first
    // failing target's incidental status — so clients retry instead of
    // classifying the failure as permanent.
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: { message: "rejected by target" } });
  });

  it("does not retry when caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    let calls = 0;
    const result = await handleComboChat({
      body: { messages: [] },
      models: ["model-a", "model-b"],
      comboName: "client-abort",
      comboStrategy: "fallback",
      signal: controller.signal,
      timeoutMs: 0,
      log,
      handleSingleModel: async () => { calls += 1; return response(200); },
    });

    expect(result.status).toBe(499);
    expect(calls).toBe(0);
  });
});
