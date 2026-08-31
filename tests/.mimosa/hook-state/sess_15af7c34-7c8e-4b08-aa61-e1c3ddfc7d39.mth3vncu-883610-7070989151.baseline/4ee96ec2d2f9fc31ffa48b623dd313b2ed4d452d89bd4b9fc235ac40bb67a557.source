/**
 * Degenerate-output detector: catches upstream models stuck in a repetition
 * loop (short unit repeated for hundreds of KB) before it floods the client.
 */
import { describe, it, expect } from "vitest";
import {
  detectDegenerateLoop,
  DEGENERATE_MAX_PERIOD,
} from "../../open-sse/utils/degenerate.js";

describe("detectDegenerateLoop", () => {
  it("detects real degenerate patterns from production logs", () => {
    // "íaíaía…" — mixed-diacritic loop (observed)
    expect(detectDegenerateLoop("ía".repeat(300))).toBeTruthy();
    // "/a/a/a/…" — path-like loop (observed)
    expect(detectDegenerateLoop("x".repeat(10) + "/a/".repeat(200))).toBeTruthy();
    // "</parameter</parameter…" — XML-fragment loop (observed)
    const r = detectDegenerateLoop("head ".repeat(3) + "</parameter".repeat(56));
    expect(r).toBeTruthy();
    expect(r.period).toBeLessThanOrEqual(DEGENERATE_MAX_PERIOD);
    // "íiedíied…" 4-char unit
    expect(detectDegenerateLoop("íied".repeat(150))).toBeTruthy();
  });

  it("does not fire on legitimate content", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    expect(detectDegenerateLoop(prose)).toBeNull();
    // base64 is high-entropy — never a perfect short loop
    const b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=".repeat(8);
    expect(detectDegenerateLoop(b64)).toBeNull();
    // repetitive-but-structured JSON
    const json = '{"a":1,"b":2,"c":3}'.repeat(40);
    expect(detectDegenerateLoop(json)).toBeNull();
    // markdown/code divider lines (legit banner output)
    expect(detectDegenerateLoop("-".repeat(200) + "text")).toBeNull();
    expect(detectDegenerateLoop("-".repeat(600) + "tail text normal words here")).toBeNull();
    expect(detectDegenerateLoop("=".repeat(300))).toBeNull();
  });

  it("still fires on a pathological single-char run (full window)", () => {
    expect(detectDegenerateLoop("a".repeat(1024))).toBeTruthy();
  });

  it("ignores short tails and non-strings", () => {
    expect(detectDegenerateLoop("ía".repeat(100))).toBeNull(); // below minRun
    expect(detectDegenerateLoop("")).toBeNull();
    expect(detectDegenerateLoop(null)).toBeNull();
    expect(detectDegenerateLoop(undefined)).toBeNull();
  });
});
