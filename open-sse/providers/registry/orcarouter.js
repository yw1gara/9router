// OrcaRouter — OpenAI-compatible multi-provider gateway (zero markup).
// Docs: https://docs.orcarouter.ai/introduction
// Auth: Bearer sk-orca-... keys from https://www.orcarouter.ai/console
// Free tier: "-free" suffixed ids shadow their paid model at $0, plus the
// orcarouter/free router id that scores request difficulty and picks a free
// model (never escapes to paid). Free limits are per-workspace (all keys
// share one bucket), day resets 00:00 UTC; 429 free_rate_limited with
// Retry-After = wait exactly + retry once, without Retry-After =
// per-request prompt cap (never retried unchanged).
export default {
  id: "orcarouter",
  priority: 10,
  hasFree: true,
  alias: "orca",
  uiAlias: "orca",
  display: {
    name: "OrcaRouter",
    icon: "waves",
    color: "#22D3EE",
    textIcon: "OA",
    website: "https://www.orcarouter.ai",
    notice: {
      text: "Free tier: orcarouter/free router + all '-free' models at $0. Limits are per-workspace (all keys share one bucket), day resets 00:00 UTC.",
      apiKeyUrl: "https://www.orcarouter.ai/console",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.orcarouter.ai/v1/chat/completions",
    validateUrl: "https://api.orcarouter.ai/v1/models",
    thinkingFormat: "openai",
  },
  // Static seed only — the live catalog at /v1/models is the source of truth
  // (docs: free capacity changes; look for the "-free" suffix with $0 price).
  models: [
    { id: "orcarouter/free", name: "OrcaRouter Free (auto-picks a free model)", contextLength: 128000 },
    { id: "deepseek/deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)", contextLength: 128000 },
    { id: "deepseek/deepseek-v4-pro-free", name: "DeepSeek V4 Pro (Free)", contextLength: 128000 },
    { id: "qwen/qwen3.8-27b-free", name: "Qwen 3.8 27B (Free)", contextLength: 128000 },
  ],
  serviceKinds: ["llm"],
  modelsFetcher: { url: "https://api.orcarouter.ai/v1/models", type: "orcarouter-free" },
  passthroughModels: true,
};
