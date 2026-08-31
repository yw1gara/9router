"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

const MODEL_LOCK_PREFIX = "modelLock_";

function activeLocks(connection, now) {
  return Object.entries(connection || {})
    .filter(([key, value]) => key.startsWith(MODEL_LOCK_PREFIX) && value && new Date(value).getTime() > now)
    .sort(([, a], [, b]) => new Date(a) - new Date(b));
}

export default function ModelLockChips({ connection }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const locks = useMemo(() => activeLocks(connection, now).filter(([, until]) => new Date(until).getTime() > now), [connection, now]);

  if (locks.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {locks.map(([key, until]) => {
        const model = key.slice(MODEL_LOCK_PREFIX.length);
        const seconds = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
        const countdown = seconds >= 3600
          ? `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`
          : seconds >= 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s`;
        return (
          <span
            key={key}
            title={`${model === "__all" ? "All models" : model} cooldown remaining ${countdown}`}
            className="inline-flex items-center gap-1 rounded border border-orange-500/30 bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-500"
          >
            <span className="material-symbols-outlined text-[12px]">close</span>
            <span className="max-w-[180px] truncate">{model === "__all" ? "all models" : model}</span>
            <span>{countdown}</span>
          </span>
        );
      })}
    </span>
  );
}

ModelLockChips.propTypes = {
  connection: PropTypes.object.isRequired,
};
