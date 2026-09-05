import { describe, expect, it } from "vitest";
import { validateContextLength } from "../../src/app/api/combos/[id]/route.js";

describe("validateContextLength", () => {
  it("accepts positive integers", () => {
    expect(validateContextLength(128000)).toEqual({ ok: true, value: 128000 });
    expect(validateContextLength(1000000)).toEqual({ ok: true, value: 1000000 });
    expect(validateContextLength(2000000)).toEqual({ ok: true, value: 2000000 });
  });

  it("accepts null/undefined/empty as unlimited", () => {
    expect(validateContextLength(null)).toEqual({ ok: true, value: null });
    expect(validateContextLength(undefined)).toEqual({ ok: true, value: null });
    expect(validateContextLength("")).toEqual({ ok: true, value: null });
  });

  it("rejects zero and negatives", () => {
    expect(validateContextLength(0).ok).toBe(false);
    expect(validateContextLength(-1000).ok).toBe(false);
  });

  it("rejects non-integers / non-numbers", () => {
    expect(validateContextLength(1.5).ok).toBe(false);
    expect(validateContextLength("abc").ok).toBe(false);
    expect(validateContextLength("12k").ok).toBe(false);
    expect(validateContextLength(NaN).ok).toBe(false);
  });

  it("rejects unreasonable values above the 2M bound", () => {
    expect(validateContextLength(2000001).ok).toBe(false);
    expect(validateContextLength(999999999).ok).toBe(false);
  });
});
