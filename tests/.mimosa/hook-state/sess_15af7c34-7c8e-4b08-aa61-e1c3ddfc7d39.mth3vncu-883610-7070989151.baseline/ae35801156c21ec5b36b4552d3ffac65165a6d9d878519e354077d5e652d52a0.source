import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "open-sse/executors/codebuddy-cn.js";

describe("CodeBuddyExecutor system prompt forwarding", () => {
  const executor = new CodeBuddyExecutor();

  it("forwards a long system prompt verbatim instead of replacing it", () => {
    const systemPrompt = `You are Claude Code, Anthropic's official CLI.\n${"x".repeat(2_500)}`;
    const result = executor.transformRequest("dmodel", {
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "hello" },
      ],
    });

    expect(result.stream).toBe(true);
    expect(result.messages[0].content).toBe(systemPrompt);
    expect(result.messages[1].content).toBe("hello");
  });

  it("preserves typed system content blocks verbatim", () => {
    const blocks = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI." }];
    const result = executor.transformRequest("dmodel", {
      messages: [{ role: "system", content: blocks }],
    });

    expect(result.messages[0].content).toBe(blocks);
  });
});