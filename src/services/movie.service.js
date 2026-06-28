'use strict';

const httpClient = require('../lib/httpClient');
const cache = require('../lib/cacheService');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, mapApiDetail } = require('../lib/scraper');

const TRENDING_DEFAULTS = {
  LIMIT: 36,
  SORT: 'popularityScore',
};

function fetchPage(resource, page, limit, sort) {
  return httpClient.getJson(`/api/${resource}?page=${page}&limit=${limit}&sort=${sort || 'createdAt'}`);
}

/**
 * Fetch movies with optional pagination.
 *
 * When page is provided, returns only that page with pagination metadata.
 * When page is omitted, aggregates ALL pages from the upstream (cached).
 *
 * @param {number}  [page]
 * @param {number}  [limit=36]
 * @param {string}  [sort='createdAt']
 * @returns {Promise<{ items: Array, pagination: { currentPage, totalPages, hasNext } }>}
 */
async function getBrowse(page, limit, sort) {
  const resLimit = Number(limit) || 36;
  const resSort = sort || 'createdAt';

  if (page != null) {
    const key = `movie.browse.p${page}.l${resLimit}.s${resSort}`;
    if (cache.isHit(key, CACHE_TTL.page)) return cache.get(key);

    const data = await fetchPage('movies', Number(page), resLimit, resSort);
    const items = (data?.data || []).map(mapApiItem).filter(Boolean);
    const upstreamPages = data?.totalPages || data?.pagination?.totalPages || 1;

    const result = {
      items,
      pagination: {
        currentPage: Number(page),
        totalPages: Number(upstreamPages),
        hasNext: Number(page) < Number(upstreamPages),
      },
    };

    cache.set(key, result);
    return result;
  }

  const allKey = 'movie.browse.all';
  if (cache.isHit(allKey, CACHE_TTL.page)) return cache.get(allKey);

  const allItems = [];
  let currentPage = 1;
  let totalPages = 1;

  while (currentPage <= 100) {
    const data = await fetchPage('movies', currentPage, resLimit, resSort);
    const items = (data?.data || []).map(mapApiItem).filter(Boolean);

    if (items.length === 0) break;

    allItems.push(...items);

    if (data?.totalPages) {
      totalPages = Number(data.totalPages);
      if (currentPage >= totalPages) break;
    } else if (data?.pagination?.totalPages) {
      totalPages = Number(data.pagination.totalPages);
      if (currentPage >= totalPages) break;
    }

    currentPage++;
  }

  const result = {
    items: allItems,
    pagination: { currentPage: 1, totalPages: 1, hasNext: false },
  };

  cache.set(allKey, result);
  return result;
}

/**
 * Fetch and parse trending movies from the homepage.
 * @returns {Promise<Array>}
 */
async function getTrending() {
  const key = 'trending';
  if (cache.isHit(key, CACHE_TTL.trending)) return cache.get(key);

  const data = await httpClient.getJson('/api/homepage');
  if (!data || !data.above) return [];

  const section = data.above.find(s => s.title && s.title.toLowerCase().includes('trending')) || data.above[0];
  const items = (section?.data || []).map(mapApiItem).filter(i => i.type === 'movie');

  cache.set(key, items);
  return items;
}

/**
 * Fetch and parse a specific page of trending movies.
 * @param {number} page
 * @returns {Promise<Array>}
 */
async function getTrendingPage(page) {
  const key = `trending.page.${page}`;
  if (cache.isHit(key, CACHE_TTL.trending)) return cache.get(key);

  const data = await httpClient.getJson(`/api/movies?page=${page}&limit=${TRENDING_DEFAULTS.LIMIT}&sort=${TRENDING_DEFAULTS.SORT}`);
  const items = (data?.data || []).map(mapApiItem).filter(Boolean);


  cache.set(key, items);
  return items;
}

/**
 * Fetch a movie detail page by slug.
 * Returns rich metadata from the native JSON API.
 *
 * @param {string} slug - e.g. "per-aspera-ad-astra-2026"
 * @returns {Promise<Object>}
 */
async function getDetail(slug) {
  const key = `movie.detail.${slug}`;
  if (cache.isHit(key, CACHE_TTL.detail)) return cache.get(key);

  const data = await httpClient.getJson(`/api/movies/${slug}`);
  const detail = mapApiDetail(data);

  if (!detail.title) {
    const err = new Error('Movie not found');
    err.status = 404;
    throw err;
  }

  cache.set(key, detail);
  return detail;
}

/**
 * Fetch the stream data for a movie: URL, subtitles, and metadata.
 *
 * Delegates to httpClient.getStreamData which runs the full API chain:
 *   1. GET /api/movies/{slug}               → content UUID
 *   2. POST /api/views/track                → view counter warm-up
 *   3. GET /api/watch/play-info/movie/{uuid} → gateToken + countdown
 *   4. Wait for countdown
 *   5. POST /api/watch/session/claim        → claim JWT + redeemUrl
 *   6. POST redeemUrl (majorplay.net)       → config URL + subtitles
 *
 * Results are cached with a short TTL since stream URLs expire.
 *
 * @param {string} slug - e.g. "salmokji-whispering-water-2026"
 * @returns {Promise<{
 *   streamUrl:   string | null,
 *   subtitles:   Array<{ lang: string, label: string, url: string }>,
 *   videoId:     string | null,
 *   title:       string | null,
 *   durationSec: number | null,
 *   maxHeight:   number | null,
 *   expiresAt:   number | null,
 * }>}
 */
async function getStreamData(slug) {
  const key = `movie.stream.${slug}`;
  if (cache.isHit(key, CACHE_TTL.stream)) return cache.get(key);

  const result = await httpClient.getStreamData(slug, 'movie');
  if (result.streamUrl) cache.set(key, result);
  return result;
}

module.exports = { getBrowse, getTrending, getTrendingPage, getDetail, getStreamData };