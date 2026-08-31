import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Probe the upstream body's first chunk BEFORE committing to a 200 SSE
 * response. An upstream that closes the stream without sending a single byte
 * would otherwise produce a "successful" empty completion — the client can't
 * distinguish it from a real API error, so it neither retries nor surfaces an
 * error (observed as ZCode turns dying mid-task on empty SSE streams).
 *
 * The probe races the provider's stall timeout — the same byte-silence budget
 * pipeWithDisconnect's watchdog uses. An upstream that produces no first byte
 * within the window is a stall (identical to the old watchdog behavior), now
 * converted into a FAILED target so the fallback chain retries invisibly.
 *
 * Returns:
 *   { empty: true, stalled? }  — zero-byte close, first-read failure, or stall.
 *   { empty: false, response } — Response whose pull-based body replays the
 *                                probed chunk + the rest of the stream.
 */
async function probeUpstreamStream(providerResponse, stallTimeoutMs) {
  const body = providerResponse?.body;
  if (!body) return { empty: true };

  const reader = body.getReader();
  let first;
  try {
    first = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error("probe-stall")), stallTimeoutMs);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
  } catch (err) {
    reader.cancel().catch(() => {});
    return { empty: true, stalled: err?.message === "probe-stall" };
  }

  if (first && first.done) return { empty: true };

  return {
    empty: false,
    response: new Response(makeReplayStream(reader, first), {
      status: providerResponse.status,
      headers: providerResponse.headers,
    }),
  };
}

/**
 * Pull-based replay of a probed reader: one chunk per pull, so downstream
 * backpressure propagates to the upstream read loop instead of buffering the
 * whole response in memory. The already-read first result is seeded first.
 */
function makeReplayStream(reader, firstResult) {
  let pending = firstResult;
  return new ReadableStream({
    async pull(controller) {
      try {
        const r = pending || await reader.read();
        pending = null;
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export { probeUpstreamStream };
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log }) {
  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      status,
      error: `[${status}]: ${shortMsg}`,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  // Empty-stream guard: probe the first upstream byte before committing to a
  // 200 SSE response. A zero-byte upstream close becomes a FAILED target so
  // the account-fallback / combo chain retries invisibly instead of the client
  // receiving a "successful" empty stream.
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const probe = await probeUpstreamStream(providerResponse, stallTimeoutMs);
  if (probe.empty) {
    const msg = probe.stalled
      ? `Upstream stalled before sending any data (${provider}/${model})`
      : `Upstream closed the stream without sending any data (${provider}/${model})`;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `${probe.stalled ? "STREAM STALL" : "EMPTY STREAM"} · ${provider}/${model}`);
    else console.warn(`[STREAM] ${provider} | ${model} | ${probe.stalled ? "stalled" : "empty"} upstream stream`);
    streamController?.handleError?.(new Error(probe.stalled ? "stream stalled before first byte" : "upstream empty stream"));
    return {
      success: false,
      status: 502,
      error: msg,
      response: new Response(JSON.stringify({ error: { message: msg } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }
  const probedResponse = probe.response;

  // Only now that the upstream response is accepted as a real SSE/JSON stream
  // do we clear account error state and provider breaker failure history.
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const transformedBody = pipeWithDisconnect(probedResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId };
}
