"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Toggle } from "@/shared/components";

function getStatusVariant(status) {
  if (status === "active") return "success";
  if (status === "error") return "error";
  return "default";
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

/** protocol://user:pass@host:port → protocol://***@host:port (never leak creds in UI) */
function maskProxyUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/\/[^@/]+@/, "//***@");
  }
}

function poolProtocol(pool) {
  if (pool.type && pool.type !== "http") return pool.type; // vercel/cloudflare/deno relay
  try {
    const proto = new URL(pool.proxyUrl).protocol.replace(":", "");
    return proto || "http";
  } catch {
    return "http";
  }
}

const STATUS_FILTERS = ["all", "active", "inactive", "error"];
const TYPE_FILTERS = ["all", "http", "https", "socks", "relay"];

function matchesTypeFilter(pool, filter) {
  if (filter === "all") return true;
  const proto = poolProtocol(pool);
  if (filter === "relay") return ["vercel", "cloudflare", "deno"].includes(proto);
  if (filter === "socks") return proto.startsWith("socks");
  return proto === filter;
}

function matchesStatusFilter(pool, filter) {
  if (filter === "all") return true;
  if (filter === "error") return pool.testStatus === "error";
  if (filter === "active") return pool.isActive === true;
  return pool.isActive !== true;
}

/**
 * PoolsTab — proxy pool management list.
 * Search + status/type filters + summary stats over the full pool set;
 * selection, bulk actions and per-pool actions are owned by the parent page.
 */
