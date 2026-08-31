/**
 * Proxy pool fitness registry + multi-pool picker.
 *
 * Fitness persistence is mocked at the repo boundary (dynamic import), so
 * these tests exercise the cache semantics without a real SQLite adapter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/db/repos/proxyPoolFitnessRepo.js", () => {
  const rows = [];
  return {
    __rows: rows,
    listProxyPoolFitness: vi.fn(async () => rows.slice()),
    upsertProxyPoolFitness: vi.fn(async (poolId, scope, until, reason, failureCount) => {
      const i = rows.findIndex((r) => r.poolId === poolId && r.scope === scope);
      const entry = { poolId, scope, until, reason, failureCount, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      if (i >= 0) rows[i] = entry; else rows.push(entry);
    }),
    deleteProxyPoolFitness: vi.fn(async (poolId, scope) => {
      const i = rows.findIndex((r) => r.poolId === poolId && r.scope === scope);
      if (i >= 0) rows.splice(i, 1);
    }),
    deleteProxyPoolFitnessByPool: vi.fn(async () => {}),
    clearProxyPoolFitness: vi.fn(async () => { rows.length = 0; }),
    pruneExpiredProxyPoolFitness: vi.fn(async () => 0),
  };
});

const loadFitness = () => import("../../open-sse/services/proxyPoolFitness.js");
const loadPicker = () => import("../../src/lib/network/connectionProxy.js");

describe("proxyPoolFitness cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("unknown pool/scope is fit (fail-open)", async () => {
    const mod = await loadFitness();
    mod.resetPoolFitness();
    expect(mod.isPoolFit("pool-a", "codex::gpt-5.5")).toBe(true);
    expect(mod.fitPoolIds(["pool-a", "pool-b"], "codex::gpt-5.5")).toEqual(["pool-a", "pool-b"]);
  });

  it("markPoolUnfit excludes exact scope but not other models", async () => {
    const mod = await loadFitness();
    mod.resetPoolFitness();
    await mod.markPoolUnfit("pool-a", "codex::gpt-5.5", null, "test");
    expect(mod.isPoolFit("pool-a", "codex::gpt-5.5")).toBe(false);
    expect(mod.isPoolFit("pool-a", "codex::gpt-5.6")).toBe(true);
    expect(mod.fitPoolIds(["pool-a", "pool-b"], "codex::gpt-5.5")).toEqual(["pool-b"]);
  });

  it("provider wildcard scope blocks every model of that provider", async () => {
    const mod = await loadFitness();
    mod.resetPoolFitness();
    await mod.markPoolUnfit("pool-a", "codex::*", null, "manual");
    expect(mod.isPoolFit("pool-a", "codex::gpt-5.5")).toBe(false);
    expect(mod.isPoolFit("pool-a", "codex::anything")).toBe(false);
    expect(mod.isPoolFit("pool-a", "claude::x")).toBe(true);
  });

  it("expired marks are dropped lazily on read", async () => {
    const mod = await loadFitness();
    mod.resetPoolFitness();
    const pastUntil = Date.now() - 1000;
    await mod.markPoolUnfit("pool-a", "codex::gpt-5.5", pastUntil, "stale");
    expect(mod.isPoolFit("pool-a", "codex::gpt-5.5")).toBe(true);
  });

  it("uses fixed ten-minute cooldown despite repeated failures", async () => {
    const mod = await loadFitness();
    mod.resetPoolFitness();
    const repo = await import("../../src/lib/db/repos/proxyPoolFitnessRepo.js");
    const prior = (await repo.listProxyPoolFitness("pool-a"))
      .find((entry) => entry.scope === "codex::gpt-5.5")?.failureCount || 0;
    const before = Date.now();
    await mod.markPoolUnfit("pool-a", "codex::gpt-5.5", null, "first");
    await mod.markPoolUnfit("pool-a", "codex::gpt-5.5", null, "second");
    const row = (await repo.listProxyPoolFitness("pool-a"))
      .find((entry) => entry.scope === "codex::gpt-5.5");
    expect(row.failureCount).toBe(prior + 2);
    expect(row.until).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(row.until).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  });

  it("clearPoolUnfit restores the pool", async () => {
    const mod = await loadFitness();
    mod.resetPoolFitness();
    await mod.markPoolUnfit("pool-a", "codex::*", null, "manual");
    await mod.clearPoolUnfit("pool-a", "codex::*");
    expect(mod.isPoolFit("pool-a", "codex::gpt-5.5")).toBe(true);
  });
});

describe("pickProxyPoolId", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null for empty list", async () => {
    const { pickProxyPoolId } = await loadPicker();
    expect(pickProxyPoolId([], "smart", "codex")).toBeNull();
  });

  it("excludes ids via opts.excludeIds", async () => {
    const { pickProxyPoolId } = await loadPicker();
    expect(pickProxyPoolId(["a", "b"], "fixed", "p", { excludeIds: ["a"] })).toBe("b");
  });

  it("smart with no fitness marks round-robins over all pools", async () => {
    const { pickProxyPoolId } = await loadPicker();
    const picks = new Set([
      pickProxyPoolId(["a", "b"], "smart", "p", { scope: "codex::m" }),
      pickProxyPoolId(["a", "b"], "smart", "p", { scope: "codex::m" }),
      pickProxyPoolId(["a", "b"], "smart", "p", { scope: "codex::m" }),
    ]);
    expect(picks.has("a")).toBe(true);
    expect(picks.has("b")).toBe(true);
  });

  it("smart skips unfit pools for the scope", async () => {
    const fitness = await loadFitness();
    fitness.resetPoolFitness();
    await fitness.markPoolUnfit("a", "codex::m", null, "test");
    const { pickProxyPoolId } = await loadPicker();
    const pick = pickProxyPoolId(["a", "b"], "smart", "p2", { scope: "codex::m" });
    expect(pick).toBe("b");
  });

  it("smart returns null (never an unfit pool) when all are unfit", async () => {
    const fitness = await loadFitness();
    fitness.resetPoolFitness();
    await fitness.markPoolUnfit("a", "codex::m", null, "test");
    await fitness.markPoolUnfit("b", "codex::m", null, "test");
    const { pickProxyPoolId } = await loadPicker();
    expect(pickProxyPoolId(["a", "b"], "smart", "p3", { scope: "codex::m" })).toBeNull();
  });

  it("smart distributes new connections deterministically across pools", async () => {
    const fitness = await loadFitness();
    fitness.resetPoolFitness();
    const { pickProxyPoolId } = await loadPicker();
    const picks = ["c1", "c2", "c3", "c4"].map((connectionId) =>
      pickProxyPoolId(["a", "b"], "smart", "balanced", { scope: "codex::m", connectionId })
    );
    expect(picks.filter((id) => id === "a")).toHaveLength(2);
    expect(picks.filter((id) => id === "b")).toHaveLength(2);
  });

  it("smart rotates a bound connection when its pool is excluded", async () => {
    const { pickProxyPoolId } = await loadPicker();
    const first = pickProxyPoolId(["a", "b", "c"], "smart", "rotate", { scope: "codex::m", connectionId: "conn" });
    const next = pickProxyPoolId(["a", "b", "c"], "smart", "rotate", { scope: "codex::m", connectionId: "conn", excludeIds: [first] });
    expect(next).not.toBe(first);
  });

  it("non-smart strategies stay fail-open when everything is excluded", async () => {
    const { pickProxyPoolId } = await loadPicker();
    expect(pickProxyPoolId(["a"], "round-robin", "p", { excludeIds: ["a"] })).toBeNull();
    expect(pickProxyPoolId(["a", "b"], "random", "p", { excludeIds: ["a"] })).toBe("b");
  });
});
