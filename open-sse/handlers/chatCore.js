import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { applyThinking, extractThinking, stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelSupportedFormats, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { supportsGrokCliReasoningEffort } from "../config/grokCli.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog, isHeadroomPhantomSavings } from "../rtk/headroom.js";
import { compressWithPxpipe } from "../rtk/pxpipe.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";
import { defaultClaudeToolType } from "../translator/concerns/toolCall.js";
import { resolveSessionId } from "../utils/sessionManager.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, headroomEnabled, headroomUrl, headroomCompressUserMessages, headroomTimeoutMs, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, pxpipeEnabled, pxpipeMinChars, pxpipeTimeoutMs, pxpipeTransform, onPxpipeEvent, sourceFormatOverride, providerThinking, externalSignal = null }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();
  // Stable per-session color so all lines of one CLI conversation share a tag
  const sessionSeed = (() => {
    try {
      return resolveSessionId({ headers: clientRawRequest?.headers, body, connectionId, scope: provider });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession ? log.tagForSession(sessionSeed) : (log?.nextTag ? log.nextTag() : "");

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  // Multi-endpoint providers: pick transport matching sourceFormat → zero translation.
  // Per-model guard: only use the transport when the model declares support for that
  // sourceFormat — opencode-go models differ in endpoint support (kimi/glm only do
  // /chat/completions), so without this guard a claude-format request would wrongly
  // route kimi to /messages.
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  // Per-model guard: when a model declares supportedFormats, only use the
  // sourceFormat-matched transport if that format is declared (opencode-go models
  // differ — kimi/glm only do /chat/completions). Undeclared models keep the
  // upstream default (use the transport), preserving behavior for glm/deepseek/...
  const useTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat)) ? runtimeTransport : null;
  // A source-format-matched endpoint keeps the request lossless. Prefer it
  // over a model-level targetFormat, which is only the fallback for clients
  // whose wire format has no supported transport (for example MiniMax-M3:
  // OpenAI clients should stay on /chat/completions; other clients can fall
  // back to its declared Claude target).
  const targetFormat = useTransport?.format || modelTargetFormat || getTargetFormat(provider, credentials);
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  const stripList = getModelStrip(alias, model);
  const upstreamModel = getModelUpstreamId(alias, model);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true;
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: externalSignal || undefined });
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) { log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`); }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) };
    if (provider === "codex") {
      const suffixThinking = {};
      applyThinking(sourceFormat, upstreamModel, suffixThinking, provider);
      if (suffixThinking.reasoning_effort) {
        const reasoning = translatedBody.reasoning;
        translatedBody.reasoning = {
          ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
          effort: suffixThinking.reasoning_effort,
        };
        delete translatedBody.reasoning_effort;
      }
    }
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model);
  } else {
    translatedBody = translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true, apiKey);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._customToolNames;
    translatedBody.model = stripThinkingSuffix(upstreamModel);
    stripContinuityFields(translatedBody);
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Request line: one correlated summary (fmt + thinking + counts + account)
  if (log?.line) {
    const clientModel = clientRawRequest?.body?.model || `${provider}/${model}`;
    const msgN = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || body.messages?.length || body.input?.length || 0;
    const toolN = translatedBody.tools?.length || body.tools?.length || 0;
    const fmtStr = passthrough ? `FMT: ${sourceFormat} (passthrough)` : `FMT: ${sourceFormat}→${targetFormat}`;
    const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model);
    const think = showThinking ? log.fmtThink?.(extractThinking(translatedBody)) : null;
    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const parts = [
      `POST ${clientModel} → ${credentials?.providerDisplayName || provider}/${model}`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      `${msgN} MSG`,
    ];
    if (toolN) parts.push(`${toolN} TOOL`);
    if (think) parts.push(`THINK:${think}`);
    parts.push(`ACC:${acc}`);
    log.line(reqTag, "▶", parts.join(" · "));
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // Claude tool schema requires `type` to be explicitly set; strict gateways (e.g., MiniMax)
  // reject legacy payloads that omit it with HTTP 400. Default to "custom" when missing.
  if (finalFormat === FORMATS.CLAUDE && Array.isArray(translatedBody.tools)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }

  // Per-request opt-out: client can bypass all token savers via header
  const tokenSaverEnabled = clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() !== "off";

  // RTK: compress tool_result content
  const rtkStats = compressMessages(translatedBody, tokenSaverEnabled && rtkEnabled);
  const rtkLine = formatRtkLog(rtkStats);
  if (rtkLine) console.log(rtkLine);

  // Headroom: optional external proxy compression; fail open if proxy is absent.
  const headroomDiagnostics = {};
  const headroomStats = await compressWithHeadroom(translatedBody, { enabled: tokenSaverEnabled && headroomEnabled, url: headroomUrl, model: upstreamModel, format: finalFormat, compressUserMessages: headroomCompressUserMessages, timeoutMs: headroomTimeoutMs, diagnostics: headroomDiagnostics });
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  if (headroomLine) {
    log?.info?.("HEADROOM", `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`);
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      log?.warn?.("HEADROOM", `reported token delta, but outbound JSON shrank <5%; provider may bill near-original payload | ${formatHeadroomSizeLog(headroomDiagnostics)}`);
    }
  } else if (tokenSaverEnabled && headroomEnabled) log?.warn?.("HEADROOM", `skipped: ${headroomDiagnostics.reason || "compression unavailable"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`);

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  // Caveman: inject terse-style system prompt
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    xf.push(`CAVEMAN:${cavemanLevel}`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    xf.push(`PONYTAIL:${ponytailLevel}`);
  }

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  if (pxpipeEnabled) {
    const pxpipeResult = await compressWithPxpipe(translatedBody, {
      enabled: true, format: finalFormat, model: upstreamModel,
      minChars: pxpipeMinChars, timeoutMs: pxpipeTimeoutMs, transform: pxpipeTransform,
    });
    pxpipeSummary = pxpipeResult.summary;
    if (pxpipeResult.body) translatedBody = pxpipeResult.body;
    if (pxpipeSummary?.applied) xf.push(`PXPIPE:${pxpipeSummary.imageCount}img`);
    try { onPxpipeEvent?.({ provider, model, ...pxpipeSummary }); } catch { /* stats must not break requests */ }
  }

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));

  // Pin cache breakpoints to the final body — every saver above can reshape
  // system/tools/messages, and a stale anchor costs a full prefix rewrite.
  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody);

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true, false, apiKey);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false, false, apiKey);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false, false, apiKey),
    log, provider, model, reqTag
  }, externalSignal);

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
    // strictProxy/proxyRequired were resolved per-connection in
    // resolveConnectionProxyConfig but dropped here previously — forward them
    // so proxyAwareFetch can fail closed instead of silently going direct.
    strictProxy: credentials?.providerSpecificData?.strictProxy === true,
    proxyRequired: credentials?.providerSpecificData?.proxyRequired === true,
    smartProxy: credentials?.providerSpecificData?.smartProxy === true || credentials?.providerSpecificData?.proxyRotationStrategy === "smart",
    // Observability context. proxyAwareFetch receives this for every executor
    // path, so proxy transport failures identify their real source.
    provider,
    model,
    connectionId: credentials?.connectionId || connectionId || null,
    connectionName: credentials?.connectionName || null,
    proxyPoolId: credentials?.providerSpecificData?.connectionProxyPoolId || null,
    proxyPoolScope: credentials?.providerSpecificData?.proxyPoolScope || null,
  };

  // ── Pool-scoped failure handling ───────────────────────────────────
  // A smart pool failure is scoped to provider::model and cools that pool for
  // 10 minutes. This request then tries every other assigned, fit pool once.
  // Smart resolution fails closed once no candidate remains.
  let activePoolId = credentials?.providerSpecificData?.connectionProxyPoolId || null;
  const poolScope = credentials?.providerSpecificData?.proxyPoolScope || null;
  const poolCandidates = Array.isArray(credentials?.providerSpecificData?.proxyPoolIds)
    ? credentials.providerSpecificData.proxyPoolIds
    : [];
  // Do not fan one request across every pool. Three candidates gives useful
  // rotation while bounding latency and upstream load.
  const POOL_RETRY_MAX = Math.min(Math.max(poolCandidates.length, 1), 3);
  const PROXY_RETRY_TIMEOUT_MS = 12_000;
  const usingProxy = !!(proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) || !!proxyOptions.vercelRelayUrl;
  const excludePoolIds = [];

  function logProxyFailure(label, error) {
    const errText = String(error?.message || error || "unknown");
    log?.warn?.(
      "PROXY",
      `${provider.toUpperCase()} | ${label} | conn=${proxyOptions.connectionName || proxyOptions.connectionId || "unknown"} | pool=${proxyOptions.proxyPoolId || activePoolId || "none"} | ${errText}`
    );
  }

  function isClientAbort(error) {
    return error?.name === "AbortError" || streamController.signal?.aborted === true;
  }

  function isProxyTransportFailure(error) {
    if (isClientAbort(error)) return false;
    const t = String(error?.message || error?.cause?.message || error || "");
    // Proxy errors are eligible only when transport itself failed. Upstream
    // HTTP/model/auth/quota errors must never poison a proxy pool.
    return /\[ProxyFetch\].*(Smart proxy failed|Relay proxy failed)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|tunneling socket|CONNECT tunnel|proxy authentication failed/i.test(t);
  }

  async function tryNextPool(reason) {
    if (!usingProxy || !activePoolId || !poolScope || !poolCandidates.includes(activePoolId)) return null;
    if (excludePoolIds.length >= POOL_RETRY_MAX) return null;
    try {
      const { markPoolUnfit } = await import("../services/proxyPoolFitness.js");
      await markPoolUnfit(activePoolId, poolScope, null, reason);
    } catch { /* advisory */ }
    excludePoolIds.push(activePoolId);
    try {
      const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
      const next = await resolveConnectionProxyConfig(
        credentials?.providerSpecificData || {},
        provider,
        excludePoolIds,
        { scope: poolScope, connectionId: credentials?.connectionId || connectionId || null }
      );
      if (!next || (!next.connectionProxyUrl && !next.vercelRelayUrl)) return null;
      proxyOptions.connectionProxyEnabled = next.connectionProxyEnabled === true;
      proxyOptions.connectionProxyUrl = next.connectionProxyUrl || "";
      proxyOptions.connectionNoProxy = next.connectionNoProxy || "";
      proxyOptions.vercelRelayUrl = next.vercelRelayUrl || "";
      proxyOptions.strictProxy = next.strictProxy === true;
      proxyOptions.proxyRequired = next.proxyRequired === true;
      proxyOptions.smartProxy = next.smartProxy === true;
      proxyOptions.proxyPoolId = next.proxyPoolId || null;
      proxyOptions.proxyPoolScope = next.proxyPoolScope || poolScope || null;
      if (credentials?.providerSpecificData) {
        credentials.providerSpecificData.connectionProxyPoolId = next.proxyPoolId || null;
        credentials.providerSpecificData.connectionProxyUrl = proxyOptions.connectionProxyUrl;
        credentials.providerSpecificData.connectionProxyEnabled = proxyOptions.connectionProxyEnabled;
        credentials.providerSpecificData.vercelRelayUrl = proxyOptions.vercelRelayUrl;
      }
      log?.warn?.("PROXY", `${provider.toUpperCase()} | pool ${activePoolId.slice(0, 8)} failed (${reason}) — retrying on pool ${String(next.proxyPoolId || "").slice(0, 8)}`);
      activePoolId = next.proxyPoolId || activePoolId;
      return next;
    } catch {
      return null;
    }
  }

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  // Most executors return their registry format. Cursor AgentService is an
  // exception: it is decoded by the executor into OpenAI-compatible output.
  let providerResponseFormat = targetFormat;
  try {
    const result = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    // Pool-scoped network failure: rotate to another assigned pool once
    // before giving up. Only fires when the error clearly implicates the
    // proxy transport, so provider-side errors never poison pool fitness.
    if (usingProxy && isProxyTransportFailure(error)) {
      logProxyFailure("initial proxy request failed", error);
      // Pool-scoped failure loop: keep marking the failing pool unfit and
      // rotating to the next fit pool until one responds or the rotation
      // budget (POOL_RETRY_MAX) is exhausted. Previously this retried exactly
      // once and swallowed a second pool failure, failing the whole request
      // even when more healthy pools were available.
      let rotateError = error;
      for (let rotation = 0; rotation < POOL_RETRY_MAX; rotation++) {
        if (streamController.signal?.aborted) break;
        const next = await tryNextPool("network:" + (rotateError.name || "Error"));
        if (!next) break;
        const retrySignal = AbortSignal.timeout(PROXY_RETRY_TIMEOUT_MS);
        try {
          const retry = await executor.execute({ model, body: translatedBody, stream, credentials, signal: retrySignal, log, proxyOptions });
          providerResponse = retry.response;
          providerUrl = retry.url;
          providerHeaders = retry.headers;
          finalBody = retry.transformedBody;
          providerResponseFormat = retry.responseFormat || targetFormat;
          reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
          // Success or upstream error — handled by shared flow below.
          break;
        } catch (rotatedErr) {
          if (!isProxyTransportFailure(rotatedErr)) break;
          logProxyFailure("rotated proxy request failed; rotating again", rotatedErr);
          rotateError = rotatedErr;
        }
      }
    }

    if (!providerResponse) {
    trackPendingRequest(model, provider, connectionId, false, true, apiKey);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: error.name === "AbortError" ? 499 : 502, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    // Honor an upstream status carried on the error (e.g. 429 from exhausted
    // fallback URLs) instead of rewrapping everything as 502.
    const errorStatus = Number.isInteger(error.status) ? error.status : HTTP_STATUS.BAD_GATEWAY;
    const errMsg = formatProviderError(error, provider, model, errorStatus);
    if (log?.errorLine) {
      log.errorLine(reqTag, "✗", `ERROR ${errorStatus} · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error.stack ? `\n    ${error.stack}` : ""}`);
    }
    return createErrorResult(errorStatus, errMsg);
    }
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      // Mutate credentials after each successful refresh: rotating refresh_token
      // providers (xAI/grok-cli) issue a new RT on every refresh; without this,
      // refreshWithRetry's 2nd/3rd attempt reuses the already-consumed RT →
      // invalid_grant → auth_failed retryable=false.
      const newCredentials = await refreshWithRetry(async () => {
        const result = await executor.refreshCredentials(credentials, log);
        if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
          if (result.accessToken) credentials.accessToken = result.accessToken;
          credentials.refreshToken = result.refreshToken;
        }
        return result;
      }, 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line) log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
          if (retryResult.response.ok) {
            // Release the original 401/403 body — an unconsumed body pins the
            // pooled socket until GC and can starve the connection pool.
            if (providerResponse.body) providerResponse.body.cancel().catch(() => {});
            providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
          } else if (retryResult.response.body) {
            // Non-ok retry: same pooled-socket starvation — release it too.
            retryResult.response.body.cancel().catch(() => {});
          }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Pool-scoped egress rotation: executor parseError() may classify an
  // upstream response as egress-IP scoped. Every failed smart pool receives
  // a 10-minute provider::model cooldown, then every remaining pool is tried.
  if (
    usingProxy && executor.noAuth &&
    activePoolId && poolScope && poolCandidates.includes(activePoolId) &&
    !providerResponse.ok
  ) {
    let rotationReason = null;
    if (typeof executor.parseError === "function" && providerResponse.body) {
      // Snapshot the body once; parseUpstreamError below reuses it.
      try {
        providerResponse._prefetchedErrorText = await providerResponse.text();
      } catch { /* body unreadable — parseUpstreamError falls back to status */ }
      try {
        const parsed = await parseUpstreamError(providerResponse, executor);
        if (parsed?.poolScoped) rotationReason = parsed.poolScoped.reason || "pool-scoped";
      } catch { /* parse failure — no rotation */ }
    } else if (providerResponse.status === HTTP_STATUS.RATE_LIMITED) {
      rotationReason = "ratelimit:429";
    }
    if (rotationReason) {
      let rotatedResponse = providerResponse;
      let failedPoolId = activePoolId;
      for (let rotation = 0; rotation < POOL_RETRY_MAX; rotation++) {
        const next = await tryNextPool(rotationReason);
        if (!next) break;
        try {
          if (rotatedResponse.body) rotatedResponse.body.cancel().catch(() => {});
          const retry = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
          providerResponse = retry.response;
          providerUrl = retry.url;
          providerHeaders = retry.headers;
          finalBody = retry.transformedBody;
          providerResponseFormat = retry.responseFormat || targetFormat;
          reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
          if (providerResponse.ok) {
            log?.warn?.("PROXY", `${provider.toUpperCase()} | conn=${proxyOptions.connectionName || proxyOptions.connectionId || "unknown"} | pool=${String(failedPoolId || "none").slice(0, 8)} hit ${rotationReason}; rotated to pool=${String(next.proxyPoolId || "none").slice(0, 8)} | 10m cooldown | succeeded`);
            break;
          }
          rotatedResponse = providerResponse;
          if (typeof executor.parseError === "function" && providerResponse.body) {
            try {
              providerResponse._prefetchedErrorText = await providerResponse.text();
              const parsed = await parseUpstreamError(providerResponse, executor);
              if (!parsed?.poolScoped) break;
              rotationReason = parsed.poolScoped.reason || "pool-scoped";
            } catch { break; }
          } else if (providerResponse.status !== HTTP_STATUS.RATE_LIMITED) {
            break;
          }
          failedPoolId = activePoolId;
        } catch (retryError) {
          if (retryError.name === "AbortError" || !isPoolScopedErrorMessage(retryError?.message || retryError?.cause?.message)) break;
          logProxyFailure("rotated proxy request failed; rotating again", retryError);
          failedPoolId = activePoolId;
        }
      }
    }
  }

  // Success through this pool ⇒ reset its accumulated failure count for the
  // scope. Pool-failure accumulation only ever resets on SUCCESS — never on
  // cooldown expiry (a pool that keeps failing after each retry escalates).
  if (providerResponse.ok && activePoolId && poolScope) {
    try {
      import("../services/proxyPoolFitness.js").then((m) => m.clearPoolUnfit(activePoolId, poolScope)).catch(() => {});
    } catch { /* advisory */ }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true, apiKey);
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    if (log?.errorLine) {
      const urlStr = providerUrl ? `\n    URL: ${providerUrl}` : "";
      log.errorLine(reqTag, "✗", `ERROR ${statusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`);
    }
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs);
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, pxpipe: pxpipeSummary, reqTag, log };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false, false, apiKey);

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, customToolNames, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, reqLogger, toolNameMap, customToolNames, trackDone, appendLog });
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, userAgent, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
