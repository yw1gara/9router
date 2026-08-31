import { NextResponse } from "next/server";
import { createProviderConnection, getProviderConnections } from "@/models";

export const dynamic = "force-dynamic";

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || "").split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (base64.length % 4)) % 4;
    return JSON.parse(Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * POST /api/mail-recovery/apply-codex
 * Persist tokens obtained via the OFFICIAL browser device flow
 * (auth.openai.com/codex/device) as a Codex OAuth connection, reusing the
 * existing email+chatgptAccountId dedupe in createProviderConnection.
 *
 * Body: { tokens: { access_token, refresh_token, id_token, expires_in }, email? }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const tokens = body?.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token) {
      return NextResponse.json({ error: "tokens.access_token and tokens.refresh_token are required" }, { status: 400 });
    }

    const payload = decodeJwtPayload(tokens.id_token) || decodeJwtPayload(tokens.access_token) || {};
    const auth = payload["https://api.openai.com/auth"] || {};
    const profile = payload["https://api.openai.com/profile"] || {};
    const email = body?.email || profile.email || payload.email || payload.preferred_username || null;

    const providerSpecificData = { authMethod: "device_flow" };
    if (auth.chatgpt_account_id) providerSpecificData.chatgptAccountId = auth.chatgpt_account_id;
    if (auth.chatgpt_plan_type) providerSpecificData.chatgptPlanType = auth.chatgpt_plan_type;

    const expiresAt = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString();

    const connection = await createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token || undefined,
      expiresAt,
      email,
      name: email || "Codex (mail recovery)",
      providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      ok: true,
      connection: {
        id: connection.id,
        email: connection.email,
        name: connection.name,
        workspace: providerSpecificData.chatgptAccountId || null,
        expiresAt,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error?.message || error).slice(0, 200) }, { status: 500 });
  }
}
