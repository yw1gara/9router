import { NextResponse } from "next/server";
import { resetCircuitBreaker, getCircuitBreaker } from "open-sse/utils/circuitBreaker.js";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/circuit-breakers/[name]/reset
 * Reset a single provider's circuit breaker to CLOSED.
 * `name` is the breaker key: `<provider>` or `<provider>:<proxyHash>`.
 */
export async function POST(request, { params }) {
  try {
    const { name } = await params;
    if (!name) {
      return NextResponse.json({ error: "Missing breaker name" }, { status: 400 });
    }
    const existing = getCircuitBreaker(name);
    if (!existing) {
      return NextResponse.json({ error: `No circuit breaker registered for "${name}"` }, { status: 404 });
    }
    resetCircuitBreaker(name);
    return NextResponse.json({ ok: true, name });
  } catch (error) {
    console.error("Failed to reset circuit breaker:", error);
    return NextResponse.json(
      { error: "Failed to reset circuit breaker" },
      { status: 500 }
    );
  }
}
