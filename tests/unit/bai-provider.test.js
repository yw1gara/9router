import { describe, expect, it } from "vitest";
import registry from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MEDIA } from "../../open-sse/providers/index.js";

describe("b.ai provider registry", () => {
  it("registers official OpenAI-compatible endpoints and aliases", () => {
    const entry = registry.find((provider) => provider.id === "b-ai");

    expect(entry).toMatchObject({
      id: "b-ai",
      alias: "bai",
      aliases: ["b.ai"],
      authType: "apikey",
      passthroughModels: true,
      transport: {
        baseUrl: "https://api.b.ai/v1/chat/completions",
        validateUrl: "https://api.b.ai/v1/models",
        format: "openai",
      },
      modelsFetcher: {
        url: "https://api.b.ai/v1/models",
        type: "openai",
      },
    });
  });

  it("exposes b.ai through provider runtime metadata", () => {
    expect(PROVIDERS["b-ai"]).toMatchObject({
      baseUrl: "https://api.b.ai/v1/chat/completions",
      validateUrl: "https://api.b.ai/v1/models",
      format: "openai",
    });
    expect(PROVIDER_MEDIA["b-ai"].modelsFetcher).toEqual({
      url: "https://api.b.ai/v1/models",
      type: "openai",
    });
  });
});