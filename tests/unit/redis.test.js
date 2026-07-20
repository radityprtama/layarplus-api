'use strict';

let mockIoRedis;
let mockIoRedisShouldThrow = false;

// Stable mock constructor ref — the jest.mock factory returns it so every
// require('ioredis') across resetModules cycles gets the same function.
const mockIoRedisCtor = jest.fn(() => {
  if (mockIoRedisShouldThrow) throw new Error('conn refused');
  return mockIoRedis;
});

jest.mock('ioredis', () => mockIoRedisCtor);

describe('Redis client module', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    mockIoRedis = {
      status: 'ready',
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
    };
    mockIoRedisShouldThrow = false;
    mockIoRedisCtor.mockClear();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  describe('when CACHE_BACKEND is memory', () => {
    beforeEach(() => {
      process.env.CACHE_BACKEND = 'memory';
    });

    it('getClient() returns null', () => {
      const redis = require('../../src/lib/redis');
      expect(redis.getClient()).toBeNull();
    });

    it('isReady() returns false', () => {
      const redis = require('../../src/lib/redis');
      expect(redis.isReady()).toBe(false);
    });

    it('disconnect() is a no-op', async () => {
      const redis = require('../../src/lib/redis');
      await expect(redis.disconnect()).resolves.toBeUndefined();
    });

    it('does not call the Redis constructor', () => {
      require('../../src/lib/redis');
      expect(mockIoRedisCtor).not.toHaveBeenCalled();
    });
  });

  describe('when CACHE_BACKEND is redis', () => {
    beforeEach(() => {
      process.env.CACHE_BACKEND = 'redis';
    });

    it('getClient() returns the Redis client', () => {
      const redis = require('../../src/lib/redis');
      expect(redis.getClient()).toBe(mockIoRedis);
    });

    it('isReady() returns true when status is ready', () => {
      const redis = require('../../src/lib/redis');
      redis.getClient(); // triggers initialise
      expect(redis.isReady()).toBe(true);
    });

    it('isReady() returns false when status is not ready', () => {
      mockIoRedis.status = 'connecting';
      const redis = require('../../src/lib/redis');
      redis.getClient();
      expect(redis.isReady()).toBe(false);
    });

    it('disconnect() calls quit() and resets internal state', async () => {
      const redis = require('../../src/lib/redis');
      redis.getClient();
      await redis.disconnect();
      expect(mockIoRedis.quit).toHaveBeenCalled();
      // After disconnect the internal client is nulled; isReady goes false.
      expect(redis.isReady()).toBe(false);
      // getClient() re-creates the client (initialised flips back to false
      // so the lazy-initialiser re-runs).
      const c2 = redis.getClient();
      expect(c2).toBe(mockIoRedis);
      expect(mockIoRedisCtor).toHaveBeenCalledTimes(2);
    });

    it('does not create a second client on repeated getClient() calls', () => {
      const redis = require('../../src/lib/redis');
      redis.getClient();
      redis.getClient();
      expect(mockIoRedisCtor).toHaveBeenCalledTimes(1);
    });

      describe('retryStrategy', () => {
      let opts;

      beforeEach(() => {
        const redis = require('../../src/lib/redis');
        redis.getClient();
        opts = mockIoRedisCtor.mock.calls[0][1];
      });

      it('doubles each attempt up to 5s cap', () => {
        expect(opts.retryStrategy(1)).toBe(50);
        expect(opts.retryStrategy(2)).toBe(100);
        expect(opts.retryStrategy(7)).toBe(3200);
        expect(opts.retryStrategy(8)).toBe(5000);
        expect(opts.retryStrategy(99)).toBe(5000);
      });
    });

    it('sets connectTimeout, disables offline queue, maxRetriesPerRequest = 0', () => {
      const redis = require('../../src/lib/redis');
      redis.getClient();
      const opts = mockIoRedisCtor.mock.calls[0][1];
      expect(opts.connectTimeout).toBe(5000);
      expect(opts.enableOfflineQueue).toBe(false);
      expect(opts.maxRetriesPerRequest).toBe(0);
    });

    it('registers event handlers on the client', () => {
      const redis = require('../../src/lib/redis');
      redis.getClient();
      expect(mockIoRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockIoRedis.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockIoRedis.on).toHaveBeenCalledWith('ready', expect.any(Function));
      expect(mockIoRedis.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('getClient() returns null when the constructor throws', () => {
      mockIoRedisShouldThrow = true;
      const redis = require('../../src/lib/redis');
      expect(redis.getClient()).toBeNull();
    });
  });
});
