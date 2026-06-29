'use strict';

const { CacheService } = require('../../src/lib/cacheService');
const { effectiveStreamTtlMs } = require('../../src/lib/streamTtl');

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
});
