"use client";

import { useCallback, useEffect, useState } from "react";

const DEFAULTS = {
  baseUrl: "https://www.codebuff.com",
  costMode: "free",
  useSessions: true,
  useAgentRuns: true,
  sessionTtlMs: 600000,
};

export default function FreebuffSettingsPage() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [status, setStatus] = useState("loading");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/freebuff/settings");
      if (res.ok) setSettings({ ...DEFAULTS, ...(await res.json()) });
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/freebuff/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...settings,
          sessionTtlMs: Number(settings.sessionTtlMs) || DEFAULTS.sessionTtlMs,
        }),
      });
      if (res.ok) {
        setSettings({ ...DEFAULTS, ...(await res.json()) });
        setStatus("saved");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  const set = (key) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setSettings((s) => ({ ...s, [key]: value }));
    setStatus("dirty");
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">FreeBuff</h1>
        <p className="text-sm opacity-70 mt-1">
          Native codebuff.com integration — no freebuff-proxy process needed. Paste your{" "}
          <code>cb_...</code> token as an API key on the{" "}
          <a href="/dashboard/providers" className="link">Providers</a> page (FreeBuff, Free Tier).
        </p>
      </div>

      {status === "loading" && <div className="text-sm opacity-60">Loading…</div>}

      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Upstream base URL</span>
          <input
            type="text"
            className="input input-bordered w-full mt-1"
            value={settings.baseUrl}
            onChange={set("baseUrl")}
          />
          <span className="text-xs opacity-60">Default https://www.codebuff.com — leave as-is unless upstream moves.</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Cost mode</span>
          <select className="select select-bordered w-full mt-1" value={settings.costMode} onChange={set("costMode")}>
            <option value="free">free (keep requests on the free tier)</option>
            <option value="">omit (routes as PAID — fresh accounts get 402)</option>
          </select>
        </label>

        <label className="flex items-center gap-3">
          <input type="checkbox" className="checkbox" checked={!!settings.useSessions} onChange={set("useSessions")} />
          <span className="text-sm">Reuse freebuff session per token (instance id in request metadata)</span>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Session refresh interval (ms)</span>
          <input
            type="number"
            className="input input-bordered w-full mt-1"
            value={settings.sessionTtlMs}
            onChange={set("sessionTtlMs")}
            min={60000}
            step={60000}
          />
        </label>

        <label className="flex items-center gap-3">
          <input type="checkbox" className="checkbox" checked={!!settings.useAgentRuns} onChange={set("useAgentRuns")} />
          <span className="text-sm">Send agent-runs START/FINISH like the official CLI</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={save} disabled={saving || status === "loading"}>
          {saving ? "Saving…" : "Save"}
        </button>
        {status === "saved" && <span className="text-sm text-success">Saved</span>}
        {status === "dirty" && <span className="text-sm opacity-60">Unsaved changes</span>}
        {status === "error" && <span className="text-sm text-error">Failed to save</span>}
      </div>

      <div className="alert alert-warning text-sm">
        <div>
          <b>Quota &amp; ban notes:</b> 429 = daily quota exhausted (resets 07:00 UTC / Pacific midnight) — 9router
          auto-locks the token and fails over to the next one. 403 <i>banned</i> is terminal. No uTLS stealth is
          applied natively, so ban risk is higher than going through freebuff-proxy; usage conflicts with
          FreeBuff/Codebuff ToS.
        </div>
      </div>
    </div>
  );
}
