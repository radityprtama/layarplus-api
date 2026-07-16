"use strict";

/**
 * Centralised runtime configuration.
 * All environment-specific values must be read here — never hardcode elsewhere.
 */
module.exports = {
  /** Base URL of the upstream site (no trailing slash). */
  BASE_URL: process.env.IDLIX_BASE_URL || "https://z2.idlixku.com",

  /** HTTP port the server listens on. */
  PORT: process.env.PORT || 3000,

  /** URL of the Silentium microservice used for Cloudflare bypass. */
  SILENTIUM_API_URL: process.env.SILENTIUM_API_URL || "http://localhost:8191",

  /**
   * TMDB API key for metadata enrichment (networks, production companies).
   * Required only when the upstream response lacks network data for a title.
   * Get one free at https://www.themoviedb.org/settings/api
   */
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',

  /**
   * Feature flag for location-aware trending.
   * Set to 'false' to disable GeoIP detection (always uses US).
   */
  ENABLE_GEO_TRENDING: process.env.ENABLE_GEO_TRENDING !== "false",

  /**
   * Cache backend selector. 'memory' (default) keeps the in-process Map
   * singleton from Phase 1. 'redis' adds a Redis L2 to cacheService for
   * cross-instance fan-in when the API runs ≥2 replicas (Phase 3).
   */
  CACHE_BACKEND: (process.env.CACHE_BACKEND || 'memory').toLowerCase(),

  /** Boolean derived: true iff CACHE_BACKEND === 'redis'. */
  get REDIS_ENABLED() { return this.CACHE_BACKEND === 'redis'; },

  /** Redis connection string used when CACHE_BACKEND=redis. */
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  /**
   * Key prefix for cache entries stored in Redis. Keep short to save bytes.
   * The in-process Map uses the same logical key (no prefix) so the two
   * layers are addressable identically from `cacheService`.
   */
  REDIS_KEY_PREFIX: process.env.REDIS_KEY_PREFIX || 'idlc:',

  /**
   * Homepage curation controls.
   * HOMEPAGE_BUDGET: maximum number of content rows the homepage will render
   *                  (excluding hero and continue-watching which are handled
   *                  client-side).
   * HOMEPAGE_ROW_SIZE: target number of items per row after cross-row
   *                    deduplication and refill.
   */
  HOMEPAGE_BUDGET: Number(process.env.HOMEPAGE_BUDGET) || 7,
  HOMEPAGE_ROW_SIZE: Number(process.env.HOMEPAGE_ROW_SIZE) || 20,

  // ── Security ─────────────────────────────────────────────────────────────

  /** Arcjet API key — set to enable rate-limiting & Shield protection. */
  ARCJET_KEY: process.env.ARCJET_KEY || '',

  /** Arcjet Shield mode: 'LIVE' (default) or 'DRY_RUN'. */
  ARCJET_SHIELD_MODE: (process.env.ARCJET_SHIELD_MODE || 'LIVE').toUpperCase(),

  /** Arcjet sliding window rate limit mode: 'LIVE' (default) or 'DRY_RUN'. */
  ARCJET_RATE_MODE: (process.env.ARCJET_RATE_MODE || 'LIVE').toUpperCase(),

  /** Rate limit: max requests per interval per IP. */
  ARCJET_RATE_MAX: Number(process.env.ARCJET_RATE_MAX) || 100,

  /** Rate limit interval in ms (default: 60s). */
  ARCJET_RATE_INTERVAL: process.env.ARCJET_RATE_INTERVAL || '60s',

  /** Enable Arcjet bot detection (additional API call). */
  ARCJET_BOT_DETECTION: process.env.ARCJET_BOT_DETECTION === 'true',

  /** Shared API key for Bearer auth between API ↔ frontend BFF. */
  API_KEY: process.env.API_KEY || '',

  /**
   * Comma-separated list of allowed CORS origins.
   * Default: layarplus.my.id, admin.layarplus.my.id, localhost dev.
   */
  get CORS_ORIGINS() {
    if (process.env.CORS_ORIGINS) {
      return process.env.CORS_ORIGINS.split(',').map(s => s.trim());
    }
    return [
      'https://layarplus.my.id',
      'https://admin.layarplus.my.id',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
    ];
  },

  /** Request timeout in ms (default: 30s). */
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS) || 30_000,

  /** Maximum JSON body size (default: 1mb). */
  MAX_BODY_SIZE: process.env.MAX_BODY_SIZE || '1mb',

  // ── Circuit breaker ──────────────────────────────────────────────────────

  /** Consecutive failures before circuit opens (default: 5). */
  CIRCUIT_BREAKER_THRESHOLD: Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5,

  /** Time (ms) before probing after open (default: 30s). */
  CIRCUIT_BREAKER_RESET_MS: Number(process.env.CIRCUIT_BREAKER_RESET_MS) || 30_000,

  /** Successful probes needed to close (default: 2). */
  CIRCUIT_BREAKER_HALF_OPEN_MAX: Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MAX) || 2,

  /**
   * Per-category cache TTLs in hours.
   * Each can be overridden via a corresponding CACHE_TTL_* env var.
   */
  CACHE_TTL: {
    page: Number(process.env.CACHE_TTL_PAGE) || 1,
    featured: Number(process.env.CACHE_TTL_FEATURED) || 1,
    cinemaxxi: Number(process.env.CACHE_TTL_CINEMAXXI) || 1,
    trending: Number(process.env.CACHE_TTL_TRENDING) || 1,
    series: Number(process.env.CACHE_TTL_SERIES) || 1,
    mcu: Number(process.env.CACHE_TTL_MCU) || 1,
    detail: Number(process.env.CACHE_TTL_DETAIL) || 2,
    search: Number(process.env.CACHE_TTL_SEARCH) || 0.5,
    leaderboard: Number(process.env.CACHE_TTL_LEADERBOARD) || 1,
    home: Number(process.env.CACHE_TTL_HOME) || 1,
    // Stream URLs expire — keep TTL short (15 minutes = 0.25h)
    stream: Number(process.env.CACHE_TTL_STREAM) || 0.25,
  },
};
