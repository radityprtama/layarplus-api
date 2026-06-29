'use strict';

/**
 * Shared cache mock used by all integration tests.
 *
 * Builds a single object that exposes `isHit`, `get`, `set`, `readThrough`
 * and `singleFlight` as jest.fn()s, with `readThrough` and `singleFlight`
 * delegating to the other mocks using the standard cache-aside shape.
 *
 * Usage:
 *   jest.mock('../../src/lib/cacheService',
 *     () => require('../fixtures/cacheMock')());
 */
function createCacheMock() {
  const m = {
    isHit: jest.fn(),
    get:   jest.fn(),
    set:   jest.fn(),
  };
  m.readThrough = jest.fn(async (key, ttl, _category, fetcher) => {
    if (m.isHit(key, ttl)) return m.get(key);
    const result = await fetcher();
    if (result != null) m.set(key, result);
    return result;
  });
  m.singleFlight = jest.fn((_key, fn) => fn());
  return m;
}

module.exports = createCacheMock;
