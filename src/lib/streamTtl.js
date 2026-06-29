'use strict';

/**
 * Compute the safe TTL for caching a stream result, honouring the
 * upstream-provided `expiresAt` if present.
 *
 * Lives in its own module so the integration mocks of `cacheService`
 * (which replace the whole module object) do not shadow this helper.
 *
 * @param {number}       flatStreamTtlHours  Configured flat stream TTL (e.g. 0.25).
 * @param {number|null}  expiresAt           Upstream expiry. Numbers below 1e12 are
 *                                           treated as Unix seconds (the production
 *                                           convention from `majorplay.net/api/play`);
 *                                           numbers above 1e12 are treated as ms.
 * @param {number}       [nowMs]             Override for testing.
 * @param {number}       [marginMs]          Safety margin before expiry (default 5 min).
 * @returns {number} TTL in milliseconds, clamped to >= 0. `0` means
 *                 "do not cache" (already expired or within the safety margin).
 */
function effectiveStreamTtlMs(flatStreamTtlHours, expiresAt, nowMs = Date.now(), marginMs = 300_000) {
  const flatMs = flatStreamTtlHours * 3_600_000;
  if (!Number.isFinite(expiresAt) || expiresAt == null) return flatMs;
  const expiresAtMs = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  if (expiresAtMs <= nowMs) return 0;
  const liveMs = expiresAtMs - nowMs - marginMs;
  return Math.max(0, Math.min(flatMs, liveMs));
}

module.exports = { effectiveStreamTtlMs };
