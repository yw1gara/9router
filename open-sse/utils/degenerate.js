// Degenerate-output detection for streaming responses.
//
// Small/quantized upstream models occasionally fall into a repetition loop:
// a short token pattern (e.g. "ía", "/a/", "</parameter") repeats for hundreds
// of KB — pure garbage that still costs tokens and floods the client. This
// module detects that pathological state cheaply: the caller passes a rolling
// tail of the accumulated output, and we report the longest suffix that forms
// a perfect loop of a short unit.
//
// Threshold rationale: legitimate text (code, minified JS, JSON, base64,
// tables, markdown dividers) never contains 512+ CONSECUTIVE characters that
// are an exact repetition of a ≤16-char unit. Observed degenerate loops run
// thousands of characters, so the margin against false positives is large.

export const DEGENERATE_MAX_PERIOD = 16; // longest repeated unit (chars) considered
export const DEGENERATE_MIN_RUN = 512;   // consecutive looped chars before triggering

/**
 * Detect a pathological repetition loop at the end of the accumulated output.
 *
 * @param {string} tail - rolling tail of accumulated output (≥ minRun chars)
 * @param {object} [opts] - { maxPeriod, minRun } overrides for tests
 * @returns {{ runLen: number, period: number, unit: string } | null}
 */
export function detectDegenerateLoop(tail, { maxPeriod = DEGENERATE_MAX_PERIOD, minRun = DEGENERATE_MIN_RUN } = {}) {
  if (typeof tail !== "string" || tail.length < minRun) return null;

  let best = 0;
  let bestPeriod = 0;

  for (let p = 1; p <= maxPeriod; p++) {
    if (tail.length < p * 2) break;
    let run = 0;
    // Walk backwards while each char equals the char one period before it.
    for (let i = tail.length - 1; i >= p; i--) {
      if (tail.charCodeAt(i) === tail.charCodeAt(i - p)) run++;
      else break;
    }
    const loopLen = run + p; // matched tail + the unit itself
    // Single-char units (p=1) need a much longer run: long "===="/"----"
    // divider lines are legitimate model output; only a full window of one
    // identical character is pathological.
    const needed = p === 1 ? Math.max(minRun, 1024) : minRun;
    if (loopLen >= needed && loopLen > best) {
      best = loopLen;
      bestPeriod = p;
    }
  }

  if (best < minRun) return null;
  return {
    runLen: best,
    period: bestPeriod,
    unit: tail.slice(tail.length - bestPeriod),
  };
}

/** How much of the accumulated output to inspect per chunk (perf bound). */
export const DEGENERATE_TAIL_WINDOW = 1024;
