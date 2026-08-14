import { NextResponse } from "next/server";
import { getAllCircuitBreakerStatuses, resetAllCircuitBreakers } from "open-sse/utils/circuitBreaker.js";
import { getAccountSemaphoreStats } from "open-sse/services/accountSemaphore.js";
import { getProvidersInCooldown } from "open-sse/services/accountFallback.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/providers/circuit-breakers
 * Returns all active circuit breaker + account semaphore statuses.
 */
export async function GET() {
  try {
    return NextResponse.json({
      statuses: getAllCircuitBreakerStatuses(),
      providersInCooldown: getProvidersInCooldown(),
      semaphores: getAccountSemaphoreStats(),
    });
  } catch (error) {
    console.error("Failed to fetch circuit breaker statuses:", error);
    return NextResponse.json(
      { error: "Failed to fetch circuit breaker statuses" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/providers/circuit-breakers
 * Reset all circuit breakers to CLOSED.
 */
export async function DELETE() {
  try {
    resetAllCircuitBreakers();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to reset circuit breakers:", error);
    return NextResponse.json(
      { error: "Failed to reset circuit breakers" },
      { status: 500 }
    );
  }
}
