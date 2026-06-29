'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, ensureContentType } = require('../lib/scraper');

/**
 * "Trending Near You" — a Netflix-style mixed feed of geo-filtered movies AND
 * TV series for the detected country.
 *
 * The upstream exposes two independent resources, each accepting a `country`
 * filter and a `popularityScore` sort:
 *   - GET /api/movies?country={CC}&page=1&limit=36&sort=popularityScore
 *   - GET /api/series?country={CC}&page=1&limit=36&sort=popularityScore
 *
 * Both are fetched in parallel (each cached independently under
 * `trending.nearyou.movie.{CC}` / `trending.nearyou.series.{CC}`), merged,
 * re-sorted by popularityScore, trimmed to the top N, and mapped through
 * the shared `mapApiItem` scraper.
 */

const NEAR_YOU_DEFAULTS = {
  LIMIT: 36,
  TOP_N: 36,
  SORT: 'popularityScore',
};

function buildUrl(resource, country) {
  return `/api/${resource}?country=${country}&page=1&limit=${NEAR_YOU_DEFAULTS.LIMIT}&sort=${NEAR_YOU_DEFAULTS.SORT}`;
}

function popularityOf(item) {
  const score = Number(item?.popularityScore);
  return Number.isFinite(score) ? score : 0;
}

/**
 * Get the location-aware mixed trending feed (movies + TV series) for a country.
 *
 * Tolerates partial failure: if one resource fails but the other succeeds,
 * the successful results are still returned. Throws only when BOTH upstream
 * requests fail.
 *
 * @param {string} country - Two-letter country code from GeoService.
 * @returns {Promise<Array>} Mapped items sorted by popularityScore (desc), top N.
 * @throws {Error} 502 when both upstream resources fail.
 */
async function getNearYou(country) {
  const key = `trending.nearyou.${country}`;

  return cache.readThrough(key, CACHE_TTL.trending, 'trending.nearyou', async () => {
    const fetchResource = (resource) => () => {
      const subKey = `trending.nearyou.${resource}.${country}`;
      return cache.readThrough(subKey, CACHE_TTL.trending, `trending.nearyou.${resource}`,
        async () => {
          const json = await httpClient.getJson(buildUrl(resource, country));
          return json == null ? null : (Array.isArray(json.data) ? json.data : []);
        });
    };

    const [movieRes, seriesRes] = await Promise.allSettled([
      fetchResource('movies')(),
      fetchResource('series')(),
    ]);

    const movieOk = movieRes.status === 'fulfilled' && movieRes.value != null;
    const seriesOk = seriesRes.status === 'fulfilled' && seriesRes.value != null;

    if (!movieOk && !seriesOk) {
      const err = new Error('Trending upstream unavailable');
      err.status = 502;
      throw err;
    }

    const movies = movieOk ? movieRes.value : [];
    const series = (seriesOk ? seriesRes.value : []).map(i => ensureContentType(i));

    return [...movies, ...series]
      .sort((a, b) => popularityOf(b) - popularityOf(a))
      .slice(0, NEAR_YOU_DEFAULTS.TOP_N)
      .map(mapApiItem)
      .filter(Boolean);
  });
}

module.exports = { getNearYou, NEAR_YOU_DEFAULTS };
