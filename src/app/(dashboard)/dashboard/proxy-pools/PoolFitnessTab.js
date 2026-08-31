"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Toggle } from "@/shared/components";

const FILTERS = ["all", "unfit", "healthy", "flapping", "no-geo"];
const AUTO_REFRESH_MS = 30_000;

function formatRemaining(ms) {
  if (ms <= 0) return "expired";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function formatCheckedAt(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleTimeString();
}

function geoBadge(geo) {
  if (!geo) return { variant: "default", label: "no egress data" };
  if (geo.flapping) return { variant: "error", label: "egress flapping" };
  if (geo.error) return { variant: "warning", label: geo.error };
  return { variant: "success", label: geo.ip || "unknown ip" };
}

/**
 * PoolFitnessTab — durable fitness (scoped cooldowns) + egress geo health.
 * - Summary cards over ALL pools (fit / unfit scopes / flapping / geo known)
 * - Filter chips: all / unfit / healthy / flapping / no-geo + search
 * - Live 1s countdown per cooldown mark (ticker armed only when needed)
 * - Auto-refresh every 30s (toggle), manual refresh, per-scope and per-pool
 *   clear, plus clear-all
 */
export default function PoolFitnessTab({ pools, notify }) {
  const [data, setData] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [tick, setTick] = useState(0);
  const [clearingKey, setClearingKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/proxy-pools/fitness", { cache: "no-store" });
      if (res.ok) {
        setData(await res.json());
        setFetchedAt(Date.now());
        setTick(0);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Initial load mirrors load() (incl. loading state) but with a cancel
    // guard so an unmounted tab never calls setState.
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/proxy-pools/fitness", { cache: "no-store" });
        if (!cancelled && res.ok) {
          setData(await res.json());
          setFetchedAt(Date.now());
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-refresh (armed only when enabled)
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => { load(); }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const nowMs = fetchedAt + tick * 1000;

  const rows = useMemo(() => (pools || []).map((pool) => {
    const geo = data?.geo?.[pool.id] || null;
    const marks = Object.entries(data?.fitness?.[pool.id] || {})
      .map(([scope, m]) => ({ scope, ...m }))
      .sort((a, b) => (b.until || 0) - (a.until || 0));
    const activeMarks = marks.filter((m) => (m.until || 0) > nowMs);
    return { pool, geo, marks, activeMarks, unfit: activeMarks.length > 0 };
  }), [pools, data, nowMs]);

  const hasActiveCooldowns = rows.some((r) => r.activeMarks.length > 0);

  // Live countdown ticker — armed only while at least one cooldown is running
  useEffect(() => {
    if (!hasActiveCooldowns) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [hasActiveCooldowns]);

  const stats = useMemo(() => ({
    total: rows.length,
    fit: rows.filter((r) => !r.unfit).length,
    unfitScopes: rows.reduce((sum, r) => sum + r.activeMarks.length, 0),
    flapping: rows.filter((r) => r.geo?.flapping).length,
    geoKnown: rows.filter((r) => !!r.geo?.ip).length,
  }), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(({ pool, geo, unfit }) => {
      if (filter === "unfit" && !unfit) return false;
      if (filter === "healthy" && unfit) return false;
      if (filter === "flapping" && !geo?.flapping) return false;
      if (filter === "no-geo" && geo?.ip) return false;
      if (!q) return true;
      return (pool.name || "").toLowerCase().includes(q)
        || (pool.proxyUrl || "").toLowerCase().includes(q);
    });
  }, [rows, filter, search]);

  const clearAll = async () => {
    setClearingKey("__all__");
    try {
      await fetch("/api/proxy-pools/fitness/clear-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      notify?.success?.("All pool cooldowns cleared");
      await load();
    } catch {
      notify?.error?.("Failed to clear cooldowns");
    }
    setClearingKey("");
  };

  const clearPool = async (poolId) => {
    setClearingKey(poolId);
    try {
      await fetch(`/api/proxy-pools/${poolId}/fitness/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await load();
    } catch { /* ignore */ }
    setClearingKey("");
  };

  const clearScope = async (poolId, scope) => {
    setClearingKey(`${poolId}:${scope}`);
    try {
      await fetch(`/api/proxy-pools/${poolId}/fitness/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      await load();
    } catch { /* ignore */ }
    setClearingKey("");
  };

  if (!data) {
    return (
      <div className="rounded-xl border border-black/10 p-4 text-sm text-text-muted dark:border-white/10">
        {loading ? "Loading pool health…" : "Pool health unavailable."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Pools</div>
          <div className="text-lg font-semibold">{stats.total}</div>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Fit now</div>
          <div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">{stats.fit}</div>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Unfit scopes</div>
          <div className="text-lg font-semibold text-red-600 dark:text-red-400">{stats.unfitScopes}</div>
        </div>
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Egress flapping</div>
          <div className="text-lg font-semibold text-orange-500">{stats.flapping}</div>
        </div>
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Geo known</div>
          <div className="text-lg font-semibold">{stats.geoKnown}/{stats.total}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">search</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pool name or URL…"
              className="w-full rounded-lg border border-black/10 bg-white py-1.5 pl-9 pr-3 text-sm text-text-main outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 dark:border-white/10 dark:bg-white/5"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Auto-refresh 30s
            <Toggle size="sm" checked={autoRefresh} onChange={() => setAutoRefresh((v) => !v)} />
          </label>
          <Button size="sm" variant="secondary" icon={loading ? "progress_activity" : "refresh"} onClick={load} disabled={loading}>
            Refresh
          </Button>
          <Button size="sm" variant="secondary" icon="mop" onClick={clearAll} disabled={clearingKey === "__all__" || stats.unfitScopes === 0}>
            Clear all cooldowns
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                filter === f
                  ? "bg-primary text-white"
                  : "bg-black/5 text-text-muted hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
              }`}
            >
              {f}
            </button>
          ))}
          <span className="ml-auto text-xs text-text-muted">
            {filtered.length}/{rows.length} shown · updated {fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : "—"}
          </span>
        </div>
      </div>

      {/* Pool cards */}
      {rows.length === 0 ? (
        <div className="text-center py-10 text-sm text-text-muted">No pools configured.</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-text-muted">No pools match the current filter.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map(({ pool, geo, marks, activeMarks, unfit }) => {
            const gb = geoBadge(geo);
            return (
              <div
                key={pool.id}
                className={`flex flex-col gap-2 rounded-xl border p-3 ${
                  unfit
                    ? "border-red-500/30 bg-red-500/[0.03]"
                    : geo?.flapping
                      ? "border-orange-500/30 bg-orange-500/[0.03]"
                      : "border-black/10 dark:border-white/10"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-text-muted">
                    {unfit ? "gpp_bad" : "verified_user"}
                  </span>
                  <span className="text-sm font-medium">{pool.name || pool.id.slice(0, 8)}</span>
                  <Badge variant={unfit ? "error" : "success"} size="sm" dot>
                    {unfit ? "unfit" : "fit"}
                  </Badge>
                  <Badge variant={gb.variant} size="sm">{gb.label}</Badge>
                  {geo?.country ? <span className="text-xs text-text-muted">{geo.country}</span> : null}
                  {geo?.latencyMs != null ? <span className="text-xs text-text-muted">{geo.latencyMs}ms</span> : null}
                  {geo?.ipHistory?.length > 1 ? (
                    <span
                      className="text-xs text-text-muted cursor-help"
                      title={`IP history: ${geo.ipHistory.join(" → ")}`}
                    >
                      {geo.ipHistory.length} IPs seen
                    </span>
                  ) : null}
                  <span className="text-[11px] text-text-muted">geo checked {formatCheckedAt(geo?.ts)}</span>
                  {marks.length > 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => clearPool(pool.id)}
                      disabled={clearingKey === pool.id}
                    >
                      Clear pool
                    </Button>
                  )}
                </div>
                {marks.length === 0 ? (
                  <div className="text-xs text-text-muted">No cooldown marks — pool is eligible for all scopes.</div>
                ) : activeMarks.length === 0 ? (
                  <div className="text-xs text-text-muted">All cooldown marks expired (will be pruned automatically).</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {marks.map((m) => {
                      const remaining = (m.until || 0) - nowMs;
                      return (
                        <div
                          key={m.scope}
                          className="flex flex-wrap items-center gap-2 rounded-lg bg-black/[0.03] px-2 py-1 text-xs dark:bg-white/[0.03]"
                        >
                          <span className="font-mono">{m.scope}</span>
                          {remaining > 0 ? (
                            <Badge variant="error" size="sm">⏱ {formatRemaining(remaining)}</Badge>
                          ) : (
                            <Badge variant="default" size="sm">expired</Badge>
                          )}
                          {m.failureCount > 1 ? <Badge variant="warning" size="sm">×{m.failureCount}</Badge> : null}
                          <span className="min-w-0 flex-1 truncate text-text-muted">{m.reason || "unfit"}</span>
                          <button
                            onClick={() => clearScope(pool.id, m.scope)}
                            disabled={clearingKey === `${pool.id}:${m.scope}`}
                            className="rounded p-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                            title="Clear this scope"
                          >
                            <span className="material-symbols-outlined text-[16px]">close</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
