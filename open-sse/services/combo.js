/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter, isTargetDenied } from "./accountFallback.js";
import { resolveProviderId } from "../../src/shared/constants/providers.js";

/**
 * Normalize a combo target's provider prefix to its canonical provider id so
 * denial marks (keyed `provider/model` post-resolution) also match targets
 * stored under an alias (e.g. `oc/...` vs `opencode/...`).
 */
function normalizeDeniedKey(target) {
  const sep = String(target || "").indexOf("/");
  if (sep <= 0) return target;
  return `${resolveProviderId(target.slice(0, sep))}/${target.slice(sep + 1)}`;
}

function isTargetDeniedAliasAware(target) {
  return isTargetDenied(target) || isTargetDenied(normalizeDeniedKey(target));
}
import { unavailableResponse } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import {
  DEFAULT_COMBO_TARGET_TIMEOUT_MS,
  COMBO_TRANSIENT_WAIT_MS,
} from "../config/runtimeConfig.js";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

/**
 * Short-term health memory for combo targets: models that just failed
 * (timeout / 5xx / fallback error) are demoted to the back of the combo for
 * the next requests, so switching away from a degraded target is immediate
 * instead of retrying it first on every request. Entries expire after a TTL;
 * a success clears the entry so recovered targets re-enter the front.
 * In-memory only — restart resets it (fine: DB model-locks cover persistence).
 * @type {Map<string, number>} key `${comboName}|${model}` -> expiry epoch ms
 */
const TARGET_FAILURE_TTL_MS = 60 * 1000;
const TARGET_FAILURE_MAP_MAX = 500;
const recentTargetFailures = new Map();

function targetFailureKey(comboName, model) {
  return `${comboName || ""}|${model}`;
}

export function noteTargetFailure(comboName, model, ttlMs = TARGET_FAILURE_TTL_MS) {
  if (!model) return;
  const now = Date.now();
  // Lazy eviction + hard cap so the map can't grow unbounded.
  if (recentTargetFailures.size >= TARGET_FAILURE_MAP_MAX) {
    for (const [k, exp] of recentTargetFailures) {
      if (exp <= now) recentTargetFailures.delete(k);
    }
    if (recentTargetFailures.size >= TARGET_FAILURE_MAP_MAX) {
      const oldest = recentTargetFailures.keys().next().value;
      if (oldest !== undefined) recentTargetFailures.delete(oldest);
    }
  }
  recentTargetFailures.set(targetFailureKey(comboName, model), now + ttlMs);
}

export function clearTargetFailure(comboName, model) {
  if (!model) return;
  recentTargetFailures.delete(targetFailureKey(comboName, model));
}

/**
 * Reset the short-term target-failure memory (tests / combo-settings resets).
 * @param {string} [comboName] - Combo to clear; omit to clear everything.
 */
export function resetTargetFailureTracking(comboName) {
  if (!comboName) {
    recentTargetFailures.clear();
    return;
  }
  const prefix = `${comboName}|`;
  for (const key of recentTargetFailures.keys()) {
    if (key.startsWith(prefix)) recentTargetFailures.delete(key);
  }
}

