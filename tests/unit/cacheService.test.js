'use strict';

const { CacheService } = require('../../src/lib/cacheService');
const { effectiveStreamTtlMs } = require('../../src/lib/streamTtl');
const { createRedisStub } = require('../fixtures/redisStub');

describe('CacheService', () => {
  /** @type {CacheService} */
  let cache;

  beforeEach(() => {
    cache = new CacheService();
  });

  // ── isHit ────────────────────────────────────────────────────────────────

  describe('isHit()', () => {
    it('returns false for an unknown key', () => {
      expect(cache.isHit('nonexistent', 1)).toBe(false);
    });

    it('returns true for a freshly stored entry within TTL', () => {
      cache.set('key', { value: 42 });
      expect(cache.isHit('key', 1)).toBe(true);
    });

    it('returns false for an entry older than the TTL', () => {
      cache.set('key', 'data');
      // Backdate timestamp by 2 hours
      cache._store.set('key', { data: 'data', timestamp: Date.now() - 2 * 3_600_000 });
      expect(cache.isHit('key', 1)).toBe(false);
    });

    it('returns true when entry timestamp is 1 ms inside the TTL boundary', () => {
      cache.set('key', 'data');
      // 1 ms before the TTL expires
      cache._store.set('key', { data: 'data', timestamp: Date.now() - 3_600_000 + 1 });
      expect(cache.isHit('key', 1)).toBe(true);
    });

    it('returns false when entry timestamp is exactly on the TTL boundary', () => {
      cache.set('key', 'data');
      cache._store.set('key', { data: 'data', timestamp: Date.now() - 3_600_000 });
      // Date.now() - timestamp === ttlHours * 3_600_000 → NOT less than → miss
      expect(cache.isHit('key', 1)).toBe(false);
    });

    it('honours absoluteExpiryMs in preference to ttlHours', () => {
      // Stored with a per-entry absolute expiry 100ms in the future.
      cache.set('key', 'data', { ttlMs: 100 });
      // ttlHours of 24 would normally keep it fresh — absolute wins.
      expect(cache.isHit('key', 24)).toBe(true);
      // After the absolute deadline, isHit must return false regardless of ttlHours.
      cache._store.set('key', {
        data: 'data',
        timestamp: Date.now() - 200,
        absoluteExpiryMs: Date.now() - 50,
      });
      expect(cache.isHit('key', 24)).toBe(false);
    });
  });

  // ── get ─────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns null for an unknown key', () => {
      expect(cache.get('missing')).toBeNull();
    });

    it('returns the data for a known key', () => {
      const movies = [{ title: 'Test' }];
      cache.set('movies', movies);
      expect(cache.get('movies')).toEqual(movies);
    });

    it('returns the latest value after multiple sets on the same key', () => {
      cache.set('k', 'first');
      cache.set('k', 'second');
      expect(cache.get('k')).toBe('second');
    });

    it('returns null after clear()', () => {
      cache.set('x', 'val');
      cache.clear();
      expect(cache.get('x')).toBeNull();
    });

    it('returns data set with ttlMs option', () => {
      cache.set('k', { foo: 'bar' }, { ttlMs: 1000 });
      expect(cache.get('k')).toEqual({ foo: 'bar' });
    });
  });

  // ── set ─────────────────────────────────────────────────────────────────

  describe('set()', () => {
    it('stores data with a current timestamp', () => {
      const before = Date.now();
      cache.set('k', { foo: 'bar' });
      const entry = cache._store.get('k');
      expect(entry.data).toEqual({ foo: 'bar' });
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('accepts any serialisable value (array, object, number, string)', () => {
      cache.set('arr', [1, 2, 3]);
      cache.set('num', 99);
      cache.set('str', 'hello');
      expect(cache.get('arr')).toEqual([1, 2, 3]);
      expect(cache.get('num')).toBe(99);
      expect(cache.get('str')).toBe('hello');
    });

    it('records absoluteExpiryMs when opts.ttlMs is provided', () => {
      const before = Date.now();
      cache.set('k', 'data', { ttlMs: 5_000 });
      const entry = cache._store.get('k');
      expect(entry.absoluteExpiryMs).toBeGreaterThanOrEqual(before + 5_000);
      expect(entry.absoluteExpiryMs).toBeLessThanOrEqual(Date.now() + 5_000);
    });

    it('does not set absoluteExpiryMs when opts.ttlMs is omitted', () => {
      cache.set('k', 'data');
      expect(cache._store.get('k').absoluteExpiryMs).toBeUndefined();
    });

    it('ignores non-finite or negative ttlMs values (falls back to relative TTL)', () => {
      cache.set('a', 1, { ttlMs: NaN });
      cache.set('b', 2, { ttlMs: -1 });
      cache.set('c', 3, { ttlMs: Infinity });
      expect(cache._store.get('a').absoluteExpiryMs).toBeUndefined();
      expect(cache._store.get('b').absoluteExpiryMs).toBeUndefined();
      expect(cache._store.get('c').absoluteExpiryMs).toBeUndefined();
    });
  });

  // ── clear ────────────────────────────────────────────────────────────────

  describe('clear()', () => {
    it('removes all entries from the store', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.clear();
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBeNull();
      expect(cache.get('c')).toBeNull();
    });

    it('leaves the cache in a usable state after clearing', () => {
      cache.set('x', 'before');
      cache.clear();
      cache.set('x', 'after');
      expect(cache.get('x')).toBe('after');
    });
  });

  // ── effectiveStreamTtlMs ─────────────────────────────────────────────────

  describe('effectiveStreamTtlMs()', () => {
    const FLAT_HOURS = 0.25; // 15 min — the configured CACHE_TTL.stream default

    it('falls back to the flat TTL when expiresAt is null', () => {
      expect(effectiveStreamTtlMs(FLAT_HOURS, null)).toBe(15 * 60 * 1000);
    });

    it('falls back to the flat TTL when expiresAt is undefined', () => {
      expect(effectiveStreamTtlMs(FLAT_HOURS, undefined)).toBe(15 * 60 * 1000);
    });

    it('falls back to the flat TTL when expiresAt is non-finite', () => {
      expect(effectiveStreamTtlMs(FLAT_HOURS, NaN)).toBe(15 * 60 * 1000);
      expect(effectiveStreamTtlMs(FLAT_HOURS, 'soon')).toBe(15 * 60 * 1000);
    });

    it('returns the flat TTL when expiresAt is well beyond the flat TTL', () => {
      const now = Date.now();
      const farFuture = (now + 2 * 3_600_000) / 1000;
      const ttlMs = effectiveStreamTtlMs(FLAT_HOURS, farFuture, now);
      expect(ttlMs).toBe(15 * 60 * 1000);
    });

    it('returns the shorter, margin-adjusted TTL when expiresAt is closer than the flat TTL', () => {
      // expiresAt 10 min in the future — less than the 15 min flat TTL.
      // After the 5 min safety margin, 5 min of safe-cache life remains.
      const now = Date.now();
      const soonFuture = (now + 10 * 60 * 1000) / 1000;
      const ttlMs = effectiveStreamTtlMs(FLAT_HOURS, soonFuture, now);
      expect(ttlMs).toBe(5 * 60 * 1000);
    });

    it('returns 0 (do not cache) when expiresAt is within the 5-min safety margin', () => {
      const now = Date.now();
      const imminent = (now + 3 * 60 * 1000) / 1000;
      const ttlMs = effectiveStreamTtlMs(FLAT_HOURS, imminent, now);
      expect(ttlMs).toBe(0);
    });

    it('returns 0 (never negative) when expiresAt is already in the past', () => {
      const now = Date.now();
      const past = (now - 60 * 1000) / 1000;
      const ttlMs = effectiveStreamTtlMs(FLAT_HOURS, past, now);
      expect(ttlMs).toBe(0);
      // Must not throw when fed to cache.set (which would store the entry with ttlMs=0).
      expect(() => cache.set('past-stream', { ok: true }, { ttlMs })).not.toThrow();
    });

    it('accepts milliseconds-shaped expiresAt (large numbers)', () => {
      const now = Date.now();
      const soonMsFuture = now + 10 * 60 * 1000; // already in ms
      const ttlMs = effectiveStreamTtlMs(FLAT_HOURS, soonMsFuture, now);
      expect(ttlMs).toBe(5 * 60 * 1000);
    });

    it('respects a custom margin override', () => {
      const now = Date.now();
      const soonFuture = (now + 10 * 60 * 1000) / 1000;
      // 1-minute margin instead of the default 5-minute.
      const ttlMs = effectiveStreamTtlMs(FLAT_HOURS, soonFuture, now, 60_000);
      expect(ttlMs).toBe(9 * 60 * 1000);
    });
  });

  // ── readThrough ──────────────────────────────────────────────────────────

  describe('readThrough()', () => {
    it('returns the cached value and skips the fetcher on hit', async () => {
      cache.set('k', { cached: true });
      const fetcher = jest.fn();
      const result = await cache.readThrough('k', 1, null, fetcher);
      expect(result).toEqual({ cached: true });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('invokes the fetcher on miss, caches a non-null result, and returns it', async () => {
      const fetcher = jest.fn().mockResolvedValue({ fresh: 1 });
      const result = await cache.readThrough('k', 1, null, fetcher);
      expect(result).toEqual({ fresh: 1 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(cache.get('k')).toEqual({ fresh: 1 });
    });

    it('does not cache a null result', async () => {
      const fetcher = jest.fn().mockResolvedValue(null);
      const result = await cache.readThrough('k', 1, null, fetcher);
      expect(result).toBeNull();
      expect(cache.get('k')).toBeNull();
    });

    it('coalesces concurrent misses on the same key into a single fetcher call', async () => {
      let resolveFetch;
      const fetcher = jest.fn(() => new Promise(r => { resolveFetch = r; }));
      const p1 = cache.readThrough('shared', 1, null, fetcher);
      const p2 = cache.readThrough('shared', 1, null, fetcher);
      const p3 = cache.readThrough('shared', 1, null, fetcher);
      // fetcher invoked exactly once for all three concurrent callers.
      expect(fetcher).toHaveBeenCalledTimes(1);
      resolveFetch({ value: 'shared' });
      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual([{ value: 'shared' }, { value: 'shared' }, { value: 'shared' }]);
      // The cached value is now available for the next caller.
      expect(cache.get('shared')).toEqual({ value: 'shared' });
    });

    it('clears the in-flight slot on rejection so the next caller retries', async () => {
      const fetcher = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
      await expect(cache.readThrough('k', 1, null, fetcher)).rejects.toThrow('boom');
      // In-flight must not be poisoned — next call retries cleanly.
      expect(cache._inFlight.has('k')).toBe(false);
      const result = await cache.readThrough('k', 1, null, fetcher);
      expect(result).toBe('ok');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('a different key runs an independent fetcher call', async () => {
      const fA = jest.fn().mockResolvedValue('A');
      const fB = jest.fn().mockResolvedValue('B');
      const [a, b] = await Promise.all([
        cache.readThrough('a', 1, null, fA),
        cache.readThrough('b', 1, null, fB),
      ]);
      expect(a).toBe('A');
      expect(b).toBe('B');
      expect(cache.get('a')).toBe('A');
      expect(cache.get('b')).toBe('B');
    });
  });

  // ── singleFlight ─────────────────────────────────────────────────────────

  describe('singleFlight()', () => {
    it('returns the in-flight promise for concurrent callers', async () => {
      let resolveFetch;
      const fn = jest.fn(() => new Promise(r => { resolveFetch = r; }));
      const p1 = cache.singleFlight('k', fn);
      const p2 = cache.singleFlight('k', fn);
      expect(fn).toHaveBeenCalledTimes(1);
      resolveFetch('done');
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('done');
      expect(r2).toBe('done');
    });

    it('clears the in-flight slot on rejection', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('nope'));
      await expect(cache.singleFlight('k', fn)).rejects.toThrow('nope');
      expect(cache._inFlight.has('k')).toBe(false);
    });

    it('does not interact with the cache store (caller manages writes)', async () => {
      const fn = jest.fn().mockResolvedValue('manual-write');
      const result = await cache.singleFlight('k', fn);
      expect(result).toBe('manual-write');
      expect(cache.get('k')).toBeNull();
    });
  });

  describe('clear()', () => {
    it('also drops in-flight entries', async () => {
      let resolveFetch;
      cache.singleFlight('k', () => new Promise(r => { resolveFetch = r; }));
      expect(cache._inFlight.has('k')).toBe(true);
      cache.clear();
      expect(cache._inFlight.has('k')).toBe(false);
      // Resolving the dangling promise after clear must not crash.
      resolveFetch('late');
    });
  });

  // ── two-tier (L2 Redis) mode ──────────────────────────────────────────────

  describe('with an injected L2 (Redis stub)', () => {
    /** @type {CacheService} */
    let tier2Cache;
    /** @type {ReturnType<typeof createRedisStub>} */
    let l2;

    beforeEach(() => {
      l2 = createRedisStub();
      tier2Cache = new CacheService(0, l2); // 0 = no eviction timer (faster tests)
    });

    afterEach(() => {
      tier2Cache._cleanupTimer && clearInterval(tier2Cache._cleanupTimer);
    });

    it('writes the value to both L1 and L2 on set', async () => {
      // L2 writes only happen when a per-entry ttlMs is supplied.
      tier2Cache.set('k', { hello: 'world' }, { ttlMs: 3600_000 });
      expect(tier2Cache.get('k')).toEqual({ hello: 'world' });
      const l2Value = await l2.get('idlc:k');
      expect(l2Value).toBe(JSON.stringify({ hello: 'world' }));
    });

    it('uses opts.ttlMs as the L2 TTL (in seconds, ceiling)', async () => {
      tier2Cache.set('k', 'v', { ttlMs: 1500 });
      const setOps = l2._operations.filter(o => o.op === 'set');
      expect(setOps).toHaveLength(1);
      expect(setOps[0].ttlSeconds).toBe(2); // 1500ms → ceil(1.5) → 2s
    });

    it('readThrough promotes an L2 hit into L1', async () => {
      // Seed L2 directly with a value (simulating a different instance having
      // written it).
      await l2.set('idlc:k', JSON.stringify({ from: 'L2' }), 'EX', 60);

      const fetcher = jest.fn();
      const result = await tier2Cache.readThrough('k', 1, null, fetcher);
      expect(result).toEqual({ from: 'L2' });
      expect(fetcher).not.toHaveBeenCalled();
      // L1 was warmed by the L2 hit.
      expect(tier2Cache.get('k')).toEqual({ from: 'L2' });
    });

    it('readThrough skips L2 entirely when the L2 client is null', async () => {
      const memoryOnly = new CacheService(0, null);
      // Force the singleton into L1-miss / fetcher path.
      const fetcher = jest.fn().mockResolvedValue('memory');
      const result = await memoryOnly.readThrough('k', 1, null, fetcher);
      expect(result).toBe('memory');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('readThrough falls through to fetcher when L2 returns null', async () => {
      const fetcher = jest.fn().mockResolvedValue({ fresh: true });
      const result = await tier2Cache.readThrough('k', 1, null, fetcher);
      expect(result).toEqual({ fresh: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('readThrough does not write L2 when fetcher returns null', async () => {
      const fetcher = jest.fn().mockResolvedValue(null);
      await tier2Cache.readThrough('k', 1, null, fetcher);
      const setOps = l2._operations.filter(o => o.op === 'set');
      expect(setOps).toHaveLength(0);
    });

    it('L2 lookup error falls back to L1 (does not throw)', async () => {
      // Stub get() to reject.
      l2.get = () => Promise.reject(new Error('redis down'));
      const fetcher = jest.fn().mockResolvedValue('fell-back');
      const result = await tier2Cache.readThrough('k', 1, null, fetcher);
      expect(result).toBe('fell-back');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('concurrent misses coalesce into a single L2 lookup', async () => {
      // Stub get to count invocations.
      let getCalls = 0;
      const realGet = l2.get.bind(l2);
      l2.get = (key) => { getCalls += 1; return realGet(key); };

      const p1 = tier2Cache.readThrough('shared', 1, null, () => Promise.resolve('X'));
      const p2 = tier2Cache.readThrough('shared', 1, null, () => Promise.resolve('X'));
      const p3 = tier2Cache.readThrough('shared', 1, null, () => Promise.resolve('X'));
      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual(['X', 'X', 'X']);
      // All three callers share the leader's L2 round-trip.
      expect(getCalls).toBe(1);
    });

    it('clear() also drops L2 entries under the configured prefix', async () => {
      // Seed a few keys (ttlMs required for L2 write-through).
      tier2Cache.set('alpha', 1, { ttlMs: 3600_000 });
      tier2Cache.set('beta', 2, { ttlMs: 3600_000 });
      // Sanity: present in L2.
      expect(await l2.get('idlc:alpha')).toBe('1');
      expect(await l2.get('idlc:beta')).toBe('2');

      tier2Cache.clear();
      // Wait for the async SCAN+DEL to settle.
      await new Promise(r => setImmediate(r));
      expect(await l2.get('idlc:alpha')).toBeNull();
      expect(await l2.get('idlc:beta')).toBeNull();
    });
  });
});
