'use strict';

const metrics = require('./metrics');
const redis = require('./redis');
const { CACHE_BACKEND, REDIS_KEY_PREFIX } = require('../config/env');

/**
 * Two-tier cache: in-process Map (L1) + optional Redis (L2).
 *
 * Phase 1 left a single-tier in-process TTL cache. Phase 3 adds the Redis
 * L2 — same key shapes, same TTL semantics, plus an L1 promotion so a
 * Redis hit warms the local Map. The in-process single-flight stays in
 * L1; per-process coalescing is not replaced by Redis (it cannot be
 * without slowing the cold path).
 *
 * Behavior by CACHE_BACKEND:
 *   - 'memory' (default): original Phase 1 behavior — in-process only.
 *   - 'redis'           : L1 + L2. L2 client constructed lazily in
 *                         `redis.js`; if Redis is unreachable, all reads
 *                         serve from L1 and writes to L2 fail silently.
 *
 * Per the audit, failing closed on a Redis blip would defeat the purpose.
 * The wrapper therefore swallows all L2 errors and logs them.
 */
class CacheService {
  /**
   * @param {number}                       [cleanupIntervalMs=300_000]  How often to purge stale L1 entries (5 min default).
   *                                                              Set to 0 to disable periodic cleanup.
   * @param {object|null}                  [redisClient=null]         Override Redis client (mostly for tests).
   *                                                              When null, the wrapper pulls from `redis.getClient()`.
   */
  constructor(cleanupIntervalMs, redisClient = null) {
    /** @type {Map<string, {data: *, timestamp: number, absoluteExpiryMs?: number}>} */
    this._store = new Map();
    /** @type {Map<string, Promise<*>>} In-flight fetches awaiting completion. */
    this._inFlight = new Map();
    this._l2 = redisClient; // null = L2 disabled (memory mode or no injection)

    // ponytail: periodic eviction prevents unbounded Map growth.
    // For Redis L2, TTL is enforced server-side — no equivalent needed.
    if (cleanupIntervalMs !== 0) {
      this._cleanupTimer = setInterval(() => this._evictStale(), cleanupIntervalMs || 300_000);
      this._cleanupTimer.unref();
    }
    // Kick off the 5-minute cache-stats log alongside the eviction timer.
    // startPeriodicLog is idempotent; safe to call from here at boot.
    metrics.startPeriodicLog(cleanupIntervalMs || 300_000);
  }

  /**
   * Lazily resolve the L2 client. Reads CACHE_BACKEND at call-time so a
   * test that flips the env mid-run still picks up the change.
   */
  _l2Client() {
    if (this._l2 !== undefined) return this._l2 || null;
    if (CACHE_BACKEND !== 'redis') return null;
    this._l2 = redis.getClient();
    return this._l2 || null;
  }

  _key(key) {
    return `${REDIS_KEY_PREFIX}${key}`;
  }

  /**
   * @private Remove all entries whose timestamp is older than the longest
   * possible TTL. The longest TTL in the codebase is 2 hours (detail
   * pages), so 24h is a safe cutoff. L2 entries are evicted by Redis TTL.
   */
  _evictStale() {
    const cutoff = Date.now() - 24 * 3_600_000;
    for (const [key, entry] of this._store) {
      if (entry.timestamp < cutoff) this._store.delete(key);
    }
  }

  /**
   * Check whether a cached entry exists and is within its TTL.
   * L1-only check (synchronous). L2 promotion happens inside readThrough.
   * If the entry carries an `absoluteExpiryMs`, that wins over `ttlHours`.
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
   * Retrieve cached data for a key. L1-only (synchronous).
   * @returns {*} Stored data, or null if not present in L1.
   */
  get(key) {
    const entry = this._store.get(key);
    return entry ? entry.data : null;
  }

  /**
   * Async L2 lookup. Returns the cached value or null. Errors swallowed.
   * On hit, also promotes the value into L1 with a current timestamp
   * so subsequent in-process reads skip the round-trip.
   */
  async _l2Get(key) {
    const c = this._l2Client();
    if (!c) return null;
    try {
      const raw = await c.get(this._key(key));
      if (raw == null) return null;
      const value = JSON.parse(raw);
      // Promote to L1. Stream entries carry absolute expiry on the entry
      // itself, so we don't recompute here — the L1 hit path's
      // absoluteExpiryMs check protects against serving past `expiresAt`.
      this._store.set(key, { data: value, timestamp: Date.now() });
      return value;
    } catch (err) {
      console.warn('[cache] l2 get failed for', key, '-', err.message);
      return null;
    }
  }

