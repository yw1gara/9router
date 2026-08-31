// Pool egress geo cache — globalThis-backed so all bundles share one map.
// Tracks each pool's observed egress IP + geo and an IP history: two or more
// distinct recent IPs mark a pool as flapping (unstable egress).

const GEO_STATE_KEY = "__9routerPoolGeo__";
const geo = (globalThis[GEO_STATE_KEY] ??= new Map()); // poolId -> { ip, country, region, latencyMs, ts, ipHistory[] }

const GEO_TTL_MS = 60 * 60 * 1000;
const IP_HISTORY_MAX = 5;

function normalizeIp(ip) {
  return typeof ip === "string" ? ip.trim() : "";
}

export function setPoolGeo(poolId, sample) {
  if (!poolId || !sample?.ip) return;
  const prev = geo.get(poolId) || { ipHistory: [] };
  const ip = normalizeIp(sample.ip);
  const ipHistory = prev.ipHistory || [];
  if (ip && ipHistory[ipHistory.length - 1] !== ip) {
    ipHistory.push(ip);
    if (ipHistory.length > IP_HISTORY_MAX) ipHistory.shift();
  }
  geo.set(poolId, {
    ip,
    country: sample.country || "",
    region: sample.region || "",
    latencyMs: Number.isFinite(sample.latencyMs) ? sample.latencyMs : null,
    ts: Date.now(),
    ipHistory,
  });
}

export function getPoolGeo(poolId) {
  const entry = geo.get(poolId);
  if (!entry) return null;
  if (Date.now() - entry.ts > GEO_TTL_MS) {
    geo.delete(poolId);
    return null;
  }
  return entry;
}

export function isPoolEgressFlapping(poolId) {
  const entry = geo.get(poolId);
  if (!entry?.ipHistory) return false;
  return new Set(entry.ipHistory).size >= 2;
}

export function pruneStaleGeo(now = Date.now()) {
  let removed = 0;
  for (const [poolId, entry] of geo) {
    if (now - entry.ts > GEO_TTL_MS) {
      geo.delete(poolId);
      removed += 1;
    }
  }
  return removed;
}

export function poolGeoSnapshot() {
  const out = {};
  for (const [poolId, entry] of geo) {
    out[poolId] = { ...entry, flapping: new Set(entry.ipHistory || []).size >= 2 };
  }
  return out;
}

// Endpoint chain with per-endpoint failure memory so a dead echo service is
// skipped for the rest of the process lifetime.
const ECHO_ENDPOINTS = [
  "https://api64.ipify.org?format=json",
  "https://api.ipify.org?format=json",
];
const endpointFailures = new Set();

/**
 * Probe a pool's egress IP through the same transport semantics the request
 * path uses: relay pools get x-relay-target/x-relay-path headers; standard
 * pools egress through an undici ProxyAgent. Returns { ok, geo, error }.
 */
export async function probePoolGeo(pool, { timeoutMs = 10000 } = {}) {
  const proxyUrl = typeof pool?.proxyUrl === "string" ? pool.proxyUrl.trim() : "";
  if (!proxyUrl) return { ok: false, geo: null, error: "no-url" };
  const isRelay = pool.type === "vercel" || pool.type === "cloudflare" || pool.type === "deno";

  for (const endpoint of ECHO_ENDPOINTS) {
    if (endpointFailures.has(endpoint)) continue;
    const started = Date.now();
    try {
      let res;
      if (isRelay) {
        const parsed = new URL(endpoint);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          res = await fetch(proxyUrl, {
            signal: controller.signal,
            headers: {
              "x-relay-target": `${parsed.protocol}//${parsed.host}`,
              "x-relay-path": `${parsed.pathname}${parsed.search}`,
            },
          });
        } finally {
          clearTimeout(timer);
        }
      } else {
        const { ProxyAgent } = await import("undici");
        const dispatcher = new ProxyAgent(proxyUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          res = await fetch(endpoint, { signal: controller.signal, dispatcher });
        } finally {
          clearTimeout(timer);
          try { dispatcher.close(); } catch { /* ignore */ }
        }
      }
      if (!res.ok) {
        endpointFailures.add(endpoint);
        continue;
      }
      const text = await res.text();
      let ip = "";
      let country = "";
      try {
        const parsedJson = JSON.parse(text);
        ip = normalizeIp(parsedJson.ip || parsedJson.query || "");
        country = parsedJson.country || "";
      } catch {
        ip = normalizeIp(text.split(/\s+/)[0]);
      }
      if (!ip) {
        endpointFailures.add(endpoint);
        continue;
      }
      return {
        ok: true,
        geo: { ip, country, region: "", latencyMs: Date.now() - started },
        error: null,
      };
    } catch (e) {
      const msg = String(e?.message || "");
      if (/abort|timeout/i.test(msg)) return { ok: false, geo: null, error: "timeout" };
      endpointFailures.add(endpoint);
    }
  }
  return { ok: false, geo: null, error: "network" };
}

export function __resetPoolGeoForTest() {
  geo.clear();
  endpointFailures.clear();
}
