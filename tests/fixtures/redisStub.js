'use strict';

/**
 * Tiny in-memory stub that mimics the subset of the ioredis client surface
 * cacheService uses (`get`, `set(key, value, 'EX', seconds)`, `scan`,
 * `del(...keys)`). Returns Promises with the right shape so the cache code's
 * await chains resolve cleanly.
 */
function createRedisStub() {
  const store = new Map(); // full key (already prefixed) -> { value, expiresAt }
  const operations = []; // for assertions
  let keyPrefix = 'idlc:';

  function applyExpiry() {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt && v.expiresAt <= now) store.delete(k);
    }
  }

  return {
    setKeyPrefix(prefix) { keyPrefix = prefix; },

    async get(key) {
      applyExpiry();
      operations.push({ op: 'get', key });
      const v = store.get(key);
      return v ? v.value : null;
    },

    async set(key, value, mode, ttlSeconds) {
      operations.push({ op: 'set', key, mode, ttlSeconds });
      const expiresAt = mode === 'EX' ? Date.now() + ttlSeconds * 1000 : null;
      store.set(key, { value, expiresAt });
      return 'OK';
    },

    async scan(cursor, _match, _pattern, _count, _n2) {
      // Ignores MATCH/COUNT (simplified). Returns all matching keys.
      operations.push({ op: 'scan', cursor });
      const keys = Array.from(store.keys()).filter(k => k.startsWith(keyPrefix));
      return ['0', keys];
    },

    async del(...keys) {
      operations.push({ op: 'del', keys });
      let count = 0;
      for (const k of keys) if (store.delete(k)) count++;
      return count;
    },

    // Test helpers.
    _store: store,
    _operations: operations,
    _reset() { store.clear(); operations.length = 0; },
  };
}

module.exports = { createRedisStub };