import { NextResponse } from "next/server";
import { pingModelByKind } from "../test/ping";
import { getProviderConnections } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";

// POST /api/models/test-all — test one model against EVERY active account of
// its provider (pinned per-account via x-connection-id), so the dashboard can
// show which accounts can serve the model. Batches of 4 to stay gentle.
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model || typeof model !== "string" || !model.includes("/")) {
      return NextResponse.json({ error: "Model required (provider/model)" }, { status: 400 });
    }
    const providerId = resolveProviderId(model.slice(0, model.indexOf("/")));

    const connections = await getProviderConnections({ provider: providerId, isActive: true });

    // noAuth providers have a single virtual Public connection — one test.
    if (!connections.length) {
      const r = await pingModelByKind(model, kind || "llm");
      return NextResponse.json({
        total: 1,
        okCount: r.ok ? 1 : 0,
        results: [{ connectionId: "noauth", name: "Public", ...r }],
      });
    }

    const results = [];
    const BATCH = 4;
    for (let i = 0; i < connections.length; i += BATCH) {
      const slice = connections.slice(i, i + BATCH);
      const batch = await Promise.all(slice.map(async (c) => {
        try {
          const r = await pingModelByKind(model, kind || "llm", undefined, c.id);
          return { connectionId: c.id, name: c.displayName || c.name || c.email || c.id.slice(0, 8), ...r };
        } catch (e) {
          return { connectionId: c.id, name: c.displayName || c.name || c.email || c.id.slice(0, 8), ok: false, latencyMs: null, error: e?.message || "test failed" };
        }
      }));
      results.push(...batch);
    }

    return NextResponse.json({
      total: results.length,
      okCount: results.filter((r) => r.ok).length,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
