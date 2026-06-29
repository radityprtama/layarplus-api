'use strict';

/**
 * Tiny in-process metrics for the upstream HTTP layer.
 *
 * Tracks per-category cache hits/misses and the wall-clock duration of
 * upstream calls (recorded only on miss — a hit has nothing to time).
 *
 * Dependency-free by design. Full APM / Prometheus integration is
 * intentionally out of scope for Phase 1 (see Redis audit, Phase 3).
 */

const counters = new Map();
const l2Counters = new Map();

function ensure(category) {
  let c = counters.get(category);
  if (!c) {
    c = { hits: 0, misses: 0, totalMissLatencyMs: 0 };
    counters.set(category, c);
  }
  return c;
}

function ensureL2(category) {
  let c = l2Counters.get(category);
  if (!c) {
    c = { hits: 0, misses: 0 };
    l2Counters.set(category, c);
  }
  return c;
}

function recordHit(category) {
  if (!category) return;
  ensure(category).hits++;
}

function recordL2Hit(category) {
  if (!category) return;
  ensureL2(category).hits++;
}

function recordL2Miss(category) {
  if (!category) return;
  ensureL2(category).misses++;
}

function recordMiss(category, latencyMs) {
  if (!category) return;
  const c = ensure(category);
  c.misses++;
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    c.totalMissLatencyMs += latencyMs;
  }
}

async function fetch(category, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    recordMiss(category, Date.now() - t0);
  }
}

function getStats() {
  const out = {};
  for (const [category, c] of counters) {
    const l2 = l2Counters.get(category) || { hits: 0, misses: 0 };
    const total = c.hits + c.misses;
    out[category] = {
      hits: c.hits,
      misses: c.misses,
      total,
      hitRate: total > 0 ? c.hits / total : 0,
      avgMissLatencyMs: c.misses > 0 ? c.totalMissLatencyMs / c.misses : 0,
      l2Hits: l2.hits,
      l2Misses: l2.misses,
    };
  }
  return out;
}

let logTimer = null;
function startPeriodicLog(intervalMs = 300_000) {
  if (logTimer) return logTimer;
  logTimer = setInterval(() => {
    console.log('[metrics]', JSON.stringify(getStats()));
  }, intervalMs);
  logTimer.unref();
  return logTimer;
}

function _reset() {
  counters.clear();
  l2Counters.clear();
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

module.exports = {
  recordHit,
  recordL2Hit,
  recordL2Miss,
  recordMiss,
  fetch,
  getStats,
  startPeriodicLog,
  _reset,
};
