/**
 * Global OAuth refresh serializer — rotation-group locking.
 *
 * Covers: codex shares one serialized lane, non-rotating providers run
 * concurrently, spacing is paid only when a sibling is queued, and the lane
 * keeps flowing after a failed refresh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const load = () => import("../../open-sse/services/refreshSerializer.js");

describe("refreshSerializer", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("maps codex to the openai-auth0 rotation lane", async () => {
    const mod = await load();
    expect(mod.rotationGroupFor("codex")).toBe("openai-auth0");
    expect(mod.rotationGroupFor("openai")).toBeNull();
    expect(mod.rotationGroupFor("claude")).toBeNull();
    expect(mod.rotationGroupFor("grok-cli")).toBeNull();
  });

  it("serializes sibling refreshes in the same group", async () => {
    const mod = await load();
    const order = [];
    const p1 = mod.serializeRefresh("codex", async () => {
      order.push("start1");
      await new Promise((r) => setTimeout(r, 20));
      order.push("end1");
      return 1;
    });
    const p2 = mod.serializeRefresh("codex", async () => {
      order.push("start2");
      order.push("end2");
      return 2;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1, r2]).toEqual([1, 2]);
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("runs non-rotating providers concurrently (no lane)", async () => {
    const mod = await load();
    const order = [];
    const p1 = mod.serializeRefresh("claude", async () => {
      order.push("start1");
      await new Promise((r) => setTimeout(r, 20));
      order.push("end1");
    });
    const p2 = mod.serializeRefresh("claude", async () => {
      order.push("start2");
      order.push("end2");
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start1", "start2", "end2", "end1"]);
  });

  it("inserts the settle gap when a sibling is queued behind", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CODEX_REFRESH_SPACING_MS", "100");
    const mod = await load();
    const calls = [];
    const p1 = mod.serializeRefresh("codex", async () => {
      calls.push("a");
    });
    const p2 = mod.serializeRefresh("codex", async () => {
      calls.push("b");
    });
    // Nothing runs until timers advance: the first refresh must not release
    // its sibling until the spacing gap elapses.
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([p1, p2]);
    expect(calls).toEqual(["a", "b"]);
  });

  it("keeps the lane flowing after a failed refresh", async () => {
    const mod = await load();
    const p1 = mod.serializeRefresh("codex", async () => {
      throw new Error("boom");
    });
    const p2 = mod.serializeRefresh("codex", async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });
});
