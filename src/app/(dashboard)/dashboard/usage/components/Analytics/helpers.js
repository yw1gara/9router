// Shared formatting helpers for the Analytics tab — kept lightweight so the
// chart components can stay declarative.

export const fmt = (n) => new Intl.NumberFormat("en-US").format(n || 0);

export const fmtTokens = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n || 0);
};

export const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export const fmtCostPrecise = (n) => `$${(n || 0).toFixed(4)}`;

export const fmtPct = (n) => `${(n || 0).toFixed(1)}%`;

export const fmtMs = (n) => (n > 0 ? `${Math.round(n)}ms` : "—");

export const fmtTime = (timestamp) => {
  if (!timestamp) return "—";
  try {
    return new Date(timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
};

export const CHART_COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#84cc16", "#06b6d4", "#a855f7",
];

export const colorForIndex = (i) => CHART_COLORS[i % CHART_COLORS.length];
