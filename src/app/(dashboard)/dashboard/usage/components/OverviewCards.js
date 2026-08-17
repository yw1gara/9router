"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(Number(n) || 0);
const fmtCost = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const fmtRate = (n) => `${(Number(n) || 0).toFixed(1)}%`;

function getTopEntry(map, field = "requests") {
  return Object.values(map || {}).sort((a, b) => (Number(b[field]) || 0) - (Number(a[field]) || 0))[0] || null;
}

function MetricCard({ label, value, detail, icon, tone }) {
  return (
    <Card className="flex min-w-0 items-center gap-3 px-4 py-4">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tone.bg}`}>
        <span className={`material-symbols-outlined text-[20px] ${tone.fg}`}>{icon}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</p>
        <p className={`truncate text-xl font-bold ${tone.fg}`} title={String(value)}>{value}</p>
        {detail && <p className="truncate text-[11px] text-text-muted" title={detail}>{detail}</p>}
      </div>
    </Card>
  );
}

MetricCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  detail: PropTypes.string,
  icon: PropTypes.string.isRequired,
  tone: PropTypes.shape({ fg: PropTypes.string, bg: PropTypes.string }).isRequired,
};

const TONES = {
  neutral: { fg: "text-text-main", bg: "bg-text-main/10" },
  input: { fg: "text-primary", bg: "bg-primary/10" },
  output: { fg: "text-success", bg: "bg-success/10" },
  cache: { fg: "text-info", bg: "bg-info/10" },
  avg: { fg: "text-violet-500", bg: "bg-violet-500/10" },
  cost: { fg: "text-warning", bg: "bg-warning/10" },
  providers: { fg: "text-cyan-500", bg: "bg-cyan-500/10" },
  top: { fg: "text-pink-500", bg: "bg-pink-500/10" },
};

export default function OverviewCards({ stats }) {
  const requests = Number(stats.totalRequests) || 0;
  const input = Number(stats.totalPromptTokens) || 0;
  const output = Number(stats.totalCompletionTokens) || 0;
  const cached = Number(stats.totalCachedTokens) || 0;
  const totalTokens = input + output;
  const active = Array.isArray(stats.activeRequests) ? stats.activeRequests : [];
  const activeCount = active.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  const providerCount = Object.keys(stats.byProvider || {}).length;
  const topModel = getTopEntry(stats.byModel);
  const topKey = getTopEntry(stats.byApiKey);
  const cacheRate = input > 0 ? (cached / input) * 100 : 0;
  const avgTokens = requests > 0 ? Math.round(totalTokens / requests) : 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total Requests" value={fmt(requests)} detail={`${activeCount} active now`} icon="swap_vert" tone={TONES.neutral} />
        <MetricCard label="Input Tokens" value={fmt(input)} detail={`${fmtRate(cacheRate)} cached`} icon="north" tone={TONES.input} />
        <MetricCard label="Output Tokens" value={fmt(output)} icon="south" tone={TONES.output} />
        <MetricCard label="Avg Tokens / Request" value={fmt(avgTokens)} detail={`${fmt(totalTokens)} total`} icon="data_usage" tone={TONES.avg} />
        <MetricCard label="Cached Tokens" value={fmt(cached)} detail={`${fmtRate(cacheRate)} of input`} icon="cached" tone={TONES.cache} />
        <MetricCard label="Estimated Cost" value={`~${fmtCost(stats.totalCost)}`} detail="Estimated, not billing" icon="payments" tone={TONES.cost} />
        <MetricCard label="Providers" value={fmt(providerCount)} detail={`${active.length} active request${active.length === 1 ? "" : "s"}`} icon="hub" tone={TONES.providers} />
        <MetricCard label="Top Model" value={topModel?.rawModel || "—"} detail={topModel ? `${fmt(topModel.requests)} requests` : "No usage yet"} icon="star" tone={TONES.top} />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="flex min-w-0 items-center gap-3 border-primary/20 bg-primary/5 px-4 py-3">
          <span className="material-symbols-outlined text-primary">monitoring</span>
          <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Live activity</p><p className="truncate text-sm font-medium text-text-main">{activeCount > 0 ? `${activeCount} request${activeCount === 1 ? "" : "s"} in flight` : "No requests in flight"}</p></div>
        </Card>
        <Card className="flex min-w-0 items-center gap-3 px-4 py-3">
          <span className="material-symbols-outlined text-warning">key</span>
          <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Top API key</p><p className="truncate text-sm font-medium text-text-main" title={topKey?.keyName || "No API key usage"}>{topKey?.keyName || "No API key usage"}{topKey ? ` · ${fmt(topKey.requests)} requests` : ""}</p></div>
        </Card>
        <Card className="flex min-w-0 items-center gap-3 px-4 py-3">
          <span className="material-symbols-outlined text-success">check_circle</span>
          <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Data freshness</p><p className="truncate text-sm font-medium text-text-main">Live SSE updates enabled</p></div>
        </Card>
      </div>
    </div>
  );
}

OverviewCards.propTypes = { stats: PropTypes.object.isRequired };
