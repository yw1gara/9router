import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnections, getApiKeys } from "@/lib/localDb";

const PERIOD_DAYS = { today: 1, "24h": 1, "7d": 7, "30d": 30, "60d": 60, all: null };
const DIMS = new Set(["provider", "model", "account", "apiKey", "endpoint"]);

function parseJson(s, fb) { try { return s ? JSON.parse(s) : fb; } catch { return fb; } }

// GET /api/usage/breakdown?period=7d&dim=model&provider=xxx
// Aggregates usageHistory by a dimension with error counts and cache-token
// efficiency — the expert drill-down behind the usage dashboard's Breakdown tab.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const dim = searchParams.get("dim") || "model";
    const providerFilter = searchParams.get("provider") || null;
    if (!DIMS.has(dim)) return NextResponse.json({ error: "Invalid dim" }, { status: 400 });

    const days = PERIOD_DAYS[period] ?? 7;
    let cutoff = null;
    if (period === "24h") cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    else if (days != null) {
      const c = new Date();
      c.setHours(0, 0, 0, 0);
      c.setDate(c.getDate() - days + 1);
      cutoff = c.toISOString();
    }

    const db = await getAdapter();

    // Name maps for readable keys.
    let connNames = {}, keyNames = {};
    try {
      for (const c of await getProviderConnections()) connNames[c.id] = c.displayName || c.name || c.email || c.id.slice(0, 8);
    } catch {}
    try {
      for (const k of await getApiKeys()) keyNames[k.key] = k.name || k.key.slice(0, 8);
    } catch {}

    const where = [];
    const params = [];
    if (cutoff) { where.push("timestamp >= ?"); params.push(cutoff); }
    if (providerFilter) { where.push("provider = ?"); params.push(providerFilter); }
    const rows = db.all(
      `SELECT provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens
       FROM usageHistory ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
      params
    );

    const acc = new Map();
    const totals = { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
    for (const r of rows) {
      const t = parseJson(r.tokens, {}) || {};
      const cached = Number(t.cached_tokens || t.cache_read_input_tokens || 0) || 0;
      const key =
        dim === "provider" ? (r.provider || "unknown")
        : dim === "model" ? `${r.provider || "?"}/${r.model || "?"}`
        : dim === "account" ? (r.connectionId ? (connNames[r.connectionId] || r.connectionId.slice(0, 8)) : "Public/no-auth")
        : dim === "apiKey" ? (r.apiKey ? `${keyNames[r.apiKey] || "key"} · ${r.apiKey.slice(0, 6)}…${r.apiKey.slice(-4)}` : "local-no-key")
        : (r.endpoint || "chat");
      const e = acc.get(key) || { key, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, provider: r.provider || "" };
      const isErr = r.status && r.status !== "ok" && !String(r.status).startsWith("200");
      e.requests += 1;
      if (isErr) e.errors += 1;
      e.promptTokens += r.promptTokens || 0;
      e.completionTokens += r.completionTokens || 0;
      e.cachedTokens += cached;
      e.cost += r.cost || 0;
      acc.set(key, e);

      totals.requests += 1;
      if (isErr) totals.errors += 1;
      totals.promptTokens += r.promptTokens || 0;
      totals.completionTokens += r.completionTokens || 0;
      totals.cachedTokens += cached;
      totals.cost += r.cost || 0;
    }

    const items = [...acc.values()].sort((a, b) => b.requests - a.requests);
    const providers = [...new Set(rows.map((r) => r.provider).filter(Boolean))].sort();

    return NextResponse.json({ dim, period, totals, items, providers });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
