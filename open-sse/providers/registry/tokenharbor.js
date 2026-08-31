// Token Harbor — OpenAI-compatible model router.
// Docs/site: https://tokenharbor.ai
// Auth: Bearer thk_live_* keys from https://tokenharbor.ai/dashboard (API Key page).
// Free tier: ":free" suffixed routes are enabled per account via the
// "Enable free models?" onboarding consent; the automations harvester
// (tokenharbor_farm.py) accepts that consent for every harvested account.
export default {
  id: "tokenharbor",
  hasFree: true,
  alias: "tokenharbor",
  aliases: ["th"],
  uiAlias: "tokenharbor",
  display: {
    name: "Token Harbor",
    icon: "anchor",
    color: "#2DD4BF",
    textIcon: "TH",
    website: "https://tokenharbor.ai",
    notice: {
      text: "OpenAI-compatible router. Free tier: ':free' model routes (enable via the dashboard 'Enable free models?' consent). Keys are issued per account at the API Key page; harvested automatically by the Token Harbor automation.",
      apiKeyUrl: "https://tokenharbor.ai/dashboard",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://tokenharbor.ai/v1/chat/completions",
    validateUrl: "https://tokenharbor.ai/v1/models",
    thinkingFormat: "openai",
  },
  // No static seed — /v1/models requires a key, so the live catalog is
  // fetched per connection via modelsFetcher; other ids pass through.
  models: [],
  serviceKinds: ["llm"],
  modelsFetcher: { url: "https://tokenharbor.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
