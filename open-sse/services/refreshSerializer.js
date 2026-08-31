/**
 * Global OAuth refresh serialization, keyed by rotation group.
 *
 * Why this exists: providers with rotating (one-time-use) refresh tokens —
 * notably OpenAI Codex — revoke the whole token family when two sibling
 * accounts refresh their `refresh_token` at nearly the same time (Auth0
 * treats it as token reuse; see openai/codex#9648). The per-connection lock
 * in oauthCredentialManager does NOT help: colliding refreshes happen on
 * DIFFERENT connections. This serializer forces the actual network refresh
 * to concurrency=1 across every connection in a rotation group.
 *
 * Optional spacing (CODEX_REFRESH_SPACING_MS) inserts a small gap between
 * consecutive refreshes in a group. Non-rotating providers are not
 * serialized — their refresh_tokens are permanent and there is no cascade.
 */

// Providers mapped to the same string share one serialized lane.
const ROTATION_GROUPS = {
  codex: "openai-auth0",
};

// Protective settle gap (ms) between two consecutive sibling refreshes when
// the env var is unset. Correctness (not revoking the family) outweighs the
// extra wall-clock on a queued refresh.
const DEFAULT_REFRESH_SPACING_MS = 2000;

/**
 * Gap (ms) inserted between two consecutive refreshes in the same rotation
 * group. Only paid when a sibling is already queued behind the current
 * refresh — a lone refresh is released immediately so the reactive request
 * path pays no extra latency. Tunable via `CODEX_REFRESH_SPACING_MS`; set it
 * to "0" to opt out entirely.
 */
export function getRefreshSpacingMs() {
  const rawEnv = process.env.CODEX_REFRESH_SPACING_MS;
  if (rawEnv === undefined || rawEnv === "") return DEFAULT_REFRESH_SPACING_MS;
  const raw = Number(rawEnv);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REFRESH_SPACING_MS;
}

// Tail promise per group — each new refresh chains after the previous one.
const groupTail = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns the serialization group for a provider, or null when not a rotating provider. */
export function rotationGroupFor(provider) {
  return ROTATION_GROUPS[provider] ?? null;
}

/**
 * Run `fn` (the actual network refresh) serialized against every other refresh
 * in the same rotation group. Different groups run concurrently; non-rotating
 * providers run immediately with no locking.
 */
export async function serializeRefresh(provider, fn) {
  const group = rotationGroupFor(provider);
  if (!group) return fn();

  const prevTail = groupTail.get(group) ?? Promise.resolve();
  let releaseMine;
  const mine = new Promise((resolve) => {
    releaseMine = resolve;
  });
  const myTail = prevTail.then(() => mine);
  groupTail.set(group, myTail);

  // Wait for our turn. Ignore a predecessor's rejection — its `finally` still
  // releases the lane, so the queue keeps flowing even after a failed refresh.
  await prevTail.catch(() => {});

  try {
    return await fn();
  } finally {
    // Only pay the settle gap when a sibling is already queued behind us — a
    // lone refresh has nobody to collide with, so it must be released
    // immediately (zero added latency on the reactive request path).
    const hasSuccessor = groupTail.get(group) !== myTail;
    if (hasSuccessor) {
      const spacing = getRefreshSpacingMs();
      if (spacing > 0) await delay(spacing);
    }
    releaseMine();
    // Garbage-collect the lane when nobody chained after us.
    if (groupTail.get(group) === myTail) groupTail.delete(group);
  }
}

/** Test-only: clear all in-flight lanes between tests. */
export function __resetRefreshSerializerForTest() {
  groupTail.clear();
}
