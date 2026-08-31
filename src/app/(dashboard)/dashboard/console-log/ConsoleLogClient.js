"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Card, Button, Input, Select } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

/* ── Line classification ──────────────────────────────────────────────────
 * Every 9router log line carries a [TAG] and/or marker emoji. Tabs route
 * lines by concern so an expert can watch one subsystem at a time. */

const TAG_COLORS = {
  CHAT: "text-blue-300", COMBO: "text-cyan-300", AUTH: "text-sky-300",
  FALLBACK: "text-orange-300", GATE: "text-amber-300", PROXY: "text-violet-300",
  TOKEN: "text-pink-300", DEGENERATE: "text-red-400", ProviderFailure: "text-red-300",
  SEMAPHORE: "text-fuchsia-300",
};

const TABS = [
  { id: "all", label: "All", match: () => true },
  { id: "requests", label: "Requests", match: (l) => /▶|📊 DONE|✗ ERROR|ABORTED|⚙|📥|📤/.test(l) },
  { id: "routing", label: "Routing", match: (l) => /\[(CHAT|COMBO|FALLBACK|AUTH|GATE)\]/.test(l) },
  { id: "proxy", label: "Proxy", match: (l) => /\[(PROXY|SEMAPHORE|DEGENERATE)\]|ProxyFetch|ProviderFailure|pool=/.test(l) },
  { id: "errors", label: "Errors", match: (l) => /✗|❌|⚠️|threw error|failed|UNAVAILABLE|breaker opened/i.test(l) },
  { id: "system", label: "System", match: (l) => /\[(TOKEN|BG_TOKEN_REFRESH|QUOTA-MONITOR|ProjectId|RTK)\]|Scheduler started|Next\.js|Ready in|Driver:/.test(l) },
];

const BUFFER_OPTIONS = [
  { value: "200", label: "200 lines" },
  { value: "1000", label: "1,000 lines" },
  { value: "5000", label: "5,000 lines" },
];
const RENDER_LIMIT = 1000; // DOM cap for filtered output

function parseLine(line) {
  // "[12:34:56] SYMBOL [TAG] message" — timestamp is always the first bracket
  const tsMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
  const ts = tsMatch ? tsMatch[1] : null;
  const tagMatch = line.match(/\[(CHAT|COMBO|AUTH|FALLBACK|GATE|PROXY|TOKEN|DEGENERATE|ProviderFailure|SEMAPHORE)\]/);
  const warn = line.includes("⚠️");
  const err = line.includes("✗") || line.includes("❌");
  return { ts, tag: tagMatch?.[1] || null, warn, err };
}

