'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const metrics    = require('../lib/metrics');
const { effectiveStreamTtlMs } = require('../lib/streamTtl');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, mapApiDetail, mapEpisode, ensureContentType } = require('../lib/scraper');

const CATEGORY_BROWSE = 'series.browse';
const CATEGORY_TRENDING = 'series.trending';
const CATEGORY_DETAIL = 'series.detail';
const CATEGORY_DETAIL_SEASON = 'series.detailSeason';
const CATEGORY_STREAM = 'series.stream';
const CATEGORY_EPISODE_STREAM = 'series.episodeStream';

function fetchPage(resource, page, limit, sort) {
  return httpClient.getJson(`/api/${resource}?page=${page}&limit=${limit}&sort=${sort || 'createdAt'}`);
}

/**
 * Fetch a season's episodes from upstream and cache them under their own
 * key (`series.season.{slug}.s{N}`). Decouples episode data from the
 * series-detail bundle so individual seasons can refresh without
 * invalidating — or being invalidated by — the rest of the detail.
 *
 * @param {string} slug
 * @param {number} seasonNumber
 * @returns {Promise<Object|null>} Upstream `{season: {episodes, posterPath}}` or null on failure.
 */
async function getSeasonEpisodes(slug, seasonNumber) {
  const key = `series.season.${slug}.s${seasonNumber}`;
  return cache.readThrough(key, CACHE_TTL.detail, CATEGORY_DETAIL_SEASON, () =>
    httpClient.getJson(`/api/series/${slug}/season/${seasonNumber}`));
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
    return cache.readThrough(key, CACHE_TTL.page, CATEGORY_BROWSE, async () => {
      const data = await fetchPage('series', Number(page), resLimit, resSort);
      const items = (data?.data || []).map(i => ensureContentType(i)).map(mapApiItem).filter(Boolean);
      const upstreamPages = data?.totalPages || data?.pagination?.totalPages || 1;
      return {
        items,
        pagination: {
          currentPage: Number(page),
          totalPages: Number(upstreamPages),
          hasNext: Number(page) < Number(upstreamPages),
        },
      };
    });
  }

  const allKey = 'series.browse.all';
  return cache.readThrough(allKey, CACHE_TTL.page, CATEGORY_BROWSE, async () => {
    const allItems = [];
    let currentPage = 1;
    let totalPages = 1;

    while (currentPage <= 100) {
      const data = await metrics.fetch(CATEGORY_BROWSE,
        () => fetchPage('series', currentPage, resLimit, resSort));
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

    return {
      items: allItems,
      pagination: { currentPage: 1, totalPages: 1, hasNext: false },
    };
  });
}

/**
 * Fetch and parse trending TV series from the homepage.
 * @returns {Promise<Array>}
 */
async function getTrending() {
  return cache.readThrough('trending.tv', CACHE_TTL.trending, CATEGORY_TRENDING, async () => {
    const data = await httpClient.getJson('/api/homepage');
    if (!data || !data.above) return [];
    const section = data.above.find(s => s.title && s.title.toLowerCase().includes('trending')) || data.above[0];
    return (section?.data || []).map(mapApiItem).filter(i => i.type === 'series');
  });
}


/**
 * Fetch a series detail page by slug.
 * Returns rich metadata from the native JSON API.
 *
 * @param {string} slug - e.g. "the-last-of-us-2023"
 * @returns {Promise<Object>}
 */
async function getDetail(slug) {
  return cache.readThrough(`series.detail.${slug}`, CACHE_TTL.detail, CATEGORY_DETAIL, async () => {
    const data = await httpClient.getJson(`/api/series/${slug}`);
    const detail = mapApiDetail(data);

    if (!detail.title) {
      const err = new Error('Series not found');
      err.status = 404;
      throw err;
    }

    // ponytail: episodes live at a separate endpoint per season — fetch in
    // parallel through the per-season cache so each season is independently
    // cacheable and the upstream cost is single-flight coalesced.
    if (Array.isArray(detail.seasons) && detail.seasons.length) {
      await Promise.all(
        detail.seasons.map(async (s) => {
          if (s.episodes && s.episodes.length) return;
          try {
            const sd = await getSeasonEpisodes(slug, s.seasonNumber);
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

    return detail;
  });
}

/**
 * Fetch the stream data for a series (first episode — backward-compat): URL, subtitles, metadata.
 *
 * Delegates to httpClient.getStreamData which runs the full API chain.
 *
 * IMPORTANT: result.expiresAt (from the redeem step) is a short-lived signed URL.
 * Never cache past its expiry.
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
  if (cache.isHit(key, CACHE_TTL.stream)) { metrics.recordHit(CATEGORY_STREAM); return cache.get(key); }

  const result = await metrics.fetch(CATEGORY_STREAM,
    () => cache.singleFlight(key, () => httpClient.getStreamData(slug)));
  if (result.streamUrl) {
    const ttlMs = effectiveStreamTtlMs(CACHE_TTL.stream, result.expiresAt);
    if (ttlMs > 0) cache.set(key, result, { ttlMs });
  }
  return result;
}

/**
 * Fetch stream data for a specific series episode.
 *
 * IMPORTANT: result.expiresAt is a short-lived signed URL — TTL is
 * computed from it via `effectiveStreamTtlMs`.
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
  if (cache.isHit(key, CACHE_TTL.stream)) { metrics.recordHit(CATEGORY_EPISODE_STREAM); return cache.get(key); }

  const result = await metrics.fetch(CATEGORY_EPISODE_STREAM,
    () => cache.singleFlight(key, () => httpClient.getEpisodeStreamData(slug, Number(season), Number(episode))));
  if (result.streamUrl) {
    const ttlMs = effectiveStreamTtlMs(CACHE_TTL.stream, result.expiresAt);
    if (ttlMs > 0) cache.set(key, result, { ttlMs });
  }
  return result;
}

module.exports = {
  getBrowse,
  getTrending,

  getDetail,
  getStreamData,
  getEpisodeStreamData,
  getSeasonEpisodes, // exported for testability
};
