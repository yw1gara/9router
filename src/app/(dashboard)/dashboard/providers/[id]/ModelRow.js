import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, caps, thinkingSuffix, onTestAll, onStopAll, isTestingAll, allResult }) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`group min-w-0 max-w-full rounded-lg border px-3 py-2 ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <span
          className="material-symbols-outlined shrink-0 text-base"
          style={iconColor ? { color: iconColor } : undefined}
        >
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code className="max-w-[72vw] truncate rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted sm:max-w-[360px]">{displayModel}</code>
          <span className="flex min-w-0 items-center text-[9px] gap-1 pl-1">
            {model.name && <span className="truncate text-[9px] italic text-text-muted/70">{model.name}</span>}
            <CapacityBadges caps={caps} colorOverride="text-text-muted/70" size={12} />
          </span>
        </div>
        {onTest && (
          <div className="relative shrink-0 group/btn">
            <button
              onClick={onTest}
              disabled={isTesting}
              className={`rounded p-0.5 text-text-muted transition-opacity hover:bg-sidebar hover:text-primary ${isTesting ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`}
            >
              <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {isTesting ? "Testing..." : "Test"}
            </span>
          </div>
        )}
        {onTestAll && (
          <div className="relative shrink-0 group/btn">
            <button
              onClick={isTestingAll ? onStopAll : onTestAll}
              disabled={isTestingAll && !onStopAll}
              className={`rounded p-0.5 transition-opacity hover:bg-sidebar ${
                isTestingAll
                  ? "text-red-500 hover:text-red-600 opacity-100"
                  : `text-text-muted hover:text-primary ${allResult ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`
              }`}
            >
              <span className="material-symbols-outlined text-sm" style={isTestingAll && !onStopAll ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTestingAll ? (onStopAll ? "stop_circle" : "progress_activity") : "groups"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {isTestingAll ? (onStopAll ? "Stop testing" : "Testing all accounts...") : "Test all accounts"}
            </span>
          </div>
        )}
        <div className="relative shrink-0 group/btn">
          <button
            onClick={() => onCopy(displayModel, `model-${model.id}`)}
            className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
          >
            <span className="material-symbols-outlined text-sm">
              {copied === `model-${model.id}` ? "check" : "content_copy"}
            </span>
          </button>
          <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
            {copied === `model-${model.id}` ? "Copied!" : "Copy"}
          </span>
        </div>
        {isCustom ? (
          <button
            onClick={onDeleteAlias}
            className="ml-auto rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
            title="Remove custom model"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : onDisable ? (
          <button
            onClick={onDisable}
            className="ml-auto rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
            title="Disable this model"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : null}
      </div>
      {allResult && (
        <div className="mt-2 rounded-md bg-sidebar/70 p-2">
          <div className="flex items-center gap-2 text-[11px] font-medium">
            {allResult.running ? (
              <span className="text-primary">
                <span className="material-symbols-outlined align-text-bottom text-xs" style={{ animation: "spin 1s linear infinite" }}>progress_activity</span>{" "}
                Testing {allResult.results.length}/{allResult.total}…
              </span>
            ) : (
              <span className={allResult.okCount === allResult.total ? "text-green-600 dark:text-green-400" : allResult.okCount === 0 ? "text-red-600 dark:text-red-400" : "text-orange-600 dark:text-orange-400"}>
                {allResult.okCount}/{allResult.total} accounts OK
              </span>
            )}
          </div>
          <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto">
            {(allResult.queue || allResult.results).map((item) => {
              const done = allResult.results.find((r) => r.connectionId === (item.connectionId || item.id));
              const isCurrent = allResult.running && allResult.currentId === (item.connectionId || item.id);
              const name = item.name || done?.name;
              const cid = item.connectionId || item.id;
              return (
                <div key={cid} className="flex min-w-0 items-center gap-2 text-[10px]">
                  {done ? (
                    <>
                      <span className={`material-symbols-outlined text-xs ${done.ok ? "text-green-500" : "text-red-500"}`}>
                        {done.ok ? "check_circle" : "cancel"}
                      </span>
                      <span className="max-w-[45%] truncate text-text-muted" title={name}>{name}</span>
                      {done.latencyMs != null && <span className="shrink-0 tabular-nums text-text-muted/70">{done.latencyMs}ms</span>}
                      {!done.ok && done.error && (
                        <span className="min-w-0 flex-1 truncate text-red-500/80" title={done.error}>{done.error}</span>
                      )}
                    </>
                  ) : isCurrent ? (
                    <>
                      <span className="material-symbols-outlined text-xs text-primary" style={{ animation: "spin 1s linear infinite" }}>progress_activity</span>
                      <span className="max-w-[45%] truncate text-primary" title={name}>{name}</span>
                      <span className="shrink-0 text-primary/80">testing…</span>
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-xs text-text-muted/40">schedule</span>
                      <span className="max-w-[45%] truncate text-text-muted/50" title={name}>{name}</span>
                      <span className="shrink-0 text-text-muted/40">queued</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
  onTestAll: PropTypes.func,
  onStopAll: PropTypes.func,
  isTestingAll: PropTypes.bool,
  allResult: PropTypes.shape({
    total: PropTypes.number,
    okCount: PropTypes.number,
    results: PropTypes.array,
  }),
};
