"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";

const MODEL_LOCK_PREFIX = "modelLock_";

function formatRemaining(ms) {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function activeLocks(connection, now) {
  return Object.entries(connection || {})
    .filter(([k, v]) => k.startsWith(MODEL_LOCK_PREFIX) && v && new Date(v).getTime() > now)
    .sort(([, a], [, b]) => new Date(a) - new Date(b));
}

/**
 * ModelLockChips — per-model cooldown chips for a connection.
 *
 * modelLock_<model> keys are MODEL-SCOPED locks: a denied model only
 * quarantines that model on that account — sibling models stay usable.
 * Each chip shows the locked model name plus a live countdown to expiry.
 * "modelLock___all" (account-wide lock) renders as an "all models" chip.
 *
 * The 1s ticker is armed ONLY while at least one lock is active and clears
 * itself when the last lock expires — rows without cooldowns never tick.
 */
export default function ModelLockChips({ connection }) {
  const [now, setNow] = useState(() => Date.now());
  const locks = useMemo(() => activeLocks(connection, now), [connection, now]);
  const hasLocks = locks.length > 0;

  useEffect(() => {
    if (!hasLocks) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasLocks]);

  if (!hasLocks) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {locks.map(([key, until]) => {
        const model = key.slice(MODEL_LOCK_PREFIX.length);
        const remaining = formatRemaining(new Date(until).getTime() - now);
        return (
          <span
            key={key}
            title={`Model cooldown until ${new Date(until).toLocaleString()}`}
            className="inline-flex items-center gap-1 rounded bg-orange-500/10 px-1.5 py-0.5 font-mono text-[10px] text-orange-500"
          >
            <span className="material-symbols-outlined text-[12px]">schedule</span>
            <span className="max-w-[180px] truncate">{model === "__all" ? "all models" : model}</span>
            <span>⏱ {remaining}</span>
          </span>
        );
      })}
    </span>
  );
}

ModelLockChips.propTypes = {
  connection: PropTypes.object.isRequired,
};
