import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo";
import { getProviderNodes } from "@/lib/db/repos/nodesRepo";

function maskApiKey(key) {
  const value = String(key || "");
  if (!value) return "";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}•••${value.slice(-4)}`;
}

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);
    const providerNames = {};
    try {
      for (const node of await getProviderNodes()) {
        if (node?.id && node.name) providerNames[node.id] = node.name;
      }
    } catch {}

    // Redact conversation payloads: the stored details include full request
    // bodies (user prompts, tool calls) and provider responses. Returning them
    // wholesale lets any dashboard-authenticated user (or, if requireLogin is
    // disabled, anyone) read every user's conversation history. Keep the
    // metadata (model, tokens, latency, status) but drop message content.
    const redactedDetails = [];
    const keyByConnectionId = new Map();
    for (const d of result.details || []) {
      const redacted = { ...d };
      for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
        if (redacted[key] !== undefined) {
          redacted[key] = { redacted: true };
        }
      }
      redacted.apiKeyMask = "";
      if (providerNames[redacted.provider]) {
        redacted.providerDisplayName = providerNames[redacted.provider];
      }
      if (redacted.connectionId) {
        if (!keyByConnectionId.has(redacted.connectionId)) {
          try {
            const connection = await getProviderConnectionById(redacted.connectionId);
            const rawKey =
              connection?.apiKey ||
              connection?.providerSpecificData?.apiKey ||
              connection?.providerSpecificData?.token ||
              "";
            keyByConnectionId.set(redacted.connectionId, {
              label: connection?.name || connection?.email || redacted.connectionId.slice(0, 8),
              masked: maskApiKey(rawKey),
            });
          } catch {
            keyByConnectionId.set(redacted.connectionId, { label: "", masked: "" });
          }
        }
        const hit = keyByConnectionId.get(redacted.connectionId);
        if (hit?.label) redacted.connectionLabel = hit.label;
        if (hit?.masked) redacted.apiKeyMask = hit.masked;
      }
      redactedDetails.push(redacted);
    }

    return NextResponse.json({ ...result, details: redactedDetails });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