export default function PoolsTab({
  pools,
  selectedIds,
  allSelected,
  onToggleSelect,
  onToggleSelectAll,
  onClearSelection,
  onEdit,
  onDelete,
  onTest,
  testingId,
  onToggleActive,
  healthChecking,
  healthProgress,
  bulkBusy,
  onHealthCheck,
  onBulkSetActive,
  onBulkDelete,
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  const stats = useMemo(() => ({
    total: pools.length,
    active: pools.filter((p) => p.isActive === true).length,
    error: pools.filter((p) => p.testStatus === "error").length,
    bound: pools.reduce((sum, p) => sum + (p.boundConnectionCount || 0), 0),
  }), [pools]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pools.filter((pool) => {
      if (!matchesStatusFilter(pool, statusFilter)) return false;
      if (!matchesTypeFilter(pool, typeFilter)) return false;
      if (!q) return true;
      return (
        (pool.name || "").toLowerCase().includes(q)
        || (pool.proxyUrl || "").toLowerCase().includes(q)
      );
    });
  }, [pools, search, statusFilter, typeFilter]);

  const filteredSelected = selectedIds.filter((id) => filtered.some((p) => p.id === id));

  return (
    <div className="flex flex-col gap-3">
      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Total pools</div>
          <div className="text-lg font-semibold">{stats.total}</div>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Active</div>
          <div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">{stats.active}</div>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Test errors</div>
          <div className="text-lg font-semibold text-red-600 dark:text-red-400">{stats.error}</div>
        </div>
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">Bound connections</div>
          <div className="text-lg font-semibold">{stats.bound}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">search</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or URL…"
              className="w-full rounded-lg border border-black/10 bg-white py-1.5 pl-9 pr-3 text-sm text-text-main outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 dark:border-white/10 dark:bg-white/5"
            />
          </div>
          {search && (
            <button onClick={() => setSearch("")} className="text-xs text-text-muted hover:text-primary">
              Clear search
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`rounded-full px-2.5 py-1 text-xs capitalize transition-colors ${
                statusFilter === f
                  ? "bg-primary text-white"
                  : "bg-black/5 text-text-muted hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
              }`}
            >
              {f}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" />
          {TYPE_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`rounded-full px-2.5 py-1 text-xs capitalize transition-colors ${
                typeFilter === f
                  ? "bg-primary text-white"
                  : "bg-black/5 text-text-muted hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
              }`}
            >
              {f}
            </button>
          ))}
          <span className="ml-auto text-xs text-text-muted">
            {filtered.length}/{pools.length} shown
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleSelectAll}
              className="size-4 rounded border-black/20 dark:border-white/20"
            />
            {allSelected ? "Unselect all" : "Select all"}
          </label>
          <Badge variant="default">Total: {pools.length}</Badge>
          <Badge variant="success">Active: {stats.active}</Badge>
        </div>
      </div>

      {/* Bulk action bar */}
      {(selectedIds.length > 0 || healthChecking) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="material-symbols-outlined text-[18px] text-primary">checklist</span>
          <span className="text-xs font-medium text-primary">
            {selectedIds.length > 0 ? `${selectedIds.length} selected` : "All pools"}
            {filteredSelected.length > 0 && filteredSelected.length !== selectedIds.length
              ? ` (${filteredSelected.length} visible)`
              : ""}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon={healthChecking ? "progress_activity" : "health_and_safety"}
              onClick={onHealthCheck}
              disabled={healthChecking || bulkBusy || pools.length === 0}
            >
              {healthChecking ? `Checking ${healthProgress.current}/${healthProgress.total}` : "Health Check"}
            </Button>
            {selectedIds.length > 0 && (
              <>
                <Button size="sm" variant="secondary" icon="toggle_on" onClick={() => onBulkSetActive(true)} disabled={bulkBusy || healthChecking}>
                  Activate
                </Button>
                <Button size="sm" variant="secondary" icon="toggle_off" onClick={() => onBulkSetActive(false)} disabled={bulkBusy || healthChecking}>
                  Deactivate
                </Button>
                <Button size="sm" variant="secondary" icon="delete" onClick={onBulkDelete} disabled={bulkBusy || healthChecking}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={onClearSelection} disabled={bulkBusy || healthChecking}>
                  Clear
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Pool list */}
      {pools.length === 0 ? (
        <div className="text-center py-10">
          <p className="text-text-main font-medium mb-1">No proxy pool entries yet</p>
          <p className="text-sm text-text-muted mb-4">
            Create a proxy pool entry, then assign it to connections.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-text-muted">
          No pools match the current search/filters.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
          {filtered.map((pool) => {
            const proto = poolProtocol(pool);
            const isRelay = ["vercel", "cloudflare", "deno"].includes(proto);
            return (
              <div key={pool.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(pool.id)}
                    onChange={() => onToggleSelect(pool.id)}
                    className="mt-1 size-4 shrink-0 rounded border-black/20 dark:border-white/20"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="min-w-0 max-w-full truncate text-sm font-medium sm:max-w-[18rem]">{pool.name}</p>
                      <Badge variant={getStatusVariant(pool.testStatus)} size="sm" dot>
                        {pool.testStatus || "unknown"}
                      </Badge>
                      <Badge variant={pool.isActive ? "success" : "default"} size="sm">
                        {pool.isActive ? "active" : "inactive"}
                      </Badge>
                      <Badge variant="default" size="sm">{isRelay ? `${proto} relay` : proto}</Badge>
                      {pool.strictProxy && <Badge variant="warning" size="sm">strict</Badge>}
                      <Badge variant="default" size="sm">
                        {pool.boundConnectionCount || 0} bound
                      </Badge>
                    </div>
                    <p className="text-xs text-text-muted truncate mt-1 font-mono">{maskProxyUrl(pool.proxyUrl)}</p>
                    {pool.noProxy ? (
                      <p className="text-xs text-text-muted truncate">No proxy: {pool.noProxy}</p>
                    ) : null}
                    <p className="text-[11px] text-text-muted mt-1">
                      Last tested: {formatDateTime(pool.lastTestedAt)}
                      {pool.lastError ? ` · ${pool.lastError}` : ""}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-1">
                  <Toggle
                    size="sm"
                    checked={pool.isActive === true}
                    onChange={() => onToggleActive(pool)}
                    title={pool.isActive ? "Disable" : "Enable"}
                  />
                  <button
                    onClick={() => onTest(pool.id)}
                    className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="Test proxy"
                    disabled={testingId === pool.id}
                  >
                    <span
                      className="material-symbols-outlined text-[18px]"
                      style={testingId === pool.id ? { animation: "spin 1s linear infinite" } : undefined}
                    >
                      {testingId === pool.id ? "progress_activity" : "science"}
                    </span>
                  </button>
                  <button
                    onClick={() => onEdit(pool)}
                    className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="Edit"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    onClick={() => onDelete(pool)}
                    className="p-2 rounded hover:bg-red-500/10 text-red-500"
                    title="Delete"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
