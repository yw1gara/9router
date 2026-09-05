import { describe, it, expect } from "vitest";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";

describe("Empty Reasoning Stream Recovery", () => {
  it("injects empty content chunk when Gemini finishes with only thinking", () => {
    const state = {};
    const chunk1 = {
      responseId: "resp-1",
      modelVersion: "gemini-3.7-flash",
      candidates: [{ content: { role: "model", parts: [{ thought: true, text: "thinking hard..." }] } }]
    };
    const chunk2 = {
      candidates: [{ finishReason: "STOP" }]
    };

    const r1 = geminiToOpenAIResponse(chunk1, state);
    expect(r1).toHaveLength(2); // initial role + reasoning delta

    const r2 = geminiToOpenAIResponse(chunk2, state);
    expect(r2).toHaveLength(2); // empty text content delta + final finish chunk
    expect(r2[0].choices[0].delta).toEqual({ content: "" });
    expect(r2[1].choices[0].finish_reason).toBe("stop");
  });

  it("injects empty content chunk when Claude finishes with only thinking", () => {
    const state = { toolCalls: new Map() };

    claudeToOpenAIResponse({ type: "message_start", message: { id: "msg-1", model: "claude-3-7-sonnet" } }, state);
    claudeToOpenAIResponse({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }, state);
    claudeToOpenAIResponse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "deep thoughts" } }, state);
    claudeToOpenAIResponse({ type: "content_block_stop", index: 0 }, state);

    const deltaChunk = { type: "message_delta", delta: { stop_reason: "end_turn" } };
    const r = claudeToOpenAIResponse(deltaChunk, state);

    expect(r).toHaveLength(2);
    expect(r[0].choices[0].delta).toEqual({ content: "" });
    expect(r[1].choices[0].finish_reason).toBe("stop");
  });
});
