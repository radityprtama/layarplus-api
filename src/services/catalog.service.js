'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const logger     = require('../lib/logger');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, ensureContentType } = require('../lib/scraper');
const { isSupportedNetwork, getNetworkItems: getNetworkItemsIndex } = require('./networkIndex.service');

function buildKey(parts) {
  return parts.filter(Boolean).join('.');
}

const HARDCODED_NETWORKS = [
  { slug: 'netflix', title: 'Netflix' },
  { slug: 'hbo', title: 'HBO' },
  { slug: 'prime-video', title: 'Prime Video' },
  { slug: 'disney-plus', title: 'Disney+' },
  { slug: 'apple-tv-plus', title: 'Apple TV+' },
  { slug: 'paramount-plus', title: 'Paramount+' },
  { slug: 'hulu', title: 'Hulu' },
  { slug: 'cw', title: 'The CW' },
  { slug: 'marvel', title: 'Marvel Studios' },
];

/**
 * Honest empty result for a network/provider browse page.
 */
function emptyNetworkResult(page, limit) {
  return {
    items: [],
    pagination: {
      currentPage: Number(page) || 1,
      totalPages: 1,
      hasNext: false,
    },
  };
}

async function getCategoryIndex(category) {
  const key = buildKey([category, 'index']);

  if (category === 'network') {
    if (cache.isHit(key, CACHE_TTL.page)) return cache.get(key);
    const items = HARDCODED_NETWORKS.map(n => ({
      title: n.title,
      originalTitle: n.title,
      category: 'network',
      slug: n.slug,
      value: n.slug,
      network: n.slug,
      link: { endpoint: `network/${n.slug}`, url: `${require('../config/env').BASE_URL}/network/${n.slug}` }
    }));
    cache.set(key, items);
    return items;
  }

  return cache.readThrough(key, CACHE_TTL.page, `${category}.index`, async () => {
    let items;
    if (category === 'genre') {
      const data = await httpClient.getJson('/api/genres');
      items = (data?.data || []).map(g => ({
        title: g.name,
        originalTitle: g.name,
        category: 'genre',
        slug: g.slug,
        value: g.slug,
        genre: g.slug,
        link: { endpoint: `genre/${g.slug}`, url: `${require('../config/env').BASE_URL}/genre/${g.slug}` }
      }));
    } else if (category === 'country') {
      const data = await httpClient.getJson('/api/browse/countries');
      items = (data?.data || []).map(c => ({
        title: c.name,
        originalTitle: c.name,
        category: 'country',
        slug: c.code,
        value: c.code,
        code: c.code,
        link: { endpoint: `country/${c.code}`, url: `${require('../config/env').BASE_URL}/country/${c.code}` }
      }));
    } else if (category === 'year') {
      const data = await httpClient.getJson('/api/browse/years');
      items = (data?.data || []).map(y => ({
        title: y,
        originalTitle: y,
        category: 'year',
        slug: y,
        value: parseInt(y, 10),
        year: parseInt(y, 10),
        link: { endpoint: `year/${y}`, url: `${require('../config/env').BASE_URL}/year/${y}` }
      }));
    } else {
      items = [];
    }
    return items;
  });
}

async function getCategoryBrowse(category, value, type, page = 1, limit, sort) {
  if (category === 'network') {
    const nLimit = Number(limit) || 36;
    const nPage  = Number(page)  || 1;
    const resSorting = sort || 'createdAt';

    if (!isSupportedNetwork(value)) {
      logger.info({ category, slug: value }, 'network.browse.unsupported: empty result, no upstream call');
      return emptyNetworkResult(nPage, nLimit);
    }

    return getNetworkItemsIndex(value, nPage, nLimit, resSorting, type);
  }

  const resLimit = Number(limit) || 36;
  const resSort = sort || 'createdAt';
  const key = buildKey([category, value, type || 'all', `page-${page}`, `limit-${resLimit}`, `sort-${resSort}`]);
  const isSeries = type === 'series';
  const apiPath = isSeries ? '/api/series' : '/api/movies';
  const qs = `${category}=${value}&page=${page}&limit=${resLimit}&sort=${resSort}`;

  return cache.readThrough(key, CACHE_TTL.page, `${category}.browse`, async () => {
    const data = await httpClient.getJson(`${apiPath}?${qs}`);
    const items = (data?.data || [])
      .map(i => ensureContentType(i, isSeries ? 'tv_series' : 'movie'))
      .map(mapApiItem)
      .filter(Boolean);
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

module.exports = {
  getCategoryIndex,
  getCategoryBrowse,
};
