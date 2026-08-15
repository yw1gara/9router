import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { fetchOidcDiscovery, getPublicOrigin, probeOidcClientSecret } from "@/lib/auth/oidc";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard";

// A user-supplied issuer URL may point anywhere; block private/internal hosts
// and reject discovery endpoints that do not match the issuer origin (a
// malicious discovery doc could otherwise steer the client-secret probe to an
// attacker-controlled server).
function assertPublicEndpoint(url, field) {
  assertPublicUrl(url);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`${field} must use https`);
  return parsed.origin;
}

async function canAccessTestRoute() {
  const settings = await getSettings();
  if (settings.requireLogin === false) return true;

  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

export async function POST(request) {
  try {
    if (!(await canAccessTestRoute())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const issuerUrl = String(body.issuerUrl || settings.oidcIssuerUrl || "").trim();
    const clientId = String(body.clientId || settings.oidcClientId || "").trim();
    const scopes = String(body.scopes || settings.oidcScopes || "openid profile email").trim() || "openid profile email";
    const clientSecret = String(
      Object.prototype.hasOwnProperty.call(body, "clientSecret")
        ? body.clientSecret
        : settings.oidcClientSecret || ""
    ).trim();

    if (!issuerUrl) {
      return NextResponse.json({ error: "Issuer URL is required" }, { status: 400 });
    }
    if (!clientId) {
      return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
    }

    // SSRF guard: reject private/internal hosts and enforce HTTPS for the
    // user-supplied issuer URL.
    assertPublicUrl(issuerUrl);
    if (new URL(issuerUrl).protocol !== "https:") {
      return NextResponse.json({ error: "Issuer URL must use https" }, { status: 400 });
    }

    const discovery = await fetchOidcDiscovery(issuerUrl);
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;

    // Validate the token endpoint from the untrusted discovery document before
    // sending the client secret to it.
    assertPublicEndpoint(discovery.token_endpoint, "token_endpoint");
    const issuerOrigin = new URL(issuerUrl).origin;
    const tokenOrigin = new URL(discovery.token_endpoint).origin;
    if (tokenOrigin !== issuerOrigin) {
      return NextResponse.json({
        error: "token_endpoint must be same-origin as the issuer",
        issuerOrigin,
        tokenOrigin,
      }, { status: 400 });
    }
    const secretProbe = await probeOidcClientSecret({
      tokenEndpoint: discovery.token_endpoint,
      clientId,
      clientSecret,
      redirectUri,
    });

    if (secretProbe.tested && secretProbe.valid === false) {
      return NextResponse.json({
        ok: false,
        discoveryOk: true,
        clientSecretTested: true,
        clientSecretValid: false,
        issuerUrl,
        clientId,
        scopes,
        redirectUri,
        authorizationEndpoint: discovery.authorization_endpoint || "",
        tokenEndpoint: discovery.token_endpoint || "",
        jwksUri: discovery.jwks_uri || "",
        error: `Discovery loaded, but the client secret is not valid: ${secretProbe.message}`,
      });
    }

    return NextResponse.json({
      ok: true,
      discoveryOk: true,
      clientSecretTested: secretProbe.tested,
      clientSecretValid: secretProbe.valid,
      issuerUrl,
      clientId,
      scopes,
      redirectUri,
      authorizationEndpoint: discovery.authorization_endpoint || "",
      tokenEndpoint: discovery.token_endpoint || "",
      jwksUri: discovery.jwks_uri || "",
      message: secretProbe.message,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "OIDC test failed" }, { status: 500 });
  }
}
