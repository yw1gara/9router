export default {
  id: "b-ai",
  alias: "bai",
  aliases: ["b.ai"],
  uiAlias: "bai",
  display: {
    name: "b.ai",
    icon: "hub",
    color: "#00D4AA",
    textIcon: "B",
    imageUrl: "/providers/b-ai.png",
    website: "https://b.ai",
    notice: {
      apiKeyUrl: "https://b.ai",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.b.ai/v1/chat/completions",
    validateUrl: "https://api.b.ai/v1/models",
    format: "openai",
  },
  models: [],
  serviceKinds: ["llm"],
  modelsFetcher: {
    url: "https://api.b.ai/v1/models",
    type: "openai",
  },
  passthroughModels: true,
};