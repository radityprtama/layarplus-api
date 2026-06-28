'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem } = require('../lib/scraper');

/**
 * Search movies and series on the upstream site.
 *
 * @param {string}   query       - Search term.
 * @param {Object}   [options]
 * @param {number}   [options.page]   - Page number (1-based).
 * @param {number}   [options.limit]  - Items per page.
 * @param {string}   [options.sort]   - Sort order (popularityScore, rating, release_date).
 * @returns {Promise<{items: Array, total: number}>}
 */
async function search(query, { page, limit, sort } = {}) {
  const normalisedQuery = `${query.trim().toLowerCase()}|p${page || 1}l${limit || 20}s${sort || ''}`;
  const key = `search.${normalisedQuery}`;
  if (cache.isHit(key, CACHE_TTL.search)) return cache.get(key);

  const params = new URLSearchParams({ q: query.trim() });
  if (page != null) params.set('page', String(page));
  if (limit != null) params.set('limit', String(limit));
  if (sort) params.set('sort', sort);

  const data = await httpClient.getJson(`/api/search?${params}`);

  const total = data?.total || 0;
  const items = (data?.results || []).map(mapApiItem).filter(Boolean);

  const result = { items, total };
  cache.set(key, result);
  return result;
}

module.exports = { search };
