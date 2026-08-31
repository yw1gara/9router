"use client";

import PropTypes from "prop-types";
import { useState } from "react";

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

const RATE_LIMIT_MESSAGE_RE =
  /rate[ _-]?limit|too many requests|quota exceeded|free usage limit|freeusagelimiterror|free_rate_limited|capacity is limited/i;

export default function ConnectionErrorBadge({ connection }) {
  const [now] = useState(() => Date.now());
  if (!connection?.lastError) return null;

  const status = Number(connection?.errorCode);
  const message =
    typeof connection.lastError === "string"
      ? connection.lastError
      : String(connection.lastError);

  const hasActiveModelLock = Object.entries(connection || {}).some(
    ([k, v]) => k.startsWith(MODEL_LOCK_PREFIX) && v && new Date(v).getTime() > now,
  );

  // 429 / rate-limit, atau akun yang sudah punya model lock: jangan tampilkan
  // error berisik di level akun — tag model yang menunjukkan model mana yang abis.
  if (
    hasActiveModelLock ||
    status === 429 ||
    RATE_LIMIT_MESSAGE_RE.test(message)
  ) {
    return null;
  }

  const ago = connection.lastErrorAt ? timeAgo(connection.lastErrorAt) : "";

  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-xs text-red-500"
      title={`${message}${ago ? `\n(${ago})` : ""}`}
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
