'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const metrics    = require('../lib/metrics');
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
 * Both are fetched in parallel, merged, re-sorted by popularityScore (so the
 * two lists interleave rather than concatenate), trimmed to the top N, and
 * mapped through the shared `mapApiItem` scraper (no mapping duplication).
 */

const NEAR_YOU_DEFAULTS = {
  LIMIT: 36, // upstream page size requested from each resource
  TOP_N: 36, // size of the merged result returned to the client
  SORT: 'popularityScore',
};

/**
 * Build the upstream URL for a given resource + country.
 * @param {'movies'|'series'} resource
 * @param {string} country - Two-letter country code (already validated by GeoService).
 * @returns {string}
 */
function buildUrl(resource, country) {
  return `/api/${resource}?country=${country}&page=1&limit=${NEAR_YOU_DEFAULTS.LIMIT}&sort=${NEAR_YOU_DEFAULTS.SORT}`;
}

/**
 * Fetch a single upstream resource, distinguishing failure from emptiness.
 *
 * `httpClient.getJson` resolves to `null` on a non-OK upstream response (it does
 * not throw), so we surface that as a failure (`null`) — while a genuine empty
 * page (`{ data: [] }`) resolves to `[]`. A thrown network error propagates and
 * is caught by the `Promise.allSettled` in the caller.
 *
 * @param {'movies'|'series'} resource
 * @param {string} country
 * @returns {Promise<Array|null>} Raw items array, or `null` when the request failed.
 */
async function fetchResource(resource, country) {
  const json = await httpClient.getJson(buildUrl(resource, country));
  if (json == null) return null; // upstream non-OK / unparseable → failure
  return Array.isArray(json.data) ? json.data : [];
}

// `ensureContentType` from scraper handles the upstream `/api/series`
// contentType omission. Used directly below — no local wrapper needed.

/**
 * Numeric popularity score for sorting. Falls back to 0 when absent so items
 * without a score sink to the bottom rather than corrupting the sort.
 *
 * @param {Object} item - Raw upstream item.
 * @returns {number}
 */
function popularityOf(item) {
  const score = Number(item?.popularityScore);
  return Number.isFinite(score) ? score : 0;
}

/**
 * Get the location-aware mixed trending feed (movies + TV series) for a country.
 *
 * Fetches both upstream resources in parallel and tolerates partial failure:
 * if one resource fails but the other succeeds, the successful results are
 * still returned. An error is thrown only when BOTH upstream requests fail.
 *
 * @param {string} country - Two-letter country code from GeoService.
 * @returns {Promise<Array>} Mapped items sorted by popularityScore (desc), top N.
 * @throws {Error} 502 when both upstream resources fail.
 */
async function getNearYou(country) {
  const key = `trending.nearyou.${country}`;
  if (cache.isHit(key, CACHE_TTL.trending)) { metrics.recordHit('trending.nearyou'); return cache.get(key); }

  const [movieRes, seriesRes] = await Promise.allSettled([
    metrics.fetch('trending.nearyou.movie', () => fetchResource('movies', country)),
    metrics.fetch('trending.nearyou.series', () => fetchResource('series', country)),
  ]);

  // A resource "succeeded" only if it resolved AND returned an array (not null,
  // which fetchResource uses to flag a non-OK upstream response).
  const movieOk = movieRes.status === 'fulfilled' && movieRes.value != null;
  const seriesOk = seriesRes.status === 'fulfilled' && seriesRes.value != null;

  // Only fail when BOTH upstream resources are unavailable.
  if (!movieOk && !seriesOk) {
    const err = new Error('Trending upstream unavailable');
    err.status = 502;
    throw err;
  }

  const movies = movieOk ? movieRes.value : [];
  const series = (seriesOk ? seriesRes.value : []).map(i => ensureContentType(i));

  const items = [...movies, ...series]
    .sort((a, b) => popularityOf(b) - popularityOf(a))
    .slice(0, NEAR_YOU_DEFAULTS.TOP_N)
    .map(mapApiItem)
    .filter(Boolean);

  cache.set(key, items);
  return items;
}

module.exports = { getNearYou, NEAR_YOU_DEFAULTS };
