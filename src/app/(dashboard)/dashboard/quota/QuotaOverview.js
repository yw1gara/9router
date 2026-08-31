"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, Button } from "@/shared/components";

const REFRESH_MS = 30_000;

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "depleted", label: "Depleted" },
  { value: "failing", label: "Failing" },
  { value: "ok", label: "Healthy" },
  { value: "unchecked", label: "Unchecked" },
];

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff >= 0 && diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
    if (diff >= 0 && diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return "—"; }
}

function countdown(iso) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "due";
  const m = Math.floor(ms / 60_000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m >= 1) return `${m}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function accountStatus(it) {
  if (it.depleted) return "depleted";
  if ((it.failures || 0) > 0) return "failing";
  if (!it.checkedAt) return "unchecked";
  return "ok";
}

const STATUS_STYLES = {
  depleted: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  failing: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400",
  unchecked: "bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400",
  ok: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400",
};

export default function QuotaOverview() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/usage/quota-snapshot", { cache: "no-store" });
      const d = await r.json();
      setData(d && !d.error ? d : { items: [], summary: {} });
    } catch {
      setData((prev) => prev || { items: [], summary: {} });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const items = data?.items || [];
  const summary = data?.summary || {};
  const providers = useMemo(
    () => [...new Set(items.map((i) => i.provider).filter(Boolean))].sort(),
    [items]
  );

  const providerAgg = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      const p = it.provider || "unknown";
      const e = m.get(p) || { provider: p, total: 0, depleted: 0, failing: 0, inactive: 0 };
      e.total += 1;
      if (it.depleted) e.depleted += 1;
      if ((it.failures || 0) > 0) e.failing += 1;
      if (it.isActive === false) e.inactive += 1;
      m.set(p, e);
    }
    return [...m.values()].sort((a, b) => (b.depleted / b.total) - (a.depleted / a.total) || b.total - a.total);
  }, [items]);

  const rows = useMemo(() => {
    let list = items.map((it) => ({ ...it, _status: accountStatus(it) }));
    if (provider) list = list.filter((i) => i.provider === provider);
    if (statusFilter !== "all") list = list.filter((i) => i._status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((i) => (i.name || "").toLowerCase().includes(q) || (i.provider || "").toLowerCase().includes(q));
    const rank = { depleted: 0, failing: 1, unchecked: 2, ok: 3 };
    return list.sort((a, b) => rank[a._status] - rank[b._status] || (a.provider || "").localeCompare(b.provider || ""));
  }, [items, provider, statusFilter, search]);

  const exportCsv = () => {
    const header = "Account,Provider,Status,Depleted,Failures,Active,LastChecked,NextCheck";
    const body = rows.map((r) => [
      `"${String(r.name || "").replace(/"/g, '""')}"`, r.provider || "", r._status, r.depleted ? "yes" : "no",
      r.failures || 0, r.isActive === false ? "no" : "yes", r.checkedAt || "", r.nextCheckAt || "",
    ].join(","));
    const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `9router-quota-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const stat = (label, value, color) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color || "text-text-main"}`}>{value}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Summary + controls */}
      <Card className="flex flex-wrap items-center gap-4 p-3">
        {stat("Tracked", summary.tracked ?? 0)}
        {stat("Active", summary.active ?? 0)}
        {stat("Depleted", summary.depleted ?? 0, (summary.depleted ?? 0) > 0 ? "text-red-500" : "text-green-600 dark:text-green-400")}
        {stat("Failing", summary.failed ?? 0, (summary.failed ?? 0) > 0 ? "text-orange-500" : "text-text-main")}
        {stat("Checked", summary.checked ?? 0)}
        <span className="flex-1" />
        <span className="text-[10px] text-text-muted">updated {fmtTime(data?.generatedAt)}</span>
        <Button size="sm" variant={autoRefresh ? "primary" : "outline"} icon="autorenew"
          onClick={() => setAutoRefresh((v) => !v)} title={`Auto-refresh every ${REFRESH_MS / 1000}s`}>
          {autoRefresh ? "Live 30s" : "Paused"}
        </Button>
        <Button size="sm" variant="outline" icon="refresh" onClick={() => { setLoading(true); load(); }}>Refresh</Button>
        <Button size="sm" variant="outline" icon="download" onClick={exportCsv}>CSV</Button>
      </Card>

      {/* Provider aggregates — worst first */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {providerAgg.map((p) => {
          const pct = p.total > 0 ? Math.round((p.depleted / p.total) * 100) : 0;
          const healthy = p.depleted === 0 && p.failing === 0;
          return (
            <Card key={p.provider} className={`p-2.5 ${healthy ? "" : "border-orange-500/40"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium" title={p.provider}>{p.provider}</span>
                <span className={`shrink-0 text-[10px] font-semibold tabular-nums ${pct > 0 ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
                  {p.depleted}/{p.total}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                <div className={`h-full rounded-full ${pct >= 50 ? "bg-red-500" : pct > 0 ? "bg-orange-500" : "bg-green-500"}`} style={{ width: `${Math.max(pct, p.depleted ? 6 : 0)}%` }} />
              </div>
              <div className="mt-1 text-[9px] text-text-muted">
                {pct}% depleted{p.failing > 0 ? ` · ${p.failing} failing` : ""}{p.inactive > 0 ? ` · ${p.inactive} off` : ""}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button key={f.value} onClick={() => setStatusFilter(f.value)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === f.value ? "bg-primary text-white" : "bg-black/[0.04] text-text-main hover:bg-black/[0.08] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
              }`}>
              {f.label}
            </button>
          ))}
        </div>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}
          className="rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs dark:border-white/10">
          <option value="">All providers</option>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search account…"
          className="w-44 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-xs dark:border-white/10" />
        <span className="ml-auto text-[10px] text-text-muted">{rows.length} of {items.length} accounts</span>
      </div>

      {/* Accounts table */}
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="border-b border-black/5 dark:border-white/5">
            <tr className="text-text-muted">
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-2 py-2 text-left">Account</th>
              <th className="px-2 py-2 text-left">Provider</th>
              <th className="px-2 py-2 text-right">Failures</th>
              <th className="px-2 py-2 text-right">Last check</th>
              <th className="px-2 py-2 text-right">Next check</th>
              <th className="px-3 py-2 text-right">Active</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-text-muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-text-muted">
                {items.length === 0 ? "No accounts tracked by the quota monitor yet." : "No accounts match the filters."}
              </td></tr>
            ) : rows.map((r) => (
              <tr key={r.connectionId} className="border-b border-black/[0.03] last:border-0 hover:bg-black/[0.02] dark:border-white/[0.03] dark:hover:bg-white/[0.02]">
                <td className="px-3 py-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[r._status]}`}>
                    {r._status === "depleted" ? "DEPLETED" : r._status === "failing" ? "FAILING" : r._status === "unchecked" ? "UNCHECKED" : "OK"}
                  </span>
                </td>
                <td className="max-w-[220px] truncate px-2 py-2 font-mono" title={r.name}>{r.name}</td>
                <td className="px-2 py-2">{r.provider}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${(r.failures || 0) > 0 ? "text-orange-500" : "text-text-muted"}`}>{r.failures || 0}</td>
                <td className="px-2 py-2 text-right text-text-muted">{fmtTime(r.checkedAt)}</td>
                <td className="px-2 py-2 text-right text-text-muted tabular-nums">{countdown(r.nextCheckAt)}</td>
                <td className="px-3 py-2 text-right">
                  {r.isActive === false ? <span className="text-text-muted">off</span> : <span className="text-green-600 dark:text-green-400">on</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
