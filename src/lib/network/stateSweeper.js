// Periodic in-memory state sweeper — prunes expired data so long-running
// servers never accumulate stale entries:
//   • pool fitness marks (proxyPoolFitness.pruneExpired)
//   • pool egress geo cache (poolGeo.pruneStaleGeo)
// Fail-open everywhere; never blocks startup or requests.

import { pruneExpired } from "open-sse/services/proxyPoolFitness.js";
import { pruneStaleGeo } from "open-sse/services/poolGeo.js";

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let started = false;
let handle = null;

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

async function sweep() {
  try {
    const fitness = await pruneExpired();
    const geo = pruneStaleGeo();
    if (fitness || geo) {
      console.log(`[StateSweeper] pruned ${fitness} fitness, ${geo} geo entries`);
    }
  } catch {
    // fail-open: next tick retries
  }
}

export function startStateSweeper({ intervalMs } = {}) {
  if (started) return false;
  if (isNonServerRuntime()) return false;
  started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : SWEEP_INTERVAL_MS;
  handle = setInterval(() => { sweep().catch(() => {}); }, period);
  if (handle.unref) handle.unref();
  return true;
}

export function stopStateSweeper() {
  if (handle) clearInterval(handle);
  handle = null;
  started = false;
}

export const __test__ = { sweep };
