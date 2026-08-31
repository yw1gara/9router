import { NextResponse } from "next/server";
import { clearAllPoolUnfit } from "open-sse/services/proxyPoolFitness.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
    const ok = await clearAllPoolUnfit(provider);
    return NextResponse.json({ ok });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
