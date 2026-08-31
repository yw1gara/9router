import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import {
  recordProviderFailure,
  clearProviderFailure,
  isProviderFullyBlocked,
  getProviderShortestCooldownMs,
  isProviderExhaustedReason,
  applyComboTargetExhaustion,
  buildModelLockUpdate,
  getTargetDenial,
} from "open-sse/services/accountFallback.js";
import { updateProviderConnection } from "@/lib/localDb";
import { maybeWaitForCooldown, MAX_COOLDOWN_RETRIES } from "open-sse/utils/cooldownRetry.js";
import {
  acquire as acquireAccountSemaphore,
  markBlocked as markAccountSemaphoreBlocked,
  isSemaphoreCapacityError,
  resolveAccountSemaphoreKey,
  resolveAccountSemaphoreMaxConcurrency,
} from "open-sse/services/accountSemaphore.js";

// Log-spam guard state for the denied-model fast path (one line per model
// per minute, however fast the client retries).
let deniedLogAt = 0;
let deniedLogKey = "";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  const modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    // Per-request exhaustion sets shared across every combo leg (panel, judge,
    // fallback targets) so one bad connection does not get retried within the
    // same request.
    const exhaustionSets = {
      exhaustedProviders: new Set(),
      exhaustedConnections: new Set(),
      transientRateLimitedProviders: new Set(),
      providerFailureCounts: new Map()
    };

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel, targetOptions) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, exhaustionSets, targetOptions?.signal ?? null);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, targetOptions) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, exhaustionSets, targetOptions?.signal ?? null),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      signal: request?.signal ?? null,
      timeoutMs: comboStrategies[modelStr]?.targetTimeoutMs
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    const exhaustionSets = {
      exhaustedProviders: new Set(),
      exhaustedConnections: new Set(),
      transientRateLimitedProviders: new Set(),
      providerFailureCounts: new Map()
    };
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, targetOptions) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, exhaustionSets, targetOptions?.signal ?? null),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      signal: request?.signal ?? null
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, exhaustionSets = null, externalSignal = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel, targetOptions) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            // Forward the panel abort signal — otherwise fusion timeout /
            // straggler aborts never reach the executor fetch.
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, exhaustionSets, targetOptions?.signal ?? null);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      // Carry the outer combo's abort signal (client disconnect + parent
      // per-target timeout) into this nested combo. Without it a parent timeout
      // never reaches the nested fallback loop, so the nested leg keeps burning
      // accounts/upstream calls after the parent already gave up on it.
      const nestedSignal = externalSignal
        ? (request?.signal ? AbortSignal.any([request.signal, externalSignal]) : externalSignal)
        : (request?.signal ?? null);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m, targetOptions) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, exhaustionSets, targetOptions?.signal ?? null),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        signal: nestedSignal,
        timeoutMs: comboStrategies[modelStr]?.targetTimeoutMs
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Denied-model fast path (noAuth "Public" providers): a model whose
  // promotion/subscription ended is dead from every IP and account — the
  // denial is cached for 30 min after the first failure. Serve the cached
  // error instantly instead of burning a proxied upstream call per request.
  {
    const denial = getTargetDenial(`${provider}/${model}`);
    if (denial) {
      // Log-spam guard: some clients retry a denied model multiple times per
      // second; log once per model per minute instead of per request.
      const key = `${provider}/${model}`;
      const now = Date.now();
      if (!deniedLogAt || now - deniedLogAt > 60_000 || deniedLogKey !== key) {
        deniedLogAt = now;
        deniedLogKey = key;
        log.info("CHAT", `[${key}] denied (cached) — skipping upstream call${denial.reason ? `: ${denial.reason.slice(0, 120)}` : ""}`);
      }
      const retryAfterSec = Math.max(1, Math.ceil((denial.until - now) / 1000));
      return new Response(
        JSON.stringify({ error: { message: denial.reason || `[${key}] model currently denied (e.g. free promotion ended); retry later`, type: "authentication_error", code: "model_denied" } }),
        {
          status: HTTP_STATUS.UNAUTHORIZED,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Retry-After": String(retryAfterSec),
          },
        }
      );
    }
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Per-request exhaustion sets: shared across combo legs so one bad
  // connection does not kill healthy sibling connections on the same provider.
  const sets = exhaustionSets || {
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    // Bound account walking per provider within one combo request.
    providerFailureCounts: new Map()
  };
  // Backward-compatible for callers that pass older exhaustion set shapes.
  sets.providerFailureCounts ??= new Map();
  const MAX_PROVIDER_ACCOUNT_FAILURES = 3;

  // Combine the client-request signal and the combo's per-target timeout
  // signal so both abort the fallback loop and release the semaphore.
  const signals = [request?.signal, externalSignal].filter(Boolean);
  const effectiveSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0] || null;

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let cooldownRetries = 0;

  // Pipeline gate: if the provider's circuit breaker is OPEN on all buckets,
  // short-circuit BEFORE any credential lookup — no point querying the DB.
  if (isProviderFullyBlocked(provider)) {
    const remainingMs = getProviderShortestCooldownMs(provider);
    const retryHuman = remainingMs > 0 ? `${Math.ceil(remainingMs / 1000)}s` : "soon";
    log.warn("GATE", `${provider} circuit breaker OPEN — short-circuiting before credential lookup`);
    return unavailableResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `[${provider}/${model}] Provider temporarily unavailable (circuit breaker open)`,
      remainingMs > 0 ? new Date(Date.now() + remainingMs).toISOString() : null,
      retryHuman
    );
  }

  // If the provider was already marked exhausted earlier in this request
  // (e.g. a previous combo leg got a quota-exhausted response), skip it.
  if (sets.exhaustedProviders.has(`${provider}:${model}`)) {
    log.info("CHAT", `[${provider}/${model}] provider already exhausted this request — skipping`);
    return errorResponse(
      lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
      lastError || `[${provider}/${model}] Provider exhausted this request`
    );
  }

  while (true) {
    // Abort check: stop trying accounts if the client already disconnected or
    // the combo target timed out. Prevents wasted upstream calls and
    // circuit-breaker probe hits on a dead connection.
    if (effectiveSignal?.aborted) {
      log.info("CHAT", `[${provider}/${model}] aborted — stopping fallback loop (client=${Boolean(request?.signal?.aborted)} target-timeout=${Boolean(externalSignal?.aborted)})`);
      return new Response(null, { status: 499 });
    }

    // Pin to a specific account when the caller asks for it (model testing
    // per-account uses this header; absent for normal traffic).
    const pinnedConnectionId = request?.headers?.get("x-connection-id") || null;
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, pinnedConnectionId ? { preferredConnectionId: pinnedConnectionId } : undefined);

    // Skip connections already exhausted in this request (e.g. a previous
    // combo leg got an auth/connection error on the same connection).
    if (credentials && !credentials.allRateLimited &&
        sets.exhaustedConnections.has(`${provider}:${credentials.connectionId}`)) {
      // Progress guard: if the credential picker returned a connection that is
      // ALREADY excluded, it ignores exclusions (e.g. a pinned/virtual path).
      // Continuing would spin this loop forever on the same credentials and
      // starve the event loop — fail over to the next combo target instead.
      if (excludeConnectionIds.has(credentials.connectionId)) {
        log.warn("CHAT", `[${provider}/${model}] credential picker ignored exclusion for ${credentials.connectionId?.slice(0, 8)} — stopping fallback loop`);
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || `[${provider}/${model}] Connection exhausted this request`);
      }
      excludeConnectionIds.add(credentials.connectionId);
      log.info("CHAT", `[${provider}/${model}] connection ${credentials.connectionId?.slice(0, 8)} already exhausted this request — skipping`);
      continue;
    }

    // All accounts unavailable. Mark this provider/model exhausted so a combo
    // immediately continues with its next target instead of revisiting it.
    if (!credentials || credentials.allRateLimited) {
      sets.exhaustedProviders.add(`${provider}:${model}`);
      if (credentials?.allRateLimited) {
        // Provider-exhaustion detection: when the last error signals provider-wide
        // quota/credit exhaustion, waiting for a cooldown is pointless — skip the
        // cooldown retry and fail over to the unavailable response immediately.
        const exhausted = isProviderExhaustedReason(lastError || credentials.lastError || "");
        // Cooldown-aware retry: if the earliest account comes off cooldown soon,
        // wait for it (aborted on client disconnect) then retry once.
        if (!exhausted && credentials.retryAfter && cooldownRetries < MAX_COOLDOWN_RETRIES) {
          const waitDecision = await maybeWaitForCooldown({
            retryAfter: credentials.retryAfter,
            retriesSoFar: cooldownRetries,
            signal: effectiveSignal,
          });
          if (waitDecision.shouldRetry) {
            cooldownRetries++;
            log.info("CHAT", `[${provider}/${model}] all accounts rate-limited — waited ${waitDecision.waitedMs}ms, retrying (attempt ${cooldownRetries})`);
            // Re-enter the loop WITHOUT excluding accounts — they may be usable now.
            continue;
          }
          if (waitDecision.reason === "client_disconnected") {
            log.info("CHAT", `[${provider}/${model}] client disconnected during cooldown wait — aborting`);
            // Return a minimal response; client is gone anyway.
            return new Response(null, { status: 499 });
          }
          log.info("CHAT", `[${provider}/${model}] cooldown retry skipped: ${waitDecision.reason}`);
        } else if (exhausted) {
          log.warn("CHAT", `[${provider}/${model}] provider quota exhausted — skipping cooldown retry`);
        }
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;

    // Account semaphore: cap concurrent requests per account (prevents 429
    // cascades when many parallel requests land on the same credential).
    // Bypassable per-account via providerSpecificData.maxConcurrency = 0.
    const semaphoreKey = resolveAccountSemaphoreKey({ provider, connectionId: credentials.connectionId });
    const semaphoreMax = resolveAccountSemaphoreMaxConcurrency(refreshedCredentials);
    let semaphoreRelease = () => {};
    if (semaphoreKey && semaphoreMax != null) {
      try {
        semaphoreRelease = await acquireAccountSemaphore(semaphoreKey, {
          maxConcurrency: semaphoreMax,
          timeoutMs: 30_000,
          signal: effectiveSignal,
        });
      } catch (e) {
        if (effectiveSignal?.aborted) {
          log.info("CHAT", `[${provider}/${model}] aborted while waiting for account semaphore — stopping`);
          return new Response(null, { status: 499 });
        }
        if (isSemaphoreCapacityError(e)) {
          log.warn("AUTH", `Account ${credentials.connectionName} at capacity, trying fallback`);
          excludeConnectionIds.add(credentials.connectionId);
          continue;
        }
        throw e;
      }
    }

    let result;
    try {
      result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        clearProviderFailure(provider);
      },
      // Pass the combined signal (client disconnect + combo target timeout) so
      // the executor's fetch is aborted when the client is gone, not just when
      // the combo leg times out.
      externalSignal: effectiveSignal || null
    });
    } catch (e) {
      semaphoreRelease();
      throw e;
    }

    if (result.success) {
      semaphoreRelease();
      return result.response;
    }

    // If the combo target timed out or the client aborted, do NOT mark the
    // account unavailable — the failure was local, not the provider's fault.
    if (externalSignal?.aborted || request?.signal?.aborted) {
      semaphoreRelease();
      // Combo per-model timeout: the abort reason carries the timeout duration
      // (set in combo.js as "combo-per-model-timeout:<ms>"). Lock ONLY this
      // model on THIS key for that duration so the same account stops burning
      // the full 12s on a model that just hung, while sibling models stay usable.
      if (!request?.signal?.aborted && externalSignal?.aborted) {
        const reason = externalSignal.reason;
        const match = typeof reason?.message === "string" ? reason.message.match(/^combo-per-model-timeout(?::(\d+))?$/) : null;
        if (match) {
          const lockMs = Math.max(1000, Math.min(Number(match[1]) || 30_000, 10 * 60 * 1000));
          // noAuth "Public" has no DB connection row — nothing to lock; the
          // in-memory denied/target-failure tracking in combo.js covers it.
          if (credentials.connectionId && credentials.connectionId !== "noauth") {
            await updateProviderConnection(credentials.connectionId, {
              ...buildModelLockUpdate(model, lockMs),
              lastError: `combo target timeout (${match[1] ? `${match[1]}ms` : "target timeout"})`,
              errorCode: 524,
              lastErrorAt: new Date().toISOString(),
            });
            log.warn("AUTH", `${credentials.connectionName} locked modelLock_${model} for ${Math.round(lockMs / 1000)}s [timeout]`);
          }
        }
      }
      log.info("CHAT", `[${provider}/${model}] aborted after upstream attempt — not marking account`);
      return new Response(null, { status: 499 });
    }

    // Failure path: the semaphore slot is released only AFTER the account is
    // marked unavailable and the gate is blocked on 429. Releasing earlier
    // would promote an already-queued request into the just-rate-limited
    // account before the cooldown is visible.
    // NOTE: shouldFallback/cooldownMs are declared here (outside the try) —
    // they are consumed below after the semaphore is released.
    let shouldFallback;
    let cooldownMs;
    let semaphoreCooldownMs;
    try {
      // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
      ({ shouldFallback, cooldownMs, semaphoreCooldownMs } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs));

      // Record provider-level failure for the circuit breaker (5xx/timeout only;
      // 429 stays per-account). Deduplicated per connection within 5s.
      recordProviderFailure(provider, result.status, typeof result.error === "string" ? result.error : result.error?.message, log, credentials.connectionId);

      // Block the account's semaphore gate on 429 so requests already queued for
      // this account do not hit it again before the DB cooldown is read back.
      const gateBlockMs = semaphoreCooldownMs ?? cooldownMs;
      if (semaphoreKey && Number(result.status) === 429 && gateBlockMs > 0) {
        markAccountSemaphoreBlocked(semaphoreKey, gateBlockMs);
        log.info("SEMAPHORE", `Account ${credentials.connectionName} gate blocked for ${Math.round(gateBlockMs / 1000)}s [429]`);
      }
    } finally {
      semaphoreRelease();
    }

    // Per-request exhaustion tracking: an auth (401/403) or connection-level
    // (408/5xx/524) failure marks only this connection exhausted — sibling
    // connections on the same provider stay eligible for the rest of the request.
    const errorText = typeof result.error === "string" ? result.error : (result.error?.message || "");
    applyComboTargetExhaustion(provider, credentials.connectionId, model, result.status, errorText, sets, log);

    // Fast-fail: if this failure just tripped the provider circuit breaker
    // (provider-wide outage), stop walking the remaining connections in this
    // leg. Without this, a down provider makes the loop visit EVERY account
    // (each a real network round-trip returning 5xx), burning the whole combo
    // per-target budget before falling back. Returning here lets the combo
    // switch to the next model immediately.
    if (shouldFallback && isProviderFullyBlocked(provider)) {
      const remainingMs = getProviderShortestCooldownMs(provider);
      const retryHuman = remainingMs > 0 ? `${Math.ceil(remainingMs / 1000)}s` : "soon";
      log.warn("GATE", `[${provider}/${model}] circuit breaker opened mid-request — stopping account walk after ${excludeConnectionIds.size + 1} connection(s)`);
      return unavailableResponse(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        `[${provider}/${model}] Provider temporarily unavailable (circuit breaker open)`,
        remainingMs > 0 ? new Date(Date.now() + remainingMs).toISOString() : null,
        retryHuman
      );
    }

    if (shouldFallback) {
      const providerFailures = (sets.providerFailureCounts.get(provider) || 0) + 1;
      sets.providerFailureCounts.set(provider, providerFailures);
      const providerLabel = credentials?.providerDisplayName || provider;
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT (${providerFailures}/${MAX_PROVIDER_ACCOUNT_FAILURES} ${providerLabel} failures)`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      if (providerFailures >= MAX_PROVIDER_ACCOUNT_FAILURES) {
        sets.exhaustedProviders.add(`${provider}:${model}`);
        log.warn("FALLBACK", `[${providerLabel}/${model}] reached ${MAX_PROVIDER_ACCOUNT_FAILURES} account failures — skip provider, continue combo`);
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || `[${providerLabel}/${model}] Provider skipped after repeated account failures`);
      }
      continue;
    }

    return result.response;
  }
}
