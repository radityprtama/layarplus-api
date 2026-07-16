'use strict';

const env = require('../config/env');
const logger = require('./logger');

/**
 * Minimal circuit breaker for Silentium upstream calls.
 *
 * States: CLOSED (normal) → OPEN (failures exceed threshold) → HALF_OPEN (probe)
 *
 * When OPEN, upstream requests fail fast without reaching Silentium,
 * preventing cascading timeouts when Chromium is unhealthy.
 *
 * ponytail: single-instance in-memory; Redis-backed shared state across
 * replicas if needed when running >1 API instance.
 */
class CircuitBreaker {
  constructor(options = {}) {
    this._threshold = options.threshold || env.CIRCUIT_BREAKER_THRESHOLD;
    this._resetMs = options.resetMs || env.CIRCUIT_BREAKER_RESET_MS;
    this._halfOpenMax = options.halfOpenMax || env.CIRCUIT_BREAKER_HALF_OPEN_MAX;
    this._state = 'CLOSED';
    this._failureCount = 0;
    this._lastFailureTime = 0;
    this._halfOpenSuccesses = 0;
    this._lastError = null;
  }

  get state() { return this._state; }
  get failureCount() { return this._failureCount; }
  get lastError() { return this._lastError; }

  /**
   * Call the upstream function through the breaker.
   * @param {Function} fn - async function that calls Silentium
   * @returns {Promise<any>}
   */
  async call(fn) {
    if (this._state === 'OPEN') {
      const elapsed = Date.now() - this._lastFailureTime;
      if (elapsed >= this._resetMs) {
        logger.info('Circuit breaker half-open — probing Silentium');
        this._state = 'HALF_OPEN';
        this._halfOpenSuccesses = 0;
      } else {
        throw new CircuitBreakerError('Silentium circuit breaker open', this._lastError);
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  _onSuccess() {
    if (this._state === 'HALF_OPEN') {
      this._halfOpenSuccesses++;
      if (this._halfOpenSuccesses >= this._halfOpenMax) {
        logger.info('Circuit breaker closed — Silentium recovered');
        this._state = 'CLOSED';
        this._failureCount = 0;
        this._lastError = null;
      }
    } else {
      this._failureCount = 0;
    }
  }

  _onFailure(err) {
    this._lastError = err;
    this._lastFailureTime = Date.now();
    this._failureCount++;

    if (this._state === 'HALF_OPEN' || this._failureCount >= this._threshold) {
      logger.warn({ failureCount: this._failureCount }, 'Circuit breaker open — Silentium degraded');
      this._state = 'OPEN';
    }
  }

  /** Reset breaker to healthy state (admin endpoint). */
  reset() {
    this._state = 'CLOSED';
    this._failureCount = 0;
    this._halfOpenSuccesses = 0;
    this._lastError = null;
    logger.info('Circuit breaker manually reset');
  }
}

class CircuitBreakerError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.cause = cause;
  }
}

// Singleton
const breaker = new CircuitBreaker();

module.exports = { CircuitBreaker, CircuitBreakerError, breaker };
