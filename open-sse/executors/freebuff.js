// FreeBuff native executor — reimplements the codebuff.com wire protocol
// (reference: trefeon/freebuff-proxy internal/upstream/client.go) so 9router
// can use FreeBuff free coding models WITHOUT running freebuff-proxy.
//
// Wire contract (per upstream CLI gate):
//   POST https://www.codebuff.com/api/v1/chat/completions
//   Headers: Authorization: Bearer <cb_...>, UA ai-sdk/openai-compatible/1.0.0/codebuff
//            (+ optional x-freebuff-model / x-freebuff-instance-id on SESSION calls only)
//   Body: OpenAI shape + codebuff_metadata envelope, provider.data_collection=deny,
//         stream forced true, stop sentinel ["cb_easp"], and the canonical
//         "You are Buffy…" system prefix at position 0.
//
// Quota semantics: 429 = daily quota (resets Pacific midnight), 403
// banned/country_blocked = terminal. See accountFallback for lock behavior.
//
// NOTE: no uTLS fingerprint stealth (Node has none) — ban risk is higher than
// going through freebuff-proxy; upstream also hard-blocks proxy/VPN egress,
// so requests always go DIRECT (no proxyOptions forwarding).
import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { randomUUID } from "crypto";

const DEFAULT_BASE_URL = "https://www.codebuff.com";
const CHAT_UA = "ai-sdk/openai-compatible/1.0.0/codebuff";
export const BUFFY_MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
const BUFFY_PHRASE = "You are Buffy, the strategic coding assistant";

// Runtime settings (defaults mirror freebuff-proxy SAFE_MODE defaults). The
// dashboard settings page persists these to localDb and pushes them here via
// setFreebuffSettings — the executor itself never touches the DB.
const settings = {
  baseUrl: DEFAULT_BASE_URL,
  costMode: "free", // "" omits; "free" keeps fresh accounts out of paid routing
  useSessions: true, // create/reuse a freebuff session per token (instance id)
  useAgentRuns: true, // START/FINISH agent runs like the official CLI
  sessionTtlMs: 10 * 60 * 1000, // re-create the cached session after this
};

export function getFreebuffSettings() {
  return { ...settings };
}

export function setFreebuffSettings(patch = {}) {
  const allowed = ["baseUrl", "costMode", "useSessions", "useAgentRuns", "sessionTtlMs"];
  for (const k of allowed) {
    if (patch[k] !== undefined) settings[k] = patch[k];
  }
  return getFreebuffSettings();
}

// Free mode is only available for specific agent+model combinations
// (upstream FREEBUFF_ROOT_AGENT_ID_BY_MODEL). New sessions must use the
// CURRENT-generation base3 roots (FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL);
// base2 roots only resolve already-admitted legacy sessions, and a NEW run
// with a base2 root 403s with free_mode_invalid_agent_model.
export const ROOT_AGENT_BY_MODEL = {
  "mimo/mimo-v2.5": "base3-free-mimo",
  "minimax/minimax-m3": "base3-free-minimax-m3",
  "openai/gpt-5.6-luna": "base3-free-luna",
  "deepseek/deepseek-v4-pro": "base3-free-deepseek",
  "deepseek/deepseek-v4-flash": "base3-free-deepseek-flash",
  "z-ai/glm-5.2": "base3-free-glm",
  "crof/kimi-k3-eco": "base3-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base3-free-fable",
  "meta/muse-spark-1.2-contributor": "base3-free-muse-spark",
  // -max extended-context variants have no base3 twin yet — base2 only
  "deepseek/deepseek-v4-pro-max": "base2-free-deepseek-pro-max",
  "deepseek/deepseek-v4-flash-max": "base2-free-deepseek-flash-max",
  "openai/gpt-5.6-luna-max": "base2-free-luna-max",
};

