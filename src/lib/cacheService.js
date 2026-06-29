'use strict';

const metrics = require('./metrics');

/**
 * Simple in-memory TTL cache backed by a Map.
 * Replaces the quick.db dependency — no SQLite file required.
 * The CacheService class is exported for unit testing; the singleton
 * instance is the default export consumed by services.
 *
 * Stale entries are purged periodically to prevent unbounded Map growth.
 *
 * Entries may optionally carry an `absoluteExpiryMs` (set via
 * `set(key, data, { ttlMs })`). When present, `isHit` checks the absolute
 * expiry instead of the caller-supplied `ttlHours`. This lets cache
 * writers express "never serve this past upstream X" without relying on
 * the caller passing the same TTL to both `isHit` and `set`.
 */
class CacheService {
  /**
   * @param {number} [cleanupIntervalMs=300_000]  How often to purge stale entries (5 min default).
   *                                               Set to 0 to disable periodic cleanup.
   */
  constructor(cleanupIntervalMs) {
    /** @type {Map<string, {data: *, timestamp: number, absoluteExpiryMs?: number}>} */
    this._store = new Map();
    /** @type {Map<string, Promise<*>>} In-flight fetches awaiting completion. */
    this._inFlight = new Map();

    // ponytail: periodic eviction prevents unbounded Map growth.
    // For Redis L2, this will be replaced by Redis TTL.
    if (cleanupIntervalMs !== 0) {
      this._cleanupTimer = setInterval(() => this._evictStale(), cleanupIntervalMs || 300_000);
      this._cleanupTimer.unref();
    }
    // Kick off the 5-minute cache-stats log alongside the eviction timer.
    // startPeriodicLog is idempotent; safe to call from here at boot.
    metrics.startPeriodicLog(cleanupIntervalMs || 300_000);
  }

  /**
   * @private Remove all entries whose timestamp is older than the longest possible TTL.
   * The longest TTL in the codebase is 2 hours (detail pages), so 24h is a safe cutoff.
   * Absolute-expiry entries (e.g. stream URLs) never exceed the flat TTL plus a margin,
   * so the same 24h cutoff is safe.
   */
  _evictStale() {
    const cutoff = Date.now() - 24 * 3_600_000;
    for (const [key, entry] of this._store) {
      if (entry.timestamp < cutoff) this._store.delete(key);
    }
  }

  /**
   * Check whether a cached entry exists and is within its TTL.
   * If the entry carries an `absoluteExpiryMs`, that wins over `ttlHours`.
   * @param {string} key
   * @param {number} ttlHours
   * @returns {boolean}
   */
  isHit(key, ttlHours) {
    const entry = this._store.get(key);
    if (!entry) return false;
    const now = Date.now();
    if (entry.absoluteExpiryMs != null) {
      return now < entry.absoluteExpiryMs;
    }
    return (now - entry.timestamp) < ttlHours * 3_600_000;
  }

  /**
   * Retrieve cached data for a key.
   * @param {string} key
   * @returns {*} Stored data, or null if not present.
   */
  get(key) {
    const entry = this._store.get(key);
    return entry ? entry.data : null;
  }

  /**
   * Store data in the cache with the current timestamp.
   * @param {string}  key
   * @param {*}       data
   * @param {Object}  [opts]
   * @param {number}  [opts.ttlMs]  Optional per-entry absolute TTL in ms.
   *                                When set, `isHit` will use this instead of any
   *                                caller-supplied `ttlHours`. Used by stream cache
   *                                writers to honour upstream `expiresAt`.
   */
  set(key, data, opts) {
    const entry = { data, timestamp: Date.now() };
    if (opts && Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0) {
      entry.absoluteExpiryMs = entry.timestamp + opts.ttlMs;
    }
    this._store.set(key, entry);
  }

  /**
   * Remove all entries. Primarily useful in tests.
   */
  clear() {
    this._store.clear();
    this._inFlight.clear();
  }

  /**
   * Single-flight wrapper around `fn`: if another caller is already
   * awaiting the same key, return its promise instead of starting a
   * second one. Used by call sites that compute TTL post-fetch (e.g.
   * streams honouring upstream `expiresAt`) and so cannot use the
   * standard `readThrough`.
   *
   * @param {string}        key    Cache key (used to coalesce).
   * @param {() => Promise<*>} fn    Thunk to invoke on cache miss.
   * @returns {Promise<*>}          Resolves with whichever caller's `fn` produced.
   */
  async singleFlight(key, fn) {
    const inFlight = this._inFlight.get(key);
    if (inFlight) return inFlight;
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this._inFlight.delete(key);
      }
    })();
    this._inFlight.set(key, promise);
    return promise;
  }

  /**
   * Cache-aside read-through with single-flight coalescing and metrics.
   *
   * On hit: records a hit (if `category` is provided) and returns the
   * cached value.
   * On miss: records a miss (timed, if `category` is provided), invokes
   * `fetcher()`, caches the non-null result, and returns it. Concurrent
   * misses on the same key share a single upstream call — the leader
   * fetches; waiters receive the same result.
   *
   * `category === null` skips both hit and miss metric recording (useful
   * for hardcoded result sets with no upstream involved).
   *
   * @param {string}        key        Cache key.
   * @param {number}        ttl        TTL in hours (consulted when no `absoluteExpiryMs`
   *                                   is present on the cached entry).
   * @param {string|null}   category   Logical category for metrics; null disables metric
   *                                   recording for this key.
   * @param {() => Promise<*>} fetcher Thunk that performs the upstream fetch.
   * @returns {Promise<*>}             Cached value (or fetcher's return value).
   */
  async readThrough(key, ttl, category, fetcher) {
    if (this.isHit(key, ttl)) {
      if (category) metrics.recordHit(category);
      return this.get(key);
    }
    const inFlight = this._inFlight.get(key);
    if (inFlight) return inFlight;
    const promise = (async () => {
      try {
        const result = category
          ? await metrics.fetch(category, fetcher)
          : await fetcher();
        if (result != null) this._store.set(key, { data: result, timestamp: Date.now() });
        return result;
      } finally {
        this._inFlight.delete(key);
      }
    })();
    this._inFlight.set(key, promise);
    return promise;
  }
}

const instance = new CacheService();
module.exports = instance;
module.exports.CacheService = CacheService;             // exposed for unit testing
