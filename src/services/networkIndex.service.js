'use strict';

/**
 * Network index: maps network slugs (netflix, hbo, …) to series slugs
 * that belong to that network.
 *
 * Built entirely from cached series detail pages — zero upstream calls
 * during rebuild. The index itself is cached for INDEX_TTL hours.
 *
 * Architecture:
 *   Cache refresh → browse.all (already cached)
 *     → for each series check cached detail → extract networks → index
 *     → all reads from cache, no N+1 during page loads
 *
 * Phase 4 (TMDB enrichment) fills missing network metadata on individual
 * detail pages; the index picks those up on next rebuild.
 */

const cache = require('../lib/cacheService');
const metrics = require('../lib/metrics');
const { CACHE_TTL } = require('../config/env');

// Network slug → TMDB network ID
// ponytail: only the 5 hardcoded from catalog.service.js. Add more here.
//
// AUTHORITATIVE REGISTRY.
// This map is the single source of truth for which network/provider slugs
// the platform supports. `catalog.service.js` reads SUPPORTED_NETWORKS from
// here to gate the `/network/:slug` browse path: a slug not in this registry
// is rejected with an honest empty result (never a generic upstream catalog).
// Network slug → TMDB network / production company IDs
const NETWORK_MAP = {
  'netflix': [213, 14500, 1632, 11463, 178464],
  'hbo': [49, 3186, 128064, 3214],
  'prime-video': [1024, 2058, 125032],
  'disney-plus': [2739, 4353, 2, 3475],
  'apple-tv-plus': [2552, 95166],
  'paramount-plus': [4330, 4, 24, 10221],
  'hulu': [453, 90899],
  'cw': [71],
  'marvel': [420, 7505, 13252],
};

// Strict, exported allowlist of supported network slugs.
const SUPPORTED_NETWORKS = Object.freeze(Object.keys(NETWORK_MAP));

/**
 * Is the given slug a supported network/provider?
 * @param {string} slug
 * @returns {boolean}
 */
function isSupportedNetwork(slug) {
  return slug != null && Object.prototype.hasOwnProperty.call(NETWORK_MAP, slug);
}

// Reverse: TMDB ID → our slug
const SLUG_BY_TMDB_ID = {};
for (const [slug, ids] of Object.entries(NETWORK_MAP)) {
  const idArray = Array.isArray(ids) ? ids : [ids];
  for (const tid of idArray) {
    SLUG_BY_TMDB_ID[tid] = slug;
  }
}

const INDEX_KEY = 'network.index.v1';
const INDEX_TTL = CACHE_TTL.detail || 2;

// ———————————————————————————————————————————————————————————————————————————
//  Public API
// ———————————————————————————————————————————————————————————————————————————

/**
 * Get the network index, rebuilding if stale.
 * @returns {Promise<Object<string, string[]>>} { netflix: [slug, …], … }
 */
async function getIndex() {
  if (cache.isHit(INDEX_KEY, INDEX_TTL)) {
    metrics.recordHit('network.index');
    return cache.get(INDEX_KEY);
  }
  metrics.recordMiss('network.index');
  return rebuildIndex();
}

/**
 * Return paginated MediaItem data for a network slug.
 *
 * @param {string} slug — 'netflix', 'hbo', etc.
 * @param {number} page
 * @param {number} limit
 * @param {string} [_sort]
 * @param {string} [type] — 'movie' | 'series' | undefined
 * @returns {Promise<{items: Array, pagination: Object}>}
 */
async function getNetworkItems(slug, page = 1, limit = 36, _sort, type) {
  const index = await getIndex();
  let allItems = index[slug] || [];

  if (type && type !== 'all') {
    allItems = allItems.filter(i => i.type === type);
  }

  // Sort by year DESC, rating DESC
  allItems = [...allItems].sort((a, b) => {
    const yb = b.year || 0;
    const ya = a.year || 0;
    if (yb !== ya) return yb - ya;
    return (b.rating || 0) - (a.rating || 0);
  });

  const start = (page - 1) * limit;
  const pageItems = allItems.slice(start, start + limit);

  // If index is cold/sparse (< 20 items), trigger background warmup
  if (allItems.length < 20) {
    warmUpNetworkIndex().catch(() => {});
  }

  return {
    items: pageItems,
    pagination: {
      currentPage: Number(page),
      totalPages: Math.max(1, Math.ceil(allItems.length / limit)),
      hasNext: start + limit < allItems.length,
    },
  };
}

let isWarmingUp = false;

/**
 * Background seeder that populates network indexes by fetching details
 * for top trending & browse titles in small async batches.
 */
