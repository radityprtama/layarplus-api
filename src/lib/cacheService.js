'use strict';

const metrics = require('./metrics');

/**
 * Simple in-memory TTL cache backed by a Map.
 * Replaces the quick.db dependency — no SQLite file required.
 * The CacheService class is exported for unit testing; the singleton
 * instance is the default export consumed by services.
 *
 * Stale entries are purged periodically to prevent unbounded Map growth.
 */
class CacheService {
  /**
   * @param {number} [cleanupIntervalMs=300_000]  How often to purge stale entries (5 min default).
   *                                               Set to 0 to disable periodic cleanup.
   */
  constructor(cleanupIntervalMs) {
    /** @type {Map<string, {data: *, timestamp: number}>} */
    this._store = new Map();

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
   */
  _evictStale() {
    const cutoff = Date.now() - 24 * 3_600_000;
    for (const [key, entry] of this._store) {
      if (entry.timestamp < cutoff) this._store.delete(key);
    }
  }

  /**
   * Check whether a cached entry exists and is within its TTL.
   * @param {string} key
   * @param {number} ttlHours
   * @returns {boolean}
   */
  isHit(key, ttlHours) {
    const entry = this._store.get(key);
    if (!entry) return false;
    return (Date.now() - entry.timestamp) < ttlHours * 3_600_000;
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
   * @param {string} key
   * @param {*} data
   */
  set(key, data) {
    this._store.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Remove all entries. Primarily useful in tests.
   */
  clear() {
    this._store.clear();
  }
}

const instance = new CacheService();
module.exports = instance;
module.exports.CacheService = CacheService;             // exposed for unit testing
