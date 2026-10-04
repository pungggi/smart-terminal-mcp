import { stripAnsi } from './ansi.js';

/**
 * Raw chars re-scanned before the unscanned region, so matches that straddle
 * two scans are still found. Must be >= the longest realistic match.
 */
export const DEFAULT_SCAN_OVERLAP_CHARS = 4096;
/** Upper bound for retained raw output (memory cap). */
export const DEFAULT_MAX_RETAINED_CHARS = 1024 * 1024;
/** Throttle: scan at most this often while output trickles in. */
export const DEFAULT_SCAN_INTERVAL_MS = 100;
/** Throttle: scan immediately once this many new chars are pending. */
export const DEFAULT_SCAN_MIN_CHARS = 10 * 1024;

/**
 * Incremental regex matcher over a raw terminal stream.
 *
 * Each scan only strips/tests the newly appended text plus a fixed overlap,
 * so total work is O(output) instead of O(output²) when re-scanning the
 * whole accumulated stream on every chunk.
 *
 * Note: `^`/`$` anchor to the scanned window, so callers should compile
 * patterns with the `m` flag to get stable line semantics.
 * @param {RegExp} regex - Must not use the `g`/`y` flags (stateless `test`).
 * @param {{ overlapChars?: number, maxRetainedChars?: number }} [opts]
 */
export function createIncrementalMatcher(regex, {
  overlapChars = DEFAULT_SCAN_OVERLAP_CHARS,
  maxRetainedChars = DEFAULT_MAX_RETAINED_CHARS,
} = {}) {
  if (regex.global || regex.sticky) {
    throw new Error('Incremental matcher requires a regex without g/y flags.');
  }

  let raw = '';
  let scannedUpTo = 0;
  let hasScanned = false;

  return {
    /** @param {string} chunk */
    push(chunk) {
      if (!chunk) return;
      raw += chunk;
      if (raw.length > maxRetainedChars) {
        const overflow = raw.length - maxRetainedChars;
        raw = raw.slice(overflow);
        scannedUpTo = Math.max(0, scannedUpTo - overflow);
      }
    },

    /** Number of raw chars appended since the last scan. */
    get pendingChars() {
      return raw.length - scannedUpTo;
    },

    /** @returns {boolean} true when the pattern matches the new window. */
    scan() {
      // Nothing new: the previous window already failed to match.
      if (hasScanned && scannedUpTo === raw.length) return false;
      hasScanned = true;
      const start = Math.max(0, scannedUpTo - overlapChars);
      scannedUpTo = raw.length;
      return regex.test(stripAnsi(raw.slice(start)));
    },

    /** Cleaned retained output (bounded by maxRetainedChars). */
    text() {
      return stripAnsi(raw);
    },
  };
}

/**
 * Incremental matcher with throttled scanning: scans when enough new output
 * is pending, otherwise at most once per interval. Calls `onMatch` once.
 * @param {RegExp} regex
 * @param {object} opts
 * @param {() => void} opts.onMatch
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.minChars]
 * @param {number} [opts.overlapChars]
 * @param {number} [opts.maxRetainedChars]
 */
export function createThrottledMatcher(regex, {
  onMatch,
  intervalMs = DEFAULT_SCAN_INTERVAL_MS,
  minChars = DEFAULT_SCAN_MIN_CHARS,
  overlapChars,
  maxRetainedChars,
}) {
  const matcher = createIncrementalMatcher(regex, { overlapChars, maxRetainedChars });
  let timer = null;
  let matched = false;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clearTimer();
    if (!matched && matcher.scan()) {
      matched = true;
      onMatch();
    }
    return matched;
  };

  return {
    /** @param {string} chunk */
    push(chunk) {
      if (matched) return;
      matcher.push(chunk);
      if (matcher.pendingChars >= minChars) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, intervalMs);
      }
    },
    /** Scan pending output now. @returns {boolean} whether matched */
    flush,
    /** Cancel any scheduled scan. */
    dispose: clearTimer,
    text: () => matcher.text(),
  };
}
