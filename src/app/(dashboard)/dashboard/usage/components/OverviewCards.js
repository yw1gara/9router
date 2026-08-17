"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(Number(n) || 0);
const fmtCost = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const fmtRate = (n) => `${(Number(n) || 0).toFixed(1)}%`;

function getTopEntry(map, field = "requests") {
  return Object.values(map || {}).sort((a, b) => (Number(b[field]) || 0) - (Number(a[field]) || 0))[0] || null;
}

function MetricCard({ label, value, detail, tone = "text-text-main", icon }) {
  return (
    <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
        {icon && <span className={`material-symbols-outlined text-[16px] ${tone}`}>{icon}</span>}
      </div>
      <span className={`truncate text-2xl font-bold ${tone}`}>{value}</span>
      {detail && <span className="truncate text-[10px] text-text-muted" title={detail}>{detail}</span>}
    </Card>
  );
}

MetricCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  detail: PropTypes.string,
  tone: PropTypes.string,
  icon: PropTypes.string,
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
  const avgTokens = requests > 0 ? totalTokens / requests : 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 sm:gap-4">
        <MetricCard label="Total Requests" value={fmt(requests)} detail={`${activeCount} active now`} icon="swap_vert" />
        <MetricCard label="Input Tokens" value={fmt(input)} tone="text-primary" icon="north" />
        <MetricCard label="Output Tokens" value={fmt(output)} tone="text-success" icon="south" />
        <MetricCard label="Cached Tokens" value={fmt(cached)} detail={`${fmtRate(cacheRate)} of input`} tone="text-info" icon="cached" />
        <MetricCard label="Avg Tokens / Req" value={fmt(Math.round(avgTokens))} detail={`${fmt(totalTokens)} total`} tone="text-violet-500" icon="data_usage" />
        <MetricCard label="Estimated Cost" value={`~${fmtCost(stats.totalCost)}`} detail="Estimated, not billing" tone="text-warning" icon="payments" />
        <MetricCard label="Providers" value={fmt(providerCount)} detail={`${active.length} active request${active.length === 1 ? "" : "s"}`} tone="text-cyan-500" icon="hub" />
        <MetricCard label="Top Model" value={topModel?.rawModel || "—"} detail={topModel ? `${fmt(topModel.requests)} requests` : "No usage yet"} icon="star" />
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="flex min-w-0 items-center gap-3 border-primary/20 bg-primary/5 px-4 py-3">
          <span className="material-symbols-outlined text-primary">monitoring</span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Live activity</p>
            <p className="truncate text-sm font-medium text-text-main">
              {activeCount > 0 ? `${activeCount} request${activeCount === 1 ? "" : "s"} in flight` : "No requests in flight"}
            </p>
          </div>
        </Card>
        <Card className="flex min-w-0 items-center gap-3 px-4 py-3">
          <span className="material-symbols-outlined text-warning">key</span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Top API key</p>
            <p className="truncate text-sm font-medium text-text-main" title={topKey?.keyName || "No API key usage"}>
              {topKey?.keyName || "No API key usage"}
              {topKey ? ` · ${fmt(topKey.requests)} requests` : ""}
            </p>
          </div>
        </Card>
        <Card className="flex min-w-0 items-center gap-3 px-4 py-3">
          <span className="material-symbols-outlined text-success">check_circle</span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Data freshness</p>
            <p className="truncate text-sm font-medium text-text-main">Live SSE updates enabled</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
