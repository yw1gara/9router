"use client";

import PropTypes from "prop-types";

const MODEL_LOCK_PREFIX = "modelLock_";

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * ConnectionErrorBadge — structured last-error display for a connection key.
 *
 * Shows the HTTP status code, the (truncated) error message with full text on
 * hover, and how long ago it happened. When the connection only has active
 * MODEL-scoped locks (a denied model does not lock the account), the badge is
 * amber to signal "account healthy, specific models cooling down"; genuine
 * account-level errors stay red.
 */
export default function ConnectionErrorBadge({ connection }) {
  if (!connection.lastError) return null;

  const now = Date.now();
  const hasActiveModelLock = Object.entries(connection).some(
    ([k, v]) => k.startsWith(MODEL_LOCK_PREFIX) && v && new Date(v).getTime() > now,
  );
  // Model-scoped denial: the lock list covers the failure, account itself is fine.
  const tone = hasActiveModelLock ? "text-amber-500" : "text-red-500";

  const ago = connection.lastErrorAt ? timeAgo(connection.lastErrorAt) : "";
  const message = typeof connection.lastError === "string" ? connection.lastError : String(connection.lastError);

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 text-xs ${tone}`}
      title={`${message}${ago ? `\n(${ago})` : ""}${hasActiveModelLock ? "\nAccount-level OK — only specific model(s) in cooldown" : ""}`}
    >
      <span className="material-symbols-outlined text-[13px] shrink-0">error_outline</span>
      {connection.errorCode && (
        <span className="shrink-0 rounded bg-current/10 px-1 font-mono text-[10px] font-semibold">
          {connection.errorCode}
        </span>
      )}
      <span className="max-w-[240px] truncate sm:max-w-[300px]">{message}</span>
      {ago && <span className="shrink-0 text-[10px] opacity-70">{ago}</span>}
    </span>
  );
}

ConnectionErrorBadge.propTypes = {
  connection: PropTypes.shape({
    lastError: PropTypes.string,
    errorCode: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    lastErrorAt: PropTypes.string,
  }).isRequired,
};
