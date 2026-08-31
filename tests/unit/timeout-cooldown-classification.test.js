import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { TIMEOUT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

// Timeouts must classify as short FIXED cooldowns: they always fall back to
// the next target, and `fixed: true` keeps them out of the model-lock
// accumulation ladder (a handful of connect timeouts must not produce a
// "reset after 27m" lock that poisons every combo leg listing the model).
describe("timeout cooldown classification", () => {
  const timeoutTexts = [
    "fetch connect timeout",
    "[502]: fetch connect timeout (cause: UND_ERR_CONNECT_TIMEOUT)",
    "ConnectTimeoutError: fetch failed",
    "ETIMEDOUT",
    "Request timed out",
    "Model yw1 timed out",
    "UND_ERR_HEADERS_TIMEOUT",
    "idle timeout while reading response",
  ];

  for (const text of timeoutTexts) {
    it(`classifies "${text.slice(0, 40)}" as short fixed cooldown`, () => {
      const res = checkFallbackError(502, text);
      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBe(TIMEOUT_COOLDOWN_MS);
      expect(res.fixed).toBe(true);
    });
  }

  it("classifies synthetic combo timeout status 524 as fixed fallback", () => {
    const res = checkFallbackError(524, "");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(TIMEOUT_COOLDOWN_MS);
    expect(res.fixed).toBe(true);
  });

  it("classifies gateway timeout status 504 without text as fixed fallback", () => {
    const res = checkFallbackError(504, "");
    expect(res.shouldFallback).toBe(true);
    expect(res.fixed).toBe(true);
  });

  // Non-timeout errors keep their existing classification: this is the guard
  // against the regex accidentally swallowing auth/quota failures.
  it("keeps invalid-api-key errors on the long rule (not timeout)", () => {
    const res = checkFallbackError(401, "invalid api key");
    expect(res.cooldownMs).toBeGreaterThan(TIMEOUT_COOLDOWN_MS);
    expect(res.fixed).toBe(false);
  });

  it("keeps client 400 errors non-fallback", () => {
    const res = checkFallbackError(400, "bad request");
    expect(res.shouldFallback).toBe(false);
  });

  it("keeps unknown 5xx on the transient cooldown", () => {
    const res = checkFallbackError(500, "internal error");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBeGreaterThan(TIMEOUT_COOLDOWN_MS);
  });
});
