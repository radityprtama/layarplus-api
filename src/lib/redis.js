'use strict';

const Redis = require('ioredis');
const { REDIS_URL, REDIS_ENABLED } = require('../config/env');

/**
 * Lazy-initialised singleton Redis client.
 *
 * Phase 3 of the Redis audit: when CACHE_BACKEND=redis is set, this module
 * constructs a single shared ioredis client and exposes it via getClient().
 * Cache failures fall back to in-process only — `cacheService` treats a
 * null/undefined `getClient()` return as "Redis layer disabled".
 *
 * The client is configured with retry strategy that NEVER gives up — a
 * transient Redis blip during deploy should not kill the API. Callers
 * that use the client must therefore handle timeouts/errors per-call.
 */

// Module-level singleton.
let client = null;
let initialised = false;

function initialise() {
  if (initialised) return client;
  initialised = true;

  if (!REDIS_ENABLED) {
    return client; // null
  }

  try {
    const c = new Redis(REDIS_URL, {
      // Don't crash the app if Redis is down at boot.
      lazyConnect: false,
      // Retry forever, with capped exponential-ish backoff.
      retryStrategy(times) {
        const delay = Math.min(50 * Math.pow(2, times - 1), 5_000);
        return delay;
      },
      // Don't queue commands while disconnected; drop them so cache
      // lookups fail fast and the caller can fall back to L1.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
    });

    c.on('error', (err) => {
      // Log without spamming: only the first error per minute would be
      // ideal, but stderr at WARN is enough for an MVP.
      console.warn('[redis] error:', err.message);
    });
    c.on('connect', () => console.log('[redis] connected'));
    c.on('ready',   () => console.log('[redis] ready'));
    c.on('close',   () => console.warn('[redis] connection closed'));

    client = c;
    return c;
  } catch (err) {
    console.warn('[redis] failed to initialise client:', err.message);
    return null;
  }
}

/**
 * @returns {import('ioredis').Redis|null} The shared client, or null if
 *                                          Redis is disabled / unavailable.
 */
function getClient() {
  return initialise();
}

/**
 * @returns {boolean} Whether the shared client is currently in the 'ready'
 *                    state. False during initial connection, after a disconnect,
 *                    or when Redis is disabled.
 */
function isReady() {
  return client != null && client.status === 'ready';
}

/**
 * Disconnect the client. Used in tests and graceful shutdown.
 * @returns {Promise<void>}
 */
async function disconnect() {
  if (client) {
    try { await client.quit(); } catch (_) { /* ignore */ }
    client = null;
    initialised = false;
  }
}

module.exports = { getClient, isReady, disconnect };