function Line({ line }) {
  const { ts, tag, warn, err } = parseLine(line);
  const cls = err ? "text-red-400" : warn ? "text-yellow-400" : tag ? TAG_COLORS[tag] || "text-green-400" : "text-green-400";
  return (
    <div className="whitespace-pre-wrap break-all">
      {ts && <span className="text-gray-500">{`[${ts}] `}</span>}
      <span className={cls}>{ts ? line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "") : line}</span>
    </div>
  );
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [exclude, setExclude] = useState("");
  const [autoScroll, setAutoScroll] = useState(false); // OFF by default
  const [paused, setPaused] = useState(false);
  const [bufferSize, setBufferSize] = useState(String(CONSOLE_LOG_CONFIG.maxLines));
  const [newCount, setNewCount] = useState(0);

  const logRef = useRef(null);
  const pausedBuffer = useRef([]);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const maxLines = Number(bufferSize) || CONSOLE_LOG_CONFIG.maxLines;

  const pushLines = useCallback((incoming) => {
    if (pausedRef.current) {
      // Keep capturing into the paused buffer; merged on resume.
      pausedBuffer.current = [...pausedBuffer.current, ...incoming].slice(-maxLines);
      setNewCount((n) => n + incoming.length);
      return;
    }
    setLogs((prev) => {
      const next = [...prev, ...incoming];
      return next.length > maxLines ? next.slice(-maxLines) : next;
    });
  }, [maxLines]);

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "init") pushLines(msg.logs.slice(-maxLines));
      else if (msg.type === "line") pushLines([msg.line]);
      else if (msg.type === "lines") pushLines(msg.lines);
      else if (msg.type === "clear") { setLogs([]); pausedBuffer.current = []; setNewCount(0); }
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [pushLines, maxLines]);

  // Follow the tail only when auto-scroll is explicitly enabled.
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
      setNewCount(0);
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setNewCount(0);
  };

  const resume = () => {
    setPaused(false);
    if (pausedBuffer.current.length) {
      setLogs((prev) => [...prev, ...pausedBuffer.current].slice(-maxLines));
      pausedBuffer.current = [];
    }
  };

  const filtered = useMemo(() => {
    const t = TABS.find((x) => x.id === tab) || TABS[0];
    const q = search.trim().toLowerCase();
    const x = exclude.trim().toLowerCase();
    return logs.filter((l) => {
      if (!t.match(l)) return false;
      if (q && !l.toLowerCase().includes(q)) return false;
      if (x && l.toLowerCase().includes(x)) return false;
      return true;
    });
  }, [logs, tab, search, exclude]);

  const tabCounts = useMemo(() => {
    const counts = {};
    for (const t of TABS) counts[t.id] = logs.reduce((n, l) => n + (t.match(l) ? 1 : 0), 0);
    return counts;
  }, [logs]);

  const rendered = filtered.length > RENDER_LIMIT ? filtered.slice(-RENDER_LIMIT) : filtered;

  const handleClear = async () => {
    try { await fetch("/api/translator/console-logs", { method: "DELETE" }); } catch {}
  };
  const handleCopy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(filtered.join("\n")).catch(() => {});
  };
  const handleDownload = () => {
    const blob = new Blob([filtered.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `9router-console-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <Card className="p-3 flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${connected ? "text-green-500" : "text-red-500"}`}>
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          {connected ? "Live" : "Disconnected"}
        </span>
        <span className="text-xs text-text-muted">{logs.length.toLocaleString()} buffered</span>

        <span className="flex-1" />

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter contains…"
          className="w-44 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-xs dark:border-white/10"
        />
        <input
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          placeholder="Exclude…"
          className="w-36 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-xs dark:border-white/10"
        />
        <select
          value={bufferSize}
          onChange={(e) => setBufferSize(e.target.value)}
          className="rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs dark:border-white/10"
        >
          {BUFFER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button size="sm" variant={autoScroll ? "primary" : "outline"} icon="vertical_align_bottom"
          onClick={() => setAutoScroll((v) => !v)} title="Follow new lines (off by default)">
          Auto-scroll {autoScroll ? "ON" : "OFF"}
        </Button>
        <Button size="sm" variant={paused ? "primary" : "outline"} icon={paused ? "play_arrow" : "pause"}
          onClick={() => (paused ? resume() : setPaused(true))}>
          {paused ? `Resume${pausedBuffer.current.length ? ` (+${pausedBuffer.current.length})` : ""}` : "Pause"}
        </Button>
        <Button size="sm" variant="outline" icon="content_copy" onClick={handleCopy}>Copy</Button>
        <Button size="sm" variant="outline" icon="download" onClick={handleDownload}>Save</Button>
        <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>Clear</Button>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.id
                ? "bg-primary text-white"
                : "bg-black/[0.04] text-text-main hover:bg-black/[0.08] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
            }`}>
            {t.label}
            <span className={`ml-1.5 tabular-nums ${tab === t.id ? "text-white/70" : "text-text-muted"}`}>
              {tabCounts[t.id].toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      {/* Log viewer */}
      <Card className="relative overflow-hidden p-0">
        <div ref={logRef} onScroll={handleScroll}
          className="h-[calc(100vh-300px)] overflow-y-auto bg-black p-4 font-mono text-xs">
          {rendered.length === 0 ? (
            <span className="text-text-muted">
              {logs.length === 0 ? "No console logs yet." : "No lines match the current filters."}
            </span>
          ) : (
            <>
              {filtered.length > RENDER_LIMIT && (
                <div className="mb-2 text-gray-500">
                  … showing newest {RENDER_LIMIT.toLocaleString()} of {filtered.length.toLocaleString()} matched lines
                </div>
              )}
              <div className="space-y-0.5">
                {rendered.map((line, i) => <Line key={i} line={line} />)}
              </div>
            </>
          )}
        </div>

        {/* Floating jump-to-bottom with unread count (visible when not following) */}
        {!autoScroll && (
          <button
            onClick={() => { const el = logRef.current; if (el) { el.scrollTop = el.scrollHeight; setNewCount(0); } }}
            className="absolute bottom-3 right-4 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:opacity-90"
          >
            ↓ Latest{newCount > 0 ? ` · ${newCount.toLocaleString()} new` : ""}
          </button>
        )}
      </Card>
    </div>
  );
}