// Legacy-generation roots — used as a fallback when the current gen rejects
// the combo (upstream keeps both registered; which one admits varies by
// surface/deploy state).
export const LEGACY_ROOT_AGENT_BY_MODEL = {
  "mimo/mimo-v2.5": "base2-free-mimo",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "z-ai/glm-5.2": "base2-free-glm",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

// Per-token session cache: token → { instanceId, createdAt }
const sessionCache = new Map();

function tokenKey(credentials) {
  return credentials?.apiKey || credentials?.connectionId || "anonymous";
}

// 13-char base36 draw — must match Math.random().toString(36).substring(2,15);
// the server fingerprints sess:/run:-shaped ids as proxy traffic (#103).
function generateClientID() {
  let s = "";
  while (s.length < 15) s += Math.random().toString(36).substring(2, 15);
  return s.substring(0, 13);
}

function authHeaders(credentials, extra = {}) {
  return {
    "User-Agent": CHAT_UA,
    Authorization: `Bearer ${credentials?.apiKey || ""}`,
    ...extra,
  };
}

// The upstream gate does a trimmed-prefix test on the first system message
// (position 0); merge the canonical marker without clobbering client prompts.
function ensureBuffyMarker(payload) {
  const msgs = payload.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    payload.messages = [{ role: "system", content: BUFFY_MARKER }];
    return;
  }
  const startsWithPhrase = (m) => {
    if (m?.role !== "system") return false;
    if (typeof m.content === "string") return m.content.trimStart().startsWith(BUFFY_PHRASE);
    if (Array.isArray(m.content)) {
      const first = m.content[0];
      return first?.type === "text" && typeof first.text === "string" && first.text.trimStart().startsWith(BUFFY_PHRASE);
    }
    return false;
  };
  if (msgs.some(startsWithPhrase)) return;

  const first = msgs[0];
  if (first?.role === "system") {
    if (typeof first.content === "string") {
      msgs[0] = { ...first, content: first.content === "" ? BUFFY_MARKER : `${BUFFY_MARKER}\n\n${first.content}` };
    } else if (Array.isArray(first.content)) {
      msgs[0] = { ...first, content: [{ type: "text", text: BUFFY_MARKER }, ...first.content] };
    } else {
      msgs[0] = { ...first, content: BUFFY_MARKER };
    }
    return;
  }
  payload.messages = [{ role: "system", content: BUFFY_MARKER }, ...msgs];
}

function buildEnvelopedBody(body, { runId, instanceId, stepNumber }) {
  const payload = { ...body, messages: Array.isArray(body?.messages) ? [...body.messages] : [] };
  ensureBuffyMarker(payload);
  const metadata = { run_id: runId, client_id: generateClientID() };
  if (instanceId) metadata.freebuff_instance_id = instanceId;
  if (stepNumber > 0) metadata.llm_step_number = String(stepNumber);
  if (settings.costMode) metadata.cost_mode = settings.costMode;
  payload.codebuff_metadata = metadata;
  payload.provider = { data_collection: "deny" };
  // The free-mode gate keys on forced streaming; non-stream clients are
  // served from an aggregated SSE body (aggregateSseToResponse below).
  payload.stream = true;
  if (!payload.stop) payload.stop = ["cb_easp"];
  return payload;
}

async function createSession(baseUrl, credentials, model, signal) {
  const headers = authHeaders(credentials);
  if (model) headers["x-freebuff-model"] = model;
  const res = await proxyAwareFetch(`${baseUrl}/api/v1/freebuff/session`, { method: "POST", headers, signal });
  if (!res.ok) return null; // session is best-effort; chat proceeds without it
  try {
    const data = await res.json();
    const instanceId = data?.session?.instanceId || data?.instanceId || null;
    return instanceId ? { instanceId, createdAt: Date.now() } : null;
  } catch {
    return null;
  }
}

async function ensureSession(baseUrl, credentials, model, signal, log) {
  // Sessions are admitted per model (upstream session_model_mismatch) — key
  // the cache on token+model, not token alone.
  const key = `${tokenKey(credentials)}::${model}`;
  const cached = sessionCache.get(key);
  if (cached && Date.now() - cached.createdAt < settings.sessionTtlMs) return cached.instanceId;
  const fresh = await createSession(baseUrl, credentials, model, signal);
  if (fresh) {
    sessionCache.set(key, fresh);
    return fresh.instanceId;
  }
  log?.debug?.("FREEBUFF", "no session instance id — chatting without one");
  return null;
}