async function warmUpNetworkIndex() {
  if (isWarmingUp) return;
  isWarmingUp = true;

  try {
    const httpClient = require('../lib/httpClient');
    const { mapApiDetail } = require('../lib/scraper');
    const logger = require('../lib/logger');

    logger.info('network.warmup: starting background index warmup...');

    // Fetch top series & movies browse pages
    const [seriesRes, moviesRes] = await Promise.allSettled([
      httpClient.getJson('/api/series?page=1&limit=60&sort=popularityScore'),
      httpClient.getJson('/api/movies?page=1&limit=60&sort=popularityScore'),
    ]);

    const seriesItems = seriesRes.status === 'fulfilled' && seriesRes.value?.data ? seriesRes.value.data : [];
    const movieItems = moviesRes.status === 'fulfilled' && moviesRes.value?.data ? moviesRes.value.data : [];

    const candidates = [
      ...seriesItems.map(i => ({ slug: i.slug, type: 'series' })),
      ...movieItems.map(i => ({ slug: i.slug, type: 'movie' })),
    ];

    // Batch process 5 items at a time
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5);
      await Promise.all(
        batch.map(async (item) => {
          if (!item.slug) return;
          const detailKey = `${item.type}.detail.${item.slug}`;
          if (!cache.isHit(detailKey, CACHE_TTL.detail)) {
            try {
              const res = await httpClient.getJson(`/api/${item.type}/${item.slug}`);
              if (res && res.data) {
                const mapped = mapApiDetail(res.data);
                cache.set(detailKey, mapped);
                onDetailCached(mapped);
              }
            } catch (err) {
              // ignore single item errors
            }
          } else {
            const cached = cache.get(detailKey);
            if (cached) onDetailCached(cached);
          }
        })
      );
    }
    logger.info('network.warmup: background index warmup completed');
  } catch (err) {
    // ignore overall warmup errors
  } finally {
    isWarmingUp = false;
  }
}

/**
 * Called after a movie or series detail is fetched and cached.
 * Incrementally updates the index so it stays warm without a full rebuild.
 *
 * @param {Object} detail — the full return value from mapApiDetail
 */
function onDetailCached(detail) {
  if (!detail) return;
  const networks = detail.networks || [];
  const companies = detail.productionCompanies || [];
  const allProviders = [...networks, ...companies];
  if (!allProviders.length) return;

  let index = cache.get(INDEX_KEY);
  if (!index) {
    index = {};
    for (const s of Object.keys(NETWORK_MAP)) index[s] = [];
  }

  const stub = {
    slug: detail.slug,
    title: detail.title,
    poster: detail.poster,
    backdrop: detail.backdrop,
    rating: detail.rating,
    year: detail.year,
    type: detail.type || 'series',
  };

  for (const provider of allProviders) {
    const ourSlug = SLUG_BY_TMDB_ID[provider.id];
    if (ourSlug) {
      if (!index[ourSlug]) index[ourSlug] = [];
      const exists = index[ourSlug].some((e) => e.slug === detail.slug);
      if (!exists) index[ourSlug].push(stub);
    }
  }
  cache.set(INDEX_KEY, index, { ttlMs: INDEX_TTL * 3_600_000 });
}

// ———————————————————————————————————————————————————————————————————————————
//  Internal
// ———————————————————————————————————————————————————————————————————————————

/**
 * Rebuild the index from cached series detail pages.
 *
 * Iterates every series in the cached browse aggregation. For each series
 * whose detail page is in cache, extracts networks and adds the slug to
 * the matching network bucket. Series whose detail is NOT cached are
 * skipped — they'll be picked up on future rebuilds once a user visits
 * their detail page.
 *
 * This is the ONLY function that writes the index cache.
 */
async function rebuildIndex() {
  // ponytail: pre-populate all buckets so missing networks return [] not null
  const index = {};
  for (const slug of Object.keys(NETWORK_MAP)) {
    index[slug] = [];
  }

  // series.browse.all is the cached aggregation of ALL upstream series pages.
  // Read it synchronously from L1 cache if available.
  const allKey = 'series.browse.all';
  const allSeries = cache.isHit(allKey, CACHE_TTL.page)
    ? cache.get(allKey)
    : null;

  if (!allSeries || !allSeries.items) {
    // ponytail: no browse cache yet — return empty index.
    // First network page visit will trigger a series browse (which builds
    // the browse.all cache) and then a network page reload will rebuild
    // this index with real data.
    cache.set(INDEX_KEY, index, { ttlMs: INDEX_TTL * 3_600_000 });
    return index;
  }

  for (const item of allSeries.items) {
    const detailKey = `series.detail.${item.slug}`;
    if (!cache.isHit(detailKey, CACHE_TTL.detail)) continue;

    const detail = cache.get(detailKey);
    if (!detail || !detail.networks) continue;

    const stub = {
      slug: detail.slug,
      title: detail.title,
      poster: detail.poster,
      backdrop: detail.backdrop,
      rating: detail.rating,
      year: detail.year,
      type: 'series',
    };

    for (const n of detail.networks) {
      const ourSlug = SLUG_BY_TMDB_ID[n.id];
      if (ourSlug) {
        const exists = index[ourSlug].some((e) => e.slug === detail.slug);
        if (!exists) index[ourSlug].push(stub);
      }
    }
  }

  cache.set(INDEX_KEY, index, { ttlMs: INDEX_TTL * 3_600_000 });
  return index;
}

module.exports = {
  getIndex,
  getNetworkItems,
  onDetailCached,
  NETWORK_MAP,
  SLUG_BY_TMDB_ID,
  SUPPORTED_NETWORKS,
  isSupportedNetwork,
};