  /**
   * Store data in the cache. Writes to both L1 and L2 when L2 is enabled.
   *
   * For L2 we use SETEX with a per-entry absolute TTL in seconds. When
   * `opts.ttlMs` is provided by the caller, that absolute deadline wins;
   * otherwise the entry's relative TTL is `Math.ceil(ttlHours * 3_600_000 / 1000)`,
   * matched to the `isHit(key, ttlHours)` check on read.
   *
   * @param {string}  key
   * @param {*}       data
   * @param {Object}  [opts]
   * @param {number}  [opts.ttlMs]  Optional per-entry absolute TTL in ms.
   */
  set(key, data, opts) {
    const entry = { data, timestamp: Date.now() };
    if (opts && Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0) {
      entry.absoluteExpiryMs = entry.timestamp + opts.ttlMs;
    }
    this._store.set(key, entry);

    const c = this._l2Client();
    if (!c) return;

    const ttlSeconds = entry.absoluteExpiryMs
      ? Math.max(1, Math.ceil((entry.absoluteExpiryMs - entry.timestamp) / 1000))
      : null;
    if (!ttlSeconds) return; // no relative TTL known at write time; skip L2

    try {
      const value = JSON.stringify(data);
      if (ttlSeconds > 0) {
        c.set(this._key(key), value, 'EX', ttlSeconds).catch((err) => {
          console.warn('[cache] l2 set failed for', key, '-', err.message);
        });
      }
    } catch (err) {
      console.warn('[cache] l2 serialise failed for', key, '-', err.message);
    }
  }

  /**
   * Remove all entries. Primarily useful in tests.
   * Drops both L1 in-flight/coalescing state and the L2 Redis namespace.
   */
  clear() {
    this._store.clear();
    this._inFlight.clear();
    const c = this._l2Client();
    if (c) {
      // Best-effort scan-and-delete of the prefix. SCAN avoids blocking
      // Redis on large keysets; we accept eventual consistency because
      // clear() is only called from tests / graceful-shutdown paths.
      let cursor = '0';
      const promise = (async () => {
        try {
          do {
            const [next, batch] = await c.scan(cursor, 'MATCH', `${REDIS_KEY_PREFIX}*`, 'COUNT', 100);
            cursor = next;
            if (batch.length) {
              const fullKeys = batch.map(k => k.startsWith(REDIS_KEY_PREFIX) ? k : `${REDIS_KEY_PREFIX}${k}`);
              await c.del(...fullKeys);
            }
          } while (cursor !== '0');
        } catch (err) {
          console.warn('[cache] l2 clear failed:', err.message);
        }
      })();
      // Don't await — clear() is synchronous from the caller's POV.
      promise.catch(() => {});
    }
  }

  /**
   * Single-flight wrapper around `fn`: if another caller is already
   * awaiting the same key, return its promise instead of starting a
   * second one. Used by call sites that compute TTL post-fetch (e.g.
   * streams honouring upstream `expiresAt`) and so cannot use the
   * standard `readThrough`.
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
   * Two-tier behavior (when CACHE_BACKEND=redis):
   *   1. L1 hit → record hit, return.
   *   2. L1 miss + L2 hit → promote to L1, record hit, return.
   *   3. L1 miss + L2 miss → record miss, invoke fetcher, cache L1 + L2,
   *      return. Concurrent misses on the same key share one upstream call.
   *
   * `category === null` skips both hit and miss metric recording (useful
   * for hardcoded result sets with no upstream involved).
   *
   * Single-flight slots are claimed BEFORE any await so a burst of
   * concurrent misses all share the same leader (and the same L2 lookup
   * round-trip, when applicable).
   */
  async readThrough(key, ttl, category, fetcher) {
    // 1. Sync L1 check.
    if (this.isHit(key, ttl)) {
      if (category) metrics.recordHit(category);
      return this.get(key);
    }

    // 2. Sync single-flight claim — concurrent callers must see this slot.
    const existing = this._inFlight.get(key);
    if (existing) return existing;

    // 3. Build the work promise and register it (both still synchronous).
    const promise = (async () => {
      try {
        // 4a. Try Redis L2 only when configured (avoids a useless microtask
        //     in memory-only mode and keeps the cold path tight).
        if (this._l2Client()) {
          const l2Value = await this._l2Get(key);
          if (l2Value != null) {
            if (category) {
              metrics.recordHit(category);
              metrics.recordL2Hit(category);
            }
            return l2Value;
          }
          if (category) metrics.recordL2Miss(category);
        }
        // 4b. L2 miss (or L2 disabled) → fetch and cache.
        const result = category
          ? await metrics.fetch(category, fetcher)
          : await fetcher();
        if (result != null) this.set(key, result);
        return result;
      } finally {
        this._inFlight.delete(key);
      }
    })();
    this._inFlight.set(key, promise);
    return promise;
  }
}

/**
 * Compute the safe TTL for caching a stream result, honouring the
 * upstream-provided `expiresAt` if present. Kept in its own module so
 * the cacheService integration-test mock does not shadow this helper.
 */
const { effectiveStreamTtlMs } = require('./streamTtl');

const instance = new CacheService();
module.exports = instance;
module.exports.CacheService = CacheService;             // exposed for unit testing
module.exports.effectiveStreamTtlMs = effectiveStreamTtlMs;
