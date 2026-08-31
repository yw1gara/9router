import { NextResponse } from "next/server";
import { getProxyPoolById, deleteProxyPoolFitnessByPool } from "@/models";
import { clearPoolUnfit, loadPoolFitness } from "open-sse/services/proxyPoolFitness.js";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }
    const body = await request.json().catch(() => ({}));
    const scope = typeof body?.scope === "string" && body.scope.trim() ? body.scope.trim() : null;
    if (scope) {
      const ok = await clearPoolUnfit(id, scope);
      return NextResponse.json({ ok });
    }
    // No scope — clear every mark for this pool, then refresh the cache
    // (loadPoolFitness with zero rows drops the pool's cache entry).
    await deleteProxyPoolFitnessByPool(id);
    await loadPoolFitness(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
