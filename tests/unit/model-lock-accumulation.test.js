/**
 * Model-lock cooldown accumulation:
 *   - repeated failures double the lock (base × 2^(n-1)), capped at 24h
 *   - accumulation resets once the previous lock has been expired for its own
 *     duration (grace window) without a new failure
 *   - buildClearModelLocksUpdate also clears modelLockAcc_* state
 */

import { describe, it, expect } from "vitest";
import {
  MODEL_LOCK_ACC_PREFIX,
  getModelLockAccKey,
  getModelLockAccCount,
  accumulateModelLockCooldown,
  buildClearModelLocksUpdate,
  isModelLockActive,
  getEarliestModelLockUntil,
} from "../../open-sse/services/accountFallback.js";
import { MAX_MODEL_LOCK_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-08-19T12:00:00.000Z");

describe("getModelLockAccKey", () => {
  it("derives key from model name and __all fallback", () => {
    expect(getModelLockAccKey("gpt-4")).toBe("modelLockAcc_gpt-4");
    expect(getModelLockAccKey(null)).toBe("modelLockAcc___all");
  });

  it("acc keys never collide with the modelLock_ lock prefix", () => {
    expect(getModelLockAccKey("x").startsWith("modelLock_")).toBe(false);
  });
});

describe("accumulateModelLockCooldown", () => {
  it("starts fresh at count 1 with the base cooldown", () => {
    const { cooldownMs, accUpdate } = accumulateModelLockCooldown(null, "gpt-4", 60_000, { now: T0 });
    expect(cooldownMs).toBe(60_000);
    const acc = accUpdate[getModelLockAccKey("gpt-4")];
    expect(acc.count).toBe(1);
    expect(acc.ms).toBe(60_000);
    expect(acc.until).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("doubles while inside the grace window (lock still active)", () => {
    const first = accumulateModelLockCooldown(null, "gpt-4", 60_000, { now: T0 });
    const conn = { [getModelLockAccKey("gpt-4")]: first.accUpdate[getModelLockAccKey("gpt-4")] };
    const second = accumulateModelLockCooldown(conn, "gpt-4", 60_000, { now: T0 + 30_000 });
    expect(second.cooldownMs).toBe(120_000);
    expect(second.accUpdate[getModelLockAccKey("gpt-4")].count).toBe(2);
  });

  it("keeps accumulating within one cooldown-length after expiry", () => {
    const acc = { count: 1, until: new Date(T0 + 60_000).toISOString(), ms: 60_000 };
    const conn = { modelLockAcc_gpt4: acc };
    // Grace = prevUntil + prev.ms = T0 + 120s. Failure just inside grace accumulates.
    const r = accumulateModelLockCooldown(conn, "gpt4", 60_000, { now: T0 + 119_000 });
    expect(r.accUpdate[getModelLockAccKey("gpt4")].count).toBe(2);
    expect(r.cooldownMs).toBe(120_000);
  });

  it("resets accumulation after the grace window (lock expired for its own duration)", () => {
    const acc = { count: 5, until: new Date(T0 + 60_000).toISOString(), ms: 60_000 };
    const conn = { modelLockAcc_gpt4: acc };
    // Grace = prevUntil + prev.ms = T0 + 120s. A failure AFTER the grace
    // window means the model stayed healthy for a full cooldown-length —
    // start the ladder over instead of doubling a stale count.
    const r = accumulateModelLockCooldown(conn, "gpt4", 60_000, { now: T0 + 121_000 });
    expect(r.accUpdate[getModelLockAccKey("gpt4")].count).toBe(1);
    expect(r.cooldownMs).toBe(60_000);
  });

  it("caps accumulated cooldown at 24h", () => {
    // count high enough that base × 2^(n-1) exceeds a day
    const acc = { count: 20, until: new Date(T0 + DAY).toISOString(), ms: DAY };
    const conn = { modelLockAcc_m: acc };
    const r = accumulateModelLockCooldown(conn, "m", 60_000, { now: T0 });
    expect(r.cooldownMs).toBe(MAX_MODEL_LOCK_COOLDOWN_MS);
    expect(r.accUpdate[getModelLockAccKey("m")].count).toBe(21);
    expect(MAX_MODEL_LOCK_COOLDOWN_MS).toBe(DAY);
  });

  it("ignores malformed prior accumulation state", () => {
    const conn = { modelLockAcc_m: { count: "NaN-string", until: null, ms: 0 } };
    const r = accumulateModelLockCooldown(conn, "m", 30_000, { now: T0 });
    expect(r.accUpdate[getModelLockAccKey("m")].count).toBe(1);
    expect(r.cooldownMs).toBe(30_000);
  });
});

describe("lock helpers ignore accumulation fields", () => {
  it("isModelLockActive / getEarliestModelLockUntil skip modelLockAcc_*", () => {
    const future = Date.now() + 60_000;
    const conn = {
      modelLock_gpt4: new Date(future).toISOString(),
      [`${MODEL_LOCK_ACC_PREFIX}gpt4`]: { count: 2, until: new Date(future).toISOString(), ms: 120_000 },
    };
    expect(isModelLockActive(conn, "gpt4")).toBe(true);
    expect(new Date(getEarliestModelLockUntil(conn)).getTime()).toBe(future);
    expect(getModelLockAccCount(conn, "gpt4")).toBe(2);
    expect(getModelLockAccCount({}, "gpt4")).toBe(0);
  });

  it("buildClearModelLocksUpdate clears locks AND accumulation state", () => {
    const conn = {
      modelLock_gpt4: new Date(T0 + 60_000).toISOString(),
      modelLockAcc_gpt4: { count: 2, until: new Date(T0 + 60_000).toISOString(), ms: 120_000 },
    };
    expect(buildClearModelLocksUpdate(conn)).toEqual({
      modelLock_gpt4: null,
      modelLockAcc_gpt4: null,
    });
  });
});
