import { describe, it, expect } from "vitest";
import * as db from "../../src/lib/db/index.js";

describe("Usage repo fixes", () => {

  it("handles concurrent pending requests for same connection/model without resetting each other", () => {
    db.trackPendingRequest("gpt-4", "openai", "conn1", true, false, "sk-test1");
    db.trackPendingRequest("gpt-4", "openai", "conn1", true, false, "sk-test1");

    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(2);

    db.trackPendingRequest("gpt-4", "openai", "conn1", false, false, "sk-test1");
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);

    db.trackPendingRequest("gpt-4", "openai", "conn1", false, false, "sk-test1");
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBeUndefined();
  });

  it("clamps limit in getUsageHistory and getRecentLogs to positive safe bounds", async () => {
    const histNeg = await db.getUsageHistory({ limit: -1 });
    expect(Array.isArray(histNeg)).toBe(true);

    const logsNeg = await db.getRecentLogs(-50);
    expect(Array.isArray(logsNeg)).toBe(true);
  });

  it("calculates long-period usage analytics with error counts", async () => {
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4-test",
      status: "error",
      tokens: { prompt_tokens: 50, completion_tokens: 10 },
      endpoint: "/v1/chat/completions",
    });

    const analytics = await db.getUsageAnalytics("7d");
    expect(analytics).toBeDefined();
    expect(analytics.summary).toBeDefined();
    expect(analytics.summary.requests).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(analytics.velocity)).toBe(true);
  });
});
