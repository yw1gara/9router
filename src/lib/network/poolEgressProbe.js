// Background pool egress probe — fills the poolGeo cache so the Proxy Pools
// dashboard can show each pool's egress IP + country and flag flapping relays.
// Fail-open everywhere; never blocks startup or requests.
//
// Rate safety: failing pools get a negative backoff instead of being re-probed
// every pass; per-pass output is one aggregated summary line.

import { getProxyPools } from "@/models";
import { probePoolGeo, setPoolGeo, getPoolGeo } from "open-sse/services/poolGeo.js";

const PROBE_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 15 * 1000;
const CONCURRENCY = 3;
const GEO_REPROBE_MS = 30 * 60 * 1000;

// Backoff windows per failure family: server/rate problems likely persist,
// network blips recover sooner.
const BACKOFF = {
  "rate-limit": 2 * 60 * 60 * 1000,
  server: 2 * 60 * 60 * 1000,
  network: 30 * 60 * 1000,
  timeout: 30 * 60 * 1000,
  "no-ip": 30 * 60 * 1000,
};

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let probing = false;
const probeBackoff = new Map(); // poolId -> retryAfter (ms epoch)

function isTruthyEnv(v) {
  if (v == null || v === "") return false;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

async function probeAll() {
  if (probing) return;
  probing = true;
  try {
    const pools = await getProxyPools({ isActive: true });
    const now = Date.now();
    const active = (pools || []).filter((p) => !!p?.proxyUrl);
    const targets = active.filter((p) => {
      const until = probeBackoff.get(p.id);
      if (until && until > now) return false;
      const g = getPoolGeo(p.id);
      return !g || now - g.ts >= GEO_REPROBE_MS;
    });
    if (targets.length === 0) return;

    const failTally = {};
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(targets.length, 1)) }, async () => {
      while (next < targets.length) {
        const pool = targets[next++];
        const res = await probePoolGeo(pool);
        if (res.ok) {
          setPoolGeo(pool.id, res.geo);
          if (probeBackoff.has(pool.id)) probeBackoff.delete(pool.id);
        } else {
          failTally[res.error] = (failTally[res.error] || 0) + 1;
          probeBackoff.set(pool.id, now + (BACKOFF[res.error] || BACKOFF.network));
        }
      }
    });
    await Promise.allSettled(workers);

    const filled = active.filter((p) => getPoolGeo(p.id)).length;
    const failSummary = Object.entries(failTally).map(([k, n]) => `${k}×${n}`).join(", ") || "none";
    console.log(`[PoolEgressProbe] geo ${filled}/${active.length} · fail: ${failSummary}`);
  } catch (e) {
    console.log(`[PoolEgressProbe] pass failed: ${e?.message || e}`);
  } finally {
    probing = false;
  }
}

export function startPoolEgressProbe({ intervalMs } = {}) {
  if (started) return false;
  if (isNonServerRuntime()) return false;
  if (isTruthyEnv(process.env.POOL_EGRESS_PROBE_DISABLED)) return false;
  started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : PROBE_INTERVAL_MS;
  console.log("[PoolEgressProbe] Scheduler started", { intervalMs: period, initialDelayMs: INITIAL_DELAY_MS });
  initialTimeoutHandle = setTimeout(() => { probeAll().catch(() => {}); }, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();
  intervalHandle = setInterval(() => { probeAll().catch(() => {}); }, period);
  if (intervalHandle.unref) intervalHandle.unref();
  return true;
}

export function stopPoolEgressProbe() {
  if (initialTimeoutHandle) clearTimeout(initialTimeoutHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  initialTimeoutHandle = null;
  intervalHandle = null;
  started = false;
}

export const __test__ = { probeAll };
