// ZenMux — multi-protocol AI gateway (OpenAI / Anthropic / Gemini protocols).
// Docs: https://zenmux.ai/docs/guide/quickstart.html
// Auth: Bearer keys from https://zenmux.ai (PAYG or Builder plan).
// Free tier: $0-priced models in the live catalog (look for "(Free)" display
// names / zero pricings in /models), e.g. GLM 5.3 (Free), GLM 4.7 Flash (Free).
// Cross-protocol: 9router uses the OpenAI surface at https://zenmux.ai/api/v1.
export default {
  id: "zenmux",
  alias: "zenmux",
  aliases: ["zm"],
  uiAlias: "zenmux",
  display: {
    name: "ZenMux",
    icon: "hub",
    color: "#8B5CF6",
    textIcon: "ZM",
    website: "https://zenmux.ai",
    notice: {
      text: "Multi-protocol gateway, 160+ models (OpenAI, Claude, Gemini, Grok, Qwen, GLM, dsb). Free tier: $0 \"(Free)\" models (GLM 5.3 Free, GLM 4.7 Flash Free, Dots3-Note). PAYG balance or Builder plan key required.",
      apiKeyUrl: "https://zenmux.ai",
    },
  },
  category: "freeTier",
  hasFree: true,
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://zenmux.ai/api/v1/chat/completions",
    validateUrl: "https://zenmux.ai/api/v1/models",
    thinkingFormat: "openai",
  },
  // Seed snapshot from live /models (160 entries, 7 free). Latest catalogue is
  // fetched via modelsFetcher; other ids still accepted via passthroughModels.
  models: [
    { id: "z-ai/glm-5.3-free", name: "Z.AI: GLM 5.3 (Free)", contextLength: 1000000 },
    { id: "z-ai/glm-4.7-flash-free", name: "Z.AI: GLM 4.7 Flash (Free)", contextLength: 200000 },
    { id: "z-ai/glm-4.6v-flash-free", name: "Z.AI: GLM 4.6V Flash (Free)", contextLength: 200000 },
    { id: "dots-studio/dots3-note-prev", name: "Dots Studio: Dots3-Note Preview (Free)", contextLength: 393100 },
    { id: "sapiens-ai/agnes-2.5-flash", name: "Sapiens AI: Agnes-2.5-Flash", contextLength: 524288 },
    { id: "inclusionai/ling-3.0-tiny", name: "inclusionAI: Ling-3.0-tiny", contextLength: 262144 },
    { id: "openai/gpt-5.4", name: "OpenAI: GPT-5.4", contextLength: 1050000 },
    { id: "anthropic/claude-opus-4.8", name: "Anthropic: Claude Opus 4.8", contextLength: 1000000 },
    { id: "google/gemini-3.7-flash", name: "Google: Gemini 3.7 Flash", contextLength: 1048576 },
    { id: "x-ai/grok-4.5", name: "xAI: Grok 4.5", contextLength: 500000 },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash 0731", contextLength: 1000000 },
    { id: "qwen/qwen3.8-max", name: "Qwen: Qwen3.8-Max", contextLength: 1000000 },
    { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", contextLength: 1048576 },
    { id: "minimax/minimax-m2.7", name: "MiniMax: MiniMax M2.7", contextLength: 204800 },
  ],
  serviceKinds: ["llm"],
  modelsFetcher: { url: "https://zenmux.ai/api/v1/models", type: "openai" },
  passthroughModels: true,
};
