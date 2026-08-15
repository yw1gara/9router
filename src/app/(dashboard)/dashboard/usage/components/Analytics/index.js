"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Card from "@/shared/components/Card";
import { colorForIndex, fmt, fmtCost, fmtCostPrecise, fmtMs, fmtPct, fmtTime, fmtTokens } from "./helpers";

function PanelHeader({ icon, title, description, right }) {
  return (
    <div className="mb-4 flex min-w-0 items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="material-symbols-outlined mt-0.5 text-[18px] text-primary">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-main">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

function EmptyState({ text = "No analytics data for this period." }) {
  return <div className="flex h-44 items-center justify-center text-sm text-text-muted">{text}</div>;
}

function Velocity({ data }) {
  if (!data?.length) return <EmptyState />;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="analyticsRequests" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} /><stop offset="95%" stopColor="#6366f1" stopOpacity={0} /></linearGradient>
          <linearGradient id="analyticsCost" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} /><stop offset="95%" stopColor="#f59e0b" stopOpacity={0} /></linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.12} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.55 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis yAxisId="requests" tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.55 }} tickLine={false} axisLine={false} width={40} />
        <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.55 }} tickLine={false} axisLine={false} width={48} tickFormatter={fmtCost} />
        <Tooltip contentStyle={{ backgroundColor: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} formatter={(v, n) => n === "Cost" ? [fmtCostPrecise(v), n] : [fmt(v), n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area yAxisId="requests" type="monotone" dataKey="requests" name="Requests" stroke="#6366f1" strokeWidth={2} fill="url(#analyticsRequests)" dot={false} activeDot={{ r: 4 }} />
        <Area yAxisId="cost" type="monotone" dataKey="cost" name="Cost" stroke="#f59e0b" strokeWidth={2} fill="url(#analyticsCost)" dot={false} activeDot={{ r: 4 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function CostBreakdown({ providers }) {
  if (!providers?.length) return <EmptyState />;
  const chartData = providers.slice(0, 8).map((p) => ({ name: p.provider, value: p.cost }));
  const total = providers.reduce((sum, p) => sum + p.cost, 0);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(180px,0.8fr)_minmax(220px,1.2fr)]">
      <div className="relative h-52">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={53} outerRadius={82} paddingAngle={2}>
              {chartData.map((_, i) => <Cell key={i} fill={colorForIndex(i)} />)}
            </Pie>
            <Tooltip contentStyle={{ backgroundColor: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} formatter={(v) => fmtCostPrecise(v)} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase text-text-muted">Total cost</span>
          <strong className="text-base text-text-main">{fmtCost(total)}</strong>
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto pr-1">
        {providers.slice(0, 10).map((p, i) => (
          <div key={p.provider} className="flex items-center gap-2 border-b border-border/60 py-2 last:border-0">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorForIndex(i) }} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-main">{p.provider}</span>
            <span className="text-xs text-text-muted">{fmtPct(p.costSharePct)}</span>
            <span className="w-16 text-right font-mono text-xs text-text-main">{fmtCostPrecise(p.cost)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Table({ headers, children, empty, className = "" }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full min-w-[500px] text-left text-xs">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wide text-text-muted">
            {headers.map((header) => <th key={header} className="px-2 py-2 font-semibold first:pl-0 last:pr-0">{header}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {hasRows
            ? children
            : <tr><td colSpan={headers.length} className="px-2 py-8 text-center text-text-muted">{empty || "No data recorded."}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function TopModels({ items }) {
  return (
    <Table headers={["#", "Model", "Provider", "Requests", "Tokens", "Cost"]}>
      {items?.map((m, i) => (
        <tr key={`${m.provider}-${m.model}`} className="hover:bg-bg-subtle/60">
          <td className="py-2.5 pl-0 text-text-muted">{i + 1}</td>
          <td className="max-w-[170px] truncate py-2.5 font-mono text-text-main" title={m.model}>{m.model}</td>
          <td className="py-2.5"><span className="rounded bg-bg-subtle px-1.5 py-0.5 text-text-muted">{m.provider}</span></td>
          <td className="py-2.5 text-right text-text-main">{fmt(m.requests)}</td>
          <td className="py-2.5 text-right text-primary">{fmtTokens(m.tokens)}</td>
          <td className="py-2.5 pr-0 text-right font-medium text-warning">{fmtCostPrecise(m.cost)}</td>
        </tr>
      ))}
    </Table>
  );
}

function Latency({ items }) {
  return (
    <Table headers={["Provider", "Samples", "TTFT p50", "TTFT p95", "Total p50", "Total p95"]} empty="Enable Observability to collect latency data.">
      {items?.map((p) => (
        <tr key={p.provider} className="hover:bg-bg-subtle/60">
          <td className="py-2.5 pl-0 font-medium text-text-main">{p.provider}</td>
          <td className="py-2.5 text-text-muted">{fmt(p.requests)}</td>
          <td className="py-2.5 font-mono text-primary">{fmtMs(p.ttftP50)}</td>
          <td className="py-2.5 font-mono text-primary">{fmtMs(p.ttftP95)}</td>
          <td className="py-2.5 font-mono text-text-main">{fmtMs(p.totalP50)}</td>
          <td className="py-2.5 pr-0 font-mono text-text-main">{fmtMs(p.totalP95)}</td>
        </tr>
      ))}
    </Table>
  );
}

function ErrorAnalysis({ errors, summary }) {
  const statuses = errors?.statuses || [];
  const pairs = errors?.worstPairs || [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {statuses.length
          ? statuses.map((s) => (
              <div key={s.status} className="rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5">
                <span className="text-[10px] uppercase text-text-muted">{s.status}</span>
                <strong className="ml-2 text-sm text-text-main">{fmt(s.count)}</strong>
              </div>
            ))
          : <span className="text-sm text-text-muted">No request statuses recorded.</span>
        }
        <div className={`rounded-lg border px-2.5 py-1.5 ${summary?.errorRate > 0 ? "border-red-500/30 bg-red-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>
          <span className="text-[10px] uppercase text-text-muted">Error rate</span>
          <strong className={`ml-2 text-sm ${summary?.errorRate > 0 ? "text-red-500" : "text-emerald-500"}`}>{fmtPct(summary?.errorRate)}</strong>
        </div>
      </div>
      <Table headers={["Provider / Model", "Requests", "Errors", "Rate"]} empty="No failed requests in this period.">
        {pairs.map((p) => (
          <tr key={`${p.provider}-${p.model}`}>
            <td className="max-w-[230px] truncate py-2.5 pl-0">
              <span className="font-medium text-text-main">{p.provider}</span>
              <span className="text-text-muted"> / </span>
              <span className="font-mono text-text-muted">{p.model}</span>
            </td>
            <td className="py-2.5 text-text-muted">{fmt(p.requests)}</td>
            <td className="py-2.5 text-red-500">{fmt(p.errors)}</td>
            <td className="py-2.5 pr-0 font-medium text-red-500">{fmtPct(p.errorRate)}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function QuotaHealth({ quota }) {
  const summary = quota?.summary || {};
  const items = quota?.items || [];
  const flagged = items.filter((item) => item.depleted || item.failures > 0).slice(0, 8);
  const cards = [
    ["Tracked", summary.tracked, "data_usage", "text-primary"],
    ["Active", summary.active, "check_circle", "text-emerald-500"],
    ["Depleted", summary.depleted, "block", "text-red-500"],
    ["Check failures", summary.failed, "warning", "text-amber-500"],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {cards.map(([label, value, icon, color]) => (
          <div key={label} className="rounded-lg border border-border bg-bg-subtle p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
              <span className={`material-symbols-outlined text-[15px] ${color}`}>{icon}</span>
            </div>
            <strong className="mt-1 block truncate text-xl text-text-main">{fmt(value)}</strong>
          </div>
        ))}
      </div>
      {flagged.length ? (
        <div className="max-h-44 overflow-y-auto">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Needs attention</p>
          {flagged.map((item) => (
            <div key={item.connectionId} className="flex items-center gap-2 border-b border-border/60 py-2 last:border-0">
              <span className={`h-2 w-2 rounded-full ${item.depleted ? "bg-red-500" : "bg-amber-500"}`} />
              <span className="min-w-0 flex-1 truncate text-xs text-text-main" title={item.name}>{item.name}</span>
              <span className="text-[10px] text-text-muted">{item.depleted ? "Depleted" : `${item.failures} failures`}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-emerald-600 dark:text-emerald-400">
          No depleted connections or monitor failures.
        </div>
      )}
      <p className="text-[10px] text-text-muted">Reads the background monitor only. No upstream quota calls are made.</p>
    </div>
  );
}

function TopConnections({ items }) {
  return (
    <Table headers={["Connection", "Provider", "State", "Requests", "Tokens", "Cost", "Error rate"]}>
      {items?.map((c) => (
        <tr key={c.connectionId} className="hover:bg-bg-subtle/60">
          <td className="max-w-[240px] truncate py-2.5 pl-0 font-medium text-text-main" title={c.name}>{c.name}</td>
          <td className="py-2.5"><span className="rounded bg-bg-subtle px-1.5 py-0.5 text-text-muted">{c.provider}</span></td>
          <td className="py-2.5"><span className={c.isActive === false ? "text-red-500" : "text-emerald-500"}>{c.isActive === false ? "Off" : c.isActive === true ? "On" : "—"}</span></td>
          <td className="py-2.5 text-right">{fmt(c.requests)}</td>
          <td className="py-2.5 text-right text-primary">{fmtTokens(c.tokens)}</td>
          <td className="py-2.5 text-right text-warning">{fmtCostPrecise(c.cost)}</td>
          <td className={`py-2.5 pr-0 text-right ${c.errorRate > 0 ? "text-red-500" : "text-text-muted"}`}>{fmtPct(c.errorRate)}</td>
        </tr>
      ))}
    </Table>
  );
}

export default function UsageAnalytics({ period }) {
  const [analytics, setAnalytics] = useState(null);
  const [quota, setQuota] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const requestSeq = useRef(0);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    const seq = ++requestSeq.current;
    if (!quiet) setLoading(true);
    try {
      const [analyticsRes, quotaRes] = await Promise.all([
        fetch(`/api/usage/analytics?period=${period}`),
        fetch("/api/usage/quota-snapshot"),
      ]);
      if (!analyticsRes.ok) throw new Error("Analytics data could not be loaded");
      const [analyticsData, quotaData] = await Promise.all([
        analyticsRes.json(),
        quotaRes.ok ? quotaRes.json() : null,
      ]);
      // Drop stale responses: a slower fetch for a previous period (or a
      // superseded quiet refresh) must not overwrite the current selection.
      if (seq !== requestSeq.current) return;
      setAnalytics(analyticsData);
      setQuota(quotaData);
      setUpdatedAt(new Date());
      setError("");
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err.message || "Failed to load analytics");
    } finally {
      if (seq === requestSeq.current && !quiet) setLoading(false);
    }
  }, [period]);

  useEffect(() => { refresh(); }, [refresh]);

  // Light refresh every 60s only when tab is visible
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) refresh({ quiet: true });
    }, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (loading && !analytics) {
    return (
      <div className="flex h-80 items-center justify-center text-text-muted">
        <span className="material-symbols-outlined animate-spin text-3xl">progress_activity</span>
      </div>
    );
  }

  if (error && !analytics) {
    return <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">{error}</div>;
  }

  const summary = analytics?.summary || {};
  const statCards = [
    ["Requests", fmt(summary.requests), "request_page", "text-primary"],
    ["Total tokens", fmtTokens(summary.tokens), "token", "text-indigo-500"],
    ["Cost / request", fmtCostPrecise(summary.avgCostPerRequest), "payments", "text-amber-500"],
    ["Success rate", fmtPct(100 - (summary.errorRate || 0)), "verified", summary.errorRate > 0 ? "text-amber-500" : "text-emerald-500"],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Header + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-text-main">Usage Analytics</h1>
          <p className="text-xs text-text-muted">Operational usage, cost, performance, and quota health for the selected period.</p>
        </div>
        <div className="flex items-center gap-2">
          {updatedAt && <span className="text-[10px] text-text-muted">Updated {fmtTime(updatedAt)}</span>}
          <button
            type="button"
            onClick={() => refresh()}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-subtle hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[14px]">refresh</span>
            Refresh
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statCards.map(([label, value, icon, color]) => (
          <Card key={label} className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
              <span className={`material-symbols-outlined text-[17px] ${color}`}>{icon}</span>
            </div>
            <strong className="mt-1 block truncate text-xl text-text-main">{value}</strong>
          </Card>
        ))}
      </div>

      {/* Velocity */}
      <Card className="p-4">
        <PanelHeader icon="monitoring" title="Request velocity" description="Requests and estimated cost across the selected period." />
        <Velocity data={analytics?.velocity} />
      </Card>

      {/* Cost breakdown + Quota health */}
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <Card className="min-w-0 p-4">
          <PanelHeader icon="pie_chart" title="Provider cost allocation" description="Estimated spend share by upstream provider." />
          <CostBreakdown providers={analytics?.providerBreakdown} />
        </Card>
        <Card className="min-w-0 p-4">
          <PanelHeader icon="health_and_safety" title="Quota monitor health" description="Background monitor state and automatic availability." />
          <QuotaHealth quota={quota} />
        </Card>
      </div>

      {/* Top models + Latency */}
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="min-w-0 p-4">
          <PanelHeader icon="leaderboard" title="Top models" description="Ranked by estimated cost, then token volume." />
          <TopModels items={analytics?.topModels} />
        </Card>
        <Card className="min-w-0 p-4">
          <PanelHeader icon="speed" title="Latency by provider" description="Rolling observability buffer. TTFT = time to first token." />
          <Latency items={analytics?.latency} />
        </Card>
      </div>

      {/* Error analysis + Top connections */}
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Card className="min-w-0 p-4">
          <PanelHeader icon="error" title="Error analysis" description="Request statuses and provider-model pairs with failures." />
          <ErrorAnalysis errors={analytics?.errors} summary={summary} />
        </Card>
        <Card className="min-w-0 p-4">
          <PanelHeader icon="account_tree" title="Top connections" description="Accounts ranked by estimated cost, then token volume." />
          <TopConnections items={analytics?.topConnections} />
        </Card>
      </div>

      {error && <p className="text-xs text-amber-500">Latest refresh failed: {error}. Showing the last successful result.</p>}
    </div>
  );
}
