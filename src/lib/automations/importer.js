import { getProviderNodeById } from "@/lib/db/repos/nodesRepo";
import { createProviderConnection } from "@/lib/db/repos/connectionsRepo";
import { getAutomationResultByEmail } from "@/lib/db/repos/automationsRepo";

// Map automation kind → 9Router free-tier provider id.
const KIND_PROVIDER = {
  "orcarouter": { provider: "orcarouter", label: "OrcaRouter" },
  "opencode-zen": { provider: "opencode-zen", label: "OpenCode Zen" },
  "tokenrouter": { provider: "tokenrouter", label: "TokenRouter" },
  "tokenharbor": { provider: "tokenharbor", label: "Token Harbor" },
};

/**
 * Import a harvested key into 9Router as a provider connection.
 * Deduplicates by email: if a result already exists for this run+email,
 * the existing connectionId is reused.
 */
export async function importKey(runId, kind, email, apiKey) {
  const cfg = KIND_PROVIDER[kind];
  if (!cfg) return { error: "unknown kind" };

  // Dedup: check for an existing result for this run + email.
  const existing = await getAutomationResultByEmail(runId, email);
  if (existing?.connectionId) {
    return { connectionId: existing.connectionId, status: "already-imported" };
  }

  // Built-in free-tier providers resolve their transport (baseUrl etc.) from
  // the open-sse registry at runtime — the connection row only needs the key.
  let node = await getProviderNodeById(cfg.provider);

  const name = `Key ${email.split("@")[0]}`;
  const connection = await createProviderConnection({
    provider: cfg.provider,
    authType: "apikey",
    name,
    email,
    apiKey,
    priority: 1,
    isActive: true,
    testStatus: "unknown",
    providerSpecificData: {}, // runtime fills from registry
  });

  return { connectionId: connection.id, status: "imported" };
}
