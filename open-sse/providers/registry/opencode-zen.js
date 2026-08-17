// OpenCode Zen — curated AI gateway by the OpenCode team.
// Docs: https://opencode.ai/docs/zen
// Auth: API key from https://opencode.ai/auth (pay-as-you-go + 7 free models).
// Zen serves OpenAI, Anthropic, Gemini and openai-compatible endpoints per
// model; this Free-Tier entry deliberately routes ONLY the 7 free models
// (all served at /zen/v1/chat/completions) so a free-tier setup can never
// accidentally bill paid models. Paid access remains available through the
// dedicated opencode-go provider.
export default {
  id: "opencode-zen",
  priority: 41,
  hasFree: true,
  alias: "oczen",
  uiAlias: "oczen",
  display: {
    name: "OpenCode Zen",
    icon: "terminal",
    color: "#E87040",
    textIcon: "ZN",
    website: "https://opencode.ai/auth",
    notice: {
      text: "Free tier: 7 free models (big-pickle, deepseek-v4-flash-free, mimo-v2.5-free, hy3-free, laguna-s-2.1-free, nemotron-3-ultra-free, nemotron-3.5-lightning-free). Paid models are pay-as-you-go.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://opencode.ai/zen/v1/chat/completions",
    validateUrl: "https://opencode.ai/zen/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "big-pickle", name: "Big Pickle (Free)", contextLength: 128000 },
    { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)", contextLength: 128000 },
    { id: "mimo-v2.5-free", name: "MiMo V2.5 (Free)", contextLength: 128000 },
    { id: "hy3-free", name: "Hy3 (Free)", contextLength: 128000 },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 (Free)", contextLength: 128000 },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra (Free)", contextLength: 128000 },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (Free)", contextLength: 128000 },
  ],
  serviceKinds: ["llm"],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  // Free-tier safety: no passthrough — only the 7 listed free models route.
  passthroughModels: false,
};
