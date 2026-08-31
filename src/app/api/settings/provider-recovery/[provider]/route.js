import { NextResponse } from "next/server";
import { getSettings, updateProviderRecoverySettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SUPPORTED_PROVIDERS = new Set(["orcarouter", "opencode-zen", "tokenrouter"]);
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  intervalMinutes: 15,
  applyProxy: false,
});
const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

function response(config, provider) {
  return NextResponse.json({ provider, ...DEFAULT_CONFIG, ...(config || {}) }, {
    headers: RESPONSE_HEADERS,
  });
}

async function getProvider(context) {
  const { provider } = await context.params;
  return provider;
}

function validateConfig(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (
    keys.length !== 3 ||
    !keys.every((key) => ["enabled", "intervalMinutes", "applyProxy"].includes(key))
  ) return null;
  if (typeof body.enabled !== "boolean" || typeof body.applyProxy !== "boolean") return null;
  if (
    !Number.isInteger(body.intervalMinutes) ||
    body.intervalMinutes < 5 ||
    body.intervalMinutes > 1440
  ) return null;
  return {
    enabled: body.enabled,
    intervalMinutes: body.intervalMinutes,
    applyProxy: body.applyProxy,
  };
}

export async function GET(_request, context) {
  const provider = await getProvider(context);
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 404 });
  }

  try {
    const settings = await getSettings();
    return response(settings.providerRecovery?.[provider], provider);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request, context) {
  const provider = await getProvider(context);
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 404 });
  }

  try {
    const config = validateConfig(await request.json());
    if (!config) {
      return NextResponse.json({ error: "Invalid provider recovery config" }, { status: 400 });
    }

    const settings = await updateProviderRecoverySettings(provider, config);
    import("@/sse/services/providerRecoveryMonitor.js")
      .then(({ configureProviderRecoveryMonitor }) => {
        configureProviderRecoveryMonitor?.(settings);
      })
      .catch((error) => console.warn("[ProviderRecovery] settings update failed:", error.message));

    return response(settings.providerRecovery?.[provider], provider);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
