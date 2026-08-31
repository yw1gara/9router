// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  // Rate-limit class base. Minimum initial model cooldown is 30 minutes —
  // shorter locks (5m) caused hot retry loops against limits that had not
  // lifted yet. Escalation beyond 30m is handled by model-lock accumulation
  // (30m × 2^n) up to the 24h cap.
  base: 30 * 60 * 1000,
  max: 30 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 60 * 1000;

// Network timeouts (connect/TCP/header/idle) say nothing about sustained
// account health — the endpoint was slow, not broken. Park the target briefly
// with a FIXED short cooldown: never escalated and never accumulated into the
// model-lock ladder (a few timeouts must not lock a key for half an hour,
// poisoning every combo leg that lists the model).
export const TIMEOUT_COOLDOWN_MS = 30 * 1000;

// Timeout signature: statuses and error-text fragments that mark a failure as
// a timeout rather than a provider rejection. Matched case-insensitively.
export const TIMEOUT_STATUS_CODES = new Set([504, 524, 599]);
export const TIMEOUT_ERROR_TEXT_RE =
  /timeout|timed?[ -]?out|etimedout|econnaborted|und_err_(connect|headers|body|response)_timeout|connect timeout|headers timeout|idle timeout/;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Hard cap for accumulated model-lock cooldown: repeated failures on the same
// model double the lock duration (base × 2^(n-1)) but never exceed 1 day.
export const MAX_MODEL_LOCK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Cooldown durations (ms) — minimum initial model cooldown is 30 minutes
const COOLDOWN = {
  long: 30 * 60 * 1000,
  short: 30 * 60 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  // Tuned from production error-log analysis (~14k classified errors):
  //
  // Free-tier KEY limits (orcarouter / opencode-zen / qoder): rate limit is
  // per API key, recovery is slow. Park 30 minutes, escalate ×2 to the 24h
  // cap; account fallback rotates to a healthy key meanwhile.
  { text: "freeusagelimiterror", cooldownMs: 30 * 60 * 1000 },
  { text: "free model capacity", cooldownMs: 30 * 60 * 1000 },
  { text: "pricingurl", cooldownMs: 30 * 60 * 1000 },
  //
  // Dead credentials — these NEVER self-heal (token refresh permanently
  // rejected / key revoked / balance exhausted). The old 2-minute lock let
  // codex+orcarouter burn thousands of retries on corpses (4.5k/1.7k hits).
  // Park long; accumulation still escalates to 24h for chronic offenders.
  { text: "refresh_token_reused", cooldownMs: 30 * 60 * 1000 },
  { text: "invalid api key", cooldownMs: 30 * 60 * 1000 },
  { text: "insufficient balance", cooldownMs: 60 * 60 * 1000 },
  //
  // NOTE: plain 401 "Unauthorized" stays on the short 2-minute rule on
  // purpose — transient 401s during background token rotation recover in
  // seconds and must not idle a healthy key.
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