async function startAgentRun(baseUrl, credentials, agentId, signal) {
  try {
    const res = await proxyAwareFetch(`${baseUrl}/api/v1/agent-runs`, {
      method: "POST",
      headers: authHeaders(credentials, { "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.runId || null;
  } catch {
    return null;
  }
}

function finishAgentRun(baseUrl, credentials, runId, status = "completed") {
  if (!runId) return;
  proxyAwareFetch(`${baseUrl}/api/v1/agent-runs`, {
    method: "POST",
    headers: authHeaders(credentials, { "Content-Type": "application/json" }),
    body: JSON.stringify({ action: "FINISH", runId, status, totalSteps: 1, directCredits: 0, totalCredits: 0, steps: [] }),
  }).catch(() => {});
}

// Aggregate an upstream SSE stream into a single OpenAI JSON response so
// non-streaming clients still work behind the forced-stream gate.
async function aggregateSseToResponse(response) {
  const text = await response.text();
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  let id = null;
  let model = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data);
      id = chunk.id || id;
      model = chunk.model || model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    } catch {
      // skip malformed frame
    }
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  return new Response(
    JSON.stringify({
      id: id || `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || "freebuff",
      choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
      usage: usage || {},
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", { baseUrl: `${DEFAULT_BASE_URL}/api/v1/chat/completions` });
  }

  buildUrl() {
    return `${settings.baseUrl}/api/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    return authHeaders(credentials, {
      "Content-Type": "application/json",
      Accept: stream ? "application/json, text/event-stream" : "application/json",
    });
  }

  transformRequest(model, body, ctx = {}) {
    return buildEnvelopedBody(body, ctx);
  }

  // Zero-cost token validation for the dashboard Check button: a GET on the
  // session endpoint without an instance header claims no session slot.
  async validateToken(credentials) {
    const res = await proxyAwareFetch(`${settings.baseUrl}/api/v1/freebuff/session`, {
      method: "GET",
      headers: authHeaders(credentials),
    });
    if (res.status === 401 || res.status === 403) return { valid: false, error: "Invalid or banned token" };
    return { valid: true, error: null };
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const baseUrl = settings.baseUrl;
    // Free mode gate: reject models without a known free-mode root agent
    // upfront, so the client gets a clear error instead of an upstream 403.
    const agentId = ROOT_AGENT_BY_MODEL[model];
    if (!agentId) {
      const err = new Error(
        `FreeBuff free mode does not offer model "${model}". Available: ${Object.keys(ROOT_AGENT_BY_MODEL).join(", ")}`
      );
      err.status = 400;
      throw err;
    }
    return this._chat(baseUrl, model, agentId, body, stream, credentials, signal, log);
  }

  // The upstream endpoint table keys on the canonical free-mode combos: the
  // official CLI always sends deepseek/deepseek-v4-flash and lets the server
  // coerce limited-tier accounts to mimo. Requesting the coerced id directly
  // 404s ("No endpoints found") — retry once with the canonical id.
  async _chat(baseUrl, model, agentId, body, stream, credentials, signal, log, retriedCanonical = false) {
    const instanceId = settings.useSessions ? await ensureSession(baseUrl, credentials, model, signal, log) : null;
    const runId = settings.useAgentRuns ? await startAgentRun(baseUrl, credentials, agentId, signal) : `run-${randomUUID()}`;
    const localRun = String(runId).startsWith("run-");
    const transformedBody = this.transformRequest(model, body, { runId, instanceId, stepNumber: 1 });
    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials, true);
    const bodyStr = JSON.stringify(transformedBody);
    log?.debug?.("FETCH", `FREEBUFF → ${url} | model=${model} | instance=${instanceId ? "yes" : "no"} | run=${runId}`);

    const response = await proxyAwareFetch(url, { method: "POST", headers, body: bodyStr, signal });

    if (response.status === 404 && !retriedCanonical && model !== "deepseek/deepseek-v4-flash") {
      // Conceded-model id (e.g. mimo/mimo-v2.5 on limited tier) has no
      // endpoint row — the canonical id is what upstream routes on.
      const text = await response.text().catch(() => "");
      if (text.includes("No endpoints found")) {
        log?.warn?.("FREEBUFF", `no endpoints for ${model} — retrying with canonical deepseek/deepseek-v4-flash`);
        if (settings.useAgentRuns && !localRun) finishAgentRun(baseUrl, credentials, runId, "error");
        return this._chat(baseUrl, "deepseek/deepseek-v4-flash", "base3-free-deepseek-flash", body, stream, credentials, signal, log, true);
      }
    }

    if (response.status === 403 && !retriedCanonical) {
      // Agent-generation mismatch: retry once with the legacy base2 root
      // (upstream keeps both generations registered).
      const text = await response.text().catch(() => "");
      if (text.includes("free_mode_invalid_agent_model")) {
        const legacy = LEGACY_ROOT_AGENT_BY_MODEL[model];
        if (legacy && legacy !== agentId) {
          log?.warn?.("FREEBUFF", `${agentId} rejected for ${model} — retrying with legacy ${legacy}`);
          if (settings.useAgentRuns && !localRun) finishAgentRun(baseUrl, credentials, runId, "error");
          return this._chat(baseUrl, model, legacy, body, stream, credentials, signal, log, true);
        }
      }
    }

    if (!response.ok) {
      if (settings.useAgentRuns && !localRun) finishAgentRun(baseUrl, credentials, runId, "error");
      return { response, url, headers, transformedBody };
    }

    if (stream) {
      if (settings.useAgentRuns && !localRun && response.body) {
        // FINISH after the stream drains
        const finish = () => finishAgentRun(baseUrl, credentials, runId);
        try {
          response.body = response.body.pipeThrough(new TransformStream({ flush: finish }));
        } catch {
          finish();
        }
      }
      return { response, url, headers, transformedBody };
    }

    // Non-stream client behind a forced-stream upstream: aggregate SSE → JSON
    const aggregated = await aggregateSseToResponse(response);
    if (settings.useAgentRuns && !localRun) finishAgentRun(baseUrl, credentials, runId);
    return { response: aggregated, url, headers, transformedBody };
  }
}

export const __test__ = { generateClientID, ensureBuffyMarker, buildEnvelopedBody, BUFFY_MARKER, aggregateSseToResponse };

export default FreebuffExecutor;
