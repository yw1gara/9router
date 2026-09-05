"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, Button, SegmentedControl } from "@/shared/components";

const DIMS = [
  { value: "model", label: "Model" },
  { value: "provider", label: "Provider" },
  { value: "account", label: "Account" },
  { value: "apiKey", label: "API Key" },
  { value: "endpoint", label: "Endpoint" },
];

const COLS = [
  { id: "key", label: "Name", num: false },
  { id: "requests", label: "Requests", num: true },
  { id: "errors", label: "Errors", num: true },
  { id: "promptTokens", label: "In Tokens", num: true },
  { id: "cachedTokens", label: "Cached", num: true },
  { id: "completionTokens", label: "Out Tokens", num: true },
  { id: "cost", label: "Cost", num: true },
];

const fmt = (n) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtCost = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0");

export default function BreakdownTab({ period }) {
  const [dim, setDim] = useState("model");
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ col: "requests", desc: true });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ period, dim });
    if (provider) qs.set("provider", provider);
    fetch(`/api/usage/breakdown?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setData(d && !d.error ? d : { totals: {}, items: [], providers: [] }); })
      .catch(() => { if (!cancelled) setData({ totals: {}, items: [], providers: [] }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, dim, provider]);

  const rows = useMemo(() => {
    let list = [...(data?.items || [])];
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((r) => r.key.toLowerCase().includes(q));
    const { col, desc } = sort;
    list.sort((a, b) => {
      if (col === "key") return desc ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key);
      const av = a[col] ?? 0, bv = b[col] ?? 0;
      return desc ? bv - av : av - bv;
    });
    return list;
  }, [data, search, sort]);

  const visible = showAll ? rows : rows.slice(0, 20);
  const t = data?.totals || {};
  const cachePct = t.promptTokens > 0 ? Math.min(100, (t.cachedTokens / t.promptTokens) * 100) : 0;
  const errPct = t.requests > 0 ? (t.errors / t.requests) * 100 : 0;

  const exportCsv = () => {
    const header = COLS.map((c) => c.label).join(",");
    const body = rows.map((r) => [ `"${String(r.key).replace(/"/g, '""')}"`, r.requests, r.errors, r.promptTokens, r.cachedTokens, r.completionTokens, r.cost ?? 0 ].join(","));
    const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `9router-breakdown-${dim}-${period}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const th = (c) => (
    <th
      key={c.id}
      onClick={() => setSort((s) => (s.col === c.id ? { col: c.id, desc: !s.desc } : { col: c.id, desc: true }))}
      className={`cursor-pointer select-none whitespace-nowrap px-2 py-2 ${c.num ? "text-right" : "text-left"} ${
        sort.col === c.id ? "text-primary" : "text-text-muted"
      } hover:text-primary`}
    >
      {c.label}{sort.col === c.id ? (sort.desc ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Summary strip */}
      <Card className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Requests", value: fmt(t.requests) },
          { label: "Errors", value: `${fmt(t.errors)} (${errPct.toFixed(1)}%)`, color: errPct > 10 ? "text-red-500" : errPct > 0 ? "text-orange-500" : "text-green-600 dark:text-green-400" },
          { label: "In Tokens", value: fmt(t.promptTokens) },
          { label: "Out Tokens", value: fmt(t.completionTokens) },
          { label: "Cache Efficiency", value: `${cachePct.toFixed(1)}%`, color: "text-primary" },
          { label: "Cost", value: fmtCost(t.cost) },
        ].map((s) => (
          <div key={s.label}>
            <div className="text-[10px] uppercase tracking-wide text-text-muted">{s.label}</div>
            <div className={`text-sm font-semibold tabular-nums ${s.color || "text-text-main"}`}>{s.value}</div>
          </div>
        ))}
      </Card>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl options={DIMS} value={dim} onChange={(v) => { setDim(v); setShowAll(false); }} size="sm" className="w-auto" />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs dark:border-white/10"
        >
          <option value="">All providers</option>
          {(data?.providers || []).map((p) => (
            <option key={p.id ?? p} value={p.id ?? p}>{(p.name ?? p)}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-40 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-xs dark:border-white/10"
        />
        <span className="flex-1" />
        <Button size="sm" variant="outline" icon="download" onClick={exportCsv}>CSV</Button>
      </div>

      {/* Table */}
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="border-b border-black/5 dark:border-white/5">
            <tr>{COLS.map(th)}</tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={COLS.length} className="px-3 py-6 text-center text-text-muted">Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={COLS.length} className="px-3 py-6 text-center text-text-muted">No usage in this period.</td></tr>
            ) : visible.map((r) => {
              const rCache = r.promptTokens > 0 ? (r.cachedTokens / r.promptTokens) * 100 : 0;
              const rErr = r.requests > 0 ? (r.errors / r.requests) * 100 : 0;
              return (
                <tr key={r.key} className="border-b border-black/[0.03] last:border-0 hover:bg-black/[0.02] dark:border-white/[0.03] dark:hover:bg-white/[0.02]">
                  <td className="max-w-[280px] truncate px-2 py-2 font-mono" title={r.key}>{r.key}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(r.requests)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${rErr > 10 ? "text-red-500" : rErr > 0 ? "text-orange-500" : "text-text-muted"}`}>
                    {r.errors > 0 ? `${fmt(r.errors)} (${rErr.toFixed(0)}%)` : "0"}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(r.promptTokens)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-primary/80">{fmt(r.cachedTokens)} <span className="text-[9px] text-text-muted">({rCache.toFixed(0)}%)</span></td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(r.completionTokens)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtCost(r.cost)}</td>
                </tr>
              );
            })}
          </tbody>
          {!loading && rows.length > 0 && (
            <tfoot className="border-t border-black/10 font-semibold dark:border-white/10">
              <tr>
                <td className="px-2 py-2">TOTAL ({fmt(rows.length)} rows)</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(rows.reduce((s, r) => s + r.requests, 0))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(rows.reduce((s, r) => s + r.errors, 0))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(rows.reduce((s, r) => s + r.promptTokens, 0))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(rows.reduce((s, r) => s + r.cachedTokens, 0))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmt(rows.reduce((s, r) => s + r.completionTokens, 0))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtCost(rows.reduce((s, r) => s + (r.cost || 0), 0))}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </Card>

      {rows.length > 20 && (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show top 20" : `Show all ${fmt(rows.length)}`}
          </Button>
        </div>
      )}
    </div>
  );
}