function isTargetRecentlyFailed(comboName, model) {
  // Two key layers: a combo-scoped mark (`${comboName}|${model}`) from an
  // in-combo failure, and a GLOBAL mark (`|${model}`) recorded by layers that
  // don't know the combo context (e.g. the degenerate-output guard in the
  // stream, keyed as `${provider}/${model}`). A global mark demotes the
  // target in every combo that lists it.
  const keys = comboName ? [`${comboName}|${model}`, `|${model}`] : [`|${model}`];
  const now = Date.now();
  for (const key of keys) {
    const exp = recentTargetFailures.get(key);
    if (!exp) continue;
    if (exp <= now) {
      recentTargetFailures.delete(key);
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Stable-partition recently-failed targets to the back of the list. Only
 * demotes when at least one healthy target exists, so an all-degraded combo
 * keeps its configured order.
 */
function demoteRecentlyFailedTargets(models, comboName, log) {
  if (!Array.isArray(models) || models.length <= 1) return models;
  const healthy = [];
  const degraded = [];
  for (const m of models) {
    (isTargetRecentlyFailed(comboName, m) ? degraded : healthy).push(m);
  }
  if (degraded.length === 0 || healthy.length === 0) return models;
  log?.info?.("COMBO", `switch-fast: demoting recently-failed target(s) to back → ${degraded.join(", ")}`);
  return [...healthy, ...degraded];
}

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

// Merge abort signals (e.g. client disconnect + per-target timeout) into one.
// Returns null when no usable signal is passed, a single signal unchanged.
function combineSignals(...signals) {
  const sources = signals.filter((s) => s && typeof s.addEventListener === "function");
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0];

  const controller = new AbortController();
  // Forward the abort REASON so downstream handlers can distinguish a combo
  // per-model timeout (and read its duration) from a plain client disconnect.
  const onAbort = (evt) => {
    const reason = evt?.target?.reason;
    controller.abort(reason !== undefined ? reason : undefined);
  };
  let aborted = false;
  let firstReason;

  for (const sig of sources) {
    if (sig.aborted) {
      aborted = true;
      firstReason = sig.reason;
      break;
    }
    sig.addEventListener("abort", onAbort, { once: true });
  }

  if (aborted) {
    controller.abort(firstReason !== undefined ? firstReason : undefined);
  }

  return controller.signal;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr, options) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {AbortSignal} [options.signal] - Optional external signal (e.g. client disconnect) that aborts every target
 * @param {number} [options.timeoutMs=DEFAULT_COMBO_TARGET_TIMEOUT_MS] - Max time to wait for a target to return response headers
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true, signal = null, timeoutMs = DEFAULT_COMBO_TARGET_TIMEOUT_MS }) {
  // Apply rotation strategy if enabled
  let rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }

  // Switch-fast: push targets that recently timed out / errored to the back
  // so the combo starts from a healthy model instead of re-burning degraded
  // ones on every request (entries auto-expire; successes clear them).
  rotatedModels = demoteRecentlyFailedTargets(rotatedModels, comboName, log);

  // Dead models: a denied target (e.g. OpenCode "Free promotion has ended")
  // is dead from every IP/account — skip it entirely for 30 min instead of
  // failing every request on it. If EVERYTHING is denied, keep the original
  // order (cheap re-probe) so the combo never returns without trying.
  if (rotatedModels.length > 1) {
    const alive = rotatedModels.filter((m) => !isTargetDeniedAliasAware(m));
    if (alive.length > 0 && alive.length < rotatedModels.length) {
      const skipped = rotatedModels.filter((m) => isTargetDeniedAliasAware(m));
      log?.info?.("COMBO", `skipping denied (promotion ended / no access) target(s): ${skipped.join(", ")}`);
      rotatedModels = alive;
    }
  }

  let lastError = null;
  let earliestRetryAfter = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];

    // A caller abort means no consumer remains for a fallback response.
    if (signal?.aborted) {
      log.info("COMBO", "External signal aborted — stopping combo fallback");
      return new Response(
        JSON.stringify({ error: { message: "Client disconnected" } }),
        { status: 499, headers: { "Content-Type": "application/json" } }
      );
    }

    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      let result;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        result = await handleSingleModel(body, modelStr);
      } else {
        // Race the target against a header timeout: if it can't produce response
        // headers within timeoutMs, stop waiting and fall back to the next target.
        const timeoutController = new AbortController();
        let timeoutId;
        let timedOut = false;

        const targetSignal = combineSignals(signal, timeoutController.signal);
        const targetOptions = targetSignal ? { signal: targetSignal } : undefined;

        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            log.warn("COMBO", `Model ${modelStr} exceeded ${timeoutMs}ms timeout — falling back`);
            noteTargetFailure(comboName, modelStr);
            timeoutController.abort(new Error(`combo-per-model-timeout:${timeoutMs}`));
            resolve(
              new Response(
                JSON.stringify({ error: { message: `Model ${modelStr} timed out` } }),
                { status: 524, headers: { "Content-Type": "application/json" } }
              )
            );
          }, timeoutMs);
        });

        try {
          result = await Promise.race([
            Promise.resolve(handleSingleModel(body, modelStr, targetOptions)).catch((err) => {
              if (timedOut) {
                // The inner call rejected because we aborted it. The synthetic 524
                // from timeoutPromise already won the race; return an empty response
                // so the loser branch resolves cleanly without leaking err.message.
                return new Response(null, { status: 599 });
              }
              throw err;
            }),
            timeoutPromise,
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
      }
      
      // Success (2xx) - return response
      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded`);
        clearTargetFailure(comboName, modelStr);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const fallbackDecision = checkFallbackError(result.status, errorText);
      // A target-level 400 can mean model-specific schema/access incompatibility.
      // Local request validation happens before combo expansion and remains 400.
      const shouldFallback = result.status === 400 || fallbackDecision.shouldFallback;
      const cooldownMs = fallbackDecision.cooldownMs;

      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // For transient errors (503/502/504), optionally wait for cooldown before
      // falling through so a briefly-overloaded provider gets a chance to recover.
      // Disabled by default (COMBO_TRANSIENT_WAIT_MS=0) to keep combo latency low.
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= COMBO_TRANSIENT_WAIT_MS &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      noteTargetFailure(comboName, modelStr);
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      noteTargetFailure(comboName, modelStr);
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // 2nd pass retry: if all models failed on the 1st pass, sweep all eligible
  // combo targets once more in case their transient cooldown/lock expired while
  // other targets were running. Bounded: skip denied/hard-failed targets, pass
  // retryPass: 2 so soft exhaustion is cleared per target, and abort if client gone.
  if (!signal?.aborted && rotatedModels.length > 1) {
    for (let j = 0; j < rotatedModels.length; j++) {
      if (signal?.aborted) break;
      const candidate = rotatedModels[j];
      if (!candidate || isTargetDeniedAliasAware(candidate)) continue;
      log.info("COMBO", `2nd pass: re-probing target ${j + 1}/${rotatedModels.length}: ${candidate}`);
      try {
        const secondAttempt = await handleSingleModel(body, candidate, {
          signal: signal ?? undefined,
          retryPass: 2
        });
        if (secondAttempt.ok) {
          log.info("COMBO", `2nd pass succeeded on ${candidate}`);
          clearTargetFailure(comboName, candidate);
          return secondAttempt;
        }
      } catch (err) {
        log.warn("COMBO", `2nd pass failed on ${candidate}: ${err.message}`);
      }
    }
  }

  // All models failed
  // ALWAYS 503 (Service Unavailable): every fallback-eligible target was tried
  // and failed, so the aggregate condition is "temporarily unavailable, retry
  // later" — never the incidental status of the FIRST failing target. Leaking
  // that status (e.g. 403 key_paused, 404, 502) makes clients classify the
  // failure as permanent/non-retryable (harness: auth_failed retryable=false)
  // even though a retry would route to a healthy target. Client-side errors
  // (400/413/414/422/431) never reach here — they return early per-target.
  const status = 503;
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms, controller = null) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      controller?.abort(new Error("fusion panel timeout"));
      resolve({ __timeout: true });
    }, ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs, onFinish } = {}) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      try { onFinish?.(); } catch { /* ignore abort errors */ }
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const panelControllers = panel.map(() => new AbortController());
  const calls = panel.map((m, i) =>
    withTimeout(
      handleSingleModel(panelBody, m, true, { signal: panelControllers[i].signal }),
      cfg.panelHardTimeoutMs,
      panelControllers[i],
    ),
  );
  const settled = await collectPanel(calls, {
    ...cfg,
    minPanel,
    onFinish: () => { for (const c of panelControllers) c.abort(); },
  });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}
