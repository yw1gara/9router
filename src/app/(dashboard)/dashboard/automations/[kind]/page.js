"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, notFound } from "next/navigation";
import { getAutomationKind, parseAccountsText } from "@/shared/constants/automations";

function parseProxiesText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^https?:\/\//i, ""));
}

function fmtElapsed(fromIso) {
  if (!fromIso) return "—";
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function AutomationPage() {
  const params = useParams();
  const kind = getAutomationKind(params?.kind);
  // selfGenerated kinds (e.g. tokenharbor) create their own disposable
  // identities — no account list is needed, only how many to create.
  const selfGenerated = !!kind?.selfGenerated;

  const [accountsText, setAccountsText] = useState("");
  const [proxiesText, setProxiesText] = useState("");
  const [autoImport, setAutoImport] = useState(true);
  const [bypassProxies, setBypassProxies] = useState(false);
  const [threads, setThreads] = useState(1);
  // How many identities a selfGenerated run creates (tokenharbor).
  const [genLimit, setGenLimit] = useState(1);
  const [copied, setCopied] = useState(false);
  const [consoleCleared, setConsoleCleared] = useState(false);

  // Proxy source: "none" = manual textarea; any rotation strategy = live
  // proxy pools (textarea hidden automatically).
  const [proxyMode, setProxyMode] = useState("none");
  const [poolProxies, setPoolProxies] = useState([]);
  const [poolsLoading, setPoolsLoading] = useState(false);

  // Expert UI state
  const [showInvalid, setShowInvalid] = useState(false);
  const [autoScrollLog, setAutoScrollLog] = useState(true);
  const [resultFilter, setResultFilter] = useState("all");
  const [resultSearch, setResultSearch] = useState("");
  const [, forceTick] = useState(0); // re-render for the elapsed timer

  // Run state
  const [running, setRunning] = useState(false);
  const [currentRun, setCurrentRun] = useState(null);
  const [runResults, setRunResults] = useState([]);
  const [history, setHistory] = useState([]);
  const pollRef = useRef(null);
  const logBoxRef = useRef(null);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/automations/${params?.kind}/runs`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data.runs || []);
        if (data.running) {
          setRunning(true);
          await pollRun(data.running);
        }
      }
    } catch {}
  }, [params?.kind]);

  const pollRun = useCallback(async (runId) => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/automations/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setCurrentRun(data.run);
        setRunResults(data.results || []);
        setRunning(data.run?.status === "running");
        if (data.run?.status === "running") {
          pollRef.current = setTimeout(() => pollRun(runId), 2500);
        } else {
          await loadRuns();
        }
      }
    } catch {}
  }, [loadRuns]);

  useEffect(() => {
    if (kind) loadRuns();
    return () => clearTimeout(pollRef.current);
  }, [kind, loadRuns]);

  // Auto-scroll the log only when the user wants it (default on during runs).
  useEffect(() => {
    if (autoScrollLog && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [currentRun?.log, autoScrollLog]);

  // Tick every second while a run is active so the elapsed timer stays live.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const parsed = useMemo(() => parseAccountsText(accountsText), [accountsText]);
  const validCount = parsed.valid.length;
  const invalidCount = parsed.invalid.length;
  const duplicateCount = useMemo(() => {
    const seen = new Set();
    let dup = 0;
    for (const a of parsed.valid) {
      if (seen.has(a.email)) dup += 1;
      else seen.add(a.email);
    }
    return dup;
  }, [parsed]);
  const uniqueCount = validCount - duplicateCount;
  const proxyCount = useMemo(() => parseProxiesText(proxiesText).length, [proxiesText]);

  // Live proxy pools for the rotation strategies (like the providers page).
  useEffect(() => {
    if (proxyMode === "none") return;
    let cancelled = false;
    setPoolsLoading(true);
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const urls = (d.proxyPools || [])
          .filter((p) => p.isActive === true && p.proxyUrl)
          .map((p) => String(p.proxyUrl).replace(/^https?:\/\//i, "").trim())
          .filter(Boolean);
        setPoolProxies(urls);
      })
      .catch(() => { if (!cancelled) setPoolProxies([]); })
      .finally(() => { if (!cancelled) setPoolsLoading(false); });
    return () => { cancelled = true; };
  }, [proxyMode]);

  // The proxy list actually used for a run: manual textarea in "none" mode,
  // otherwise the live pool inventory (random shuffles once per run).
  const effectiveProxies = useCallback(() => {
    if (bypassProxies) return [];
    if (proxyMode === "none") return parseProxiesText(proxiesText);
    if (proxyMode === "random") {
      const shuffled = [...poolProxies];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }
    return poolProxies;
  }, [bypassProxies, proxyMode, proxiesText, poolProxies]);

  const activeProxyCount = proxyMode === "none" ? proxyCount : poolProxies.length;

  const clearAll = () => {
    setAccountsText("");
  };

  const run = async () => {
    // What's in the form is what runs — all valid accounts, no persistence.
    // selfGenerated kinds run with an empty account list + a limit instead.
    const accounts = selfGenerated ? [] : parsed.valid;
    const proxies = effectiveProxies();
    if (proxyMode !== "none" && !bypassProxies && proxies.length === 0) {
      alert("Selected proxy-pool mode but no active pools with a proxy URL are available.");
      return;
    }
    setConsoleCleared(false);
    try {
      const res = await fetch(`/api/automations/${params?.kind}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts,
          autoImport,
          threads,
          proxies,
          limit: selfGenerated ? genLimit : 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        pollRun(data.runId);
        return;
      }
      if (res.ok && data.runId) {
        setRunning(true);
        pollRun(data.runId);
      } else {
        alert(data.error || "Failed to start run");
      }
    } catch (e) {
      alert(`Failed to start run: ${e.message}`);
    }
  };

  const exportedKeys = useMemo(
    () =>
      runResults
        .filter((r) => r.status === "success" && r.apiKey)
        .map((r) => `${r.email}|${r.apiKey}`)
        .join("\n"),
    [runResults]
  );

  const copyKeys = async () => {
    const text = exportedKeys;
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // HTTP fallback (dashboard is served over LAN http).
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // last resort: user selects the textarea manually
    }
  };

  if (!kind) return notFound();

  const runBadge = (st) => {
    if (st === "running") return <span className="badge badge-info badge-sm">Running</span>;
    if (st === "done") return <span className="badge badge-success badge-sm">Done</span>;
    if (st === "failed") return <span className="badge badge-error badge-sm">Failed</span>;
    return <span className="badge badge-ghost badge-sm">{st}</span>;
  };

  const showLog = !consoleCleared || running;

  const filteredResults = useMemo(() => {
    let list = runResults;
    if (resultFilter === "success") list = list.filter((r) => r.status === "success");
    if (resultFilter === "failed") list = list.filter((r) => r.status !== "success");
    const q = resultSearch.trim().toLowerCase();
    if (q) list = list.filter((r) => (r.email || "").toLowerCase().includes(q) || (r.error || "").toLowerCase().includes(q));
    return list;
  }, [runResults, resultFilter, resultSearch]);

  const exportResultsCsv = () => {
    const header = "email,status,apiKey,imported,error";
    const body = filteredResults.map((r) => [
      r.email || "", r.status || "", r.apiKey || "", r.connectionId ? "yes" : "no",
      `"${String(r.error || "").replace(/"/g, '""')}"`,
    ].join(","));
    const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `9router-${kind.id}-run-${currentRun?.id || "export"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const totalAccounts = selfGenerated ? (currentRun?.total || genLimit) : validCount;
  const doneCount = (currentRun?.success || 0) + (currentRun?.failed || 0);
  const progressPct = running && totalAccounts > 0 ? Math.min(100, Math.round((doneCount / totalAccounts) * 100)) : (currentRun && !running ? 100 : 0);

  const stat = (label, value, color) => (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide opacity-60">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color || ""}`}>{value}</div>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4">
      {/* Header + live stats */}
      <div className="rounded-xl border border-border-subtle bg-vibrancy p-5 space-y-4">
        <div className="flex items-start gap-4">
          <div className="flex items-center justify-center size-11 rounded-xl bg-primary/10 text-primary shrink-0">
            <span className="material-symbols-outlined text-[24px]">{kind.icon}</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">{kind.label}</h1>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-surface-2 text-text-muted">{kind.script}</span>
            </div>
            <p className="text-sm opacity-70 mt-1">{kind.description}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 pt-1">
          {selfGenerated ? (
            <>
              {stat("Success target", genLimit, "text-primary")}
              {stat("Identities", "auto-generated")}
              {stat("Proxies", bypassProxies ? "bypassed" : (proxyMode === "none" ? activeProxyCount : `${activeProxyCount} pool`), bypassProxies ? "text-orange-500" : "")}
              {stat("Last run", currentRun && !running ? `${currentRun.success}✓/${currentRun.failed}✗` : running ? "running…" : "—")}
            </>
          ) : (
            <>
              {stat("Accounts valid", validCount, "text-green-600 dark:text-green-400")}
              {stat("Unique", uniqueCount)}
              {stat("Duplicates", duplicateCount, duplicateCount > 0 ? "text-orange-500" : "")}
              {stat("Invalid lines", invalidCount, invalidCount > 0 ? "text-red-500" : "")}
              {stat("Proxies", bypassProxies ? "bypassed" : (proxyMode === "none" ? activeProxyCount : `${activeProxyCount} pool`), bypassProxies ? "text-orange-500" : "")}
              {stat("Last run", currentRun && !running ? `${currentRun.success}✓/${currentRun.failed}✗` : running ? "running…" : "—")}
            </>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* Accounts input (or identity generator for selfGenerated kinds) */}
        {selfGenerated ? (
          <div className="rounded-xl border border-border-subtle bg-vibrancy p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Identities</span>
              <span className="text-xs opacity-60">auto-generated disposable accounts</span>
            </div>
            <div className="text-xs opacity-70 leading-5">
              Automation ini membuat identitas sendiri (email disposable catch-all +
              password acak), verifikasi email otomatis, memanen API key dan langsung
              meng-importnya ke <b>{kind.label}</b> di Providers — tanpa file txt.
              Angka di bawah adalah <b>target sukses</b>: attempt yang gagal otomatis
              di-retry dengan identitas baru sampai target tercapai (maks. 3× percobaan).
            </div>
            <label className="flex items-center gap-3 text-xs opacity-80">
              Target sukses per run
              <input
                type="number" min={1} max={50}
                className="input input-bordered input-sm w-20"
                value={genLimit}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setGenLimit(Math.min(50, Math.max(1, Number.isFinite(v) ? Math.floor(v) : 1)));
                }}
              />
              <span className="opacity-50">(1–50 sukses/run)</span>
            </label>
          </div>
        ) : (
          <div className="rounded-xl border border-border-subtle bg-vibrancy p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Accounts</span>
              <div className="flex items-center gap-2">
                {invalidCount > 0 && (
                  <button className="btn btn-ghost btn-xs" onClick={() => setShowInvalid((v) => !v)}>
                    {showInvalid ? "Hide" : "Show"} {invalidCount} invalid
                  </button>
                )}
                <span className="text-xs opacity-60">
                  <span className="text-green-600 dark:text-green-400 font-medium">{validCount}</span> valid ·{" "}
                  <code className="font-mono">email|password</code>/line
                </span>
              </div>
            </div>
            <textarea
              className="input input-bordered w-full h-56 font-mono text-xs leading-5 resize-y"
              placeholder={"user1@gmail.com|password1\nuser2@gmail.com|password2\n# lines starting with # are ignored"}
              value={accountsText}
              onChange={(e) => setAccountsText(e.target.value)}
              spellCheck={false}
            />
            {showInvalid && invalidCount > 0 && (
              <div className="max-h-28 overflow-y-auto custom-scrollbar rounded-lg bg-red-500/5 border border-red-500/20 p-2 space-y-0.5">
                {parsed.invalid.map((it, i) => (
                  <div key={i} className="text-[10px] font-mono text-red-500 truncate" title={it.raw}>
                    ✗ {it.raw} <span className="opacity-60">— {it.reason}</span>
                  </div>
                ))}
              </div>
            )}
            {duplicateCount > 0 && (
              <div className="text-[11px] text-orange-500">
                ⚠ {duplicateCount} duplicate email{duplicateCount === 1 ? "" : "s"} detected — both lines will run.
              </div>
            )}
          </div>
        )}

        {/* Options + proxies + run */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border-subtle bg-vibrancy p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Run options</span>
              <button
                className="btn border-orange-500 bg-orange-500 text-white hover:border-orange-600 hover:bg-orange-600 disabled:border-orange-500/30 disabled:bg-orange-500/30 disabled:text-white/70"
                onClick={run}
                disabled={running || (!selfGenerated && validCount === 0)}
                title={running ? "Run in progress…" : selfGenerated ? `Run until ${genLimit} account${genLimit === 1 ? "" : "s"} harvested successfully (failed attempts retry automatically)` : validCount === 0 ? "Paste at least one valid account" : "Run the farm for all valid accounts"}
              >
                <span className={`material-symbols-outlined text-[18px]${running ? " animate-spin" : ""}`}>{running ? "progress_activity" : "play_arrow"}</span>
                {running ? "Running…" : selfGenerated
                  ? `Run until ${genLimit} success${genLimit === 1 ? "" : "es"}`
                  : `Run ${validCount} account${validCount === 1 ? "" : "s"}`}
              </button>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer select-none" title="When off, harvested keys are shown as email|key text instead of being imported">
                <input type="checkbox" className="toggle toggle-success toggle-sm" checked={autoImport} onChange={(e) => setAutoImport(e.target.checked)} />
                <span className="text-xs opacity-80">Auto-import to {kind.label}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none" title="Ignore the proxy list for this run">
                <input type="checkbox" className="toggle toggle-warning toggle-sm" checked={bypassProxies} onChange={(e) => setBypassProxies(e.target.checked)} />
                <span className="text-xs opacity-80">Bypass proxies</span>
              </label>
              {!selfGenerated && (
                <label className="flex items-center gap-2 text-xs opacity-80">
                  Threads
                  <input
                    type="number" min={1} max={10}
                    className="input input-bordered input-sm w-16"
                    value={threads}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setThreads(Math.min(10, Math.max(1, Number.isFinite(v) ? v : 1)));
                    }}
                  />
                  <span className="opacity-50">(max 10)</span>
                </label>
              )}
            </div>
          </div>

          {!bypassProxies && (
            <div className="rounded-xl border border-border-subtle bg-vibrancy p-5 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-medium">Proxies</span>
                <span className="text-xs opacity-60">
                  {proxyMode === "none" ? (
                    <><span className="font-medium">{proxyCount}</span> · <code className="font-mono">ip:port</code>/line</>
                  ) : (
                    <span className={poolProxies.length ? "text-primary" : "text-orange-500"}>
                      {poolsLoading ? "loading pools…" : `${poolProxies.length} from proxy pool (live)`}
                    </span>
                  )}
                </span>
              </div>
              <label className="flex items-center gap-2 text-xs opacity-80">
                Rotation strategy
                <select
                  className="select select-bordered select-sm w-44"
                  value={proxyMode}
                  onChange={(e) => setProxyMode(e.target.value)}
                  title="none = manual list below; other strategies pull the LIVE proxy-pool inventory and hide the textarea"
                >
                  <option value="none">none (manual list)</option>
                  <option value="smart">smart</option>
                  <option value="round-robin">round-robin</option>
                  <option value="random">random</option>
                </select>
              </label>
              {proxyMode === "none" ? (
                <textarea
                  className="input input-bordered w-full h-24 font-mono text-xs leading-5 resize-y"
                  placeholder={"127.0.0.1:8080\nuser:pass@ip:port\n# one proxy per line"}
                  value={proxiesText}
                  onChange={(e) => setProxiesText(e.target.value)}
                  spellCheck={false}
                />
              ) : (
                <div className="max-h-24 overflow-y-auto custom-scrollbar rounded-lg bg-black/5 dark:bg-white/5 p-2 space-y-0.5">
                  {poolsLoading ? (
                    <div className="text-[10px] opacity-60 font-mono">Loading proxy pools…</div>
                  ) : poolProxies.length === 0 ? (
                    <div className="text-[10px] text-orange-500 font-mono">No active pools with a proxy URL — add pools in Proxy Pools or switch to manual list.</div>
                  ) : (
                    poolProxies.map((u, i) => (
                      <div key={i} className="text-[10px] font-mono opacity-70 truncate" title={u}>{u}</div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {!selfGenerated && (
            <div className="flex justify-end">
              <button className="btn btn-secondary" onClick={clearAll} disabled={!accountsText}>Clear</button>
            </div>
          )}
        </div>
      </div>

      {/* Active run progress + console */}
      {(running || (currentRun && runResults.length > 0)) && (
        <div className="rounded-xl border border-primary/30 bg-vibrancy p-5 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
              {running && <span className="loading loading-spinner loading-sm" />}
              {running ? "Run in progress…" : <>Results {runBadge(currentRun.status)}</>}
              <span className="text-xs opacity-60">
                {currentRun?.success || 0} ✓ / {currentRun?.failed || 0} ✗{totalAccounts ? ` / ${totalAccounts}` : ""}
                {running && currentRun?.createdAt ? ` · ${fmtElapsed(currentRun.createdAt)}` : ""}
              </span>
            </span>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost btn-xs" onClick={() => setAutoScrollLog((v) => !v)}>
                Auto-scroll {autoScrollLog ? "ON" : "OFF"}
              </button>
              <button className="btn btn-ghost btn-xs" onClick={() => setConsoleCleared(true)}>Clear console</button>
            </div>
          </div>
          {running && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs font-mono text-text-muted">
                <span>Progress: {doneCount} of {totalAccounts} finished</span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                <div
                  className="h-full rounded-full bg-orange-500 transition-all duration-300 ease-out"
                  style={{ width: `${Math.max(5, progressPct)}%` }}
                />
              </div>
            </div>
          )}
          <pre
            ref={logBoxRef}
            className="max-h-48 overflow-y-auto custom-scrollbar text-[11px] font-mono opacity-80 whitespace-pre-wrap bg-black/5 dark:bg-white/5 rounded-lg p-3"
          >
            {showLog ? (currentRun?.log || "Starting…").split("\n").slice(-120).join("\n") : ""}
          </pre>
        </div>
      )}

      {/* Results table with filter/search/CSV */}
      {currentRun && !running && runResults.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-vibrancy overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border-subtle flex-wrap">
            <span className="text-sm font-medium flex items-center gap-2">
              Results {runBadge(currentRun.status)}
              <span className="text-xs opacity-60">{currentRun.success} ✓ / {currentRun.failed} ✗ · {runResults.length} rows</span>
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1">
                {["all", "success", "failed"].map((f) => (
                  <button key={f} onClick={() => setResultFilter(f)}
                    className={`btn btn-xs ${resultFilter === f ? "btn-primary" : "btn-ghost"}`}>
                    {f}
                  </button>
                ))}
              </div>
              <input
                className="input input-bordered input-sm w-36 font-mono"
                placeholder="Search email/error…"
                value={resultSearch}
                onChange={(e) => setResultSearch(e.target.value)}
              />
              <button className="btn btn-secondary btn-sm" onClick={exportResultsCsv}>CSV</button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto custom-scrollbar">
            <table className="table table-sm text-sm w-full">
              <thead className="sticky top-0 bg-surface-2/95 backdrop-blur">
                <tr>
                  <th className="text-left">Email</th>
                  <th className="text-left">Key</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">Imported</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.map((r) => (
                  <tr key={r.id} className="border-t border-border-subtle">
                    <td className="font-mono text-xs">{r.email}</td>
                    <td className="font-mono text-xs">
                      {r.apiKey ? `${r.apiKey.slice(0, 10)}…${r.apiKey.slice(-6)}` : <span className="opacity-40" title={r.error || ""}>—</span>}
                    </td>
                    <td>
                      {r.status === "success"
                        ? <span className="inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400"><span className="size-1.5 rounded-full bg-green-500" /> Success</span>
                        : <span className="inline-flex items-center gap-1.5 text-xs text-red-500" title={r.error || ""}><span className="size-1.5 rounded-full bg-red-500" /> {r.error || "Failed"}</span>}
                    </td>
                    <td>
                      {r.connectionId
                        ? <span className="inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400"><span className="material-symbols-outlined text-[14px]">check_circle</span> {kind.label}</span>
                        : <span className="text-xs opacity-40">—</span>}
                    </td>
                  </tr>
                ))}
                {filteredResults.length === 0 && (
                  <tr><td colSpan={4} className="text-center text-xs opacity-50 py-4">No rows match the filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Exportable email|key output */}
      {currentRun && !running && exportedKeys && (
        <div className="rounded-xl border border-border-subtle bg-vibrancy p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              Output <span className="text-xs opacity-60">— email|key, one per line ({exportedKeys.split("\n").length} keys)</span>
            </span>
            <button className="btn btn-secondary btn-sm" onClick={copyKeys}>
              {copied ? "✓ Copied!" : "Copy"}
            </button>
          </div>
          <textarea
            readOnly
            className="input input-bordered w-full h-40 font-mono text-xs leading-5"
            value={exportedKeys}
            onFocus={(e) => e.target.select()}
          />
        </div>
      )}

      {/* Run history */}
      {history.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-vibrancy overflow-hidden">
          <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
            <span className="text-sm font-medium">Run history</span>
            <span className="text-xs opacity-50">{history.length} runs</span>
          </div>
          <div className="max-h-56 overflow-y-auto custom-scrollbar">
            <table className="table table-sm text-sm w-full">
              <tbody>
                {history.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-t border-border-subtle ${currentRun?.id === r.id ? "bg-primary/5" : ""} cursor-pointer hover:bg-surface-2`}
                    onClick={() => pollRun(r.id)}
                  >
                    <td className="text-xs opacity-60 font-mono">{new Date(r.createdAt).toLocaleString()}</td>
                    <td>{runBadge(r.status)}</td>
                    <td className="text-xs">{r.success} ✓ / {r.failed} ✗</td>
                    <td className="text-xs opacity-50">{(r.log || "").split("\n").filter(Boolean).length || 0} lines</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="alert alert-info text-sm">
        <div>
          Dengan <b>Auto-import</b> aktif, key sukses langsung masuk ke{" "}
          <a href="/dashboard/providers" className="link">Providers</a> (Free Tier). Output{" "}
          <code className="font-mono">email|key</code> selalu tersedia di kotak Output di atas.
        </div>
      </div>
    </div>
  );
}
