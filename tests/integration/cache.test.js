'use strict';

/**
 * Integration tests for the two-tier cache with a real Redis L2.
 *
 * These tests do NOT mock cacheService — they create a fresh CacheService
 * instance connected to a real Redis. Each test performs an availability
 * check first and returns early if Redis is unreachable, so the suite is
 * safe to run in environments without Redis (all tests "pass" as skipped).
 */

const Redis = require('ioredis');
const { CacheService } = require('../../src/lib/cacheService');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redisClient = null;

beforeAll(async () => {
  const c = new Redis(REDIS_URL, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  try {
    await c.ping();
    redisClient = c;
  } catch {
    try { await c.quit(); } catch { /* ignore */ }
  }
});

afterAll(async () => {
  if (redisClient) {
    try { await redisClient.quit(); } catch { /* ignore */ }
  }
});

describe('CacheService two-tier (real Redis)', () => {
  let cache;

  function itIfRedis(name, fn) {
    it(name, async () => {
      if (!redisClient) return; // eslint-disable-line jest/no-standalone-expect
      await fn();
    });
  }

  beforeEach(async () => {
    if (!redisClient) return;
    cache = new CacheService(0, redisClient);
    await redisClient.del('idlc:k', 'idlc:alpha', 'idlc:beta', 'idlc:shared');
  });

  afterEach(() => {
    if (cache) {
      cache._cleanupTimer && clearInterval(cache._cleanupTimer);
    }
  });

  itIfRedis('writes a value to both L1 and L2 on set()', async () => {
    cache.set('k', { hello: 'world' }, { ttlMs: 60_000 });
    expect(cache.get('k')).toEqual({ hello: 'world' });
    const raw = await redisClient.get('idlc:k');
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
  });

  itIfRedis('L2 stores JSON with TTL', async () => {
    cache.set('k', 'my-val', { ttlMs: 5_000 });
    const raw = await redisClient.get('idlc:k');
    expect(raw).toBe('"my-val"');
    const ttl = await redisClient.ttl('idlc:k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  itIfRedis('readThrough promotes an L2 hit into L1', async () => {
    await redisClient.set('idlc:k', JSON.stringify({ from: 'L2' }), 'EX', 60);
    const fetcher = jest.fn();
    const result = await cache.readThrough('k', 1, null, fetcher);
    expect(result).toEqual({ from: 'L2' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.get('k')).toEqual({ from: 'L2' });
  });

  itIfRedis('readThrough falls through to fetcher when L2 misses', async () => {
    const fetcher = jest.fn().mockResolvedValue({ fresh: true });
    const result = await cache.readThrough('k', 1, null, fetcher);
    expect(result).toEqual({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  itIfRedis('concurrent misses coalesce into a single fetcher call', async () => {
    const fetcher = jest.fn().mockResolvedValue('coalesced');
    const [p1, p2, p3] = await Promise.all([
      cache.readThrough('shared', 1, null, fetcher),
      cache.readThrough('shared', 1, null, fetcher),
      cache.readThrough('shared', 1, null, fetcher),
    ]);
    expect([p1, p2, p3]).toEqual(['coalesced', 'coalesced', 'coalesced']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  itIfRedis('clear() removes keys from L1 and L2', async () => {
    cache.set('alpha', 1, { ttlMs: 60_000 });
    cache.set('beta', 2, { ttlMs: 60_000 });
    expect(cache.get('alpha')).toBe(1);
    expect(cache.get('beta')).toBe(2);
    expect(await redisClient.get('idlc:alpha')).toBe('1');
    expect(await redisClient.get('idlc:beta')).toBe('2');

    cache.clear();
    expect(cache.get('alpha')).toBeNull();
    expect(cache.get('beta')).toBeNull();
    await new Promise(r => setTimeout(r, 100));
    expect(await redisClient.get('idlc:alpha')).toBeNull();
    expect(await redisClient.get('idlc:beta')).toBeNull();
  });

  itIfRedis('L2 lookup error falls back to fetcher', async () => {
    const flaky = Object.create(redisClient);
    flaky.get = () => Promise.reject(new Error('timeout'));
    const badCache = new CacheService(0, flaky);
    const fetcher = jest.fn().mockResolvedValue('fell-back');
    const result = await badCache.readThrough('k', 1, null, fetcher);
    expect(result).toBe('fell-back');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
