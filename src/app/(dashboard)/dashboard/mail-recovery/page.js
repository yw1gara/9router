"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Input } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Official OpenAI device-flow constants (same wire contract as the Codex CLI).
const AUTH_BASE = "https://auth.openai.com";
const DEVICE_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const VERIFICATION_URI = `${AUTH_BASE}/codex/device`;

const OTP_POLL_MS = 5000;
const OTP_TIMEOUT_MS = 10 * 60 * 1000;

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

/**
 * Mail Recovery — semi-automatic Codex re-login assist.
 *
 * 1. Store the mailbox credential (email----password----client_id----refresh_token;
 *    the password slot is parsed away and discarded — login happens in YOUR browser).
 * 2. "Re-login" runs the OFFICIAL device flow: the browser asks auth.openai.com for
 *    a user_code, you sign in at auth.openai.com/codex/device (password + OTP).
 * 3. While you sign in, the OTP watcher pulls the 6-digit code from your mailbox via
 *    IMAP and shows it here — no inbox hunting.
 * 4. Once authorized, the browser exchanges the code for tokens and the backend
 *    persists them as a Codex connection (refresh serializer keeps them safe).
 */
export default function MailRecoveryPage() {
  const notify = useNotificationStore();
  const { copied, copy } = useCopyToClipboard(2000);
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [line, setLine] = useState("");
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  // Device-flow session per credential id
  const [flow, setFlow] = useState(null); // { credId, email, userCode, status, error, otp, connection }
  const pollRef = useRef(null);
  const otpRef = useRef(null);

  const fetchCredentials = useCallback(async () => {
    try {
      const res = await fetch("/api/mail-recovery", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setCredentials(data.credentials || []);
    } catch (error) {
      console.log("Error fetching IMAP credentials:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchCredentials(), 0);
    return () => clearTimeout(t);
  }, [fetchCredentials]);

  // Stop all pollers on unmount
  useEffect(() => () => {
    clearInterval(pollRef.current);
    clearInterval(otpRef.current);
  }, []);

  const stopPollers = () => {
    clearInterval(pollRef.current);
    pollRef.current = null;
    clearInterval(otpRef.current);
    otpRef.current = null;
  };

  const handleAdd = async () => {
    if (!line.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/mail-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: line.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setLine("");
        await fetchCredentials();
        notify.success(`Mailbox added: ${data.credential.email}`);
      } else {
        notify.error(data.error || "Failed to add mailbox");
      }
    } catch {
      notify.error("Failed to add mailbox");
    } finally {
      setAdding(false);
    }
  };

  const handleTest = async (cred) => {
    setTestingId(cred.id);
    try {
      const res = await fetch(`/api/mail-recovery/${cred.id}/test`, { method: "POST" });
      const data = await res.json();
      if (data.ok) notify.success(`IMAP OK for ${cred.email}`);
      else notify.error(`IMAP failed: ${data.error || "unknown"}`);
      await fetchCredentials();
    } catch {
      notify.error("Test failed");
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = (cred) => {
    setConfirmState({
      title: "Delete Mailbox Credential",
      message: `Remove IMAP credential for ${cred.email}?`,
      onConfirm: async () => {
        setConfirmState(null);
        if (flow?.credId === cred.id) { stopPollers(); setFlow(null); }
        await fetch(`/api/mail-recovery?id=${cred.id}`, { method: "DELETE" }).catch(() => {});
        await fetchCredentials();
        notify.success("Credential deleted");
      },
    });
  };

  /** Start the OFFICIAL device flow from the browser (auth.openai.com allows CORS). */
  const startRelogin = async (cred) => {
    stopPollers();
    setFlow({ credId: cred.id, email: cred.email, userCode: null, status: "requesting", error: null, otp: null, connection: null });
    const startedAt = Date.now();
    try {
      const res = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
      });
      const data = await res.json();
      const userCode = data.user_code || data.usercode;
      if (!res.ok || !data.device_auth_id || !userCode) {
        throw new Error(`usercode failed (${res.status})`);
      }
      setFlow({ credId: cred.id, email: cred.email, userCode, status: "awaiting_authorization", error: null, otp: null, connection: null });

      // OTP watcher: poll the mailbox while the user signs in
      otpRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/mail-recovery/${cred.id}/otp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sinceMs: startedAt }),
          });
          const d = await r.json();
          if (d.otp) {
            setFlow((prev) => (prev?.credId === cred.id ? { ...prev, otp: d.otp } : prev));
          }
        } catch { /* keep polling */ }
        if (Date.now() - startedAt > OTP_TIMEOUT_MS) {
          clearInterval(otpRef.current);
          otpRef.current = null;
          setFlow((prev) => (prev?.credId === cred.id ? { ...prev, status: "timeout", error: "OTP window timed out" } : prev));
        }
      }, OTP_POLL_MS);

      // Device-auth poller: wait for the user to authorize, then exchange tokens
      const intervalSec = Number.isFinite(data.interval) && data.interval > 0 ? data.interval : 5;
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ device_auth_id: data.device_auth_id, user_code: userCode }),
          });
          if (r.status === 403 || r.status === 404) return; // still pending
          if (!r.ok) return;
          const auth = await r.json();
          if (!auth.authorization_code || !auth.code_verifier) return;

          clearInterval(pollRef.current);
          pollRef.current = null;

          const tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: DEVICE_CLIENT_ID,
              code: auth.authorization_code,
              code_verifier: auth.code_verifier,
              redirect_uri: `${AUTH_BASE}/deviceauth/callback`,
            }),
          });
          const tokens = await tokenRes.json();
          if (!tokenRes.ok || !tokens.access_token) {
            throw new Error(`token exchange failed (${tokenRes.status})`);
          }

          const applyRes = await fetch("/api/mail-recovery/apply-codex", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tokens, email: cred.email }),
          });
          const applied = await applyRes.json();
          if (!applyRes.ok) throw new Error(applied.error || "apply failed");

          clearInterval(otpRef.current);
          otpRef.current = null;
          setFlow((prev) => (prev?.credId === cred.id ? { ...prev, status: "done", connection: applied.connection } : prev));
          notify.success(`Codex connection saved: ${applied.connection.email || cred.email}`);
          await fetchCredentials();
        } catch (err) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          clearInterval(otpRef.current);
          otpRef.current = null;
          setFlow((prev) => (prev?.credId === cred.id ? { ...prev, status: "error", error: String(err?.message || err) } : prev));
        }
      }, intervalSec * 1000);
    } catch (err) {
      setFlow((prev) => (prev?.credId === cred.id ? { ...prev, status: "error", error: String(err?.message || err) } : prev));
    }
  };

  const cancelFlow = () => {
    stopPollers();
    setFlow(null);
  };

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Mail Recovery</h1>
        <p className="text-xs text-text-muted mt-1">
          Semi-auto Codex re-login: official device flow in your browser + OTP fetched straight from your Outlook mailbox.
          Passwords are never stored — the password slot in the paste format is discarded on import.
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-3">
          <Input
            label="Add mailbox (paste format)"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="email----password----client_id----refresh_token"
            hint={<>4-part paste format accepted — the password field is parsed away and NOT stored. A 3-part format (email----client_id----refresh_token) also works.</>}
          />
          <div>
            <Button onClick={handleAdd} disabled={!line.trim() || adding}>
              {adding ? "Adding..." : "Add Mailbox"}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-3 text-sm font-semibold">Mailboxes ({credentials.length})</div>
        {credentials.length === 0 ? (
          <div className="py-6 text-center text-sm text-text-muted">
            No mailboxes yet — paste a credential line above.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
            {credentials.map((cred) => (
              <div key={cred.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-text-muted">mail</span>
                  <span className="text-sm font-medium">{cred.email}</span>
                  <Badge variant={cred.testStatus === "active" ? "success" : cred.testStatus === "error" ? "error" : "default"} size="sm" dot>
                    {cred.testStatus || "untested"}
                  </Badge>
                  <Button size="sm" icon="science" onClick={() => handleTest(cred)} disabled={testingId === cred.id}>
                    {testingId === cred.id ? "Testing..." : "Test IMAP"}
                  </Button>
                  <Button size="sm" icon="login" onClick={() => startRelogin(cred)} disabled={flow?.credId === cred.id}>
                    Re-login Codex
                  </Button>
                  <button
                    onClick={() => handleDelete(cred)}
                    className="ml-auto rounded p-2 text-red-500 hover:bg-red-500/10"
                    title="Delete"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
                <div className="text-xs text-text-muted">
                  client_id: <span className="font-mono">{cred.clientId}</span> · refresh: <span className="font-mono">{cred.refreshTokenMasked}</span>
                  {cred.lastError ? ` · last error: ${cred.lastError}` : ""}
                  {` · tested ${formatDateTime(cred.lastTested)}`}
                </div>

                {/* Device-flow session panel */}
                {flow?.credId === cred.id && (
                  <div className="mt-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">Re-login: {flow.email}</span>
                      <Badge variant={flow.status === "done" ? "success" : flow.status === "error" || flow.status === "timeout" ? "error" : "warning"} size="sm">
                        {flow.status.replace(/_/g, " ")}
                      </Badge>
                      <button onClick={cancelFlow} className="ml-auto text-xs text-text-muted hover:text-primary">
                        Cancel
                      </button>
                    </div>

                    {flow.userCode && flow.status !== "done" && (
                      <div className="mt-2 flex flex-col gap-2">
                        <div className="text-xs text-text-muted">
                          1. Open the verification page and sign in with your OpenAI account password.
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <a href={VERIFICATION_URI} target="_blank" rel="noopener noreferrer">
                            <Button size="sm" variant="secondary" icon="open_in_new">Open verification page</Button>
                          </a>
                          <span className="text-xs text-text-muted">2. Enter this code:</span>
                          <button
                            onClick={() => copy(flow.userCode)}
                            className="rounded-lg bg-white px-3 py-1.5 font-mono text-lg font-bold tracking-[0.3em] text-text-main shadow dark:bg-white/10"
                            title="Copy code"
                          >
                            {flow.userCode}
                          </button>
                          {copied && <span className="text-xs text-emerald-500">copied!</span>}
                        </div>
                        <div className="text-xs text-text-muted">
                          3. When OpenAI emails your OTP, it appears below automatically.
                        </div>
                      </div>
                    )}

                    {flow.otp && flow.status !== "done" && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2">
                        <span className="material-symbols-outlined text-[20px] text-emerald-500">mark_email_read</span>
                        <span className="text-xs text-text-muted">OTP from {flow.otp.from || "OpenAI"}:</span>
                        <button
                          onClick={() => copy(flow.otp.code)}
                          className="font-mono text-2xl font-bold tracking-[0.35em] text-emerald-600 dark:text-emerald-400"
                          title="Copy OTP"
                        >
                          {flow.otp.code}
                        </button>
                        {copied && <span className="text-xs text-emerald-500">copied!</span>}
                        <span className="text-[11px] text-text-muted">({flow.otp.subject?.slice(0, 50)})</span>
                      </div>
                    )}

                    {flow.status === "awaiting_authorization" && !flow.otp && (
                      <div className="mt-2 text-xs text-text-muted animate-pulse">
                        Waiting for authorization / OTP… (watching {flow.email})
                      </div>
                    )}
                    {flow.status === "done" && flow.connection && (
                      <div className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                        ✓ Codex connection saved{flow.connection.email ? ` for ${flow.connection.email}` : ""} — tokens are now protected by the refresh serializer.
                      </div>
                    )}
                    {flow.error && (
                      <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                        {flow.error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
