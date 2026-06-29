'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const metrics    = require('../lib/metrics');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, mapApiDetail, mapEpisode, ensureContentType } = require('../lib/scraper');

function fetchPage(resource, page, limit, sort) {
  return httpClient.getJson(`/api/${resource}?page=${page}&limit=${limit}&sort=${sort || 'createdAt'}`);
}

/**
 * Fetch series with optional pagination.
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
    const key = `series.browse.p${page}.l${resLimit}.s${resSort}`;
    if (cache.isHit(key, CACHE_TTL.page)) { metrics.recordHit('series.browse'); return cache.get(key); }

    const data = await metrics.fetch('series.browse', () => fetchPage('series', Number(page), resLimit, resSort));
    const items = (data?.data || []).map(i => ensureContentType(i)).map(mapApiItem).filter(Boolean);
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

  const allKey = 'series.browse.all';
  if (cache.isHit(allKey, CACHE_TTL.page)) { metrics.recordHit('series.browse'); return cache.get(allKey); }

  const allItems = [];
  let currentPage = 1;
  let totalPages = 1;

  while (currentPage <= 100) {
    const data = await metrics.fetch('series.browse', () => fetchPage('series', currentPage, resLimit, resSort));
    const items = (data?.data || []).map(i => ensureContentType(i)).map(mapApiItem).filter(Boolean);

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
 * Fetch and parse trending TV series from the homepage.
 * @returns {Promise<Array>}
 */
async function getTrending() {
  const key = 'trending.tv';
  if (cache.isHit(key, CACHE_TTL.trending)) { metrics.recordHit('series.trending'); return cache.get(key); }

  const data = await metrics.fetch('series.trending', () => httpClient.getJson('/api/homepage'));
  if (!data || !data.above) return [];

  const section = data.above.find(s => s.title && s.title.toLowerCase().includes('trending')) || data.above[0];
  const items = (section?.data || []).map(mapApiItem).filter(i => i.type === 'series');
  
  cache.set(key, items);
  return items;
}


/**
 * Fetch a series detail page by slug.
 * Returns rich metadata from the native JSON API.
 *
 * @param {string} slug - e.g. "the-last-of-us-2023"
 * @returns {Promise<Object>}
 */
async function getDetail(slug) {
  const key = `series.detail.${slug}`;
  if (cache.isHit(key, CACHE_TTL.detail)) { metrics.recordHit('series.detail'); return cache.get(key); }

  const data = await metrics.fetch('series.detail', () => httpClient.getJson(`/api/series/${slug}`));
  const detail = mapApiDetail(data);

  if (!detail.title) {
    const err = new Error('Series not found');
    err.status = 404;
    throw err;
  }

  // Upstream /api/series/{slug} returns season summaries WITHOUT episodes.
  // Episodes live at /api/series/{slug}/season/{N}; fetch them in parallel.
  // ponytail: per-season fetch is the only source; cached with the detail so it's one-time.
  if (Array.isArray(detail.seasons) && detail.seasons.length) {
    await Promise.all(
      detail.seasons.map(async (s) => {
        if (s.episodes && s.episodes.length) return; // already populated
        try {
          const sd = await metrics.fetch('series.detailSeason', () => httpClient.getJson(`/api/series/${slug}/season/${s.seasonNumber}`));
          const eps = (sd && sd.season && sd.season.episodes) || [];
          s.episodes = eps.map((e) => mapEpisode(e, {
            seasonPosterPath: sd?.season?.posterPath,
            seriesBackdropPath: data?.backdropPath,
            seriesPosterPath: data?.posterPath,
          }));
        } catch {
          /* leave this season's episodes empty on failure */
        }
      })
    );
  }

  cache.set(key, detail);
  return detail;
}

/**
 * Fetch the stream data for a series episode: URL, subtitles, and metadata.
 *
 * Delegates to httpClient.getStreamData which runs the full API chain.
 * Results are cached with a short TTL since stream URLs expire.
 *
 * @param {string} slug - e.g. "the-last-of-us-2023"
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
  const key = `series.stream.${slug}`;
  if (cache.isHit(key, CACHE_TTL.stream)) { metrics.recordHit('series.stream'); return cache.get(key); }

  const result = await metrics.fetch('series.stream', () => httpClient.getStreamData(slug));
  if (result.streamUrl) cache.set(key, result);
  return result;
}

/**
 * Fetch stream data for a specific series episode.
 *
 * @param {string} slug    - e.g. "oasis-2026"
 * @param {number} season  - Season number (1-based)
 * @param {number} episode - Episode number (1-based)
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
async function getEpisodeStreamData(slug, season, episode) {
  const key = `series.stream.${slug}.s${season}e${episode}`;
  if (cache.isHit(key, CACHE_TTL.stream)) { metrics.recordHit('series.episodeStream'); return cache.get(key); }

  const result = await metrics.fetch('series.episodeStream', () => httpClient.getEpisodeStreamData(slug, Number(season), Number(episode)));
  if (result.streamUrl) cache.set(key, result);
  return result;
}

module.exports = {
  getBrowse,
  getTrending,

  getDetail,
  getStreamData,
  getEpisodeStreamData,
};