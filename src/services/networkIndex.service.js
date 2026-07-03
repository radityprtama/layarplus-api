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
const NETWORK_MAP = {
  netflix: 213,
  hbo: 49,
  'prime-video': 1024,
  'disney-plus': 2739,
  'apple-tv-plus': 2552,
};

// Reverse: TMDB network ID → our slug
const SLUG_BY_TMDB_ID = {};
for (const [slug, tid] of Object.entries(NETWORK_MAP)) {
  SLUG_BY_TMDB_ID[tid] = slug;
}

const INDEX_KEY = 'network.index.v1';
// ponytail: index TTL matches detail TTL so rebuild sees fresh detail pages.
// If detail pages are fresher than the index, next rebuild picks them up.
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
 * Items are looked up from the cached series browse aggregation
 * (series.browse.all) so no upstream calls happen during page load.
 *
 * @param {string} slug — 'netflix', 'hbo', etc.
 * @param {number} page
 * @param {number} limit
 * @returns {Promise<{items: Array, pagination: Object}>}
 */
async function getNetworkItems(slug, page = 1, limit = 36) {
  const index = await getIndex();
  const allItems = index[slug] || [];

  const start = (page - 1) * limit;
  const pageItems = allItems.slice(start, start + limit);

  return {
    items: pageItems,
    pagination: {
      currentPage: Number(page),
      totalPages: Math.max(1, Math.ceil(allItems.length / limit)),
      hasNext: start + limit < allItems.length,
    },
  };
}

/**
 * Called after a series detail is fetched and cached.
 * Incrementally updates the index so it stays warm without a full rebuild.
 *
 * Stores a lightweight item stub ({ slug, title, poster }) alongside each
 * slug so the browse endpoint can render items without reading the browse
 * aggregation — the index is self-contained.
 *
 * @param {Object} detail — the full return value from mapApiDetail
 */
function onDetailCached(detail) {
  if (!detail || !detail.networks || !detail.networks.length) return;
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
    type: 'series',
  };

  for (const n of detail.networks) {
    const ourSlug = SLUG_BY_TMDB_ID[n.id];
    if (ourSlug) {
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
};
