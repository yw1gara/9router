// FreeBuff — free AI coding models behind the Codebuff/FreeBuff CLI, accessed
// NATIVELY (no freebuff-proxy needed) via the codebuff.com wire protocol
// implemented in open-sse/executors/freebuff.js.
// Auth: Bearer tokens (cb_...) from a FreeBuff account — log in once with the
// official CLI or https://www.codebuff.com and paste the token as an API key.
// Free tier: daily per-account quota, resets Pacific midnight; 429 = quota,
// 403 banned = terminal. Full tier default deepseek-v4-flash; limited-tier
// accounts are coerced upstream to mimo-v2.5.
// NOTE: no uTLS stealth — ban risk is higher than freebuff-proxy (ToS).
export default {
  id: "freebuff",
  alias: "freebuff",
  aliases: ["fb"],
  uiAlias: "freebuff",
  display: {
    name: "FreeBuff",
    icon: "bolt",
    color: "#F59E0B",
    textIcon: "FB",
    website: "https://www.codebuff.com",
    notice: {
      text: "Native codebuff.com protocol (no freebuff-proxy required). Paste your cb_... token as API key. Free daily quota per account (resets 07:00 UTC); limited-tier accounts get mimo-v2.5. Configure in the FreeBuff sidebar page. ToS/ban risk applies.",
      apiKeyUrl: "https://www.codebuff.com",
    },
  },
  category: "freeTier",
  hasFree: true,
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    thinkingFormat: "openai",
  },
  // Free-mode catalog (upstream FREE_MODE_AGENT_MODELS). Limited-tier
  // accounts (non-Tier-1 IP) are coerced to mimo/mimo-v2.5 upstream.
  models: [
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (full tier)", contextLength: 128000 },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (full tier)", contextLength: 128000 },
    { id: "mimo/mimo-v2.5", name: "MiMo v2.5 (limited tier default)", contextLength: 128000 },
    { id: "minimax/minimax-m3", name: "MiniMax M3", contextLength: 128000 },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", contextLength: 128000 },
    { id: "z-ai/glm-5.2", name: "GLM 5.2", contextLength: 128000 },
    { id: "crof/kimi-k3-eco", name: "Kimi K3 Eco", contextLength: 128000 },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5", contextLength: 128000 },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2", contextLength: 128000 },
    { id: "deepseek/deepseek-v4-flash-max", name: "DeepSeek V4 Flash Max (extended ctx)", contextLength: 1000000 },
    { id: "deepseek/deepseek-v4-pro-max", name: "DeepSeek V4 Pro Max (extended ctx)", contextLength: 1000000 },
    { id: "openai/gpt-5.6-luna-max", name: "GPT-5.6 Luna Max (extended ctx)", contextLength: 1000000 },
  ],
  serviceKinds: ["llm"],
  // Passthrough disabled: free mode 403s on any model outside the
  // FREE_MODE_AGENT_MODELS catalog (free_mode_invalid_agent_model).
  passthroughModels: false,
};
